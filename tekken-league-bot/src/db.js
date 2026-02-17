const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'league.sqlite');

function openDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

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
      max_players INTEGER NOT NULL DEFAULT 64,
      timeslot_count INTEGER NOT NULL DEFAULT 4,
      timeslot_duration_minutes INTEGER NOT NULL DEFAULT 120,
      timeslot_starts TEXT NOT NULL DEFAULT '18:00,20:00,22:00,00:00',
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
      guild_id TEXT,
      fixture_id INTEGER NOT NULL,
      player_a_discord_id TEXT NOT NULL,
      player_b_discord_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      thread_id TEXT,
      match_channel_id TEXT,
      match_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (fixture_id) REFERENCES fixtures(fixture_id)
    );

    CREATE TABLE IF NOT EXISTS match_reports (
      match_id INTEGER NOT NULL,
      reporter_discord_id TEXT NOT NULL,
      winner_side TEXT,
      score_code INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, reporter_discord_id),
      FOREIGN KEY (match_id) REFERENCES matches(match_id)
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


    CREATE TABLE IF NOT EXISTS admin_match_overrides (
      match_id INTEGER PRIMARY KEY,
      admin_discord_id TEXT NOT NULL,
      winner_side TEXT NOT NULL CHECK (winner_side IN ('A','B')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (match_id) REFERENCES matches(match_id)
    );

    CREATE TABLE IF NOT EXISTS rematch_votes (
      match_id INTEGER NOT NULL,
      discord_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (match_id, discord_user_id),
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

    CREATE TABLE IF NOT EXISTS admin_roles (
      league_id INTEGER NOT NULL,
      guild_id TEXT,
      role_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (league_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      results_channel_id TEXT,
      admin_channel_id TEXT,
      standings_channel_id TEXT,
      dispute_channel_id TEXT,
      match_format TEXT NOT NULL DEFAULT 'FT3',
      allow_public_player_commands INTEGER NOT NULL DEFAULT 1,
      tournament_name TEXT NOT NULL DEFAULT 'Tekken League',
      timezone TEXT NOT NULL DEFAULT 'Asia/Qatar',
      cleanup_policy TEXT NOT NULL DEFAULT 'keep',
      cleanup_days INTEGER,
      enable_diagnostics INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  function ensureColumn(tableName, columnName, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = cols.some(c => c.name === columnName);
    if (!exists) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`);
  }

  ensureColumn('leagues', 'max_players', 'max_players INTEGER NOT NULL DEFAULT 64');
  ensureColumn('leagues', 'timeslot_count', 'timeslot_count INTEGER NOT NULL DEFAULT 4');
  ensureColumn('leagues', 'timeslot_duration_minutes', 'timeslot_duration_minutes INTEGER NOT NULL DEFAULT 120');
  ensureColumn('leagues', 'timeslot_starts', "timeslot_starts TEXT NOT NULL DEFAULT '18:00,20:00,22:00,00:00'");
  ensureColumn('matches', 'guild_id', 'guild_id TEXT');
  ensureColumn('matches', 'match_channel_id', 'match_channel_id TEXT');
  ensureColumn('matches', 'match_message_id', 'match_message_id TEXT');
  ensureColumn('admin_roles', 'guild_id', 'guild_id TEXT');
  ensureColumn('guild_settings', 'dispute_channel_id', 'dispute_channel_id TEXT');


  const createIndexStatements = [
    "CREATE INDEX IF NOT EXISTS idx_players_league_status ON players (league_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_attendance_league_date ON attendance (league_id, date)",
    "CREATE INDEX IF NOT EXISTS idx_fixtures_league_status ON fixtures (league_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_fixtures_players_status ON fixtures (league_id, player_a_discord_id, player_b_discord_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_pending_matches_fixture ON pending_matches (fixture_id)",
    "CREATE INDEX IF NOT EXISTS idx_matches_fixture_state ON matches (fixture_id, state)",
    "CREATE INDEX IF NOT EXISTS idx_matches_players_state ON matches (league_id, player_a_discord_id, player_b_discord_id, state)",
    "CREATE INDEX IF NOT EXISTS idx_matches_message ON matches (match_message_id)",
    "CREATE INDEX IF NOT EXISTS idx_results_match_confirmed ON results (match_id, confirmed_at)",
    "CREATE INDEX IF NOT EXISTS idx_match_reports_match ON match_reports (match_id)",
    "CREATE INDEX IF NOT EXISTS idx_admin_override_match ON admin_match_overrides (match_id)",
    "CREATE INDEX IF NOT EXISTS idx_rematch_votes_match ON rematch_votes (match_id)",
    "CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON audit_log (league_id, action_type, ts)",
    "CREATE INDEX IF NOT EXISTS idx_admin_roles_league ON admin_roles (league_id)",
  ];

  for (const stmt of createIndexStatements) {
    db.exec(stmt);
  }

  // Ensure league row exists
  const league = db.prepare('SELECT league_id FROM leagues WHERE league_id = 1').get();
  if (!league) {
    const name = process.env.LEAGUE_NAME || 'Tekken Ramadan League';
    db.prepare('INSERT INTO leagues (league_id, name) VALUES (1, ?)').run(name);
  }
}

module.exports = { openDb, initDb, DB_PATH };
