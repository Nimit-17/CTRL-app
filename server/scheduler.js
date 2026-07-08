/* scheduler.js — deterministic slot-fitting. NO AI here.
   Times are minutes-from-midnight internally; "24:00" (1440) is a valid end bound.
   Granularity: 5 minutes. Never overlaps fixed blocks. */

const { q, todayStr, addDays, dowOf, weekDates, nowIST } = require('./db');

const GRAN = 5;          // minutes
const GAP = 10;          // breathing room between planned items

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}
function toHHMM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function roundUp(min) { return Math.ceil(min / GRAN) * GRAN; }

/* Named windows → minute ranges (clamped to day window later) */
const WINDOWS = { morning: [5 * 60, 12 * 60], afternoon: [12 * 60, 17 * 60], evening: [17 * 60, 22 * 60], night: [20 * 60, 24 * 60] };
function windowRange(pw) {
  if (!pw) return null;
  const w = String(pw).toLowerCase().trim();
  if (WINDOWS[w]) return WINDOWS[w];
  const m = w.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
  if (m) return [toMin(m[1]), toMin(m[2])];
  return null;
}

/* Deadline urgency: days until arc deadline (Infinity if none / unparseable) */
function deadlineDays(arc, today) {
  if (!arc || !arc.deadline) return Infinity;
  const m = String(arc.deadline).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return Infinity;
  const diff = (new Date(+m[1], +m[2] - 1, +m[3]) - new Date(...today.split('-').map((v, i) => i === 1 ? +v - 1 : +v))) / 86400000;
  return Math.max(0, Math.round(diff));
}

/* Free intervals for one day: day window minus fixed blocks minus busy[] */
function freeIntervals(dayWindow, blocks, busy) {
  let free = [[dayWindow[0], dayWindow[1]]];
  const occupied = [...blocks, ...busy].sort((a, b) => a[0] - b[0]);
  for (const [s, e] of occupied) {
    const next = [];
    for (const [fs, fe] of free) {
      if (e <= fs || s >= fe) { next.push([fs, fe]); continue; }
      if (s > fs) next.push([fs, s]);
      if (e < fe) next.push([e, fe]);
    }
    free = next;
  }
  return free;
}

/* Fit `dur` minutes into free intervals, preferring `pref` range if given.
   Returns [start, end] in minutes or null. */
function fitInto(free, dur, pref) {
  const tryRange = (range) => {
    for (const [fs, fe] of free) {
      const s = roundUp(range ? Math.max(fs, range[0]) : fs);
      const cap = range ? Math.min(fe, range[1]) : fe;
      if (cap - s >= dur) return [s, s + dur];
    }
    return null;
  };
  if (pref) { const hit = tryRange(pref); if (hit) return hit; }
  return tryRange(null);
}

/* Priority sort: oneoffs first (date-pinned), then arc deadline urgency, then priority, then longer-first */
function taskOrder(a, b, arcById, today) {
  const ao = a.kind === 'oneoff' ? 0 : 1, bo = b.kind === 'oneoff' ? 0 : 1;
  if (ao !== bo) return ao - bo;
  const ad = deadlineDays(arcById[a.arc_id], today), bd = deadlineDays(arcById[b.arc_id], today);
  if (ad !== bd) return ad - bd;
  if ((a.priority || 3) !== (b.priority || 3)) return (a.priority || 3) - (b.priority || 3);
  return (b.minutes || 30) - (a.minutes || 30);
}

/* Estimated duration for a task in minutes */
function taskDur(t) { return Math.max(GRAN, roundUp(t.minutes || 30)); }

/* ── planWeek: generates schedule rows for [today .. today+6] ──
   opts.days — restrict to subset of dates (e.g. just today for "prioritize today")
   opts.keepDone — preserve rows already marked done (default true)
   Returns { items, overflow } and PERSISTS to the schedule table. */
function planWeek(opts = {}) {
  const today = todayStr();
  const dates = opts.days || weekDates();
  const from = dates[0], to = dates[dates.length - 1];

  const tasks = q.allTasks();
  const arcs = q.allArcs();
  const arcById = Object.fromEntries(arcs.map(a => [a.id, a]));
  const blocks = q.allBlocks();
  const dw = (q.getPref('day_window') || '08:00-24:00').split('-').map(toMin);

  // preserve completed/manually-set rows; regenerate the rest
  const existing = q.scheduleRange(from, to);
  const keep = existing.filter(r => r.status === 'done');
  q.clearPlanned(from, to);
  for (const r of keep) q.insertScheduleItem(r);

  const items = [];
  const overflow = [];
  let seq = 0;
  const nid = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

  // current time floor: today can't schedule into the past
  const ist = nowIST();
  const nowMin = ist.getHours() * 60 + ist.getMinutes();

  for (const date of dates) {
    const dow = dowOf(date);

    // 1. fixed blocks for this day
    const dayBlocks = blocks.filter(b => b.days.includes(dow)).map(b => ({ ...b, s: toMin(b.start), e: toMin(b.end) }));
    for (const b of dayBlocks) {
      const row = { id: nid(), date, start: toHHMM(b.s), end: toHHMM(b.e), task_id: null, label: b.label, source: 'fixed', status: 'pending' };
      q.insertScheduleItem(row); items.push(row);
    }

    // 2. candidate tasks for this day
    const done = new Set(q.completionsFor(date).map(c => c.task_id));
    const candidates = tasks.filter(t => {
      if (done.has(t.id) && t.type === 'check') return false;
      if (t.kind === 'oneoff') return (t.dates || []).includes(date);
      return (t.days || []).includes(dow);
    }).sort((a, b) => taskOrder(a, b, arcById, today));

    // 3. busy = kept done-rows on this date + floor for today
    const busy = keep.filter(r => r.date === date).map(r => [toMin(r.start), toMin(r.end)]);
    let floor = dw[0];
    if (date === today && nowMin > dw[0]) floor = Math.min(roundUp(nowMin + GRAN), dw[1]);
    const dayWin = [floor, dw[1]];

    // 4. pack
    const blockIv = dayBlocks.map(b => [b.s, b.e]);
    for (const t of candidates) {
      const dur = taskDur(t);
      const free = freeIntervals(dayWin, blockIv, busy);
      const pref = windowRange(t.preferred_window);
      const slot = fitInto(free, dur, pref);
      if (!slot) { overflow.push({ task_id: t.id, name: t.name, date }); continue; }
      busy.push([slot[0], Math.min(slot[1] + GAP, dw[1])]); // reserve gap after
      const row = { id: nid(), date, start: toHHMM(slot[0]), end: toHHMM(slot[1]), task_id: t.id, label: t.name, source: 'planned', status: 'pending' };
      q.insertScheduleItem(row); items.push(row);
    }
  }
  return { items: q.scheduleRange(from, to), overflow };
}

/* ── proposeSlot: next viable slot for a task, searching fromDate..end of week.
   excludeItemId — the schedule row being moved. Its own slot stays "busy" so the
   proposal can never be the slot it already occupies (a move must go elsewhere).
   Recurring-task rule: an instance may move LATER THE SAME DAY or to a day the
   task does NOT already repeat on — never onto a repeat day (no double gym).
   opts.onlyDate — restrict the search to that single date.
   opts.notBefore — "HH:MM" floor on the fromDate (e.g. owner busy until then).
   Returns { date, start, end } or null. ── */
function proposeSlot(taskId, fromDate, excludeItemId, opts = {}) {
  const t = q.getTask(taskId);
  if (!t) return null;
  const dur = taskDur(t);
  const dw = (q.getPref('day_window') || '08:00-24:00').split('-').map(toMin);
  const blocks = q.allBlocks();
  const pref = windowRange(t.preferred_window);
  const week = opts.onlyDate ? [opts.onlyDate] : weekDates();
  const today = todayStr();
  const startIdx = opts.onlyDate ? 0 : Math.max(0, week.indexOf(fromDate));
  const notBefore = opts.notBefore && /^\d{1,2}:\d{2}$/.test(opts.notBefore) ? toMin(opts.notBefore) : null;

  const ist = nowIST();
  const nowMin = ist.getHours() * 60 + ist.getMinutes();

  for (let i = startIdx; i < week.length; i++) {
    const date = week[i];
    const dow = dowOf(date);
    // recurring: same day is fine; other days only if the task doesn't already run there
    if (t.kind === 'recurring' && date !== fromDate && (t.days || []).includes(dow)) continue;
    const dayBlocks = blocks.filter(b => b.days.includes(dow)).map(b => [toMin(b.start), toMin(b.end)]);
    /* NOTE: the excluded item is intentionally kept busy — see docstring above */
    const busy = q.scheduleFor(date)
      .filter(r => r.status !== 'dropped' && r.status !== 'moved' && r.source !== 'fixed')
      .map(r => [toMin(r.start), toMin(r.end)]);
    let floor = dw[0];
    if (date === today && nowMin > dw[0]) floor = Math.min(roundUp(nowMin + GRAN), dw[1]);
    // "not before" applies only to the day the owner is constrained (the fromDate)
    if (notBefore !== null && date === fromDate) floor = Math.max(floor, notBefore);
    const free = freeIntervals([floor, dw[1]], dayBlocks, busy);
    const slot = fitInto(free, dur, pref) || fitInto(free, dur, null);
    if (slot) return { date, start: toHHMM(slot[0]), end: toHHMM(slot[1]) };
  }
  return null;
}

/* "19:05" → "7:05pm" — for LLM prompts, briefings, chat confirmations */
function fmt12(hhmm) {
  if (!hhmm) return '';
  let [h, m] = String(hhmm).split(':').map(Number);
  if (h >= 24) h -= 24;
  const ap = h >= 12 ? 'pm' : 'am';
  let hr = h % 12; if (hr === 0) hr = 12;
  return m ? `${hr}:${String(m).padStart(2, '0')}${ap}` : `${hr}${ap}`;
}

module.exports = { planWeek, proposeSlot, toMin, toHHMM, fmt12 };
