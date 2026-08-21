/* app.js — shell, state, migration, Home / Tasks / More screens.
   Plan + AXIS screens live in axis.js. */

/* ── constants ── */
const ARC_COLORS = [
  { id: 'orange', hex: '#F5A623' }, { id: 'green', hex: '#34D399' },
  { id: 'purple', hex: '#818CF8' }, { id: 'blue', hex: '#38BDF8' },
  { id: 'red', hex: '#F87171' }, { id: 'pink', hex: '#F472B6' },
];
const arcColor = arc => (ARC_COLORS.find(c => c.id === (arc && arc.color)) || ARC_COLORS[0]).hex;
const DS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DF = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* "19:05" → "7:05pm", "08:00" → "8am", "24:00"/"00:00" → "12am" */
function fmtT(hhmm) {
  if (!hhmm) return '';
  let [h, m] = String(hhmm).split(':').map(Number);
  if (h >= 24) h -= 24;
  const ap = h >= 12 ? 'pm' : 'am';
  let hr = h % 12; if (hr === 0) hr = 12;
  return m ? `${hr}:${String(m).padStart(2, '0')}${ap}` : `${hr}${ap}`;
}
/* pretty-print a preferred window ("16:00-17:00" → "4pm–5pm") */
function fmtWin(w) {
  if (!w) return '';
  const m = String(w).match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  return m ? `${fmtT(m[1])}–${fmtT(m[2])}` : w;
}

/* day resets at 3am (same behavior as v1) */
const _now = new Date(Date.now() - 3 * 3600 * 1000);
const TODAY = _now.getDay();
const TSTR = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;

/* ── client state ── */
let C = {
  loaded: false, offline: false,
  profile: null, tasks: [], arcs: [], wins: [], loops: [], prefs: {}, blocks: [],
  comp: {},                     // `${task_id}_${date}` → count
  tab: localStorage.getItem('ctrl_tab') || 'home',
  ui: { editTask: null, taskForm: null, editArc: null, arcForm: null, moreSec: localStorage.getItem('ctrl_more') || 'arcs', loopsShowClosed: false, onboard: null, classifyPending: null, classifyBusy: false },
};

function cacheState() {
  try { localStorage.setItem('ctrl_v2_cache', JSON.stringify({ profile: C.profile, tasks: C.tasks, arcs: C.arcs, wins: C.wins, loops: C.loops, prefs: C.prefs, blocks: C.blocks, comp: C.comp })); } catch {}
}
function adoptState(st) {
  C.profile = st.profile; C.tasks = st.tasks || []; C.arcs = st.arcs || [];
  C.wins = st.wins || []; C.loops = st.loops || []; C.prefs = st.prefs || {}; C.blocks = st.blocks || [];
  C.comp = {};
  for (const c of st.completions || []) C.comp[`${c.task_id}_${c.date}`] = c.count;
  cacheState();
}

/* ── migration from v1 localStorage ── */
const LEGACY_KEYS = ['ctrl_local_v1', 'ctrl_v2_cache', 'ctrl_v8', 'ctrl_v7', 'ctrl_v6', 'ctrl_v5', 'ctrl_v4', 'ctrl_v3', 'ctrl_state'];
function readLegacyState() {
  for (const k of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const S = JSON.parse(raw);
      if (!S || typeof S !== 'object') continue;
      // Normalize local-first / cache shape into sync seed payload
      if (S.comp && !S.counts) S.counts = S.comp;
      if (Array.isArray(S.completions)) {
        S.counts = S.counts || {};
        for (const c of S.completions) {
          if (c?.task_id && c?.date) S.counts[c.task_id + '_' + c.date] = c.count || 1;
        }
      }
      return S;
    } catch {}
  }
  return null;
}

async function boot() {
  let legacy = null;
  if (!localStorage.getItem('ctrl_v2_migrated')) legacy = readLegacyState();
  try {
    const r = legacy ? await api('/sync', 'POST', legacy) : await api('/sync');
    adoptState(r.state);
    if (legacy) { localStorage.setItem('ctrl_v2_migrated', '1'); if (r.seeded) toast('Data migrated to server ✓'); }
    C.loaded = true; C.offline = false;
  } catch (e) {
    // offline / server down → run off cache
    try { const cached = JSON.parse(localStorage.getItem('ctrl_v2_cache') || 'null'); if (cached) Object.assign(C, cached); } catch {}
    C.loaded = true; C.offline = true;
  }
  if (!C.profile || !C.profile.name) C.ui.onboard = C.ui.onboard || { step: -1, answers: {}, val: '' };
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

async function refresh() {
  try { const r = await api('/sync'); adoptState(r.state); C.offline = false; } catch { C.offline = true; }
  render();
}

/* ── derived (same formulas as v1) ── */
const getCount = t => C.comp[`${t.id}_${TSTR}`] || 0;
const doneToday = t => t.type === 'count' ? getCount(t) >= (t.target || 1) : getCount(t) > 0;
function activeToday(t) {
  if (t.kind === 'oneoff') return (t.dates || []).includes(TSTR);
  return (t.days || []).includes(TODAY);
}
const todayTasks = () => C.tasks.filter(activeToday);
const fmtM = m => m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : m + 'm';
function arcProgress(arc) {
  let pct = 0;
  for (const t of C.tasks.filter(t => t.arc_id === arc.id)) {
    const done = Object.keys(C.comp).filter(k => k.startsWith(t.id + '_') && C.comp[k] > 0).length;
    pct += done * (t.arc_pct || 0);
  }
  return Math.min(Math.round(pct), 100);
}
function getDerived() {
  const tt = todayTasks();
  const xpE = tt.reduce((s, t) => {
    if (t.type === 'count') {
      const c = getCount(t), tgt = t.target || 1;
      return s + Math.round((t.minutes || 30) / 5 * (Math.min(c, tgt) / tgt));
    }
    return s + (doneToday(t) ? Math.round((t.minutes || 30) / 5) : 0);
  }, 0);
  const totalXp = (C.profile?.xp || 0) + xpE;
  const level = Math.floor(totalXp / 150) + 1;
  const xpInL = totalXp % 150;
  const done = tt.filter(doneToday).length;
  return { level, xpInL, xpPct: xpInL / 150, done, prog: tt.length ? done / tt.length : 0, tt };
}

/* ── toast ── */
let _toastT = null;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.getElementById('app').appendChild(el);
  clearTimeout(_toastT); _toastT = setTimeout(() => el.remove(), 2600);
}

/* ── bottom sheet ── */
function openSheet(html, bind) {
  const w = document.getElementById('sheet-wrap');
  document.getElementById('sheet').innerHTML = `<div class="sheet-handle"></div>` + html;
  w.classList.add('open');
  document.getElementById('sheet-scrim').onclick = closeSheet;
  if (bind) bind();
}
function closeSheet() { document.getElementById('sheet-wrap').classList.remove('open'); }

/* ── render root ── */
const TABS = [
  ['home', 'Home', `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`],
  ['plan', 'Plan', `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`],
  ['axis', 'AXIS', `<span class="axis-orb"></span>`],
  ['tasks', 'Tasks', `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`],
  ['more', 'More', `<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>`],
];

function render() {
  const wrap = document.getElementById('screen-wrap');
  const axisEl = document.getElementById('axis-screen');
  const tb = document.getElementById('tabbar');
  const ov = document.getElementById('overlay');

  if (!C.loaded) { wrap.innerHTML = `<div style="display:flex;height:80dvh;align-items:center;justify-content:center"><span class="hud-label">BOOTING…</span></div>`; return; }

  /* onboarding */
  if (C.ui.onboard) {
    tb.style.display = 'none'; axisEl.style.display = 'none'; wrap.style.display = 'block'; ov.classList.remove('open');
    wrap.innerHTML = renderOnboard(); bindOnboard(); return;
  }

  /* tab bar */
  tb.style.display = 'flex';
  tb.innerHTML = TABS.map(([id, lbl, svg]) =>
    `<button class="tab-btn${C.tab === id ? ' active' : ''}" data-tab="${id}">${svg}${lbl}</button>`).join('');
  tb.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => { C.tab = b.dataset.tab; localStorage.setItem('ctrl_tab', C.tab); wrap.scrollTop = 0; render(); });

  /* AXIS is a persistent screen (chat state survives) */
  if (C.tab === 'axis') {
    wrap.style.display = 'none'; axisEl.style.display = 'flex';
    AXIS.show();
  } else {
    axisEl.style.display = 'none'; wrap.style.display = 'block';
    wrap.innerHTML =
      C.tab === 'home' ? renderHome() :
      C.tab === 'plan' ? PLAN.render() :
      C.tab === 'tasks' ? renderTasks() :
      renderMore();
    bindCommon();
    if (C.tab === 'plan') PLAN.bind();
    if (C.tab === 'home') bindHome();
    if (C.tab === 'tasks') bindTasks();
    if (C.tab === 'more') bindMore();
  }

  /* overlays */
  if (C.ui.editTask !== null) { ov.classList.add('open'); ov.innerHTML = renderTaskForm(); bindTaskForm(); }
  else if (C.ui.editArc !== null) { ov.classList.add('open'); ov.innerHTML = renderArcForm(); bindArcForm(); }
  else { ov.classList.remove('open'); ov.innerHTML = ''; }
}

function bindCommon() {
  document.querySelectorAll('[data-goto]').forEach(b => b.onclick = () => { C.tab = b.dataset.goto; localStorage.setItem('ctrl_tab', C.tab); render(); });
}

/* ════════ ONBOARDING ════════ */
const ASSESS = [
  { key: 'name', q: "What's your name?", type: 'text', ph: 'Your name…' },
  { key: 'goal', q: "What's your #1 goal right now?", type: 'text', ph: 'Be specific…' },
];
function renderOnboard() {
  const o = C.ui.onboard;
  if (o.step === -1) return `
    <div class="au" style="margin-top:48px"><span class="hud-label">CTRL · Self-improvement OS</span></div>
    <div class="au d1 h-display" style="font-size:44px;margin:14px 0 18px">Take control</div>
    <p class="au d2 sub" style="line-height:1.9;margin-bottom:44px">Not another habit app.<br>A command center for your life —<br>with AXIS, your scheduling co-pilot.</p>
    <button id="ob-begin" class="btn btn-primary au d3" style="animation:glowPulse 2.5s infinite">Get started</button>
    <p class="au d4 xs dim" style="margin-top:14px;text-align:center">Two questions · 20 seconds</p>`;
  const q = ASSESS[o.step];
  return `
    <div style="display:flex;gap:4px;margin:16px 0 36px">${ASSESS.map((_, i) => `<div style="flex:1;height:2px;border-radius:2px;background:${i <= o.step ? 'var(--primary)' : 'var(--dim)'}"></div>`).join('')}</div>
    <div class="au hud-label" style="margin-bottom:10px">${o.step + 1} / ${ASSESS.length}</div>
    <div class="au h1" style="margin-bottom:30px">${q.q}</div>
    <input id="ob-input" class="input-line" type="text" placeholder="${q.ph}" value="${esc(o.val)}" style="margin-bottom:36px"/>
    <button id="ob-next" class="btn ${o.val.trim() ? 'btn-primary' : 'btn-ghost'}">Continue →</button>`;
}
function bindOnboard() {
  const o = C.ui.onboard;
  document.getElementById('ob-begin')?.addEventListener('click', () => { o.step = 0; render(); });
  const inp = document.getElementById('ob-input');
  if (inp) {
    inp.focus();
    inp.oninput = e => { o.val = e.target.value; const b = document.getElementById('ob-next'); if (b) b.className = 'btn ' + (o.val.trim() ? 'btn-primary' : 'btn-ghost'); };
    inp.onkeydown = e => { if (e.key === 'Enter' && o.val.trim()) advOnboard(o.val); };
  }
  document.getElementById('ob-next')?.addEventListener('click', () => { if (o.val.trim()) advOnboard(o.val); });
  document.querySelectorAll('.ob-choice').forEach(b => b.onclick = () => advOnboard(b.dataset.val));
}
async function advOnboard(val) {
  const o = C.ui.onboard;
  o.answers[ASSESS[o.step].key] = val.trim(); o.val = '';
  if (o.step < ASSESS.length - 1) { o.step++; render(); return; }
  try {
    const r = await api('/profile', 'PUT', o.answers);
    C.profile = r.profile;
  } catch { C.profile = { ...o.answers, xp: 0, streak: 1 }; }
  C.ui.onboard = null; cacheState(); render();
}

/* ════════ HOME ════════ */
function renderHome() {
  const p = C.profile || {};
  const { level, xpInL, xpPct, done, prog, tt } = getDerived();
  const activeArcs = C.arcs.filter(a => !a.completed);
  const ring = (pct, size, sw, color) => {
    const r = (size - sw) / 2, c = 2 * Math.PI * r;
    return `<div class="ring-wrap" style="width:${size}px;height:${size}px">
      <svg class="ring-svg" width="${size}" height="${size}" style="--ring-c:${c}">
        <circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}" fill="none"/>
        <circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${sw}" fill="none" stroke="${color}"
          stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/>
      </svg>
      <div class="ring-center"><span class="mono" style="font-size:${size / 4.2}px;font-weight:600">${Math.round(pct * 100)}<span style="font-size:${size / 7}px;color:var(--sub)">%</span></span></div>
    </div>`;
  };
  return `
  <div class="au hud-label amber" style="margin-bottom:6px">${esc(p.season || 'CTRL')}</div>
  <div class="au d1 h-display" style="margin-bottom:4px">${esc(p.name || 'Commander')}</div>
  ${p.identity || p.goal ? `<p class="au d1 sub small" style="font-style:italic;margin-bottom:18px">"${esc(p.identity || p.goal)}"</p>` : '<div style="margin-bottom:14px"></div>'}

  <div class="au d1" style="display:flex;gap:8px;margin-bottom:12px">
    <div class="stat-tile"><div class="v" style="color:var(--primary)">${level}</div><div class="l">Level</div></div>
    <div class="stat-tile"><div class="v" style="color:var(--accent)">${p.streak || 1}d</div><div class="l">Streak</div></div>
    <div class="stat-tile"><div class="v" style="color:var(--sub)">${xpInL}<span style="font-size:12px;color:var(--dim)">/150</span></div><div class="l">XP</div></div>
  </div>

  <div class="au d2 card tick" style="display:flex;gap:16px;align-items:center;margin-bottom:12px">
    ${ring(prog, 84, 7, prog === 1 ? 'var(--ok)' : 'var(--primary)')}
    <div style="flex:1;min-width:0">
      <div class="hud-label" style="margin-bottom:4px">Today · ${DF[TODAY]}</div>
      <div style="font-size:15px;font-weight:600">${done}/${tt.length} tasks complete</div>
      <div class="bar-track" style="margin-top:8px"><div class="bar-fill" style="width:${xpPct * 100}%"></div></div>
      <div class="xs dim" style="margin-top:4px">${Math.round(xpPct * 100)}% to Level ${level + 1}</div>
    </div>
  </div>

  <div class="au d3 card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span class="hud-label sub">Today's tasks</span>
      <button class="press hud-label" data-goto="plan">Timetable →</button>
    </div>
    ${tt.length === 0
      ? `<p class="small dim" style="text-align:center;padding:16px 0">No tasks today — <button class="press" data-goto="tasks" style="color:var(--primary);text-decoration:underline">add some →</button></p>`
      : tt.map(renderTodayTask).join('')}
  </div>

  ${activeArcs.length ? `
  <div class="au d4 card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span class="hud-label sub">Active arcs</span>
      <button class="press hud-label" data-goto="more">View all →</button>
    </div>
    ${activeArcs.slice(0, 3).map(arc => {
      const pct = arcProgress(arc), col = arcColor(arc);
      return `<div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <span class="small">${esc(arc.name)}</span><span class="mono small" style="color:${col}">${pct}%</span>
        </div>
        <div class="bar-track" style="height:3px"><div class="bar-fill" style="width:${pct}%;background:${col}"></div></div>
        ${arc.deadline ? `<div class="xs dim" style="margin-top:3px">Due ${esc(arc.deadline)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>` : `
  <div class="au d4 empty" style="margin-bottom:12px">
    <p style="font-size:20px;margin-bottom:8px">◎</p>
    <p class="small" style="margin-bottom:4px">No active arcs</p>
    <p class="xs sub" style="margin-bottom:14px">Set your first goal to start making real progress.</p>
    <button class="press btn btn-amber" data-goto="more" style="width:auto;margin:0 auto;padding:11px 22px">+ New arc</button>
  </div>`}

  ${C.offline ? `<p class="xs dim" style="text-align:center;margin-top:4px">⚠ offline — showing cached data</p>` : ''}`;
}
function renderTodayTask(t) {
  const dn = doneToday(t);
  const arc = C.arcs.find(a => a.id === t.arc_id);
  const col = arc ? arcColor(arc) : 'var(--dim)';
  if (t.type === 'count') {
    const cnt = getCount(t), tgt = t.target || 1, pct = Math.min(cnt / tgt, 1);
    return `<div style="margin-top:13px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="min-width:0;flex:1;padding-right:8px">
          <p class="small" style="color:${dn ? 'var(--sub)' : 'var(--text)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</p>
          <p class="xs" style="color:${col};margin-top:1px">${cnt}/${tgt} ${esc(t.unit || 'times')}${arc ? ` · ${esc(arc.name)}` : ''}</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button class="press ctr-btn ctr-minus" data-id="${t.id}" style="border-color:${cnt > 0 ? col : 'var(--border)'};color:${cnt > 0 ? col : 'var(--sub)'}">−</button>
          <span class="ctr-val" style="color:${dn ? col : 'var(--text)'}">${cnt}</span>
          <button class="press ctr-btn ctr-plus" data-id="${t.id}" style="border-color:${dn ? 'var(--dim)' : 'var(--primary)'};color:${dn ? 'var(--dim)' : 'var(--primary)'}" ${dn ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div class="bar-track" style="height:3px"><div class="bar-fill" style="width:${pct * 100}%;background:${dn ? col : 'var(--primary)'}"></div></div>
    </div>`;
  }
  return `<div class="trow">
    <button class="press checkbox htg${dn ? ' on' : ''}" data-id="${t.id}" style="--pc:${col}">
      ${dn ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#05070A" stroke-width="3.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
    </button>
    <div style="flex:1;min-width:0">
      <p class="small" style="color:${dn ? 'var(--sub)' : 'var(--text)'};text-decoration:${dn ? 'line-through' : 'none'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</p>
      <p class="xs" style="color:${col};margin-top:2px">${fmtM(t.minutes)}${t.kind === 'oneoff' ? ' · one-off' : ''}${arc ? ` · ${esc(arc.name)}` : ''}</p>
    </div>
    ${arc ? `<div style="width:6px;height:6px;border-radius:50%;background:${col};flex-shrink:0"></div>` : ''}
  </div>`;
}
function bindHome() { bindTaskToggles(); }

function bindTaskToggles() {
  document.querySelectorAll('.htg').forEach(b => b.onclick = async () => {
    const t = C.tasks.find(x => x.id === b.dataset.id); if (!t) return;
    const now = doneToday(t) ? 0 : 1;
    C.comp[`${t.id}_${TSTR}`] = now; cacheState(); render();
    try { await api(`/tasks/${t.id}/complete`, 'POST', { date: TSTR, count: now }); } catch { toast('⚠ offline — will not sync'); }
  });
  const bump = async (id, d) => {
    const t = C.tasks.find(x => x.id === id); if (!t) return;
    const v = Math.max(0, Math.min(getCount(t) + d, t.target || 99));
    C.comp[`${t.id}_${TSTR}`] = v; cacheState(); render();
    try { await api(`/tasks/${t.id}/complete`, 'POST', { date: TSTR, count: v }); } catch { toast('⚠ offline — will not sync'); }
  };
  document.querySelectorAll('.ctr-plus').forEach(b => b.onclick = () => bump(b.dataset.id, 1));
  document.querySelectorAll('.ctr-minus').forEach(b => b.onclick = () => bump(b.dataset.id, -1));
}

/* ════════ TASKS ════════ */
function renderTasks() {
  const cp = C.ui.classifyPending;
  return `
  <div class="au" style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px">
    <div><div class="hud-label" style="margin-bottom:6px">Manage</div><div class="h-display">Tasks</div></div>
    <button id="add-task-btn" class="press fab"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#04121A" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
  </div>
  <p class="au small sub" style="margin-bottom:16px">Recurring habits and one-off tasks. AXIS schedules them.</p>

  <div class="au d1 card lit" style="margin-bottom:16px">
    <div class="hud-label" style="margin-bottom:10px">⚡ Quick add — just type it</div>
    <div style="display:flex;gap:8px">
      <input id="nl-input" class="input-line" type="text" placeholder='e.g. "dentist thursday 4pm" or "meditate daily"' style="flex:1;font-size:14px"/>
      <button id="nl-go" class="press icon-btn" style="border-color:rgba(56,225,255,.4);color:var(--primary)">${C.ui.classifyBusy ? '…' : '→'}</button>
    </div>
    ${cp ? renderClassifyCard(cp) : ''}
  </div>

  ${C.tasks.length === 0
    ? `<div class="au empty"><p style="font-size:24px;margin-bottom:8px">◎</p><p class="small" style="margin-bottom:4px">No tasks yet</p><p class="xs sub">Type one above or hit +.</p></div>`
    : C.tasks.map((t, i) => renderTaskCard(t, i)).join('')}`;
}
function renderClassifyCard(cp) {
  const days = (cp.days || []).map(d => DF[d]).join(' ');
  const dates = (cp.dates || []).join(', ');
  return `<div class="action-card" style="margin-top:14px">
    <div class="ac-title">AXIS read that as</div>
    <div class="ac-kv"><span class="k">Task</span><span class="v">${esc(cp.name)}</span></div>
    <div class="ac-kv"><span class="k">Kind</span><span class="v">${cp.kind === 'oneoff' ? `One-off · ${esc(dates)}` : `Recurring · ${esc(days) || 'daily'}`}</span></div>
    <div class="ac-kv"><span class="k">Type</span><span class="v">${cp.type === 'count' ? `Counter · ${cp.target} ${esc(cp.unit)}` : `Checkbox · ${fmtM(cp.minutes)}`}</span></div>
    ${cp.preferred_window ? `<div class="ac-kv"><span class="k">Window</span><span class="v">${esc(fmtWin(cp.preferred_window))}</span></div>` : ''}
    <div class="ac-kv"><span class="k">Priority</span><span class="v">P${cp.priority}</span></div>
    <div class="ac-row">
      <button id="cls-save" class="press ac-btn cyan">✓ Save</button>
      <button id="cls-edit" class="press ac-btn">Edit first</button>
      <button id="cls-cancel" class="press ac-btn danger">✕</button>
    </div>
  </div>`;
}
function renderTaskCard(t, i) {
  const arc = C.arcs.find(a => a.id === t.arc_id);
  const col = arc ? arcColor(arc) : 'var(--dim)';
  const isToday = activeToday(t);
  const when = t.kind === 'oneoff'
    ? (t.dates || []).join(', ') || 'no date'
    : (t.days || []).length === 7 ? 'Every day' : (t.days || []).slice().sort((a, b) => a - b).map(d => DS[d]).join(' ');
  const typeTag = t.type === 'count'
    ? `<span class="xs" style="padding:2px 9px;border-radius:100px;background:rgba(129,140,248,.14);color:#818CF8">Counter · ${t.target} ${esc(t.unit)}</span>`
    : `<span class="xs" style="padding:2px 9px;border-radius:100px;background:rgba(52,211,153,.14);color:#34D399">${fmtM(t.minutes)}</span>`;
  const kindTag = t.kind === 'oneoff'
    ? `<span class="xs" style="padding:2px 9px;border-radius:100px;background:var(--accent-dim);color:var(--accent)">One-off</span>` : '';
  return `<div class="au d${Math.min(i + 1, 5)} card" style="margin-bottom:10px;border-left:3px solid ${col}">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
      <div style="flex:1;min-width:0;padding-right:10px">
        <p style="font-size:15px;font-weight:500;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.name)}</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${kindTag}${typeTag}
          <span class="xs" style="color:${isToday ? 'var(--primary)' : 'var(--dim)'}">${isToday ? '● Today' : '○'}</span>
          <span class="xs dim mono">${esc(when)}</span>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="press icon-btn et" data-id="${t.id}" style="width:32px;height:32px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="press icon-btn danger dt" data-id="${t.id}" style="width:32px;height:32px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      ${arc ? `<span class="xs" style="padding:2px 10px;border-radius:100px;border:1px solid ${col};color:${col}">${esc(arc.name)}</span><span class="xs dim">+${t.arc_pct || 0}%/completion</span>`
            : `<span class="xs dim">Not linked to an Arc</span>`}
      ${t.preferred_window ? `<span class="xs mono" style="color:var(--sub);margin-left:auto">${esc(fmtWin(t.preferred_window))}</span>` : ''}
    </div>
  </div>`;
}
function blankTaskForm() { return { name: '', kind: 'recurring', type: 'check', minutes: 30, target: 1, unit: 'times', days: [], dates: [], arc_id: null, arc_pct: 0, priority: 3, preferred_window: null }; }
function bindTasks() {
  const openNew = () => { C.ui.editTask = 'new'; C.ui.taskForm = blankTaskForm(); render(); setTimeout(() => document.getElementById('tf-name')?.focus(), 80); };
  document.getElementById('add-task-btn')?.addEventListener('click', openNew);
  document.querySelectorAll('.et').forEach(b => b.onclick = () => {
    const t = C.tasks.find(x => x.id === b.dataset.id); if (!t) return;
    C.ui.editTask = t.id;
    C.ui.taskForm = { name: t.name, kind: t.kind, type: t.type, minutes: t.minutes, target: t.target, unit: t.unit, days: [...(t.days || [])], dates: [...(t.dates || [])], arc_id: t.arc_id, arc_pct: t.arc_pct, priority: t.priority || 3, preferred_window: t.preferred_window };
    render();
  });
  document.querySelectorAll('.dt').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this task?')) return;
    C.tasks = C.tasks.filter(t => t.id !== b.dataset.id); cacheState(); render();
    try { await api(`/tasks/${b.dataset.id}`, 'DELETE'); } catch { toast('⚠ offline'); }
  });

  /* NL quick add */
  const go = async () => {
    const inp = document.getElementById('nl-input');
    const text = inp?.value.trim(); if (!text || C.ui.classifyBusy) return;
    C.ui.classifyBusy = true; render();
    try {
      const r = await api('/tasks/classify', 'POST', { text });
      C.ui.classifyPending = { ...r.classified, _raw: text };
    } catch (e) { toast(e.message || 'Classification failed'); }
    C.ui.classifyBusy = false; render();
  };
  document.getElementById('nl-go')?.addEventListener('click', go);
  document.getElementById('nl-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });

  const cp = C.ui.classifyPending;
  if (cp) {
    document.getElementById('cls-save')?.addEventListener('click', async () => {
      try {
        const r = await api('/tasks', 'POST', cp);
        C.tasks.push(r.task); C.ui.classifyPending = null; cacheState(); render(); toast('Task saved ✓');
      } catch (e) { toast(e.message); }
    });
    document.getElementById('cls-edit')?.addEventListener('click', () => {
      C.ui.editTask = 'new'; C.ui.taskForm = { ...blankTaskForm(), ...cp }; C.ui.classifyPending = null; render();
    });
    document.getElementById('cls-cancel')?.addEventListener('click', () => { C.ui.classifyPending = null; render(); });
  }
}

/* ── task form (overlay) ── */
function renderTaskForm() {
  const isNew = C.ui.editTask === 'new';
  const f = C.ui.taskForm;
  const isCount = f.type === 'count';
  const isOneoff = f.kind === 'oneoff';
  const linkedArc = C.arcs.find(a => a.id === f.arc_id);
  const arcCol = linkedArc ? arcColor(linkedArc) : 'var(--dim)';
  const activeArcs = C.arcs.filter(a => !a.completed);
  return `
  <div class="ov-head">
    <button id="tf-back" class="press icon-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
    <span class="h2">${isNew ? 'New task' : 'Edit task'}</span>
    <button id="tf-save" class="press btn btn-primary" style="width:auto;margin-left:auto;padding:10px 22px">Save</button>
  </div>
  <div class="ov-body">
    <div class="field"><span class="hud-label">Task name</span>
      <input id="tf-name" class="input-line" type="text" placeholder="e.g. Gym session" value="${esc(f.name)}"/></div>

    <div class="field"><span class="hud-label">Kind</span>
      <div style="display:flex;gap:8px">
        <button class="press chip${!isOneoff ? ' on' : ''}" id="kind-rec" style="flex:1;padding:12px">↻ Recurring habit</button>
        <button class="press chip${isOneoff ? ' on amber' : ''}" id="kind-one" style="flex:1;padding:12px">◈ One-off</button>
      </div></div>

    ${isOneoff ? `
    <div class="field"><span class="hud-label">Date(s)</span>
      <input id="tf-date" class="input-line mono" type="date" value="${esc((f.dates || [])[0] || TSTR)}" style="color-scheme:dark"/>
      <p class="xs dim" style="margin-top:8px">One-off tasks are scheduled on this date only.</p></div>`
    : `
    <div class="field">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <span class="hud-label" style="margin:0">Active days</span>
        <span class="xs dim">${f.days.length === 7 ? 'Every day' : f.days.length === 0 ? 'Select days' : f.days.length + '× / week'}</span>
      </div>
      <div style="display:flex;gap:6px;justify-content:space-between">${DS.map((d, i) => `<button class="press day-btn${f.days.includes(i) ? ' on' : ''}" data-day="${i}">${d}</button>`).join('')}</div>
      <button id="tf-everyday" class="press xs sub" style="margin-top:10px;letter-spacing:1px">${f.days.length === 7 ? '✓ Every day' : 'Set every day'}</button>
    </div>`}

    <div class="field"><span class="hud-label">Type</span>
      <div style="display:flex;gap:8px">
        <button class="press chip${!isCount ? ' on' : ''}" id="type-check" style="flex:1;padding:12px">☑ Checkbox</button>
        <button class="press chip${isCount ? ' on' : ''}" id="type-count" style="flex:1;padding:12px"># Counter</button>
      </div></div>

    ${isCount ? `
    <div class="field"><span class="hud-label">Daily target</span>
      <div style="display:flex;gap:14px;align-items:flex-end">
        <div style="display:flex;align-items:center;gap:8px">
          <button class="press ctr-btn" id="tgt-minus">−</button>
          <input type="number" id="tgt-val" class="mono" value="${f.target || 1}" min="1" max="999" style="width:56px;text-align:center;font-size:20px;border-bottom:1px solid var(--border);padding:4px 0;color:var(--primary)"/>
          <button class="press ctr-btn" id="tgt-plus">+</button>
        </div>
        <input id="tf-unit" class="input-line" type="text" value="${esc(f.unit || 'times')}" placeholder="glasses, pages…" style="flex:1;font-size:15px"/>
      </div></div>`
    : `
    <div class="field"><span class="hud-label">Time per session</span>
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:12px">
        <button class="press ctr-btn" id="min-minus" style="width:42px;height:42px">−</button>
        <div style="flex:1;text-align:center"><span id="min-disp" class="mono" style="font-size:34px;font-weight:600;color:var(--primary)">${fmtM(f.minutes)}</span></div>
        <button class="press ctr-btn" id="min-plus" style="width:42px;height:42px">+</button>
      </div>
      <div class="chip-row" id="min-presets">${[15, 30, 45, 60, 90, 120].map(v => `<button class="press chip${f.minutes === v ? ' on' : ''}" data-min="${v}">${fmtM(v)}</button>`).join('')}</div>
    </div>`}

    <div class="field"><span class="hud-label">Priority</span>
      <div class="chip-row">${[1, 2, 3, 4, 5].map(p => `<button class="press chip tf-prio${f.priority === p ? ' on' : ''}" data-p="${p}">P${p}${p === 1 ? ' · urgent' : p === 5 ? ' · whenever' : ''}</button>`).join('')}</div></div>

    <div class="field"><span class="hud-label">Preferred window</span>
      <div class="chip-row">${['none', 'morning', 'afternoon', 'evening'].map(w => `<button class="press chip tf-win${(f.preferred_window || 'none') === w ? ' on' : ''}" data-w="${w}">${w}</button>`).join('')}</div>
      <p class="xs dim" style="margin-top:8px">AXIS packs this task inside its window when possible.</p></div>

    <div class="field"><span class="hud-label">Link to Arc</span>
      ${activeArcs.length === 0
        ? `<div class="empty" style="padding:14px"><p class="xs dim">No active arcs. Create one in More → Arcs.</p></div>`
        : `<div style="display:flex;flex-direction:column;gap:8px">
            <button class="press chip tf-arc${!f.arc_id ? ' on' : ''}" data-arc="" style="text-align:left;padding:11px 14px">None — unlinked</button>
            ${activeArcs.map(a => {
              const col = arcColor(a), sel = f.arc_id === a.id;
              return `<button class="press chip tf-arc" data-arc="${a.id}" style="text-align:left;padding:11px 14px;${sel ? `border-color:${col};color:${col};background:${col}14` : ''}">
                <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${col};margin-right:8px"></span>${esc(a.name)}</button>`;
            }).join('')}
          </div>
          ${f.arc_id ? `
          <div style="margin-top:14px">
            <div style="display:flex;justify-content:space-between;margin-bottom:8px">
              <span class="xs sub">% added to arc per completion</span><span class="mono small" id="pct-val" style="color:${arcCol}">${f.arc_pct || 0}%</span>
            </div>
            <input type="range" id="pct-slider" min="0" max="100" step="5" value="${f.arc_pct || 0}"/>
          </div>` : ''}`}
    </div>
  </div>`;
}
function bindTaskForm() {
  const f = C.ui.taskForm;
  document.getElementById('tf-back').onclick = () => { C.ui.editTask = null; render(); };
  document.getElementById('tf-name').oninput = e => f.name = e.target.value;
  document.getElementById('kind-rec')?.addEventListener('click', () => { f.kind = 'recurring'; render(); });
  document.getElementById('kind-one')?.addEventListener('click', () => { f.kind = 'oneoff'; if (!f.dates?.length) f.dates = [TSTR]; render(); });
  document.getElementById('tf-date')?.addEventListener('change', e => { f.dates = [e.target.value]; });
  document.getElementById('type-check')?.addEventListener('click', () => { f.type = 'check'; render(); });
  document.getElementById('type-count')?.addEventListener('click', () => { f.type = 'count'; render(); });
  document.querySelectorAll('.day-btn[data-day]').forEach(b => b.onclick = () => {
    const d = +b.dataset.day, i = f.days.indexOf(d);
    i >= 0 ? f.days.splice(i, 1) : f.days.push(d); render();
  });
  document.getElementById('tf-everyday')?.addEventListener('click', () => { f.days = f.days.length === 7 ? [] : [0, 1, 2, 3, 4, 5, 6]; render(); });
  const setMin = v => { f.minutes = Math.max(5, Math.min(480, v)); document.getElementById('min-disp').textContent = fmtM(f.minutes); document.querySelectorAll('#min-presets .chip').forEach(c => c.classList.toggle('on', +c.dataset.min === f.minutes)); };
  document.getElementById('min-minus')?.addEventListener('click', () => setMin(f.minutes - 5));
  document.getElementById('min-plus')?.addEventListener('click', () => setMin(f.minutes + 5));
  document.querySelectorAll('#min-presets .chip').forEach(b => b.onclick = () => setMin(+b.dataset.min));
  const setTgt = v => { f.target = Math.max(1, Math.min(999, v)); const el = document.getElementById('tgt-val'); if (el) el.value = f.target; };
  document.getElementById('tgt-minus')?.addEventListener('click', () => setTgt((f.target || 1) - 1));
  document.getElementById('tgt-plus')?.addEventListener('click', () => setTgt((f.target || 1) + 1));
  document.getElementById('tgt-val')?.addEventListener('input', e => setTgt(+e.target.value || 1));
  document.getElementById('tf-unit')?.addEventListener('input', e => f.unit = e.target.value);
  document.querySelectorAll('.tf-prio').forEach(b => b.onclick = () => { f.priority = +b.dataset.p; render(); });
  document.querySelectorAll('.tf-win').forEach(b => b.onclick = () => { f.preferred_window = b.dataset.w === 'none' ? null : b.dataset.w; render(); });
  document.querySelectorAll('.tf-arc').forEach(b => b.onclick = () => { f.arc_id = b.dataset.arc || null; f.arc_pct = 0; render(); });
  document.getElementById('pct-slider')?.addEventListener('input', e => { f.arc_pct = +e.target.value; document.getElementById('pct-val').textContent = e.target.value + '%'; });

  document.getElementById('tf-save').onclick = async () => {
    f.name = (document.getElementById('tf-name')?.value || f.name).trim();
    if (!f.name) return toast('Enter a task name');
    if (f.kind === 'recurring' && f.days.length === 0) return toast('Select at least one day');
    if (f.kind === 'oneoff') { const d = document.getElementById('tf-date')?.value; if (d) f.dates = [d]; }
    if (f.type === 'count') f.unit = (document.getElementById('tf-unit')?.value || f.unit || 'times').trim() || 'times';
    try {
      if (C.ui.editTask === 'new') {
        const r = await api('/tasks', 'POST', f);
        C.tasks.push(r.task);
      } else {
        const r = await api(`/tasks/${C.ui.editTask}`, 'PUT', f);
        const i = C.tasks.findIndex(t => t.id === C.ui.editTask);
        if (i >= 0) C.tasks[i] = r.task;
      }
      C.ui.editTask = null; cacheState(); render();
    } catch (e) { toast(e.message); }
  };
}

/* ════════ MORE (Arcs / Wins / Loops / Settings) ════════ */
function renderMore() {
  const sec = C.ui.moreSec;
  return `
  <div class="au" style="margin-bottom:14px"><div class="hud-label" style="margin-bottom:6px">System</div><div class="h-display">More</div></div>
  <div class="au chip-row scroll" style="margin-bottom:18px">
    ${[['arcs', 'Arcs'], ['wins', 'Wins'], ['loops', 'Loops'], ['settings', 'Settings']].map(([id, l]) =>
      `<button class="press chip${sec === id ? ' on' : ''}" data-sec="${id}">${l}</button>`).join('')}
  </div>
  ${sec === 'arcs' ? renderArcsSec() : sec === 'wins' ? renderWinsSec() : sec === 'loops' ? renderLoopsSec() : renderSettingsSec()}`;
}

/* — arcs — */
function renderArcsSec() {
  const active = C.arcs.filter(a => !a.completed);
  const done = C.arcs.filter(a => a.completed);
  return `
  <div class="au" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
    <span class="small sub">One-time goals. Tasks push them forward.</span>
    <button id="add-arc" class="press fab" style="width:34px;height:34px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#04121A" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
  </div>
  ${active.length === 0 ? `<div class="au empty"><p class="small" style="margin-bottom:4px">No active arcs</p><p class="xs sub">Create a goal. Something real.</p></div>`
  : active.map((arc, i) => {
    const pct = arcProgress(arc), col = arcColor(arc);
    const linked = C.tasks.filter(t => t.arc_id === arc.id).length;
    return `<div class="au d${Math.min(i + 1, 5)} card" style="margin-bottom:12px;border-left:3px solid ${col}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div style="flex:1;min-width:0;padding-right:10px">
          <p style="font-size:15px;font-weight:500;margin-bottom:3px">${esc(arc.name)}</p>
          ${arc.deadline ? `<p class="xs dim mono">Due ${esc(arc.deadline)}</p>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <span class="mono" style="font-size:26px;font-weight:600;color:${col}">${pct}<span style="font-size:13px;color:var(--sub)">%</span></span>
          <div style="display:flex;gap:6px">
            <button class="press icon-btn ea" data-id="${arc.id}" style="width:28px;height:28px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
            <button class="press icon-btn danger da" data-id="${arc.id}" style="width:28px;height:28px"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
          </div>
        </div>
      </div>
      <div class="bar-track" style="height:5px;margin-bottom:8px"><div class="bar-fill" style="width:${pct}%;background:${col}"></div></div>
      <div style="display:flex;justify-content:space-between">
        <span class="xs dim">${linked} task${linked !== 1 ? 's' : ''} linked</span>
        ${pct >= 100 ? `<button class="press xs ca" data-id="${arc.id}" style="padding:3px 12px;border-radius:100px;background:rgba(52,211,153,.14);color:var(--ok);border:1px solid var(--ok)">✓ Mark complete</button>`
                     : `<span class="xs dim">${100 - pct}% remaining</span>`}
      </div>
    </div>`;
  }).join('')}
  ${done.length ? `<div class="hud-label sub" style="margin:16px 0 10px">Completed</div>` + done.map(a => `
    <div class="card" style="margin-bottom:8px;opacity:.5"><div style="display:flex;justify-content:space-between"><span class="small sub" style="text-decoration:line-through">${esc(a.name)}</span><span class="xs" style="color:var(--ok)">✓ Done</span></div></div>`).join('') : ''}`;
}

/* — wins — */
function renderWinsSec() {
  return `
  <div class="au card" style="margin-bottom:14px">
    <textarea id="win-input" rows="2" placeholder="Log a win…" style="width:100%;border-bottom:1px solid var(--border);padding:8px 0;margin-bottom:12px;font-size:16px"></textarea>
    ${C.arcs.length ? `<div class="chip-row" style="margin-bottom:12px" id="win-arcs">
      <button class="press chip on" data-arc="">General</button>
      ${C.arcs.filter(a => !a.completed).map(a => `<button class="press chip" data-arc="${a.id}">${esc(a.name)}</button>`).join('')}
    </div>` : ''}
    <button id="log-win" class="btn btn-amber">+ Log win (+25 XP)</button>
  </div>
  ${C.wins.length === 0 ? `<div class="empty"><p class="xs dim">No wins logged yet. Motivation fades — proof lasts.</p></div>`
  : C.wins.map(w => {
    const arc = C.arcs.find(a => a.id === w.arc_id);
    const col = arc ? arcColor(arc) : 'var(--accent)';
    return `<div class="card" style="display:flex;gap:12px;border-left:3px solid ${col};margin-bottom:8px">
      <div style="flex:1;min-width:0">
        <p class="small" style="line-height:1.5">${esc(w.text)}</p>
        <div style="display:flex;gap:8px;margin-top:5px">
          ${arc ? `<span class="xs" style="color:${col};letter-spacing:1px;text-transform:uppercase">${esc(arc.name)}</span><span class="xs dim">·</span>` : ''}
          <span class="xs dim mono">${esc(w.date || '')}</span>
        </div>
      </div>
    </div>`;
  }).join('')}`;
}

/* — loops — */
const LOOP_P = { burning: { l: 'Burning', i: '🔥', c: '#F87171' }, brewing: { l: 'Brewing', i: '🌀', c: '#A78BFA' }, dormant: { l: 'Dormant', i: '😴', c: 'var(--sub)' } };
const LOOP_C = { done: { l: 'Done', i: '✅' }, delegated: { l: 'Delegated', i: '🔁' }, dropped: { l: 'Dropped', i: '❌' } };
function renderLoopsSec() {
  const open = C.loops.filter(l => !l.closed);
  const closed = C.loops.filter(l => l.closed);
  return `
  <p class="au small sub" style="margin-bottom:14px">Open mental loops draining energy. Close them.</p>
  <div class="au card" style="margin-bottom:14px">
    <input id="loop-input" class="input-line" type="text" placeholder="What's the open loop?" style="margin-bottom:14px"/>
    <div style="display:flex;gap:6px;margin-bottom:14px" id="loop-prio">
      ${Object.entries(LOOP_P).map(([k, v], i) => `<button class="press chip lp${i === 0 ? ' on' : ''}" data-p="${k}" style="flex:1;text-align:center">${v.i} ${v.l}</button>`).join('')}
    </div>
    <button id="loop-save" class="btn btn-ghost cyan">+ Add loop</button>
  </div>
  ${open.length === 0 ? `<div class="empty" style="margin-bottom:12px"><p style="font-size:20px;margin-bottom:6px">🧘</p><p class="small">No open loops. Clean mind.</p></div>`
  : Object.keys(LOOP_P).map(pk => {
    const items = open.filter(l => l.priority === pk); if (!items.length) return '';
    const pv = LOOP_P[pk];
    return `<div style="margin-bottom:16px">
      <div class="hud-label sub" style="margin-bottom:8px;color:${pv.c}">${pv.i} ${pv.l} (${items.length})</div>
      ${items.map(l => `
      <div class="card" style="margin-bottom:8px;border-left:3px solid ${pv.c}">
        <div style="display:flex;gap:10px">
          <p class="small" style="flex:1;line-height:1.5">${esc(l.text)}</p>
          <button class="press icon-btn dl" data-id="${l.id}" style="width:28px;height:28px;color:var(--dim)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px">
          ${Object.entries(LOOP_C).map(([ck, cv]) => `<button class="press chip cl" data-id="${l.id}" data-how="${ck}" style="flex:1;text-align:center;font-size:11px">${cv.i} ${cv.l}</button>`).join('')}
        </div>
      </div>`).join('')}
    </div>`;
  }).join('')}
  ${closed.length ? `
  <button id="toggle-closed" class="press" style="width:100%;display:flex;justify-content:space-between;padding:12px 0;border-top:1px solid var(--border)">
    <span class="hud-label sub">Closed (${closed.length})</span><span class="dim">${C.ui.loopsShowClosed ? '▲' : '▼'}</span>
  </button>
  ${C.ui.loopsShowClosed ? closed.map(l => {
    const cv = LOOP_C[l.how] || LOOP_C.done;
    return `<div class="card" style="margin-bottom:8px;opacity:.5"><p class="small sub" style="text-decoration:line-through">${esc(l.text)}</p><p class="xs dim" style="margin-top:4px">${cv.i} ${cv.l} · ${esc(l.closed_date || '')}</p></div>`;
  }).join('') : ''}` : ''}`;
}

/* — settings — */
function renderSettingsSec() {
  const dw = C.prefs.day_window || '08:00-24:00';
  let [dwS, dwE] = dw.split('-');
  if (dwE === '24:00') dwE = '00:00'; // native time input can't show 24:00
  return `
  <div class="au card" style="margin-bottom:12px">
    <div class="hud-label" style="margin-bottom:14px">Scheduling</div>
    <div class="field" style="margin-bottom:18px">
      <span class="xs sub" style="display:block;margin-bottom:8px">Day window (awake hours — AXIS only schedules inside this)</span>
      <div style="display:flex;gap:10px;align-items:center">
        <input id="dw-start" type="time" class="input-line mono" value="${esc(dwS)}" style="text-align:center;color-scheme:dark"/>
        <span class="dim">→</span>
        <input id="dw-end" type="time" class="input-line mono" value="${esc(dwE)}" style="text-align:center;color-scheme:dark"/>
      </div>
      <p class="xs dim" style="margin-top:6px">Set the end to 12:00 AM if you sleep at midnight.</p>
    </div>
    <div class="field" style="margin-bottom:18px">
      <span class="xs sub" style="display:block;margin-bottom:8px">Briefings (push + chat)</span>
      <div style="display:flex;gap:10px;align-items:center">
        <input id="bf-m" type="time" class="input-line mono" value="${esc(C.prefs.briefing_morning || '08:00')}" style="text-align:center;color-scheme:dark"/>
        <span class="dim">/</span>
        <input id="bf-e" type="time" class="input-line mono" value="${esc(C.prefs.briefing_evening || '21:00')}" style="text-align:center;color-scheme:dark"/>
      </div>
      <p class="xs dim" style="margin-top:6px">Morning / evening · restart server to apply new times</p>
    </div>
    <div class="field" style="margin-bottom:18px">
      <span class="xs sub" style="display:block;margin-bottom:8px">Rules for AXIS (soft preferences — it reads these every chat)</span>
      <textarea id="pref-rules" rows="3" placeholder="e.g. Office 11:30am–8pm on weekdays — schedule work tasks there.&#10;No deep work after 10pm." style="width:100%;border:1px solid var(--border);border-radius:9px;padding:10px;font-size:14px;line-height:1.5">${esc(C.prefs.rules || '')}</textarea>
    </div>
    <button id="prefs-save" class="btn btn-ghost cyan">Save preferences</button>
  </div>

  <div class="au d1 card" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div class="hud-label" style="margin:0">Fixed blocks</div>
      <button id="add-block" class="press icon-btn" style="border-color:rgba(56,225,255,.4);color:var(--primary)">+</button>
    </div>
    <p class="xs sub" style="margin-bottom:12px">Immovable commitments — gym, office, classes. AXIS schedules around them.</p>
    ${C.blocks.length === 0 ? `<p class="xs dim" style="text-align:center;padding:10px 0">None yet — add your gym/office hours.</p>`
    : C.blocks.map(b => `
      <div class="trow">
        <div style="flex:1;min-width:0">
          <p class="small" style="font-weight:500">${esc(b.label)}</p>
          <p class="xs dim mono" style="margin-top:2px">${(b.days || []).length === 7 ? 'Every day' : (b.days || []).map(d => DF[d]).join(' ')} · ${fmtT(b.start)}–${fmtT(b.end)}</p>
        </div>
        <button class="press icon-btn eb" data-id="${b.id}" style="width:30px;height:30px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
        <button class="press icon-btn danger db" data-id="${b.id}" style="width:30px;height:30px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>`).join('')}
  </div>

  <div class="au d2 card" style="margin-bottom:12px">
    <div class="hud-label" style="margin-bottom:12px">Notifications</div>
    <p class="xs sub" style="margin-bottom:12px" id="push-status">Enable push to get AXIS briefings on your phone.</p>
    <button id="push-enable" class="btn btn-ghost cyan">Enable notifications</button>
    <p class="xs dim" style="margin-top:10px">iPhone: install to Home Screen first (Share → Add to Home Screen) — iOS only allows push for installed web apps.</p>
  </div>

  <div class="au d3 card">
    <div class="hud-label" style="margin-bottom:12px">System</div>
    <div class="ac-kv"><span class="k">Server</span><span class="v" style="color:${C.offline ? 'var(--danger)' : 'var(--ok)'}">${C.offline ? 'OFFLINE' : 'CONNECTED'}</span></div>
    <div class="ac-kv"><span class="k">Owner token</span><span class="v">${API.token ? 'set' : 'not set'}</span></div>
    <button id="set-token" class="press xs sub" style="margin-top:10px;letter-spacing:1px;text-decoration:underline">Set owner token</button>
  </div>`;
}

function bindMore() {
  document.querySelectorAll('[data-sec]').forEach(b => b.onclick = () => { C.ui.moreSec = b.dataset.sec; localStorage.setItem('ctrl_more', b.dataset.sec); render(); });

  /* arcs */
  document.getElementById('add-arc')?.addEventListener('click', () => { C.ui.editArc = 'new'; C.ui.arcForm = { name: '', deadline: '', color: 'orange' }; render(); });
  document.querySelectorAll('.ea').forEach(b => b.onclick = () => {
    const a = C.arcs.find(x => x.id === b.dataset.id); if (!a) return;
    C.ui.editArc = a.id; C.ui.arcForm = { name: a.name, deadline: a.deadline || '', color: a.color || 'orange' }; render();
  });
  document.querySelectorAll('.da').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this arc?')) return;
    C.arcs = C.arcs.filter(a => a.id !== b.dataset.id);
    C.tasks.forEach(t => { if (t.arc_id === b.dataset.id) { t.arc_id = null; t.arc_pct = 0; } });
    cacheState(); render();
    try { await api(`/arcs/${b.dataset.id}`, 'DELETE'); } catch { toast('⚠ offline'); }
  });
  document.querySelectorAll('.ca').forEach(b => b.onclick = async () => {
    const a = C.arcs.find(x => x.id === b.dataset.id); if (!a) return;
    a.completed = true; if (C.profile) C.profile.xp = (C.profile.xp || 0) + 100;
    cacheState(); render(); toast('Arc complete — +100 XP');
    try { await api(`/arcs/${a.id}`, 'PUT', { completed: true }); } catch { toast('⚠ offline'); }
  });

  /* wins */
  let winArc = null;
  document.querySelectorAll('#win-arcs .chip').forEach(b => b.onclick = () => {
    winArc = b.dataset.arc || null;
    document.querySelectorAll('#win-arcs .chip').forEach(x => x.classList.toggle('on', x === b));
  });
  document.getElementById('log-win')?.addEventListener('click', async () => {
    const el = document.getElementById('win-input');
    const text = el?.value.trim(); if (!text) return;
    try {
      const r = await api('/wins', 'POST', { text, arc_id: winArc });
      C.wins = r.wins; if (C.profile) C.profile.xp = (C.profile.xp || 0) + 25;
      cacheState(); render(); toast('+25 XP');
    } catch { toast('⚠ offline'); }
  });

  /* loops */
  let loopP = 'burning';
  document.querySelectorAll('#loop-prio .lp').forEach(b => b.onclick = () => {
    loopP = b.dataset.p;
    document.querySelectorAll('#loop-prio .lp').forEach(x => x.classList.toggle('on', x === b));
  });
  document.getElementById('loop-save')?.addEventListener('click', async () => {
    const el = document.getElementById('loop-input');
    const text = el?.value.trim(); if (!text) return;
    try { const r = await api('/loops', 'POST', { text, priority: loopP }); C.loops = r.loops; cacheState(); render(); }
    catch { toast('⚠ offline'); }
  });
  document.querySelectorAll('.cl').forEach(b => b.onclick = async () => {
    try { const r = await api(`/loops/${b.dataset.id}`, 'PUT', { closed: true, how: b.dataset.how }); C.loops = r.loops; cacheState(); render(); }
    catch { toast('⚠ offline'); }
  });
  document.querySelectorAll('.dl').forEach(b => b.onclick = async () => {
    C.loops = C.loops.filter(l => l.id !== b.dataset.id); cacheState(); render();
    try { await api(`/loops/${b.dataset.id}`, 'DELETE'); } catch {}
  });
  document.getElementById('toggle-closed')?.addEventListener('click', () => { C.ui.loopsShowClosed = !C.ui.loopsShowClosed; render(); });

  /* settings */
  document.getElementById('prefs-save')?.addEventListener('click', async () => {
    let dwEnd = document.getElementById('dw-end').value.trim();
    if (dwEnd === '00:00') dwEnd = '24:00'; // midnight-end maps back to 24:00 internally
    const dw = `${document.getElementById('dw-start').value.trim()}-${dwEnd}`;
    if (!/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(dw)) return toast('Set both day window times');
    try {
      const r = await api('/prefs', 'POST', {
        day_window: dw,
        briefing_morning: document.getElementById('bf-m').value.trim(),
        briefing_evening: document.getElementById('bf-e').value.trim(),
        rules: document.getElementById('pref-rules').value.trim(),
      });
      C.prefs = r.prefs; cacheState(); toast('Preferences saved ✓');
    } catch { toast('⚠ offline'); }
  });
  document.getElementById('add-block')?.addEventListener('click', () => openBlockSheet(null));
  document.querySelectorAll('.eb').forEach(b => b.onclick = () => openBlockSheet(C.blocks.find(x => x.id === b.dataset.id)));
  document.querySelectorAll('.db').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this fixed block?')) return;
    try { const r = await api(`/prefs/blocks/${b.dataset.id}`, 'DELETE'); C.blocks = r.blocks; cacheState(); render(); }
    catch { toast('⚠ offline'); }
  });
  document.getElementById('push-enable')?.addEventListener('click', enablePush);
  document.getElementById('set-token')?.addEventListener('click', () => {
    const t = prompt('Owner token (matches OWNER_TOKEN in server .env):', API.token);
    if (t !== null) { API.setToken(t.trim()); toast('Token saved'); refresh(); }
  });
}

function openBlockSheet(block) {
  const b = block || { label: '', days: [1, 2, 3, 4, 5], start: '10:00', end: '19:00' };
  const days = [...(b.days || [])];
  openSheet(`
    <div class="hud-label" style="margin-bottom:16px">${block ? 'Edit' : 'New'} fixed block</div>
    <div class="field"><span class="hud-label sub">Label</span>
      <input id="bk-label" class="input-line" value="${esc(b.label)}" placeholder="e.g. Office, Gym"/></div>
    <div class="field"><span class="hud-label sub">Days</span>
      <div style="display:flex;gap:6px;justify-content:space-between" id="bk-days">
        ${DS.map((d, i) => `<button class="press day-btn${days.includes(i) ? ' on' : ''}" data-day="${i}">${d}</button>`).join('')}
      </div></div>
    <div class="field"><span class="hud-label sub">Time</span>
      <div style="display:flex;gap:10px;align-items:center">
        <input id="bk-start" type="time" class="input-line mono" value="${esc(b.start)}" style="text-align:center;color-scheme:dark"/>
        <span class="dim">→</span>
        <input id="bk-end" type="time" class="input-line mono" value="${esc(b.end)}" style="text-align:center;color-scheme:dark"/>
      </div></div>
    <button id="bk-save" class="btn btn-primary">Save block</button>
  `, () => {
    document.querySelectorAll('#bk-days .day-btn').forEach(x => x.onclick = () => {
      const d = +x.dataset.day, i = days.indexOf(d);
      i >= 0 ? days.splice(i, 1) : days.push(d);
      x.classList.toggle('on');
    });
    document.getElementById('bk-save').onclick = async () => {
      const label = document.getElementById('bk-label').value.trim();
      const start = document.getElementById('bk-start').value.trim();
      const end = document.getElementById('bk-end').value.trim();
      if (!label) return toast('Label required');
      if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return toast('Times must be HH:MM');
      if (!days.length) return toast('Pick at least one day');
      try {
        const r = block
          ? await api(`/prefs/blocks/${block.id}`, 'PUT', { label, days, start, end })
          : await api('/prefs/blocks', 'POST', { label, days, start, end });
        C.blocks = r.blocks; cacheState(); closeSheet(); render(); toast('Fixed block saved ✓');
      } catch (e) { toast(e.message); }
    };
  });
}

async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Push not supported here — install to Home Screen first');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return toast('Notifications denied');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/push/key');
    if (!key) return toast('Server has no VAPID keys configured');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await api('/push/subscribe', 'POST', sub.toJSON());
    toast('Notifications enabled ✓');
    const st = document.getElementById('push-status'); if (st) st.textContent = 'Push enabled on this device ✓';
  } catch (e) { toast('Push setup failed: ' + e.message); }
}
function urlB64ToUint8(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/* ── arc form overlay ── */
function renderArcForm() {
  const isNew = C.ui.editArc === 'new';
  const f = C.ui.arcForm;
  return `
  <div class="ov-head">
    <button id="af-back" class="press icon-btn"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
    <span class="h2">${isNew ? 'New arc' : 'Edit arc'}</span>
    <button id="af-save" class="press btn btn-primary" style="width:auto;margin-left:auto;padding:10px 22px">Save</button>
  </div>
  <div class="ov-body">
    <div class="field"><span class="hud-label">Arc name</span>
      <input id="af-name" class="input-line" placeholder="e.g. Get to 75kg, finish my project…" value="${esc(f.name)}"/>
      <p class="xs dim" style="margin-top:8px">Make it specific. Vague goals don't get done.</p></div>
    <div class="field"><span class="hud-label">Deadline (optional)</span>
      <input id="af-deadline" class="input-line mono" type="date" value="${/^\d{4}-\d{2}-\d{2}$/.test(f.deadline) ? f.deadline : ''}" style="color-scheme:dark"/>
      <p class="xs dim" style="margin-top:8px">A real date lets AXIS prioritize by urgency.</p></div>
    <div class="field"><span class="hud-label">Color</span>
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        ${ARC_COLORS.map(c => `<button class="press af-col" data-col="${c.id}" style="width:38px;height:38px;border-radius:50%;background:${c.hex};border:3px solid ${f.color === c.id ? 'var(--text)' : 'transparent'}"></button>`).join('')}
      </div></div>
  </div>`;
}
function bindArcForm() {
  const f = C.ui.arcForm;
  document.getElementById('af-back').onclick = () => { C.ui.editArc = null; render(); };
  document.getElementById('af-name').oninput = e => f.name = e.target.value;
  document.getElementById('af-deadline').onchange = e => f.deadline = e.target.value;
  document.querySelectorAll('.af-col').forEach(b => b.onclick = () => { f.color = b.dataset.col; render(); });
  document.getElementById('af-save').onclick = async () => {
    f.name = (document.getElementById('af-name')?.value || f.name).trim();
    if (!f.name) return toast('Enter an arc name');
    try {
      if (C.ui.editArc === 'new') {
        const r = await api('/arcs', 'POST', f);
        C.arcs.push(r.arc);
      } else {
        const r = await api(`/arcs/${C.ui.editArc}`, 'PUT', f);
        const i = C.arcs.findIndex(a => a.id === C.ui.editArc);
        if (i >= 0) C.arcs[i] = r.arc;
      }
      C.ui.editArc = null; cacheState(); render();
    } catch (e) { toast(e.message); }
  };
}

boot();
