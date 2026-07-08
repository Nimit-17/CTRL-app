/* /api/tasks — CRUD + /classify (NL → structured task JSON) + completions. */
const express = require('express');
const { q, todayStr, todayDow } = require('../db');
const { completeJson } = require('../brain');

const router = express.Router();
const DF = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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

  const today = todayStr();
  const system = `You classify a user's natural-language task into strict JSON. Today is ${DF[todayDow()]}, ${today} (timezone Asia/Kolkata).
Return ONLY a JSON object with these fields:
{
 "kind": "recurring" | "oneoff",        // recurring habit vs one-time dated task
 "type": "check" | "count",              // count only if there's a numeric daily target like "8 glasses"
 "name": string,                          // short clean task name, no dates/times in it
 "days": [0-6],                           // recurring only; 0=Sunday..6=Saturday; "daily" = [0,1,2,3,4,5,6]; "weekdays" = [1,2,3,4,5]
 "dates": ["YYYY-MM-DD"],               // oneoff only; resolve relative dates ("thursday", "tomorrow") to the NEXT occurrence from today
 "minutes": int,                          // estimated session length, default 30
 "target": int, "unit": string,          // count type only
 "preferred_window": "morning"|"afternoon"|"evening"|"HH:MM-HH:MM"|null,  // if a time is given like "4pm" use "16:00-17:00"
 "priority": 1|2|3|4|5                    // 1 = most urgent; default 3
}
Rules: if the text mentions a specific date or a single occasion (appointment, meeting, errand) it is oneoff. Habits/routines ("daily", "every", "3x a week") are recurring. Never invent fields.`;

  const r = await completeJson({ system, messages: [{ role: 'user', content: text }] });
  if (!r.data || r.data.error) {
    return res.status(503).json({ error: 'llm_unavailable', message: 'AXIS could not classify right now — add the task manually or retry.' });
  }
  const d = r.data;
  // sanitize
  const out = {
    kind: d.kind === 'oneoff' ? 'oneoff' : 'recurring',
    type: d.type === 'count' ? 'count' : 'check',
    name: String(d.name || text).slice(0, 120),
    days: Array.isArray(d.days) ? d.days.filter(x => Number.isInteger(x) && x >= 0 && x <= 6) : [],
    dates: Array.isArray(d.dates) ? d.dates.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)) : [],
    minutes: Math.max(5, +d.minutes || 30),
    target: Math.max(1, +d.target || 1),
    unit: d.unit || 'times',
    preferred_window: d.preferred_window || null,
    priority: Math.min(5, Math.max(1, +d.priority || 3)),
  };
  if (out.kind === 'oneoff' && out.dates.length === 0) out.dates = [today];
  if (out.kind === 'recurring' && out.days.length === 0) out.days = [0, 1, 2, 3, 4, 5, 6];
  res.json({ classified: out, provider: r.provider });
});

module.exports = router;
