-- All tables are prefixed with hunt_ so they can live in the shared IEEE ITS database.
CREATE TABLE IF NOT EXISTS hunt_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO hunt_settings (key, value) VALUES
  ('event_name', 'Hunt the Code'),
  ('status', 'draft');

CREATE TABLE IF NOT EXISTS hunt_teams (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  progress        INTEGER NOT NULL DEFAULT 0,
  last_advance_at TEXT,
  finished_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A clue is one QR station: clue_text is the riddle that leads teams TO the place where this QR is stuck.
CREATE TABLE IF NOT EXISTS hunt_clues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  clue_text  TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  is_final   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hunt_sequence (
  team_id  INTEGER NOT NULL,
  position INTEGER NOT NULL,
  clue_id  INTEGER NOT NULL,
  PRIMARY KEY (team_id, position)
);

CREATE TABLE IF NOT EXISTS hunt_participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  reg_no     TEXT NOT NULL,
  consent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS hunt_participants_team ON hunt_participants (team_id);

CREATE TABLE IF NOT EXISTS hunt_scans (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id        INTEGER NOT NULL,
  participant_id INTEGER NOT NULL,
  clue_id        INTEGER,
  result         TEXT NOT NULL,
  scanned_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS hunt_scans_team ON hunt_scans (team_id);
