const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'league.sqlite');

function openDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb(db) {
  // One-league template (league_id = 1)
  db.exec(`
    CREATE TABLE IF NOT EXISTS leagues (
      league_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Qatar',
      season_days INTEGER NOT NULL DEFAULT 20,
      attendance_min_days INTEGER NOT NULL DEFAULT 15,
      eligibility_min_percent REAL NOT NULL DEFAULT 0.75,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS players (
      player_id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      discord_user_id TEXT NOT NULL UNIQUE,
      discord_username_at_signup TEXT,
      discord_display_name_at_signup TEXT,
      discord_display_name_last_seen TEXT,
      real_name_enc TEXT NOT NULL,
      tekken_tag TEXT NOT NULL,
      email_enc TEXT NOT NULL,
      phone_enc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      signup_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (league_id) REFERENCES leagues(league_id)
    );

    CREATE TABLE IF NOT EXISTS attendance (
      league_id INTEGER NOT NULL,
      discord_user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      checked_in INTEGER NOT NULL DEFAULT 1,
      checked_in_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_id, discord_user_id, date)
    );

    CREATE TABLE IF NOT EXISTS fixtures (
      fixture_id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      player_a_discord_id TEXT NOT NULL,
      player_b_discord_id TEXT NOT NULL,
      leg_number INTEGER NOT NULL CHECK (leg_number IN (1,2)),
      status TEXT NOT NULL DEFAULT 'unplayed',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT,
      FOREIGN KEY (league_id) REFERENCES leagues(league_id)
    );

    CREATE TABLE IF NOT EXISTS ready_queue (
      league_id INTEGER NOT NULL,
      discord_user_id TEXT NOT NULL,
      since_ts TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_id, discord_user_id)
    );

    CREATE TABLE IF NOT EXISTS pending_matches (
      pending_id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      fixture_id INTEGER NOT NULL,
      player_a_discord_id TEXT NOT NULL,
      player_b_discord_id TEXT NOT NULL,
      accept_a INTEGER NOT NULL DEFAULT 0,
      accept_b INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,
      channel_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (fixture_id) REFERENCES fixtures(fixture_id)
    );

    CREATE TABLE IF NOT EXISTS matches (
      match_id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      fixture_id INTEGER NOT NULL,
      player_a_discord_id TEXT NOT NULL,
      player_b_discord_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      thread_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (fixture_id) REFERENCES fixtures(fixture_id)
    );

    CREATE TABLE IF NOT EXISTS results (
      result_id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      winner_discord_id TEXT NOT NULL,
      score_a INTEGER NOT NULL,
      score_b INTEGER NOT NULL,
      is_forfeit INTEGER NOT NULL DEFAULT 0,
      reporter_discord_id TEXT NOT NULL,
      reported_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmer_discord_id TEXT,
      confirmed_at TEXT,
      FOREIGN KEY (match_id) REFERENCES matches(match_id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      actor_discord_id TEXT,
      action_type TEXT NOT NULL,
      payload_json TEXT
    );
  `);

  // Ensure league row exists
  const league = db.prepare('SELECT league_id FROM leagues WHERE league_id = 1').get();
  if (!league) {
    const name = process.env.LEAGUE_NAME || 'Tekken Ramadan League';
    db.prepare('INSERT INTO leagues (league_id, name) VALUES (1, ?)').run(name);
  }
}

module.exports = { openDb, initDb, DB_PATH };
