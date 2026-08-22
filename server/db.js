/* SQLite layer — better-sqlite3, synchronous, single file.
   Weekday indexing everywhere: 0=Sun … 6=Sat (same as the old app).
   The "day" boundary is 3am — see time.js-style helpers below. */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'ctrl.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT, goal TEXT, identity TEXT, season TEXT, blocker TEXT,
  xp INTEGER DEFAULT 0, streak INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'recurring',   -- recurring | oneoff
  type TEXT NOT NULL DEFAULT 'check',       -- check | count
  minutes INTEGER DEFAULT 30,
  target INTEGER DEFAULT 1,
  unit TEXT DEFAULT 'times',
  days TEXT DEFAULT '[]',                   -- JSON weekday indices (recurring)
  dates TEXT DEFAULT '[]',                  -- JSON ISO dates (oneoff)
  arc_id TEXT,
  arc_pct INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 3,               -- 1 highest … 5 lowest
  preferred_window TEXT,                    -- morning|afternoon|evening|HH:MM-HH:MM
  archived INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS arcs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  deadline TEXT,                            -- free text or ISO date
  color TEXT DEFAULT 'orange',
  completed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS completions (
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,                       -- ISO date (3am-rollover day)
  count INTEGER DEFAULT 1,
  PRIMARY KEY (task_id, date)
);
CREATE TABLE IF NOT EXISTS wins (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  arc_id TEXT,
  date TEXT
);
CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  priority TEXT DEFAULT 'brewing',          -- burning | brewing | dormant
  closed INTEGER DEFAULT 0,
  how TEXT,                                 -- done | delegated | dropped
  date TEXT,
  closed_date TEXT
);
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS fixed_blocks (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  days TEXT DEFAULT '[]',                   -- JSON weekday indices
  start TEXT NOT NULL,                      -- HH:MM
  end TEXT NOT NULL                         -- HH:MM
);
CREATE TABLE IF NOT EXISTS schedule (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,                       -- ISO date
  start TEXT NOT NULL,                      -- HH:MM
  end TEXT NOT NULL,
  task_id TEXT,                             -- null for fixed blocks
  label TEXT,                               -- display label (fixed blocks / fallback)
  source TEXT DEFAULT 'planned',            -- fixed | planned
  status TEXT DEFAULT 'pending'             -- pending | done | moved | dropped
);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule(date);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,                       -- user | assistant | system
  content TEXT NOT NULL,
  meta TEXT,                                -- JSON: pending actions, provider, etc.
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  sub TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

/* ── default preferences ── */
const DEFAULT_PREFS = {
  day_window: '08:00-24:00',      // owner is awake 8am–midnight
  briefing_morning: '08:00',
  briefing_evening: '21:00',
  timezone: 'Asia/Kolkata',
};
const insPref = db.prepare('INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_PREFS)) insPref.run(k, v);

/* ── time helpers (IST + 3am rollover, mirrors old app's _now/TODAY/TSTR) ── */
const TZ = 'Asia/Kolkata';
function nowIST() {
  // Date whose UTC fields read as IST wall-clock time
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}
function logicalNow() {
  const d = nowIST();
  d.setHours(d.getHours() - 3); // day resets at 3am
  return d;
}
function todayStr() {
  const d = logicalNow();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayDow() { return logicalNow().getDay(); }
function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(iso, n) {
  const [y, m, dd] = iso.split('-').map(Number);
  const d = new Date(y, m - 1, dd + n);
  return dateToStr(d);
}
function dowOf(iso) {
  const [y, m, dd] = iso.split('-').map(Number);
  return new Date(y, m - 1, dd).getDay();
}
/* Week = today .. today+6 (rolling week, always plans forward) */
function weekDates() {
  const t = todayStr();
  return Array.from({ length: 7 }, (_, i) => addDays(t, i));
}

/* ── row (de)serializers ── */
function parseTask(r) {
  if (!r) return null;
  return { ...r, days: JSON.parse(r.days || '[]'), dates: JSON.parse(r.dates || '[]'), archived: !!r.archived };
}
function parseArc(r) { return r ? { ...r, completed: !!r.completed } : null; }
function parseLoop(r) { return r ? { ...r, closed: !!r.closed } : null; }
function parseBlock(r) { return r ? { ...r, days: JSON.parse(r.days || '[]') } : null; }

const q = {
  /* profile */
  getProfile: () => db.prepare('SELECT * FROM profile WHERE id=1').get() || null,
  upsertProfile(p) {
    db.prepare(`INSERT INTO profile (id,name,goal,identity,season,blocker,xp,streak)
      VALUES (1,@name,@goal,@identity,@season,@blocker,@xp,@streak)
      ON CONFLICT(id) DO UPDATE SET name=@name,goal=@goal,identity=@identity,season=@season,blocker=@blocker,xp=@xp,streak=@streak`)
      .run({ name: null, goal: null, identity: null, season: null, blocker: null, xp: 0, streak: 1, ...p });
  },
  addXp(n) { db.prepare('UPDATE profile SET xp = xp + ? WHERE id=1').run(n); },

  /* tasks */
  allTasks: () => db.prepare('SELECT * FROM tasks WHERE archived=0 ORDER BY created_at').all().map(parseTask),
  getTask: id => parseTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id)),
  insertTask(t) {
    db.prepare(`INSERT INTO tasks (id,name,kind,type,minutes,target,unit,days,dates,arc_id,arc_pct,priority,preferred_window)
      VALUES (@id,@name,@kind,@type,@minutes,@target,@unit,@days,@dates,@arc_id,@arc_pct,@priority,@preferred_window)`)
      .run({ kind: 'recurring', type: 'check', minutes: 30, target: 1, unit: 'times', arc_id: null, arc_pct: 0, priority: 3, preferred_window: null, ...t, days: JSON.stringify(t.days || []), dates: JSON.stringify(t.dates || []) });
  },
  updateTask(id, t) {
    const cur = q.getTask(id);
    if (!cur) return false;
    const m = { ...cur, ...t };
    db.prepare(`UPDATE tasks SET name=@name,kind=@kind,type=@type,minutes=@minutes,target=@target,unit=@unit,
      days=@days,dates=@dates,arc_id=@arc_id,arc_pct=@arc_pct,priority=@priority,preferred_window=@preferred_window WHERE id=@id`)
      .run({ ...m, id, days: JSON.stringify(m.days || []), dates: JSON.stringify(m.dates || []) });
    return true;
  },
  deleteTask(id) {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
    db.prepare('DELETE FROM completions WHERE task_id=?').run(id);
    db.prepare("DELETE FROM schedule WHERE task_id=? AND status='pending'").run(id);
  },

  /* completions */
  completionsFor: date => db.prepare('SELECT * FROM completions WHERE date=?').all(date),
  allCompletions: () => db.prepare('SELECT * FROM completions').all(),
  completionCount: taskId => db.prepare('SELECT COUNT(*) c FROM completions WHERE task_id=?').get(taskId).c,
  setCompletion(taskId, date, count) {
    if (count <= 0) db.prepare('DELETE FROM completions WHERE task_id=? AND date=?').run(taskId, date);
    else db.prepare('INSERT INTO completions (task_id,date,count) VALUES (?,?,?) ON CONFLICT(task_id,date) DO UPDATE SET count=?').run(taskId, date, count, count);
  },

  /* arcs */
  allArcs: () => db.prepare('SELECT * FROM arcs ORDER BY created_at').all().map(parseArc),
  getArc: id => parseArc(db.prepare('SELECT * FROM arcs WHERE id=?').get(id)),
  insertArc(a) { db.prepare('INSERT INTO arcs (id,name,deadline,color,completed) VALUES (@id,@name,@deadline,@color,@completed)').run({ deadline: null, color: 'orange', completed: 0, ...a, completed: a.completed ? 1 : 0 }); },
  updateArc(id, a) {
    const cur = q.getArc(id); if (!cur) return false;
    const m = { ...cur, ...a };
    db.prepare('UPDATE arcs SET name=@name,deadline=@deadline,color=@color,completed=@completed WHERE id=@id')
      .run({ ...m, id, completed: m.completed ? 1 : 0 });
    return true;
  },
  deleteArc(id) {
    db.prepare('DELETE FROM arcs WHERE id=?').run(id);
    db.prepare('UPDATE tasks SET arc_id=NULL, arc_pct=0 WHERE arc_id=?').run(id);
  },

  /* wins */
  allWins: () => db.prepare('SELECT * FROM wins ORDER BY rowid DESC').all(),
  insertWin(w) { db.prepare('INSERT INTO wins (id,text,arc_id,date) VALUES (@id,@text,@arc_id,@date)').run({ arc_id: null, date: null, ...w }); },
  deleteWin(id) { db.prepare('DELETE FROM wins WHERE id=?').run(id); },

  /* loops */
  allLoops: () => db.prepare('SELECT * FROM loops ORDER BY rowid DESC').all().map(parseLoop),
  insertLoop(l) { db.prepare('INSERT INTO loops (id,text,priority,closed,how,date,closed_date) VALUES (@id,@text,@priority,@closed,@how,@date,@closed_date)').run({ priority: 'brewing', closed: 0, how: null, date: null, closed_date: null, ...l, closed: l.closed ? 1 : 0 }); },
  updateLoop(id, l) {
    const cur = parseLoop(db.prepare('SELECT * FROM loops WHERE id=?').get(id)); if (!cur) return false;
    const m = { ...cur, ...l };
    db.prepare('UPDATE loops SET text=@text,priority=@priority,closed=@closed,how=@how,closed_date=@closed_date WHERE id=@id')
      .run({ ...m, id, closed: m.closed ? 1 : 0 });
    return true;
  },
  deleteLoop(id) { db.prepare('DELETE FROM loops WHERE id=?').run(id); },

  /* preferences */
  getPref: key => { const r = db.prepare('SELECT value FROM preferences WHERE key=?').get(key); return r ? r.value : null; },
  allPrefs: () => Object.fromEntries(db.prepare('SELECT key,value FROM preferences').all().map(r => [r.key, r.value])),
  setPref(key, value) { db.prepare('INSERT INTO preferences (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?').run(key, String(value), String(value)); },

  /* fixed blocks */
  allBlocks: () => db.prepare('SELECT * FROM fixed_blocks').all().map(parseBlock),
  insertBlock(b) { db.prepare('INSERT INTO fixed_blocks (id,label,days,start,end) VALUES (@id,@label,@days,@start,@end)').run({ ...b, days: JSON.stringify(b.days || []) }); },
  updateBlock(id, b) {
    const cur = parseBlock(db.prepare('SELECT * FROM fixed_blocks WHERE id=?').get(id)); if (!cur) return false;
    const m = { ...cur, ...b };
    db.prepare('UPDATE fixed_blocks SET label=@label,days=@days,start=@start,end=@end WHERE id=@id')
      .run({ ...m, id, days: JSON.stringify(m.days || []) });
    return true;
  },
  deleteBlock(id) { db.prepare('DELETE FROM fixed_blocks WHERE id=?').run(id); },

  /* schedule */
  scheduleRange: (from, to) => db.prepare('SELECT * FROM schedule WHERE date>=? AND date<=? ORDER BY date,start').all(from, to),
  scheduleFor: date => db.prepare('SELECT * FROM schedule WHERE date=? ORDER BY start').all(date),
  getScheduleItem: id => db.prepare('SELECT * FROM schedule WHERE id=?').get(id),
  clearPlanned(from, to) { db.prepare("DELETE FROM schedule WHERE date>=? AND date<=?").run(from, to); },
  insertScheduleItem(s) {
    db.prepare('INSERT INTO schedule (id,date,start,end,task_id,label,source,status) VALUES (@id,@date,@start,@end,@task_id,@label,@source,@status)')
      .run({ task_id: null, label: null, source: 'planned', status: 'pending', ...s });
  },
  updateScheduleItem(id, s) {
    const cur = q.getScheduleItem(id); if (!cur) return false;
    const m = { ...cur, ...s };
    db.prepare('UPDATE schedule SET date=@date,start=@start,end=@end,task_id=@task_id,label=@label,source=@source,status=@status WHERE id=@id').run({ ...m, id });
    return true;
  },
  deleteScheduleItem(id) { db.prepare('DELETE FROM schedule WHERE id=?').run(id); },

  /* messages — trimmed to 20 rows after every insert (see retention.js) */
  recentMessages: n => db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(n).reverse(),
  trimMessages(max) {
    const before = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
    if (before <= max) return 0;
    const r = db.prepare(
      'DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)'
    ).run(max);
    return r.changes;
  },
  insertMessage(role, content, meta) {
    const r = db.prepare('INSERT INTO messages (role,content,meta) VALUES (?,?,?)').run(role, content, meta ? JSON.stringify(meta) : null);
    q.trimMessages(20);
    return r.lastInsertRowid;
  },

  /* retention helpers — never touch profile, arcs, preferences, wins, loops, push_subs */
  pruneScheduleBefore(today) {
    return db.prepare('DELETE FROM schedule WHERE date < ?').run(today).changes;
  },
  pruneCompletionsBefore(today) {
    /* profile.xp is stored separately; only today's completions affect live UI ticks */
    return db.prepare('DELETE FROM completions WHERE date < ?').run(today).changes;
  },
  pruneCompletedOneoffs(today) {
    const rows = db.prepare("SELECT id, dates FROM tasks WHERE kind='oneoff' AND archived=0").all();
    let n = 0;
    for (const row of rows) {
      const dates = JSON.parse(row.dates || '[]');
      if (!dates.length || dates.some(d => d >= today)) continue;
      const done = db.prepare('SELECT 1 FROM completions WHERE task_id=? AND count>0 LIMIT 1').get(row.id);
      if (!done) continue;
      q.deleteTask(row.id);
      n++;
    }
    return n;
  },

  /* push */
  allSubs: () => db.prepare('SELECT * FROM push_subs').all().map(r => JSON.parse(r.sub)),
  insertSub(sub) { db.prepare('INSERT INTO push_subs (endpoint,sub) VALUES (?,?) ON CONFLICT(endpoint) DO UPDATE SET sub=excluded.sub').run(sub.endpoint, JSON.stringify(sub)); },
  deleteSub(endpoint) { db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(endpoint); },

  isEmpty: () => !db.prepare('SELECT 1 FROM profile WHERE id=1').get() && db.prepare('SELECT COUNT(*) c FROM tasks').get().c === 0,
};

module.exports = { db, q, todayStr, todayDow, addDays, dowOf, weekDates, dateToStr, nowIST, TZ };
