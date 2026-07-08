/* /api/sync — one-time seed of the DB from the old localStorage `S` object.
   Only seeds when the DB is empty; afterwards returns current server state
   so the client can adopt the server as source of truth. */
const express = require('express');
const { db, q, todayStr } = require('../db');

const router = express.Router();

function seedFromState(S) {
  const tx = db.transaction(() => {
    // profile
    const p = S.profile || S.aAnswers || {};
    q.upsertProfile({
      name: p.name || null, goal: p.goal || null, identity: p.identity || null,
      season: p.season || null, blocker: p.blocker || null,
      xp: S.xp || 0, streak: S.streak || 1,
    });
    // arcs
    for (const a of S.arcs || []) {
      q.insertArc({ id: String(a.id), name: a.name || 'Untitled arc', deadline: a.deadline || null, color: a.color || 'orange', completed: !!a.completed });
    }
    // tasks (all legacy tasks are recurring)
    for (const t of S.tasks || []) {
      q.insertTask({
        id: String(t.id), name: t.name || 'Untitled', kind: 'recurring', type: t.type === 'count' ? 'count' : 'check',
        minutes: t.minutes || 30, target: t.target || 1, unit: t.unit || 'times',
        days: Array.isArray(t.days) ? t.days : [], dates: [],
        arc_id: t.arcId ? String(t.arcId) : null, arc_pct: t.arcPct || 0,
        priority: 3, preferred_window: null,
      });
      // check-type completions
      for (const d of t.completedDates || []) q.setCompletion(String(t.id), d, 1);
    }
    // count-type completions live in S.counts as "taskId_YYYY-MM-DD" → n
    for (const [key, n] of Object.entries(S.counts || {})) {
      const i = key.lastIndexOf('_');
      if (i < 0) continue;
      const taskId = key.slice(0, i), date = key.slice(i + 1);
      if (n > 0) q.setCompletion(taskId, date, n);
    }
    // wins
    for (const w of S.wins || []) {
      q.insertWin({ id: String(w.id), text: w.text || '', arc_id: w.arcId ? String(w.arcId) : null, date: w.date || null });
    }
    // loops
    for (const l of S.loops || []) {
      q.insertLoop({
        id: String(l.id), text: l.text || '', priority: l.priority || 'brewing',
        closed: !!l.closed, how: l.how || null, date: l.date || null, closed_date: l.closedDate || null,
      });
    }
  });
  tx();
}

function serverState() {
  return {
    profile: q.getProfile(),
    tasks: q.allTasks(),
    arcs: q.allArcs(),
    completions: q.allCompletions(),
    wins: q.allWins(),
    loops: q.allLoops(),
    prefs: q.allPrefs(),
    blocks: q.allBlocks(),
    today: todayStr(),
  };
}

router.post('/', (req, res) => {
  const S = req.body || {};
  let seeded = false;
  if (q.isEmpty() && (S.tasks?.length || S.profile || S.arcs?.length)) {
    try {
      seedFromState(S);
      seeded = true;
      console.log(`[sync] seeded DB: ${S.tasks?.length || 0} tasks, ${S.arcs?.length || 0} arcs, ${S.wins?.length || 0} wins, ${S.loops?.length || 0} loops`);
    } catch (e) {
      console.error('[sync] seed failed:', e.message);
      return res.status(500).json({ error: 'seed_failed', detail: e.message });
    }
  }
  res.json({ seeded, state: serverState() });
});

/* GET /api/sync — full state pull (used on every app load after migration) */
router.get('/', (_req, res) => res.json({ state: serverState() }));

module.exports = router;
