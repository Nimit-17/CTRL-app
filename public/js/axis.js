/* axis.js — PLAN (timetable) view + AXIS chat. */

/* ════════ PLAN — the timetable ════════ */
const PLAN = {
  data: null,        // { dates, items, tasks, arcs, today }
  sel: null,         // selected ISO date
  view: localStorage.getItem('ctrl_planview') || 'day',   // 'day' | 'week'
  rationale: null,
  overflow: null,
  loading: false,

  async load(force = false) {
    if (this.data && !force) return;
    try { this.data = await api('/plan'); this.sel = this.sel || this.data.today; }
    catch { this.data = null; }
  },

  async generate(scope) {
    if (this.loading) return;
    this.loading = true; render();
    try {
      const r = await api('/plan', 'POST', { scope });
      this.data = r; this.rationale = r.rationale; this.overflow = r.overflow;
      this.sel = this.sel || r.today;
      toast(scope === 'today' ? 'Today prioritized ✓' : 'Week planned ✓');
    } catch (e) { toast(e.message || 'Planning failed'); }
    this.loading = false; render();
  },

  render() {
    if (!this.data) {
      this.load().then(() => render());
      return `<div style="display:flex;height:70dvh;align-items:center;justify-content:center"><span class="hud-label">Loading plan…</span></div>`;
    }
    const { dates, items } = this.data;
    const sel = this.sel || this.data.today;
    const hasPlan = items.some(i => i.source === 'planned');

    return `
    <div class="au" style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:10px">
      <div><div class="hud-label" style="margin-bottom:6px">AXIS timetable</div><div class="h-display">Plan</div></div>
      <button id="plan-week" class="press btn btn-primary" style="width:auto;padding:11px 16px;${this.loading ? 'opacity:.5' : ''}">${this.loading ? 'Planning…' : hasPlan ? '↻ Replan' : '⚡ Plan my week'}</button>
    </div>

    <div class="au" style="display:flex;gap:8px;margin-bottom:12px">
      <button class="press chip${this.view === 'day' ? ' on' : ''}" data-view="day" style="flex:1;text-align:center">Day</button>
      <button class="press chip${this.view === 'week' ? ' on' : ''}" data-view="week" style="flex:1;text-align:center">Week</button>
    </div>

    ${this.rationale ? `<div class="au d1 card tick" style="margin-bottom:14px;border-color:rgba(56,225,255,.25);position:relative">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div class="hud-label">AXIS rationale</div>
        <button id="rat-close" class="press" style="color:var(--sub);font-size:16px;line-height:1;padding:2px 6px">✕</button>
      </div>
      <p class="small sub" style="line-height:1.6">${esc(this.rationale)}</p>
    </div>` : ''}

    ${this.overflow?.length ? `<div class="au d1 card" style="margin-bottom:14px;border-color:rgba(245,166,35,.4)">
      <div class="hud-label amber" style="margin-bottom:6px">⚠ Couldn't fit</div>
      <p class="xs sub">${this.overflow.map(o => `${esc(o.name)} (${o.date.slice(5)})`).join(' · ')}</p>
    </div>` : ''}

    ${this.view === 'week' ? this.renderWeek() : this.renderDay(sel, hasPlan)}`;
  },

  /* shared: minutes helper + grid bounds across the given items */
  _bounds(list) {
    const dw = (C.prefs.day_window || '08:00-24:00').split('-');
    const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
    let gs = toMin(dw[0]), ge = toMin(dw[1]);
    for (const it of list) { gs = Math.min(gs, toMin(it.start)); ge = Math.max(ge, toMin(it.end)); }
    return { toMin, gs: Math.floor(gs / 60) * 60, ge: Math.min(Math.ceil(ge / 60) * 60, 1440) };
  },
  _nowMin() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); },

  renderDay(sel, hasPlan) {
    const { items, tasks, arcs } = this.data;
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    const dayItems = items.filter(i => i.date === sel && i.status !== 'moved' && i.status !== 'dropped');
    const { toMin, gs, ge } = this._bounds(dayItems);
    const PX = 1.15;
    const H = (ge - gs) * PX;

    const hourMarks = [];
    for (let h = gs; h <= ge; h += 60) {
      const y = (h - gs) * PX;
      hourMarks.push(`<div class="tt-hour" style="top:${y}px">${fmtT(`${Math.floor(h / 60)}:00`)}</div><div class="tt-hourline" style="top:${y}px"></div>`);
    }
    const blocks = dayItems.map(it => {
      const top = (toMin(it.start) - gs) * PX;
      const h = Math.max((toMin(it.end) - toMin(it.start)) * PX, 20);
      const t = byId[it.task_id];
      const arc = t && arcs.find(a => a.id === t.arc_id);
      const col = it.source === 'fixed' ? '' : (arc ? arcColor(arc) : 'var(--primary)');
      const done = it.status === 'done';
      return `<button class="tt-block press ${it.source} ${done ? 'done' : ''} ${h < 34 ? 'short' : ''}" data-item="${it.id}"
        style="top:${top}px;height:${h}px;${col ? `--pc:${col}` : ''}">
        <div class="bl-name">${done ? '✓ ' : ''}${esc(t ? t.name : it.label)}</div>
        <div class="bl-time mono">${fmtT(it.start)}–${fmtT(it.end)}${t ? ` · ${fmtM(t.minutes)}` : ''}</div>
      </button>`;
    }).join('');

    let nowLine = '';
    if (sel === this.data.today) {
      const nm = this._nowMin();
      if (nm >= gs && nm <= ge) nowLine = `<div class="tt-now" style="top:${(nm - gs) * PX}px"></div>`;
    }

    return `
    <div class="au tt-daychips">
      ${this.data.dates.map(d => {
        const [, , dd] = d.split('-');
        const dow = new Date(d + 'T12:00:00').getDay();
        const has = this.data.items.some(i => i.date === d && i.status !== 'moved' && i.status !== 'dropped');
        return `<button class="press tt-daychip${d === sel ? ' sel' : ''}${d === this.data.today ? ' today' : ''}" data-date="${d}">
          <span class="dw">${DF[dow]}</span><span class="dn">${+dd}</span><span class="dot${has ? ' has' : ''}"></span>
        </button>`;
      }).join('')}
    </div>
    ${dayItems.length === 0
      ? `<div class="au d2 empty" style="margin-top:20px">
          <p style="font-size:22px;margin-bottom:8px">◷</p>
          <p class="small" style="margin-bottom:4px">Nothing scheduled for ${sel === this.data.today ? 'today' : DF[new Date(sel + 'T12:00:00').getDay()]}</p>
          <p class="xs sub">${hasPlan ? 'A rest day — or add tasks for this day.' : 'Hit "Plan my week" and AXIS will build your timetable.'}</p>
        </div>`
      : `<div class="au d2 tt-grid" style="height:${H + 20}px;margin-bottom:20px">${hourMarks.join('')}${blocks}${nowLine}</div>`}`;
  },

  /* whole week at a glance — 7 columns, tap a column/block to jump into that day */
  renderWeek() {
    const { dates, items, tasks, arcs } = this.data;
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    const live = items.filter(i => i.status !== 'moved' && i.status !== 'dropped');
    const { toMin, gs, ge } = this._bounds(live);
    const PX = 0.55;
    const H = (ge - gs) * PX;

    const axis = [];
    for (let h = gs; h <= ge; h += 120) {
      axis.push(`<div class="wk-hour" style="top:${(h - gs) * PX + 24}px">${fmtT(`${Math.floor(h / 60)}:00`)}</div>`);
    }

    const cols = dates.map(d => {
      const dow = new Date(d + 'T12:00:00').getDay();
      const dayItems = live.filter(i => i.date === d);
      const blocks = dayItems.map(it => {
        const top = (toMin(it.start) - gs) * PX;
        const h = Math.max((toMin(it.end) - toMin(it.start)) * PX, 3);
        const t = byId[it.task_id];
        const arc = t && arcs.find(a => a.id === t.arc_id);
        const col = arc ? arcColor(arc) : 'var(--primary)';
        return `<div class="wk-block ${it.source}${it.status === 'done' ? ' done' : ''}" style="top:${top}px;height:${h}px;${it.source === 'planned' ? `--pc:${col}` : ''}"></div>`;
      }).join('');
      const nowLine = d === this.data.today && this._nowMin() >= gs && this._nowMin() <= ge
        ? `<div class="wk-nowline" style="top:${(this._nowMin() - gs) * PX}px"></div>` : '';
      return `<button class="press wk-col${d === this.data.today ? ' today' : ''}" data-wkday="${d}">
        <div class="wk-head"><span class="dw">${DF[dow]}</span><span class="dn">${+d.split('-')[2]}</span></div>
        <div class="wk-body" style="height:${H}px">${blocks}${nowLine}</div>
      </button>`;
    }).join('');

    return `
    <div class="au d2" style="position:relative;margin-bottom:8px">
      ${axis.join('')}
      <div class="wk-wrap">${cols}</div>
    </div>
    <div class="au d2" style="display:flex;gap:14px;justify-content:center;margin-bottom:20px">
      <span class="xs dim"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:repeating-linear-gradient(135deg,rgba(76,125,255,.5) 0 3px,rgba(76,125,255,.15) 3px 6px);vertical-align:-1px;margin-right:5px"></span>Fixed</span>
      <span class="xs dim"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--primary);vertical-align:-1px;margin-right:5px"></span>Planned</span>
      <span class="xs dim">Tap a day to zoom in</span>
    </div>`;
  },

  bind() {
    document.getElementById('plan-week')?.addEventListener('click', () => this.generate('week'));
    document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { this.view = b.dataset.view; localStorage.setItem('ctrl_planview', this.view); render(); });
    document.getElementById('rat-close')?.addEventListener('click', () => { this.rationale = null; render(); });
    document.querySelectorAll('.tt-daychip').forEach(b => b.onclick = () => { this.sel = b.dataset.date; render(); });
    document.querySelectorAll('.tt-block').forEach(b => b.onclick = () => this.openItemSheet(b.dataset.item));
    document.querySelectorAll('.wk-col').forEach(b => b.onclick = () => { this.sel = b.dataset.wkday; this.view = 'day'; localStorage.setItem('ctrl_planview', 'day'); render(); });
  },

  openItemSheet(itemId) {
    const it = this.data.items.find(x => x.id === itemId);
    if (!it) return;
    const t = this.data.tasks.find(x => x.id === it.task_id);
    const isFixed = it.source === 'fixed';
    openSheet(`
      <div class="hud-label" style="margin-bottom:4px">${isFixed ? 'Fixed block' : 'Scheduled task'}</div>
      <div class="h2" style="margin-bottom:14px">${esc(t ? t.name : it.label)}</div>
      <div class="ac-kv"><span class="k">When</span><span class="v">${DF[new Date(it.date + 'T12:00:00').getDay()]} ${it.date.slice(5)} · ${fmtT(it.start)}–${fmtT(it.end)}</span></div>
      ${t ? `<div class="ac-kv"><span class="k">Duration</span><span class="v">${fmtM(t.minutes)}</span></div>
             <div class="ac-kv"><span class="k">Priority</span><span class="v">P${t.priority || 3}</span></div>` : ''}
      ${isFixed
        ? `<p class="xs dim" style="margin-top:14px">Fixed blocks are immovable — edit them in More → Settings.</p>`
        : `<div class="ac-row" style="margin-top:16px">
            <button id="it-done" class="press ac-btn cyan">${it.status === 'done' ? '↩ Undo done' : '✓ Done'}</button>
            <button id="it-move" class="press ac-btn amber">→ Move</button>
            <button id="it-drop" class="press ac-btn danger">Drop</button>
          </div>
          <div id="it-proposal"></div>`}
    `, () => {
      if (isFixed) return;
      document.getElementById('it-done').onclick = async () => {
        const newStatus = it.status === 'done' ? 'pending' : 'done';
        try {
          await api(`/plan/item/${it.id}`, 'PUT', { status: newStatus });
          if (t) {
            const cnt = newStatus === 'done' ? (t.type === 'count' ? (t.target || 1) : 1) : 0;
            await api(`/tasks/${t.id}/complete`, 'POST', { date: it.date, count: cnt });
            C.comp[`${t.id}_${it.date}`] = cnt; cacheState();
          }
          it.status = newStatus; closeSheet(); render();
        } catch (e) { toast(e.message); }
      };
      document.getElementById('it-drop').onclick = async () => {
        try { await api(`/plan/item/${it.id}`, 'PUT', { status: 'dropped' }); it.status = 'dropped'; closeSheet(); render(); toast('Dropped'); }
        catch (e) { toast(e.message); }
      };
      document.getElementById('it-move').onclick = async () => {
        const box = document.getElementById('it-proposal');
        box.innerHTML = `<p class="xs sub" style="margin-top:14px">Finding next viable slot…</p>`;
        try {
          const { slot } = await api('/plan/propose', 'POST', { task_id: it.task_id, from_date: it.date, exclude_item_id: it.id });
          if (!slot) {
            box.innerHTML = `<p class="xs" style="margin-top:14px;color:var(--danger)">${t?.kind === 'recurring'
              ? 'No free slot left today — recurring tasks can only move within the same day (it already repeats). Keep it or drop it.'
              : 'No free slot this week — free something up or drop it.'}</p>`;
            return;
          }
          box.innerHTML = `
            <div class="action-card" style="margin-top:14px">
              <div class="ac-title">Proposed slot</div>
              <div class="ac-kv"><span class="k">New time</span><span class="v">${DF[new Date(slot.date + 'T12:00:00').getDay()]} ${slot.date.slice(5)} · ${fmtT(slot.start)}–${fmtT(slot.end)}</span></div>
              <div class="ac-row"><button id="it-confirm" class="press ac-btn cyan">✓ Confirm move</button></div>
            </div>`;
          document.getElementById('it-confirm').onclick = async () => {
            try {
              await api(`/plan/item/${it.id}`, 'PUT', { date: slot.date, start: slot.start, end: slot.end, status: 'pending' });
              Object.assign(it, slot); closeSheet(); render(); toast('Moved ✓');
            } catch (e) { toast(e.message); }
          };
        } catch (e) { box.innerHTML = `<p class="xs" style="margin-top:14px;color:var(--danger)">${esc(e.message)}</p>`; }
      };
    });
  },
};

/* ════════ AXIS chat ════════ */
const AXIS = {
  msgs: null, busy: false, booted: false,

  async show() {
    const el = document.getElementById('axis-screen');
    if (!this.booted) {
      el.innerHTML = this.shell();
      this.bindShell();
      this.booted = true;
      try {
        const r = await api('/chat');
        this.msgs = r.messages || [];
      } catch { this.msgs = []; }
      this.renderMsgs();
    }
    setTimeout(() => this.scrollDown(false), 30);
  },

  shell() {
    return `
    <div class="axis-head">
      <div class="axis-orb-lg"></div>
      <div style="flex:1">
        <div class="h2" style="letter-spacing:2px">AXIS</div>
        <div class="xs sub" id="axis-status">scheduling co-pilot · online</div>
      </div>
    </div>
    <div class="axis-msgs" id="axis-msgs">
      <div class="typing"><i></i><i></i><i></i></div>
    </div>
    <div class="axis-quick">
      <button class="press chip" data-q="Plan my week">⚡ Plan my week</button>
      <button class="press chip" data-q="Prioritize today">◎ Prioritize today</button>
      <button class="press chip" data-q="__late__">⏱ I'm running late</button>
      <button class="press chip" data-q="What's left today?">☑ What's left?</button>
    </div>
    <div class="axis-inputbar">
      <textarea id="axis-input" class="axis-input" rows="1" placeholder="Talk to AXIS…"></textarea>
      <button id="axis-send" class="press axis-send" disabled>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#04121A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>`;
  },

  bindShell() {
    const input = document.getElementById('axis-input');
    const send = document.getElementById('axis-send');
    input.oninput = () => {
      send.disabled = !input.value.trim();
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 110) + 'px';
    };
    input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } };
    send.onclick = () => this.send();
    document.querySelectorAll('.axis-quick .chip').forEach(b => b.onclick = () => {
      if (b.dataset.q === '__late__') { input.value = "I'm running about  hours late — "; input.focus(); input.oninput(); return; }
      input.value = b.dataset.q; this.send();
    });
  },

  msgHtml(m, typewriter = false) {
    let meta = null;
    try { meta = m.meta ? (typeof m.meta === 'string' ? JSON.parse(m.meta) : m.meta) : null; } catch {}
    const brief = meta?.kind?.startsWith('briefing');
    const tag = brief ? `<span class="msg-tag">${meta.kind === 'briefing_morning' ? '☀ MORNING BRIEFING' : '☾ EVENING CHECK-IN'}</span>` : '';
    return `<div class="msg ${m.role}${brief ? ' briefing' : ''}" ${typewriter ? 'data-tw="1"' : ''}>${tag}${esc(m.content)}</div>`;
  },

  renderMsgs() {
    const box = document.getElementById('axis-msgs');
    if (!box) return;
    if (!this.msgs?.length) {
      box.innerHTML = `<div class="msg assistant">I'm AXIS — your scheduling co-pilot. I plan your week around your fixed blocks, reshuffle when life happens, and brief you morning and night.\n\nTry "Plan my week", or just tell me what's going on.</div>`;
      return;
    }
    box.innerHTML = this.msgs.map(m => this.msgHtml(m)).join('');
    /* re-render any pending action card from the last assistant message */
    const last = this.msgs[this.msgs.length - 1];
    let meta = null;
    try { meta = last?.meta ? (typeof last.meta === 'string' ? JSON.parse(last.meta) : last.meta) : null; } catch {}
    if (last?.role === 'assistant' && meta?.action) this.renderAction(meta.action);
    this.scrollDown(false);
  },

  scrollDown(smooth = true) {
    const box = document.getElementById('axis-msgs');
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  },

  addBubble(html) {
    const box = document.getElementById('axis-msgs');
    box.insertAdjacentHTML('beforeend', html);
    this.scrollDown();
    return box.lastElementChild;
  },

  typewrite(el, text) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || text.length > 600) { el.textContent = text; this.scrollDown(); return; }
    el.innerHTML = '<span></span><span class="msg-caret"></span>';
    const span = el.firstChild;
    let i = 0;
    const step = () => {
      i = Math.min(text.length, i + 2 + Math.floor(Math.random() * 2));
      span.textContent = text.slice(0, i);
      this.scrollDown(false);
      if (i < text.length) setTimeout(step, 14);
      else el.querySelector('.msg-caret')?.remove();
    };
    step();
  },

  async send(overrideText) {
    if (this.busy) return;
    const input = document.getElementById('axis-input');
    const text = (overrideText ?? input.value).trim();
    if (!text) return;
    input.value = ''; input.style.height = 'auto';
    document.getElementById('axis-send').disabled = true;
    this.busy = true;

    this.msgs.push({ role: 'user', content: text });
    this.addBubble(this.msgHtml({ role: 'user', content: text }));
    const typing = this.addBubble(`<div class="typing"><i></i><i></i><i></i></div>`);

    try {
      const r = await api('/chat', 'POST', { text });
      typing.remove();
      this.msgs.push({ role: 'assistant', content: r.reply, meta: { action: r.action } });
      const bubble = this.addBubble(`<div class="msg assistant"></div>`);
      this.typewrite(bubble, r.reply);
      if (r.action) setTimeout(() => this.renderAction(r.action), Math.min(r.reply.length * 8, 1200) + 200);
      if (r.action?.type === 'update_pref') { try { const p = await api('/prefs'); C.prefs = p.prefs; cacheState(); } catch {} }
    } catch (e) {
      typing.remove();
      this.addBubble(this.msgHtml({ role: 'assistant', content: '⚠ ' + (e.message || 'Something broke — try again.') }));
    }
    this.busy = false;
  },

  /* ── action cards ── */
  renderAction(action) {
    if (!action) return;
    if (action.type === 'disruption' && action.items?.length) this.renderDisruption(action);
    else if (action.type === 'plan_week' || action.type === 'plan_today') this.renderPlanAction(action.type);
    else if (action.type === 'add_task' && action.text) this.renderAddTask(action.text);
    else if (action.type === 'task_added' && action.task) {
      // server already created (and maybe scheduled) it — sync local state, no confirm needed
      if (!C.tasks.some(t => t.id === action.task.id)) C.tasks.push(action.task);
      cacheState();
      const t = action.task;
      const meta = t.kind === 'oneoff'
        ? `One-off · ${(t.dates || []).join(', ')}` : `Recurring · ${(t.days || []).length === 7 ? 'daily' : (t.days || []).map(d => DF[d]).join(' ')}`;
      this.addBubble(`<div class="action-card"><div class="ac-title">Task added</div>
        <div class="ac-kv"><span class="k">${esc(t.name)}</span><span class="v">${t.type === 'count' ? `${t.target} ${esc(t.unit)}` : fmtM(t.minutes)}</span></div>
        <div class="ac-kv"><span class="k">${meta}</span><span class="v">${action.placed ? `${DF[new Date(action.placed.date + 'T12:00:00').getDay()]} ${fmtT(action.placed.start)}` : 'not scheduled yet'}</span></div></div>`);
      if (action.placed) PLAN.load(true);
    }
    else if (action.type === 'move_applied') {
      const sameDay = action.to.date === action.from.date;
      const to = `${sameDay ? '' : DF[new Date(action.to.date + 'T12:00:00').getDay()] + ' '}${fmtT(action.to.start)}–${fmtT(action.to.end)}`;
      this.addBubble(`<div class="action-card"><div class="ac-title">Schedule updated</div>
        <div class="ac-kv"><span class="k">${esc(action.name)}</span><span class="v">${fmtT(action.from.start)} → ${to}</span></div></div>`);
      PLAN.load(true); // pull the rewritten schedule so the Plan tab is fresh
    }
    else if (action.type === 'move_failed') {
      /* reply text already explains it — nothing extra to render */
    }
    else if (action.type === 'update_pref') {
      const v = action.key === 'day_window' ? fmtWin(action.value)
        : action.key === 'rules' ? action.value
        : fmtT(action.value);
      this.addBubble(`<div class="action-card"><div class="ac-title">Preference updated</div>
        <div class="ac-kv"><span class="k">${esc(action.key.replace(/_/g, ' '))}</span><span class="v" style="white-space:pre-wrap;text-align:right">${esc(v)}</span></div></div>`);
      api('/prefs').then(p => { C.prefs = p.prefs; cacheState(); }).catch(() => {});
    }
  },

  renderPlanAction(type) {
    const card = this.addBubble(`<div class="action-card">
      <div class="ac-title">${type === 'plan_today' ? 'Prioritize today' : 'Plan the week'}</div>
      <p class="xs sub">Run the scheduler now? Fixed blocks stay untouched.</p>
      <div class="ac-row"><button class="press ac-btn cyan" data-act="go">⚡ Run it</button><button class="press ac-btn" data-act="no">Not now</button></div>
    </div>`);
    card.querySelector('[data-act="go"]').onclick = async () => {
      card.querySelector('.ac-row').innerHTML = `<p class="xs sub">Scheduling…</p>`;
      await PLAN.generate(type === 'plan_today' ? 'today' : 'week');
      card.querySelector('.ac-row')?.remove();
      this.addBubble(`<div class="msg assistant">Done — check the Plan tab. ${PLAN.overflow?.length ? `Couldn't fit: ${PLAN.overflow.map(o => esc(o.name)).join(', ')}.` : 'Everything fit.'}</div>`);
    };
    card.querySelector('[data-act="no"]').onclick = () => card.remove();
  },

  renderAddTask(text) {
    const card = this.addBubble(`<div class="action-card"><div class="ac-title">New task detected</div><p class="xs sub">Classifying "${esc(text)}"…</p></div>`);
    api('/tasks/classify', 'POST', { text }).then(r => {
      const cp = r.classified;
      const days = (cp.days || []).map(d => DF[d]).join(' ');
      card.innerHTML = `<div class="ac-title">Confirm new task</div>
        <div class="ac-kv"><span class="k">Task</span><span class="v">${esc(cp.name)}</span></div>
        <div class="ac-kv"><span class="k">Kind</span><span class="v">${cp.kind === 'oneoff' ? `One-off · ${(cp.dates || []).join(', ')}` : `Recurring · ${days || 'daily'}`}</span></div>
        <div class="ac-kv"><span class="k">Length</span><span class="v">${cp.type === 'count' ? `${cp.target} ${esc(cp.unit)}` : fmtM(cp.minutes)}</span></div>
        ${cp.preferred_window ? `<div class="ac-kv"><span class="k">Window</span><span class="v">${esc(fmtWin(cp.preferred_window))}</span></div>` : ''}
        <div class="ac-row"><button class="press ac-btn cyan" data-act="save">✓ Save</button><button class="press ac-btn danger" data-act="no">✕</button></div>`;
      card.querySelector('[data-act="save"]').onclick = async () => {
        try {
          const rr = await api('/tasks', 'POST', cp);
          C.tasks.push(rr.task); cacheState();
          card.remove();
          this.addBubble(`<div class="msg assistant">Saved "${esc(cp.name)}". Want me to replan to fit it in? Just say "replan".</div>`);
        } catch (e) { toast(e.message); }
      };
      card.querySelector('[data-act="no"]').onclick = () => card.remove();
    }).catch(() => {
      card.innerHTML = `<div class="ac-title">Classification failed</div><p class="xs sub">Add it manually in the Tasks tab.</p>`;
    });
  },

  renderDisruption(action) {
    const items = action.items;
    let resolved = 0;
    const card = this.addBubble(`<div class="action-card">
      <div class="ac-title">Disruption — ${items.length} item${items.length !== 1 ? 's' : ''} affected</div>
      ${items.map((it, i) => `
      <div class="dis-item" data-i="${i}" style="padding:10px 0;border-bottom:1px solid rgba(28,39,51,.6)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span class="small" style="font-weight:600">${esc(it.name)}</span>
          <span class="xs mono sub">${fmtT(it.current.start)}–${fmtT(it.current.end)}</span>
        </div>
        <div class="ac-row" style="margin-top:6px">
          <button class="press ac-btn" data-d="keep">Keep today</button>
          <button class="press ac-btn amber" data-d="move" ${it.proposal ? '' : 'disabled style="opacity:.4"'}>
            ${it.proposal ? `→ ${it.proposal.date === it.current.date ? '' : DF[new Date(it.proposal.date + 'T12:00:00').getDay()] + ' '}${fmtT(it.proposal.start)}` : 'No slot free'}
          </button>
          <button class="press ac-btn danger" data-d="drop">Drop</button>
        </div>
      </div>`).join('')}
    </div>`);

    const finish = () => {
      if (++resolved < items.length) return;
      this.addBubble(`<div class="msg assistant">All sorted. Schedule updated — check the Plan tab.</div>`);
      PLAN.load(true);
    };

    card.querySelectorAll('.dis-item').forEach(row => {
      const it = items[+row.dataset.i];
      const done = (label, color) => { row.innerHTML = `<div style="display:flex;justify-content:space-between;padding:4px 0"><span class="small">${esc(it.name)}</span><span class="xs" style="color:${color}">${label}</span></div>`; finish(); };
      row.querySelector('[data-d="keep"]').onclick = () => done('✓ kept today', 'var(--ok)');
      row.querySelector('[data-d="drop"]').onclick = async () => {
        try { await api(`/plan/item/${it.item_id}`, 'PUT', { status: 'dropped' }); done('✕ dropped', 'var(--danger)'); }
        catch (e) { toast(e.message); }
      };
      const mv = row.querySelector('[data-d="move"]');
      if (it.proposal) mv.onclick = async () => {
        try {
          await api(`/plan/item/${it.item_id}`, 'PUT', { ...it.proposal, status: 'pending' });
          done(`→ moved to ${it.proposal.date === it.current.date ? '' : it.proposal.date.slice(5) + ' '}${fmtT(it.proposal.start)}`, 'var(--accent)');
        } catch (e) { toast(e.message); }
      };
    });
  },
};
