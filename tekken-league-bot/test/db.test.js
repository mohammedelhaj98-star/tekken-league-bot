const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { initDb } = require('../src/db');

test('initDb migrates legacy matches schema before creating indexes', () => {
  const db = new Database(':memory:');

  // Simulate legacy DB schema where matches table exists but lacks new columns.
  db.exec(`
    CREATE TABLE leagues (
      league_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Qatar',
      season_days INTEGER NOT NULL DEFAULT 20,
      attendance_min_days INTEGER NOT NULL DEFAULT 15,
      eligibility_min_percent REAL NOT NULL DEFAULT 0.75,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE matches (
      match_id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL,
      fixture_id INTEGER NOT NULL,
      player_a_discord_id TEXT NOT NULL,
      player_b_discord_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      thread_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
  `);

  // Should not throw "no such column: match_message_id" anymore.
  initDb(db);

  const cols = db.prepare("PRAGMA table_info(matches)").all().map((c) => c.name);
  assert.equal(cols.includes('guild_id'), true);
  assert.equal(cols.includes('match_channel_id'), true);
  assert.equal(cols.includes('match_message_id'), true);

  db.close();
});


test('initDb creates admin override and rematch vote tables', () => {
  const db = new Database(':memory:');
  initDb(db);

  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admin_match_overrides','rematch_votes') ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(names, ['admin_match_overrides', 'rematch_votes']);

  db.close();
});

test('initDb adds configurable points columns and admin override control columns', () => {
  const db = new Database(':memory:');
  initDb(db);

  const leagueCols = db.prepare("PRAGMA table_info(leagues)").all().map((c) => c.name);
  assert.equal(leagueCols.includes('points_win'), true);
  assert.equal(leagueCols.includes('points_loss'), true);
  assert.equal(leagueCols.includes('points_no_show'), true);
  assert.equal(leagueCols.includes('points_sweep_bonus'), true);
  assert.equal(leagueCols.includes('tournament_start_date'), true);
  assert.equal(leagueCols.includes('auto_unready_minutes'), true);

  const overrideCols = db.prepare("PRAGMA table_info(admin_match_overrides)").all().map((c) => c.name);
  assert.equal(overrideCols.includes('score_code'), true);
  assert.equal(overrideCols.includes('active'), true);
  assert.equal(overrideCols.includes('winner_selected'), true);

  db.close();
});


test('initDb adds player allowance bonus and power ranking columns', () => {
  const db = new Database(':memory:');
  initDb(db);

  const playerCols = db.prepare("PRAGMA table_info(players)").all().map((c) => c.name);
  assert.equal(playerCols.includes('allowance_bonus_days'), true);
  assert.equal(playerCols.includes('dq_count'), true);
  assert.equal(playerCols.includes('power_player_rating'), true);
  assert.equal(playerCols.includes('league_strength_score'), true);
  assert.equal(playerCols.includes('ranked_strength_score'), true);
  assert.equal(playerCols.includes('activity_momentum_score'), true);
  assert.equal(playerCols.includes('reliability_index_score'), true);
  assert.equal(playerCols.includes('seeding_restriction'), true);
  assert.equal(playerCols.includes('seeding_asterisk'), true);

  const guildCols = db.prepare("PRAGMA table_info(guild_settings)").all().map((c) => c.name);
  assert.equal(guildCols.includes('power_rankings_channel_id'), true);
  assert.equal(guildCols.includes('power_rankings_message_ids_json'), true);
  assert.equal(guildCols.includes('power_rankings_last_hash'), true);

  db.close();
});
