/* retention.js — bounded SQLite growth. Never touches profile, arcs, prefs, wins, loops, push_subs.
   Safe by design: each prune is scoped; failures are logged, never thrown to callers. */
const { q, todayStr } = require('./db');

/** Max rows kept in messages (UI + DB). LLM context uses the newest 14 only. */
const MESSAGES_MAX = 20;
const MESSAGES_LLM = 14;

function runRetention() {
  const today = todayStr();
  const report = {
    messages: 0,
    schedule: 0,
    completions: 0,
    tasks: 0,
    at: today,
  };

  try { report.messages = q.trimMessages(MESSAGES_MAX); } catch (e) {
    console.warn('[retention] trimMessages:', e.message);
  }
  try { report.schedule = q.pruneScheduleBefore(today); } catch (e) {
    console.warn('[retention] pruneScheduleBefore:', e.message);
  }
  try { report.completions = q.pruneCompletionsBefore(today); } catch (e) {
    console.warn('[retention] pruneCompletionsBefore:', e.message);
  }
  try { report.tasks = q.pruneCompletedOneoffs(today); } catch (e) {
    console.warn('[retention] pruneCompletedOneoffs:', e.message);
  }

  const total = report.messages + report.schedule + report.completions + report.tasks;
  if (total > 0) {
    console.log(`[retention] pruned messages=${report.messages} schedule=${report.schedule} completions=${report.completions} tasks=${report.tasks}`);
  }
  return report;
}

module.exports = { runRetention, MESSAGES_MAX, MESSAGES_LLM };
