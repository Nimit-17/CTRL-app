/* /api/chat — AXIS conversation. The LLM understands messy language and decides
   WHAT should happen; deterministic code (scheduler) decides WHERE things land.

   Two ways a move happens:
   - disruption: LLM flags affected items → client renders keep/move/drop cards
     (nothing changes until the owner taps a button).
   - move_item: the owner has ALREADY told AXIS what to do in words ("push gym to
     later today", "move it to tomorrow"). The server applies it immediately via the
     scheduler and states the concrete new time back in chat — the LLM never invents
     a time itself. */
const express = require('express');
const { q, todayStr, todayDow, weekDates, dowOf } = require('../db');
const { completeJson } = require('../brain');
const { proposeSlot, fmt12 } = require('../scheduler');

const router = express.Router();
const DF = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DFS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

router.get('/', (_req, res) => {
  res.json({ messages: q.recentMessages(80) });
});

function buildContext() {
  const today = todayStr();
  const tasks = q.allTasks();
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  const todayRows = q.scheduleFor(today).filter(r => r.status !== 'moved' && r.status !== 'dropped');
  const done = new Set(q.completionsFor(today).map(c => c.task_id));
  const prefs = q.allPrefs();
  const blocks = q.allBlocks();

  const rowLine = r => {
    const nm = r.source === 'fixed' ? `[FIXED] ${r.label}` : (byId[r.task_id]?.name || r.label);
    const st = r.status === 'done' || (r.task_id && done.has(r.task_id)) ? ' (done)' : '';
    return `- id=${r.id} ${fmt12(r.start)}-${fmt12(r.end)} ${nm}${st}`;
  };
  const scheduleTxt = todayRows.map(rowLine).join('\n') || '(no schedule generated for today)';

  // compact week view so AXIS can answer "when is gym this week" / move across days
  const week = weekDates();
  const weekTxt = week.map(d => {
    const rows = q.scheduleFor(d).filter(r => r.status !== 'moved' && r.status !== 'dropped');
    const label = d === today ? `${DFS[dowOf(d)]} ${d} (today)` : `${DFS[dowOf(d)]} ${d}`;
    const items = rows.map(r => `${fmt12(r.start)} ${r.source === 'fixed' ? '[FIXED] ' + r.label : (byId[r.task_id]?.name || r.label)}`).join(', ') || '—';
    return `  ${label}: ${items}`;
  }).join('\n');

  const tasksTxt = tasks.slice(0, 40).map(t => {
    const days = t.kind === 'recurring' ? ` days=[${(t.days || []).map(d => DFS[d]).join(',')}]` : ` dates=[${(t.dates || []).join(',')}]`;
    return `- id=${t.id} "${t.name}" ${t.kind}${days} ${t.minutes}min prio=${t.priority}${t.preferred_window ? ' window=' + t.preferred_window : ''}`;
  }).join('\n') || '(none)';

  const blocksTxt = blocks.map(b => `- "${b.label}" days=[${b.days.map(d => DFS[d]).join(',')}] ${fmt12(b.start)}-${fmt12(b.end)}`).join('\n') || '(none)';

  return { today, tasks, byId, todayRows, scheduleTxt, weekTxt, tasksTxt, blocksTxt, prefs };
}

const SYSTEM_TEMPLATE = (ctx, profile) => `You are AXIS — the owner's personal scheduling co-pilot inside his CTRL app. Calm, sharp, direct; a competent chief-of-staff, not a cheerleader. Keep replies SHORT (1-3 sentences). No markdown, no bullet lists. Use 12-hour times with am/pm (e.g. "8:15pm"), never 24-hour.

TODAY: ${DF[todayDow()]}, ${ctx.today} (Asia/Kolkata). Owner: ${profile?.name || 'the owner'}.
DAY WINDOW (awake hours): ${ctx.prefs.day_window}.
FIXED BLOCKS (immovable):
${ctx.blocksTxt}
TODAY'S SCHEDULE (source of truth — read times from here, never guess):
${ctx.scheduleTxt}
THIS WEEK:
${ctx.weekTxt}
TASKS:
${ctx.tasksTxt}

Return ONLY a JSON object:
{
 "reply": string,           // what you say. When you move/schedule something, do NOT state a specific new time — the scheduler assigns it and the app appends the confirmed time. Just acknowledge (e.g. "Done — pushing gym to later today.").
 "action": null | {
   "type": "disruption",           // owner is delayed/blocked and it's unclear which items to move — let the app show keep/move/drop cards
   "affected_item_ids": [".."]     // schedule row ids from TODAY'S SCHEDULE that are now at risk; PLANNED items only, never FIXED
 } | {
   "type": "move_item",            // owner has clearly said to move ONE specific scheduled item — apply it now
   "item_id": "..",                // the id= of that row in TODAY'S SCHEDULE
   "scope": "today" | "week",      // "today" = later the same day only; "week" = allow another day
   "not_before": "HH:MM" | null    // 24h floor if the owner is busy until a time ("in office till 8" -> "20:00")
 } | {
   "type": "update_pref",          // lasting preference change (sleep schedule / day window / briefing times)
   "key": "day_window" | "briefing_morning" | "briefing_evening",
   "value": string                 // day_window as "HH:MM-HH:MM" 24h (midnight = 24:00); times as "HH:MM"
 } | {
   "type": "plan_week"
 } | {
   "type": "plan_today"
 } | {
   "type": "add_task",
   "text": string                  // the task description verbatim, for the classifier
 }
}

Rules:
- If the owner names ONE item and says to move/push/reschedule it (or answers "today"/"tomorrow"/"later" to your reschedule question), use move_item with the right item_id. Recurring items like gym can only move LATER THE SAME DAY or to a day they don't already run — never twice on one day; use scope accordingly ("today" for a same-day push).
- If the owner says something vague like "I'm 2 hours behind" affecting several items, use disruption.
- "In office till 8", "stuck till 6" etc. is a not_before constraint on the affected item(s).
- Sleep-schedule changes → update_pref with the new day_window.
- Never claim a specific new time yourself; the app confirms it. If nothing is actionable, action is null.`;

/* Apply a move_item: returns { applied, name, from, to } or { applied:false, name, reason } */
function applyMove(action, ctx) {
  const row = ctx.todayRows.find(r => r.id === action.item_id && r.source === 'planned' && r.task_id);
  if (!row) return null; // bad id — let the reply stand alone
  const t = ctx.byId[row.task_id];
  const scope = action.scope === 'week' ? 'week' : 'today';
  const slot = proposeSlot(row.task_id, row.date, row.id, {
    onlyDate: scope === 'today' ? row.date : undefined,
    notBefore: action.not_before || null,
  });
  if (!slot) {
    return { applied: false, name: t?.name || row.label, scope };
  }
  q.updateScheduleItem(row.id, { date: slot.date, start: slot.start, end: slot.end, status: 'pending' });
  return { applied: true, name: t?.name || row.label, from: { date: row.date, start: row.start, end: row.end }, to: slot };
}

router.post('/', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });

  q.insertMessage('user', text);
  const ctx = buildContext();
  const profile = q.getProfile();
  const history = q.recentMessages(14)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const r = await completeJson({
    system: SYSTEM_TEMPLATE(ctx, profile),
    messages: history.length ? history : [{ role: 'user', content: text }],
  });

  if (!r.data || typeof r.data.reply !== 'string') {
    const fallback = "I'm offline right now (both AI providers unreachable). Your schedule and tasks still work — try me again in a few minutes.";
    q.insertMessage('assistant', fallback, { fallback: true });
    return res.json({ reply: fallback, action: null, fallback: true });
  }

  let { reply, action = null } = r.data;
  let enriched = null;

  if (action?.type === 'disruption' && Array.isArray(action.affected_item_ids)) {
    const valid = ctx.todayRows.filter(row =>
      action.affected_item_ids.includes(row.id) && row.source === 'planned' && row.status === 'pending' && row.task_id
    );
    enriched = {
      type: 'disruption',
      items: valid.map(row => {
        const t = ctx.byId[row.task_id];
        const slot = proposeSlot(row.task_id, ctx.today, row.id);
        return {
          item_id: row.id, task_id: row.task_id, name: t?.name || row.label,
          current: { date: row.date, start: row.start, end: row.end },
          proposal: slot,
        };
      }),
    };
    if (enriched.items.length === 0) enriched = null;
  } else if (action?.type === 'move_item' && action.item_id) {
    const res2 = applyMove(action, ctx);
    if (res2?.applied) {
      const sameDay = res2.to.date === res2.from.date;
      const when = sameDay ? `${fmt12(res2.to.start)} today` : `${DFS[dowOf(res2.to.date)]} at ${fmt12(res2.to.start)}`;
      reply = `${reply}\n\n✓ ${res2.name} moved to ${when}.`;
      enriched = { type: 'move_applied', name: res2.name, to: res2.to, from: res2.from };
      console.log(`[chat] moved ${res2.name} -> ${res2.to.date} ${res2.to.start}`);
    } else if (res2 && !res2.applied) {
      reply = `${reply}\n\nI couldn't find a free slot ${res2.scope === 'today' ? 'later today' : 'this week'} for ${res2.name} — want to keep it where it is, or drop it?`;
      enriched = { type: 'move_failed', name: res2.name };
    }
  } else if (action?.type === 'update_pref') {
    const ALLOWED = ['day_window', 'briefing_morning', 'briefing_evening'];
    if (ALLOWED.includes(action.key) && typeof action.value === 'string' && action.value.length < 20) {
      q.setPref(action.key, action.value);
      enriched = { type: 'update_pref', key: action.key, value: action.value, applied: true };
      console.log(`[chat] pref updated by AXIS: ${action.key}=${action.value}`);
    }
  } else if (action?.type === 'plan_week' || action?.type === 'plan_today' || action?.type === 'add_task') {
    enriched = action;
  }

  q.insertMessage('assistant', reply, { action: enriched, provider: r.provider });
  res.json({ reply, action: enriched, provider: r.provider });
});

module.exports = router;
