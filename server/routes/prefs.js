/* /api/prefs — key/value preferences + fixed blocks CRUD. */
const express = require('express');
const { q } = require('../db');

const router = express.Router();

router.get('/', (_req, res) => res.json({ prefs: q.allPrefs(), blocks: q.allBlocks() }));

router.post('/', (req, res) => {
  const updates = req.body || {};
  const ALLOWED = ['day_window', 'briefing_morning', 'briefing_evening', 'rules'];
  for (const [k, v] of Object.entries(updates)) {
    if (ALLOWED.includes(k)) q.setPref(k, v);
  }
  res.json({ prefs: q.allPrefs() });
});

/* fixed blocks */
router.post('/blocks', (req, res) => {
  const b = req.body || {};
  if (!b.label || !b.start || !b.end) return res.status(400).json({ error: 'label, start, end required' });
  if (!/^\d{2}:\d{2}$/.test(b.start) || !/^\d{2}:\d{2}$/.test(b.end)) return res.status(400).json({ error: 'start/end must be HH:MM' });
  const id = b.id || 'b' + Date.now().toString(36);
  q.insertBlock({ id, label: String(b.label).slice(0, 80), days: Array.isArray(b.days) ? b.days : [], start: b.start, end: b.end });
  res.json({ blocks: q.allBlocks() });
});

router.put('/blocks/:id', (req, res) => {
  const ok = q.updateBlock(req.params.id, req.body || {});
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ blocks: q.allBlocks() });
});

router.delete('/blocks/:id', (req, res) => {
  q.deleteBlock(req.params.id);
  res.json({ blocks: q.allBlocks() });
});

module.exports = router;
