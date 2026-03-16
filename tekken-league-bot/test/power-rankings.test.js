const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { initDb } = require('../src/db');
const { reliabilityFromDqCount, recalculateAndStorePowerRankings, generateSeedsFromPowerRankings } = require('../src/power-rankings');

test('reliabilityFromDqCount follows required penalty ladder', () => {
  assert.equal(reliabilityFromDqCount(0), 100);
  assert.equal(reliabilityFromDqCount(1), 75);
  assert.equal(reliabilityFromDqCount(2), 40);
  assert.equal(reliabilityFromDqCount(3), 0);
  assert.equal(reliabilityFromDqCount(4), 0);
});

test('recalculateAndStorePowerRankings uses baseline league strength for players with no league participation', () => {
  const db = new Database(':memory:');
  initDb(db);

  db.prepare(`
    INSERT INTO players (league_id, discord_user_id, tekken_tag, real_name_enc, email_enc, phone_enc, ranked_tier_score, ranked_recent_win_rate, ranked_recent_matches, ranked_recent_activity)
    VALUES (1, 'u1', 'NoLeague', 'a', 'b', 'c', 70, 60, 20, 0.5)
  `).run();

  const rankings = recalculateAndStorePowerRankings(db, 1);
  assert.equal(rankings.length, 1);
  const row = rankings[0];
  assert.equal(Math.round(Number(row.league_strength_score)), 50);

  db.close();
});


test('league-disqualified players get maximum DQ penalty behavior regardless of dq_count', () => {
  const db = new Database(':memory:');
  initDb(db);

  db.prepare(`
    INSERT INTO players (
      league_id, discord_user_id, tekken_tag, real_name_enc, email_enc, phone_enc,
      status, dq_count, ranked_tier_score, ranked_recent_win_rate, ranked_recent_matches, ranked_recent_activity
    ) VALUES (1, 'dq1', 'DQPlayer', 'a', 'b', 'c', 'disqualified', 1, 80, 70, 25, 0.8)
  `).run();

  const rankings = recalculateAndStorePowerRankings(db, 1);
  assert.equal(rankings.length, 1);
  assert.equal(Number(rankings[0].reliability_index_score), 0);
  assert.equal(rankings[0].seeding_restriction, 'lowest_seed_pool');
  assert.equal(Number(rankings[0].seeding_asterisk), 1);

  db.close();
});

test('generateSeedsFromPowerRankings applies DQ-based hard seeding rules', () => {
  const rankings = [
    { discord_user_id: 'a', tekken_tag: 'A', power_player_rating: 99, dq_count: 0, seeding_restriction: 'none', seeding_asterisk: 0 },
    { discord_user_id: 'b', tekken_tag: 'B', power_player_rating: 95, dq_count: 2, seeding_restriction: 'bottom_quarter_cap', seeding_asterisk: 0 },
    { discord_user_id: 'c', tekken_tag: 'C', power_player_rating: 90, dq_count: 0, seeding_restriction: 'none', seeding_asterisk: 0 },
    { discord_user_id: 'd', tekken_tag: 'D', power_player_rating: 80, dq_count: 3, seeding_restriction: 'lowest_seed_pool', seeding_asterisk: 1 },
  ];

  const seeds = generateSeedsFromPowerRankings(rankings);
  assert.equal(seeds[seeds.length - 1].discord_user_id, 'd');
  assert.equal(seeds[seeds.length - 1].seeding_asterisk, 1);
});
