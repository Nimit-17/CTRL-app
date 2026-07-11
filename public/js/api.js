/* Browser-local data layer. The server only receives AI requests and never saves them. */
const LOCAL_KEY = 'ctrl_local_v1';
const isoToday = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const newId = prefix => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const emptyState = () => ({ profile: null, tasks: [], arcs: [], wins: [], loops: [], prefs: { day_window: '08:00-24:00' }, blocks: [], comp: {}, planItems: [], messages: [] });

function localState() {
  try {
    const stored = localStorage.getItem(LOCAL_KEY);
    if (stored) return { ...emptyState(), ...JSON.parse(stored) };
    // Carry an existing install forward once, without uploading anything.
    const previous = JSON.parse(localStorage.getItem('ctrl_v2_cache') || 'null');
    const state = { ...emptyState(), ...(previous || {}) };
    saveLocalState(state);
    return state;
  }
  catch { return emptyState(); }
}
function saveLocalState(s) { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)); }
function localPayload(s) {
  return { state: { profile: s.profile, tasks: s.tasks, arcs: s.arcs, wins: s.wins, loops: s.loops, prefs: s.prefs, blocks: s.blocks,
    completions: Object.entries(s.comp).filter(([, count]) => count > 0).map(([key, count]) => { const i = key.lastIndexOf('_'); return { task_id: key.slice(0, i), date: key.slice(i + 1), count }; }) } };
}
function datesForWeek() {
  const d = new Date(isoToday() + 'T12:00:00'); d.setDate(d.getDate() - d.getDay());
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x.toISOString().slice(0, 10); });
}
function activeOn(task, date) {
  return task.kind === 'oneoff' ? (task.dates || []).includes(date) : (task.days || []).includes(new Date(date + 'T12:00:00').getDay());
}
function minutes(value) { const [h, m] = String(value || '00:00').split(':').map(Number); return h * 60 + (m || 0); }
function clock(value) { const h = Math.floor(value / 60); return `${String(h).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function buildPlan(s, scope) {
  const dates = scope === 'today' ? [isoToday()] : datesForWeek();
  const [start, end] = String(s.prefs.day_window || '08:00-24:00').split('-').map(minutes);
  const items = [];
  for (const date of dates) {
    const dow = new Date(date + 'T12:00:00').getDay();
    for (const b of s.blocks.filter(b => (b.days || []).includes(dow))) items.push({ id: newId('f'), date, start: b.start, end: b.end, source: 'fixed', label: b.label, status: 'pending' });
    const tasks = s.tasks.filter(t => !t.archived && activeOn(t, date)).sort((a, b) => (a.priority || 3) - (b.priority || 3));
    for (const t of tasks) {
      const duration = Math.max(5, +t.minutes || 30); const occupied = items.filter(i => i.date === date && i.status !== 'dropped').sort((a, b) => minutes(a.start) - minutes(b.start));
      let cursor = start; const window = t.preferred_window ? t.preferred_window.split('-').map(minutes) : null; if (window) cursor = Math.max(cursor, window[0]);
      for (const item of occupied) { if (minutes(item.end) <= cursor) continue; if (minutes(item.start) - cursor >= duration) break; cursor = Math.max(cursor, minutes(item.end)); }
      const limit = window ? Math.min(end, window[1]) : end;
      if (cursor + duration <= limit) items.push({ id: newId('p'), date, start: clock(cursor), end: clock(cursor + duration), source: 'planned', task_id: t.id, label: t.name, status: s.comp[`${t.id}_${date}`] ? 'done' : 'pending' });
    }
  }
  s.planItems = items; saveLocalState(s); return items;
}
function planPayload(s) { const dates = datesForWeek(); return { dates, items: s.planItems.filter(i => dates.includes(i.date)), tasks: s.tasks, arcs: s.arcs, today: isoToday() }; }
function localError(message) { const e = new Error(message); e.status = 400; throw e; }

async function api(path, method = 'GET', body = null) {
  const s = localState(); const b = body || {}; const parts = path.split('/').filter(Boolean);
  if (path === '/sync') return localPayload(s);
  if (path === '/chat') {
    if (method === 'GET') return { messages: s.messages || [] };
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: b.text, history: (s.messages || []).slice(-14), state: localPayload(s).state }) });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'AI unavailable');
    s.messages = [...(s.messages || []), { role: 'user', content: b.text }, { role: 'assistant', content: data.reply, meta: { action: data.action || null } }].slice(-160);
    saveLocalState(s); return data;
  }
  if (path === '/tasks/classify') {
    const res = await fetch('/api/tasks/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: b.text }) });
    const data = await res.json(); if (!res.ok) throw new Error(data.message || data.error || 'Classification failed'); return data;
  }
  if (path === '/plan') {
    if (method === 'GET') return planPayload(s);
    const items = buildPlan(s, b.scope); return { ...planPayload(s), items, overflow: [], rationale: null, provider: null };
  }
  if (path === '/plan/propose') {
    const current = s.planItems.find(i => i.id === b.exclude_item_id); const task = s.tasks.find(t => t.id === b.task_id); if (!task) return { slot: null };
    const draft = { ...s, planItems: s.planItems.filter(i => i.id !== b.exclude_item_id) }; buildPlan(draft, 'week');
    const replacement = draft.planItems.find(i => i.source === 'planned' && i.task_id === task.id && (!current || i.date >= current.date));
    return { slot: replacement ? { date: replacement.date, start: replacement.start, end: replacement.end } : null };
  }
  if (parts[0] === 'plan' && parts[1] === 'item') { const item = s.planItems.find(i => i.id === parts[2]); if (!item) localError('not found'); Object.assign(item, b); saveLocalState(s); return { item }; }
  if (parts[0] === 'profile') { s.profile = { ...(s.profile || { xp: 0, streak: 1 }), ...b }; saveLocalState(s); return { profile: s.profile }; }
  if (parts[0] === 'prefs') {
    if (parts[1] === 'blocks') {
      if (method === 'POST') s.blocks.push({ id: newId('b'), ...b });
      else if (method === 'PUT') Object.assign(s.blocks.find(x => x.id === parts[2]) || localError('not found'), b);
      else if (method === 'DELETE') s.blocks = s.blocks.filter(x => x.id !== parts[2]);
      saveLocalState(s); return { blocks: s.blocks };
    }
    if (method === 'POST') s.prefs = { ...s.prefs, ...b }; saveLocalState(s); return { prefs: s.prefs };
  }
  if (parts[0] === 'tasks') {
    if (parts[2] === 'complete') { const task = s.tasks.find(x => x.id === parts[1]); if (!task) localError('not found'); const date = b.date || isoToday(); s.comp[`${task.id}_${date}`] = Math.max(0, +b.count || 0); s.planItems.filter(i => i.task_id === task.id && i.date === date).forEach(i => i.status = s.comp[`${task.id}_${date}`] ? 'done' : 'pending'); saveLocalState(s); return { ok: true }; }
    if (method === 'POST') { const task = { id: newId('t'), archived: false, priority: 3, minutes: 30, target: 1, type: 'check', kind: 'recurring', days: [], dates: [], ...b }; if (!task.name) localError('name required'); s.tasks.push(task); saveLocalState(s); return { task }; }
    const task = s.tasks.find(x => x.id === parts[1]); if (!task) localError('not found'); if (method === 'PUT') Object.assign(task, b); if (method === 'DELETE') s.tasks = s.tasks.filter(x => x.id !== parts[1]); saveLocalState(s); return method === 'DELETE' ? { ok: true } : { task };
  }
  for (const key of ['arcs', 'wins', 'loops']) if (parts[0] === key) {
    const id = parts[1]; if (method === 'POST') { const item = { id: newId(key[0]), ...b, date: b.date || isoToday() }; s[key].push(item); saveLocalState(s); return { [key === 'arcs' ? 'arc' : key]: key === 'arcs' ? item : s[key] }; }
    const item = s[key].find(x => x.id === id); if (!item) localError('not found'); if (method === 'PUT') Object.assign(item, b); if (method === 'DELETE') s[key] = s[key].filter(x => x.id !== id); saveLocalState(s); return method === 'DELETE' ? { ok: true } : { [key === 'arcs' ? 'arc' : key]: key === 'arcs' ? item : s[key] };
  }
  localError(`Unsupported local operation: ${method} ${path}`);
}
