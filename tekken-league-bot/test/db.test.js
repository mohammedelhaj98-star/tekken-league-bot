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

  const overrideCols = db.prepare("PRAGMA table_info(admin_match_overrides)").all().map((c) => c.name);
  assert.equal(overrideCols.includes('score_code'), true);
  assert.equal(overrideCols.includes('active'), true);
  assert.equal(overrideCols.includes('winner_selected'), true);

  db.close();
});
