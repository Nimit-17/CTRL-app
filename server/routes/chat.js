/* Stateless AXIS relay. Requests are used for this response only and are never stored. */
const express = require('express');
const { complete } = require('../brain');
const router = express.Router();

router.post('/', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const state = req.body?.state || {};
  const tasks = Array.isArray(state.tasks) ? state.tasks.slice(0, 50) : [];
  const profile = state.profile || {};
  const summary = tasks.map(t => `- ${t.name} (${t.kind || 'recurring'}, priority ${t.priority || 3})`).join('\n') || '(no tasks yet)';
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-14).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 3000) })) : [];
  const system = `You are AXIS, a concise personal planning co-pilot. The user owns all of this data locally in their browser; do not claim to save, sync, or retain it. Reply in 1-3 short sentences, no markdown. You can advise on priorities and planning. If asked to plan or create a task, tell the user to use the Plan or Tasks tab; never claim an action was applied. User: ${profile.name || 'there'}. Local task context:\n${summary}`;
  const result = await complete({ system, messages: [...history, { role: 'user', content: text }] });
  const reply = result.fallback ? "I'm unavailable right now. Your data is still safely stored on this device." : result.text;
  res.json({ reply, action: null, provider: result.provider });
});

module.exports = router;
