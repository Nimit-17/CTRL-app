/* brain.js — the single swappable LLM seam.
   complete({system, messages, json}) → { text, provider } or { text, provider:'none', fallback:true }.
   Tries Gemini first, fails over to Groq on any error/quota, never throws. */

const GEMINI_MODEL = 'gemini-2.5-flash';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const TIMEOUT_MS = 30000;

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function callGemini({ system, messages, json }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const body = {
    system_instruction: system ? { parts: [{ text: system }] } : undefined,
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: {
      temperature: 0.4,
      ...(json ? { response_mime_type: 'application/json' } : {}),
    },
  };
  const t = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal: t.signal,
      }
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
    if (!text) throw new Error('Gemini returned empty response');
    return text;
  } finally { t.done(); }
}

async function callGroq({ system, messages, json }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  const body = {
    model: GROQ_MODEL,
    temperature: 0.4,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ],
    ...(json ? { response_format: { type: 'json_object' } } : {}),
  };
  const t = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: t.signal,
    });
    if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq returned empty response');
    return text;
  } finally { t.done(); }
}

/* Strip markdown fences some models wrap JSON in */
function cleanJson(text) {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

async function complete({ system, messages, json = false }) {
  try {
    const text = await callGemini({ system, messages, json });
    console.log(`[brain] served by gemini (${GEMINI_MODEL})`);
    return { text: json ? cleanJson(text) : text, provider: 'gemini' };
  } catch (e1) {
    console.warn(`[brain] gemini failed: ${e1.message} — failing over to groq`);
    try {
      const text = await callGroq({ system, messages, json });
      console.log(`[brain] served by groq (${GROQ_MODEL})`);
      return { text: json ? cleanJson(text) : text, provider: 'groq' };
    } catch (e2) {
      console.error(`[brain] groq also failed: ${e2.message}`);
      return {
        text: json ? '{"error":"llm_unavailable"}' : "AXIS is temporarily offline — both AI providers are unreachable. Your schedule and tasks still work; try again in a bit.",
        provider: 'none',
        fallback: true,
      };
    }
  }
}

/* completeJson — complete() with json mode + safe parse. Returns null on failure. */
async function completeJson({ system, messages }) {
  const r = await complete({ system, messages, json: true });
  if (r.fallback) return { data: null, provider: 'none', fallback: true };
  try {
    return { data: JSON.parse(r.text), provider: r.provider };
  } catch {
    // one retry: ask the other shape of the same thing via non-strict parse
    const m = r.text.match(/\{[\s\S]*\}/);
    if (m) { try { return { data: JSON.parse(m[0]), provider: r.provider }; } catch {} }
    console.error('[brain] JSON parse failed:', r.text.slice(0, 200));
    return { data: null, provider: r.provider, fallback: true };
  }
}

module.exports = { complete, completeJson };
