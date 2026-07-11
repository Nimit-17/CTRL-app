/* Shared NL → structured-task classifier. Used by /api/tasks/classify (Tasks tab
   quick-add) and by /api/chat when AXIS adds a task conversationally. */
const { completeJson } = require('./brain');

const localDate = () => new Date(Date.now() + 5.5 * 3600e3);
const todayStr = () => localDate().toISOString().slice(0, 10);
const todayDow = () => localDate().getUTCDay();
const addDays = (date, days) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const dowOf = date => new Date(date + 'T12:00:00Z').getUTCDay();

const DF = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DFS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* "11:30am" → 690 (minutes), "12am" → 0, "12pm" → 720. null if unparseable. */
function ampmToMin(s) {
  const m = String(s).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!m) return null;
  let h = +m[1] % 12; const min = +(m[2] || 0);
  if (m[3] === 'pm') h += 12;
  return h * 60 + min;
}
function minToHHMM(v) { return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`; }

/* Normalize a preferred_window to something the scheduler understands:
   "morning"/"afternoon"/"evening", a 24h "HH:MM-HH:MM" span, or null.
   Accepts am/pm spans ("11:30am-12:30pm") and converts them. */
function normWindow(w) {
  if (!w) return null;
  const s = String(w).trim().toLowerCase();
  if (['morning', 'afternoon', 'evening', 'night'].includes(s)) return s;
  if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(s)) {           // already 24h
    const [a, b] = s.split('-').map(x => x.trim());
    return `${a.padStart(5, '0')}-${b.padStart(5, '0')}`;
  }
  const m = s.match(/^(.+?(?:am|pm))\s*-\s*(.+?(?:am|pm))$/);      // am/pm span
  if (m) {
    const a = ampmToMin(m[1]), b = ampmToMin(m[2]);
    if (a != null && b != null) return `${minToHHMM(a)}-${minToHHMM(b)}`;
  }
  return null;
}

/* Resolve a relative date phrase to an ISO date deterministically (LLMs get
   "tomorrow" wrong often enough to matter). Returns a date string or null. */
const WEEKDAY_NAMES = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
function resolveRelativeDate(text, today, nextDow) {
  const t = ' ' + text.toLowerCase() + ' ';
  if (/\bday after tomorrow\b/.test(t)) return addDays(today, 2);
  if (/\btomorrow\b/.test(t) || /\btmrw?\b/.test(t)) return addDays(today, 1);
  if (/\b(today|tonight|this (?:evening|morning|afternoon))\b/.test(t)) return today;
  for (const [name, w] of Object.entries(WEEKDAY_NAMES)) {
    if (new RegExp('\\b' + name + '\\b').test(t)) return nextDow[w];
  }
  return null;
}

async function classifyTask(text) {
  text = String(text || '').trim();
  if (!text) return null;

  const today = todayStr();
  // explicit date cheat-sheet so the model never has to compute a relative date itself
  const nextDow = {};
  for (let i = 0; i < 7; i++) { const d = addDays(today, i); const w = dowOf(d); if (nextDow[w] === undefined) nextDow[w] = d; }
  const cheat = DFS.map((n, w) => `${n}=${nextDow[w]}`).join(', ');

  const system = `You classify a user's natural-language task into strict JSON.
DATES (Asia/Kolkata): today is ${DF[todayDow()]} ${today}. tomorrow=${addDays(today, 1)}. Next occurrence of each weekday: ${cheat}. Resolve every relative date ("tomorrow","thursday","this weekend") to one of these EXACT ISO dates — never output a date you were not given here.
Return ONLY a JSON object:
{
 "kind": "recurring" | "oneoff",
 "type": "check" | "count",
 "name": string,                          // short clean task name, no dates/times in it
 "days": [0-6],                           // recurring only; 0=Sunday..6=Saturday; "daily"=[0..6]; "weekdays"=[1,2,3,4,5]
 "dates": ["YYYY-MM-DD"],               // oneoff only; use the cheat-sheet dates above
 "minutes": int,                          // ESTIMATED DURATION. Map spoken durations exactly: "an hour"/"about an hour"/"~1h"=60; "half an hour"/"30 mins"=30; "45 minutes"=45; "a couple hours"/"2 hours"=120; "90 mins"/"1.5h"=90. Only default to 30 when NO duration is stated.
 "target": int, "unit": string,          // count type only
 "preferred_window": "morning"|"afternoon"|"evening"|"HH:MM-HH:MM"|null,  // if a clock time is given ("4pm","first thing at 11:30") give a 24-HOUR span like "16:00-17:00" — NEVER use am/pm here
 "priority": 1|2|3|4|5
}
Rules: a specific date or single occasion (appointment, meeting, errand, "tomorrow") is oneoff. Habits/routines ("daily","every","3x a week") are recurring. Never invent fields.`;

  const r = await completeJson({ system, messages: [{ role: 'user', content: text }] });
  if (!r.data || r.data.error) return null;

  const d = r.data;
  const out = {
    kind: d.kind === 'oneoff' ? 'oneoff' : 'recurring',
    type: d.type === 'count' ? 'count' : 'check',
    name: String(d.name || text).slice(0, 120),
    days: Array.isArray(d.days) ? d.days.filter(x => Number.isInteger(x) && x >= 0 && x <= 6) : [],
    dates: Array.isArray(d.dates) ? d.dates.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x)) : [],
    minutes: Math.max(5, +d.minutes || 30),
    target: Math.max(1, +d.target || 1),
    unit: d.unit || 'times',
    preferred_window: normWindow(d.preferred_window),
    priority: Math.min(5, Math.max(1, +d.priority || 3)),
  };
  // deterministic relative-date override — trust code over the LLM for "tomorrow"/weekday names
  if (out.kind === 'oneoff') {
    const rd = resolveRelativeDate(text, today, nextDow);
    if (rd) out.dates = [rd];
    else if (out.dates.length === 0) out.dates = [addDays(today, 1)];
  }
  if (out.kind === 'recurring' && out.days.length === 0) out.days = [0, 1, 2, 3, 4, 5, 6];
  return { classified: out, provider: r.provider };
}

/* Resolve a relative date from arbitrary text using the current day context.
   Used by chat to correct a oneoff's date from the owner's ACTUAL message
   (the LLM's task paraphrase often drops "tomorrow"/weekday words). */
function resolveDateFromText(text) {
  const today = todayStr();
  const nextDow = {};
  for (let i = 0; i < 7; i++) { const d = addDays(today, i); const w = dowOf(d); if (nextDow[w] === undefined) nextDow[w] = d; }
  return resolveRelativeDate(String(text || ''), today, nextDow);
}

module.exports = { classifyTask, normWindow, resolveDateFromText };
