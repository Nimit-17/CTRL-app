/* jobs.js — proactive briefings via node-cron, pinned to Asia/Kolkata.
   Morning 08:00: "here's your day". Evening 21:00: "N tasks unticked — move or drop?"
   Both are inserted into AXIS chat AND sent as web push. */
const cron = require('node-cron');
const { q, todayStr, todayDow, TZ } = require('./db');
const { complete } = require('./brain');
const { sendToAll } = require('./push');
const { runRetention } = require('./retention');

function todaysAgenda() {
  const date = todayStr();
  const rows = q.scheduleFor(date).filter(r => r.status !== 'moved' && r.status !== 'dropped');
  const tasks = q.allTasks();
  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));
  const done = new Set(q.completionsFor(date).map(c => c.task_id));
  return { date, rows, byId, done };
}

async function morningBriefing() {
  try {
    const { rows, byId, done } = todaysAgenda();
    const profile = q.getProfile() || {};
    const lines = rows.map(r => `${r.start}-${r.end} ${r.source === 'fixed' ? `[fixed] ${r.label}` : (byId[r.task_id]?.name || r.label)}`);
    let text;
    if (rows.length === 0) {
      text = `Morning${profile.name ? ', ' + profile.name : ''}. No schedule generated for today yet — open the Plan tab and hit "Plan my week", or just tell me what's on.`;
    } else {
      const r = await complete({
        system: 'You are AXIS, a calm, sharp personal scheduling co-pilot. Write a SHORT morning briefing (3-5 sentences max, no markdown headers). Confident, warm, zero fluff.',
        messages: [{ role: 'user', content: `Owner: ${profile.name || 'the owner'}. Season: ${profile.season || '-'}. Today's schedule:\n${lines.join('\n')}\nAlready done: ${[...done].map(id => byId[id]?.name).filter(Boolean).join(', ') || 'nothing yet'}.\nWrite the morning briefing.` }],
      });
      text = r.fallback
        ? `Morning. ${rows.length} block${rows.length !== 1 ? 's' : ''} on today's schedule:\n${lines.join('\n')}`
        : r.text;
    }
    q.insertMessage('assistant', text, { kind: 'briefing_morning' });
    await sendToAll({ title: 'AXIS — Morning Briefing', body: text.slice(0, 170), tag: 'briefing', url: '/?tab=axis' });
    console.log('[jobs] morning briefing sent');
  } catch (e) { console.error('[jobs] morning briefing failed:', e.message); }
}

async function eveningCheckin() {
  try {
    const { rows, byId, done } = todaysAgenda();
    const planned = rows.filter(r => r.source === 'planned' && r.task_id);
    const unticked = planned.filter(r => !done.has(r.task_id) && r.status !== 'done');
    let text;
    if (planned.length === 0) {
      text = 'Evening check-in: nothing was scheduled today. If tomorrow needs a plan, say "plan my week".';
    } else if (unticked.length === 0) {
      text = 'Evening check-in: everything scheduled today is done. Clean sweep — log a win if something stood out.';
    } else {
      const names = unticked.map(r => byId[r.task_id]?.name || r.label);
      const r = await complete({
        system: 'You are AXIS, a calm personal scheduling co-pilot. Write a SHORT evening check-in (2-4 sentences, no markdown). Mention the unfinished tasks by name and ask whether to move them to another day this week or drop them. Not preachy.',
        messages: [{ role: 'user', content: `Unfinished today: ${names.join(', ')}. Write the evening check-in.` }],
      });
      text = r.fallback
        ? `Evening check-in: ${names.length} task${names.length !== 1 ? 's' : ''} unticked — ${names.join(', ')}. Move or drop? Tell me here.`
        : r.text;
    }
    q.insertMessage('assistant', text, { kind: 'briefing_evening' });
    await sendToAll({ title: 'AXIS — Evening Check-in', body: text.slice(0, 170), tag: 'briefing', url: '/?tab=axis' });
    console.log('[jobs] evening check-in sent');
  } catch (e) { console.error('[jobs] evening check-in failed:', e.message); }
}

function start() {
  const morning = q.getPref('briefing_morning') || '08:00';
  const evening = q.getPref('briefing_evening') || '21:00';
  const [mh, mm] = morning.split(':');
  const [eh, em] = evening.split(':');
  cron.schedule(`${+mm} ${+mh} * * *`, morningBriefing, { timezone: TZ });
  cron.schedule(`${+em} ${+eh} * * *`, eveningCheckin, { timezone: TZ });
  /* 03:00 IST — prune past schedule/completions, completed one-offs, trim messages */
  cron.schedule('0 3 * * *', () => runRetention(), { timezone: TZ });
  console.log(`[jobs] briefings scheduled ${morning} & ${evening} ${TZ}; retention daily 03:00 ${TZ}`);
  runRetention();
}

module.exports = { start, morningBriefing, eveningCheckin };
