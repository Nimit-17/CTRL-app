/* CTRL server: static PWA plus stateless AI helpers. Personal data stays in the browser. */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const express = require('express');
const { classifyTask } = require('./classify');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

app.use('/api/chat', require('./routes/chat'));
app.post('/api/tasks/classify', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const classified = await classifyTask(text);
  if (!classified) return res.status(503).json({ error: 'llm_unavailable', message: 'AXIS could not classify right now - add the task manually or retry.' });
  res.json(classified);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

const PUB = path.join(__dirname, '..', 'public');
app.use(express.static(PUB, { maxAge: '1h', setHeaders: (res, file) => { if (file.endsWith('sw.js') || file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('*', (_req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.use((err, _req, res, _next) => {
  console.error('[server] error:', err.message);
  res.status(500).json({ error: 'internal' });
});

const PORT = +process.env.PORT || 8787;
app.listen(PORT, () => console.log(`[server] CTRL local-first app listening on http://localhost:${PORT}`));
