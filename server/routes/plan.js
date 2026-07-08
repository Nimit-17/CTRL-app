/* /api/plan — generate / fetch / edit the weekly timetable. */
const express = require('express');
const { q, todayStr, weekDates } = require('../db');
const { planWeek, proposeSlot } = require('../scheduler');
const { complete } = require('../brain');

const router = express.Router();

function planPayload() {
  const dates = weekDates();
  return {
    dates,
    items: q.scheduleRange(dates[0], dates[6]),
    tasks: q.allTasks(),
    arcs: q.allArcs(),
    today: todayStr(),
  };
}

router.get('/', (_req, res) => res.json(planPayload()));

/* POST /api/plan — run the deterministic planner; LLM adds a short rationale.
   body: { scope: 'week' | 'today', rationale: bool (default true) } */
router.post('/', async (req, res) => {
  const scope = req.body?.scope === 'today' ? 'today' : 'week';
  const { items, overflow } = planWeek(scope === 'today' ? { days: [todayStr()] } : {});

  let rationale = null, provider = null;
  if (req.body?.rationale !== false && items.length > 0) {
    const tasks = q.allTasks();
    const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
    const summary = items.filter(i => i.status !== 'moved').slice(0, 60)
      .map(i => `${i.date} ${i.start}-${i.end} ${i.source === 'fixed' ? '[fixed] ' + i.label : (byId[i.task_id]?.name || i.label)}`)
      .join('\n');
    const r = await complete({
      system: 'You are AXIS, a personal scheduling co-pilot. In ONE short paragraph (3-4 sentences, no markdown, no list), explain the logic of this schedule: what got prioritized and why, and anything that could not be placed. Confident and concise.',
      messages: [{ role: 'user', content: `Schedule:\n${summary}\n\nUnplaceable (overflow): ${overflow.map(o => `${o.name} on ${o.date}`).join(', ') || 'none'}` }],
    });
    if (!r.fallback) { rationale = r.text; provider = r.provider; }
  }
  res.json({ ...planPayload(), overflow, rationale, provider });
});

/* PUT /api/plan/item/:id — move / drop / complete a single schedule row */
router.put('/item/:id', (req, res) => {
  const item = q.getScheduleItem(req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const patch = {};
  if (b.date && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) patch.date = b.date;
  if (b.start && /^\d{2}:\d{2}$/.test(b.start)) patch.start = b.start;
  if (b.end && /^\d{2}:\d{2}$/.test(b.end)) patch.end = b.end;
  if (['pending', 'done', 'moved', 'dropped'].includes(b.status)) patch.status = b.status;
  q.updateScheduleItem(item.id, patch);
  res.json({ item: q.getScheduleItem(item.id) });
});

/* POST /api/plan/propose — { task_id, from_date?, exclude_item_id? } → next viable slot */
router.post('/propose', (req, res) => {
  const { task_id, from_date, exclude_item_id } = req.body || {};
  if (!task_id) return res.status(400).json({ error: 'task_id required' });
  const slot = proposeSlot(task_id, from_date || todayStr(), exclude_item_id || null);
  res.json({ slot }); // slot may be null = nothing fits this week
});

module.exports = router;
