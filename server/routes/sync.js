/* /api/sync — seed SQLite from browser localStorage once, then server is source of truth. */
const express = require('express');
const { db, q, todayStr } = require('../db');

const router = express.Router();

function seedFromState(S) {
  const tx = db.transaction(() => {
    const p = S.profile || S.aAnswers || {};
    q.upsertProfile({
      name: p.name || null, goal: p.goal || null, identity: p.identity || null,
      season: p.season || null, blocker: p.blocker || null,
      xp: p.xp || S.xp || 0, streak: p.streak || S.streak || 1,
    });

    for (const a of S.arcs || []) {
      try {
        q.insertArc({
          id: String(a.id), name: a.name || 'Untitled arc',
          deadline: a.deadline || null, color: a.color || 'orange', completed: !!a.completed,
        });
      } catch {}
    }

    for (const t of S.tasks || []) {
      try {
        q.insertTask({
          id: String(t.id),
          name: t.name || 'Untitled',
          kind: t.kind === 'oneoff' ? 'oneoff' : 'recurring',
          type: t.type === 'count' ? 'count' : 'check',
          minutes: t.minutes || 30,
          target: t.target || 1,
          unit: t.unit || 'times',
          days: Array.isArray(t.days) ? t.days : [],
          dates: Array.isArray(t.dates) ? t.dates : [],
          arc_id: (t.arc_id || t.arcId) ? String(t.arc_id || t.arcId) : null,
          arc_pct: t.arc_pct || t.arcPct || 0,
          priority: Math.min(5, Math.max(1, +t.priority || 3)),
          preferred_window: t.preferred_window || null,
        });
        for (const d of t.completedDates || []) q.setCompletion(String(t.id), d, 1);
      } catch {}
    }

    const counts = S.counts || S.comp || {};
    for (const [key, n] of Object.entries(counts)) {
      const i = key.lastIndexOf('_');
      if (i < 0) continue;
      const taskId = key.slice(0, i), date = key.slice(i + 1);
      if (n > 0) q.setCompletion(taskId, date, n);
    }
    for (const c of S.completions || []) {
      if (c?.task_id && c?.date && c.count > 0) q.setCompletion(String(c.task_id), c.date, c.count);
    }

    for (const w of S.wins || []) {
      try {
        q.insertWin({
          id: String(w.id), text: w.text || '',
          arc_id: (w.arc_id || w.arcId) ? String(w.arc_id || w.arcId) : null,
          date: w.date || null,
        });
      } catch {}
    }

    for (const l of S.loops || []) {
      try {
        q.insertLoop({
          id: String(l.id), text: l.text || '', priority: l.priority || 'brewing',
          closed: !!l.closed, how: l.how || null,
          date: l.date || null, closed_date: l.closed_date || l.closedDate || null,
        });
      } catch {}
    }

    const prefs = S.prefs || {};
    for (const [k, v] of Object.entries(prefs)) {
      if (['day_window', 'briefing_morning', 'briefing_evening', 'rules', 'timezone'].includes(k) && v != null) {
        q.setPref(k, v);
      }
    }

    for (const b of S.blocks || []) {
      try {
        q.insertBlock({
          id: String(b.id),
          label: b.label || 'Block',
          days: Array.isArray(b.days) ? b.days : [],
          start: b.start, end: b.end,
        });
      } catch {}
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
  if (q.isEmpty() && (S.tasks?.length || S.profile || S.arcs?.length || S.blocks?.length)) {
    try {
      seedFromState(S);
      seeded = true;
      console.log(`[sync] seeded DB: ${S.tasks?.length || 0} tasks, ${S.arcs?.length || 0} arcs, ${S.blocks?.length || 0} blocks`);
    } catch (e) {
      console.error('[sync] seed failed:', e.message);
      return res.status(500).json({ error: 'seed_failed', detail: e.message });
    }
  }
  res.json({ seeded, state: serverState() });
});

router.get('/', (_req, res) => res.json({ state: serverState() }));

module.exports = router;
