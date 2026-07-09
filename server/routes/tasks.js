/* /api/tasks — CRUD + /classify (NL → structured task JSON) + completions. */
const express = require('express');
const { q, todayStr } = require('../db');
const { classifyTask } = require('../classify');

const router = express.Router();

router.get('/', (_req, res) => res.json({ tasks: q.allTasks() }));

router.post('/', (req, res) => {
  const t = req.body || {};
  if (!t.name || !String(t.name).trim()) return res.status(400).json({ error: 'name required' });
  const id = t.id || 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  q.insertTask({
    id, name: String(t.name).trim(),
    kind: t.kind === 'oneoff' ? 'oneoff' : 'recurring',
    type: t.type === 'count' ? 'count' : 'check',
    minutes: Math.max(5, +t.minutes || 30),
    target: Math.max(1, +t.target || 1),
    unit: t.unit || 'times',
    days: Array.isArray(t.days) ? t.days.filter(d => d >= 0 && d <= 6) : [],
    dates: Array.isArray(t.dates) ? t.dates : [],
    arc_id: t.arc_id || null, arc_pct: +t.arc_pct || 0,
    priority: Math.min(5, Math.max(1, +t.priority || 3)),
    preferred_window: t.preferred_window || null,
  });
  res.json({ task: q.getTask(id) });
});

router.put('/:id', (req, res) => {
  const ok = q.updateTask(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ task: q.getTask(req.params.id) });
});

router.delete('/:id', (req, res) => {
  q.deleteTask(req.params.id);
  res.json({ ok: true });
});

/* completion toggle / counter set: { date?, count } */
router.post('/:id/complete', (req, res) => {
  const t = q.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const date = req.body?.date || todayStr();
  const count = Math.max(0, +req.body?.count ?? 1);
  q.setCompletion(t.id, date, count);
  // mark matching schedule rows done/undone
  const rows = q.scheduleFor(date).filter(r => r.task_id === t.id);
  const doneNow = t.type === 'count' ? count >= (t.target || 1) : count > 0;
  for (const r of rows) q.updateScheduleItem(r.id, { status: doneNow ? 'done' : 'pending' });
  res.json({ ok: true, completions: q.completionsFor(date) });
});

/* ── NL classification ── */
router.post('/classify', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const r = await classifyTask(text);
  if (!r) return res.status(503).json({ error: 'llm_unavailable', message: 'AXIS could not classify right now — add the task manually or retry.' });
  res.json(r);
});

module.exports = router;
