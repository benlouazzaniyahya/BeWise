'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.BEWIZE_DB || path.join(DATA_DIR, 'bewize.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// Schema (minimum tables from the brief, plus a couple of helper columns)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    role          TEXT NOT NULL CHECK (role IN ('admin','teacher','parent')),
    email         TEXT UNIQUE,
    password_hash TEXT,
    google_id     TEXT UNIQUE,
    language      TEXT NOT NULL DEFAULT 'en',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS children (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    child_login_id  TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    age             INTEGER NOT NULL,
    gender          TEXT NOT NULL CHECK (gender IN ('male','female')),
    profile_type    TEXT NOT NULL DEFAULT 'normale' CHECK (profile_type IN ('normale','autisme','deficience_auditive')),
    language        TEXT NOT NULL DEFAULT 'en',
    school_level    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id       INTEGER NOT NULL REFERENCES subjects(id),
    teacher_id       INTEGER NOT NULL REFERENCES users(id),
    title            TEXT NOT NULL,
    raw_lesson_text  TEXT NOT NULL,
    level            INTEGER NOT NULL DEFAULT 1,
    target_score     INTEGER NOT NULL DEFAULT 60,
    order_index      INTEGER NOT NULL DEFAULT 0,
    school_level     TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS games (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id           INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    variant             TEXT NOT NULL CHECK (variant IN ('normale','autisme','deficience_auditive')),
    gender_theme        TEXT NOT NULL DEFAULT 'neutral' CHECK (gender_theme IN ('male','female','neutral')),
    status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_review','approved','rejected')),
    template_type       TEXT NOT NULL,
    game_json           TEXT NOT NULL,
    static_version_json TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    approved_at         TEXT,
    approved_by         INTEGER REFERENCES users(id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_games_lesson_variant_gender
    ON games(lesson_id, variant, gender_theme)
    WHERE status != 'approved';

  CREATE TABLE IF NOT EXISTS attempts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id       INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    lesson_id      INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    score          REAL NOT NULL,
    max_score      REAL NOT NULL,
    answers_json   TEXT NOT NULL,
    started_at     TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_child_lesson ON attempts(child_id, lesson_id);

  CREATE TABLE IF NOT EXISTS badges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id   INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    badge_type TEXT NOT NULL,
    awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (child_id, lesson_id)
  );

  CREATE TABLE IF NOT EXISTS progress (
    child_id   INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
    lesson_id  INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    unlocked   INTEGER NOT NULL DEFAULT 0,
    best_score REAL NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked','in_progress','passed')),
    PRIMARY KEY (child_id, lesson_id)
  );

  CREATE TABLE IF NOT EXISTS gen_jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id  INTEGER NOT NULL,
    job_type   TEXT NOT NULL,
    payload    TEXT,
    status     TEXT NOT NULL DEFAULT 'pending',
    result     TEXT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// Migration: school level (CP → 6ème) on children + lessons.
// Adds the columns on pre-existing DBs and backfills from age / difficulty.
// ---------------------------------------------------------------------------
const TABLE_GRADES = { 1: 'cp', 2: 'ce1', 3: 'ce2', 4: 'cm1', 5: 'cm2', 6: 'sixieme' };
const tableColumns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

if (!tableColumns('children').includes('school_level')) {
  db.exec("ALTER TABLE children ADD COLUMN school_level TEXT;");
}
if (!tableColumns('lessons').includes('school_level')) {
  db.exec("ALTER TABLE lessons ADD COLUMN school_level TEXT;");
}

// Children: age is a separate, independent column — we do NOT guess a class
// from age (kids start school at different ages). Undefined = parent sees all.
const backfillLessonStmt = db.prepare('UPDATE lessons SET school_level = ? WHERE id = ?');
for (const l of db.prepare("SELECT id, level FROM lessons WHERE school_level IS NULL OR school_level = ''").all()) {
  backfillLessonStmt.run(TABLE_GRADES[Number(l.level)] || 'cp', l.id);
}

// ---------------------------------------------------------------------------
// Migration: legacy games (old quiz/match/fill game_json) → the fixed 3
// template architecture. Runs on boot so already-approved games stay
// playable and reviewable after the template refactor.
// ---------------------------------------------------------------------------
{
  const { convertLegacyGame, deriveStaticVersion } = require('./services/ai');
  const legacy = db.prepare('SELECT id, game_json FROM games WHERE template_type NOT IN (?, ?, ?)')
    .all('adventure_mission', 'challenge_quest', 'build_rescue');
  const saveGame = db.prepare('UPDATE games SET game_json = ?, template_type = ?, static_version_json = ?, notes = COALESCE(notes, ?) WHERE id = ?');
  for (const row of legacy) {
    let parsed = null;
    try { parsed = JSON.parse(row.game_json); } catch { /* skip malformed */ }
    if (!parsed) continue;
    const converted = convertLegacyGame(parsed);
    if (!converted) continue;
    saveGame.run(
      JSON.stringify(converted.game),
      converted.game.template,
      JSON.stringify(converted.staticVersion || deriveStaticVersion(converted.game)),
      `migrated to ${converted.game.template}`,
      row.id,
    );
  }
}

const nonNull = (row) => {
  if (row === undefined || row === null) return null;
  return row;
};

const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => nonNull(db.prepare(sql).get(...params));
const run = (sql, ...params) => db.prepare(sql).run(...params);
const transaction = (fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

module.exports = { db, DB_PATH, all, get, run, transaction };