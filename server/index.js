/* CTRL server — Express, serves /public + /api. Single user, tiny footprint. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const express = require('express');

const { q, todayStr } = require('./db');
const push = require('./push');
const jobs = require('./jobs');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

/* optional owner-token gate */
const TOKEN = (process.env.OWNER_TOKEN || '').trim();
app.use('/api', (req, res, next) => {
  if (!TOKEN) return next();
  if (req.get('X-Owner-Token') === TOKEN) return next();
  res.status(401).json({ error: 'unauthorized' });
});

app.use('/api/sync', require('./routes/sync'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/prefs', require('./routes/prefs'));
app.use('/api/plan', require('./routes/plan'));
app.use('/api/chat', require('./routes/chat'));

/* wins / loops / arcs / profile — thin CRUD kept here (small enough) */
app.get('/api/arcs', (_req, res) => res.json({ arcs: q.allArcs() }));
app.post('/api/arcs', (req, res) => {
  const a = req.body || {};
  if (!a.name) return res.status(400).json({ error: 'name required' });
  const id = a.id || 'a' + Date.now().toString(36);
  q.insertArc({ id, name: a.name, deadline: a.deadline || null, color: a.color || 'orange', completed: !!a.completed });
  res.json({ arc: q.getArc(id) });
});
app.put('/api/arcs/:id', (req, res) => {
  if (!q.updateArc(req.params.id, req.body || {})) return res.status(404).json({ error: 'not found' });
  if (req.body?.completed) q.addXp(100);
  res.json({ arc: q.getArc(req.params.id) });
});
app.delete('/api/arcs/:id', (req, res) => { q.deleteArc(req.params.id); res.json({ ok: true }); });

app.get('/api/wins', (_req, res) => res.json({ wins: q.allWins() }));
app.post('/api/wins', (req, res) => {
  const w = req.body || {};
  if (!w.text) return res.status(400).json({ error: 'text required' });
  const id = 'w' + Date.now().toString(36);
  q.insertWin({ id, text: w.text, arc_id: w.arc_id || null, date: w.date || todayStr() });
  q.addXp(25);
  res.json({ wins: q.allWins() });
});
app.delete('/api/wins/:id', (req, res) => { q.deleteWin(req.params.id); res.json({ ok: true }); });

app.get('/api/loops', (_req, res) => res.json({ loops: q.allLoops() }));
app.post('/api/loops', (req, res) => {
  const l = req.body || {};
  if (!l.text) return res.status(400).json({ error: 'text required' });
  const id = 'l' + Date.now().toString(36);
  q.insertLoop({ id, text: l.text, priority: l.priority || 'brewing', date: todayStr() });
  res.json({ loops: q.allLoops() });
});
app.put('/api/loops/:id', (req, res) => {
  const patch = { ...req.body };
  if (patch.closed) patch.closed_date = todayStr();
  if (!q.updateLoop(req.params.id, patch)) return res.status(404).json({ error: 'not found' });
  res.json({ loops: q.allLoops() });
});
app.delete('/api/loops/:id', (req, res) => { q.deleteLoop(req.params.id); res.json({ ok: true }); });

app.put('/api/profile', (req, res) => {
  const cur = q.getProfile() || {};
  q.upsertProfile({ ...cur, ...req.body });
  res.json({ profile: q.getProfile() });
});
app.post('/api/profile/xp', (req, res) => {
  q.addXp(+req.body?.delta || 0);
  res.json({ profile: q.getProfile() });
});

/* push */
app.get('/api/push/key', (_req, res) => res.json({ key: push.publicKey() }));
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid subscription' });
  q.insertSub(sub);
  res.json({ ok: true });
});
/* manual triggers for testing briefings */
app.post('/api/push/test-morning', async (_req, res) => { await jobs.morningBriefing(); res.json({ ok: true }); });
app.post('/api/push/test-evening', async (_req, res) => { await jobs.eveningCheckin(); res.json({ ok: true }); });

app.get('/api/health', (_req, res) => res.json({ ok: true, today: todayStr(), rss_mb: Math.round(process.memoryUsage().rss / 1048576) }));

/* static frontend */
const PUB = path.join(__dirname, '..', 'public');
app.use(express.static(PUB, { maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('*', (_req, res) => res.sendFile(path.join(PUB, 'index.html')));

/* error guard — never leak a crash */
app.use((err, _req, res, _next) => {
  console.error('[server] error:', err.message);
  res.status(500).json({ error: 'internal', detail: err.message });
});

const PORT = +process.env.PORT || 8787;
push.init();
jobs.start(); /* also runs retention once on boot */
app.listen(PORT, () => {
  console.log(`[server] CTRL listening on http://localhost:${PORT} (rss ${Math.round(process.memoryUsage().rss / 1048576)}MB)`);
});
