const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { initDb } = require('../src/db');
const { calcMatchPoints, computeStandings, generateDoubleRoundRobinFixtures } = require('../src/league');

function setupDb() {
  const db = new Database(':memory:');
  initDb(db);

  const players = [
    ['u1', 'King'],
    ['u2', 'Jin'],
    ['u3', 'Kazuya'],
  ];

  for (const [id, tag] of players) {
    db.prepare(`
      INSERT INTO players (league_id, discord_user_id, real_name_enc, tekken_tag, email_enc, phone_enc)
      VALUES (1, ?, 'x', ?, 'x', 'x')
    `).run(id, tag);
  }

  return db;
}

test('calcMatchPoints applies clean win and loser bonus correctly', () => {
  assert.deepEqual(calcMatchPoints({
    score_a: 3,
    score_b: 0,
    winner_discord_id: 'u1',
    player_a_discord_id: 'u1',
    player_b_discord_id: 'u2',
    is_forfeit: 0,
  }), { pointsA: 3, pointsB: 1 });

  assert.deepEqual(calcMatchPoints({
    score_a: 3,
    score_b: 2,
    winner_discord_id: 'u1',
    player_a_discord_id: 'u1',
    player_b_discord_id: 'u2',
    is_forfeit: 0,
  }), { pointsA: 2, pointsB: 1 });
});

test('calcMatchPoints uses custom point rules when provided', () => {
  assert.deepEqual(calcMatchPoints({
    score_a: 3,
    score_b: 0,
    winner_discord_id: 'u1',
    player_a_discord_id: 'u1',
    player_b_discord_id: 'u2',
    is_forfeit: 0,
  }, {
    points_win: 5,
    points_loss: 2,
    points_no_show: 7,
    points_sweep_bonus: 3,
  }), { pointsA: 8, pointsB: 2 });

  assert.deepEqual(calcMatchPoints({
    score_a: 0,
    score_b: 0,
    winner_discord_id: 'u2',
    player_a_discord_id: 'u1',
    player_b_discord_id: 'u2',
    is_forfeit: 1,
  }, {
    points_win: 5,
    points_loss: 2,
    points_no_show: 7,
    points_sweep_bonus: 3,
  }), { pointsA: 0, pointsB: 7 });
});

test('computeStandings ranks by points then diff then games won', () => {
  const db = setupDb();

  // Match 1: u1 beats u2 3-0 (u1 gets 3, u2 gets 1)
  db.prepare("INSERT INTO fixtures (league_id, player_a_discord_id, player_b_discord_id, leg_number, status, confirmed_at) VALUES (1,'u1','u2',1,'confirmed',datetime('now'))").run();
  db.prepare("INSERT INTO matches (league_id, fixture_id, player_a_discord_id, player_b_discord_id, state, ended_at) VALUES (1,1,'u1','u2','confirmed',datetime('now'))").run();
  db.prepare("INSERT INTO results (match_id, winner_discord_id, score_a, score_b, is_forfeit, reporter_discord_id, confirmer_discord_id, confirmed_at) VALUES (1,'u1',3,0,0,'u1','u2',datetime('now'))").run();

  // Match 2: u2 beats u3 3-2 (u2 gets 2, u3 gets 1)
  db.prepare("INSERT INTO fixtures (league_id, player_a_discord_id, player_b_discord_id, leg_number, status, confirmed_at) VALUES (1,'u2','u3',1,'confirmed',datetime('now'))").run();
  db.prepare("INSERT INTO matches (league_id, fixture_id, player_a_discord_id, player_b_discord_id, state, ended_at) VALUES (1,2,'u2','u3','confirmed',datetime('now'))").run();
  db.prepare("INSERT INTO results (match_id, winner_discord_id, score_a, score_b, is_forfeit, reporter_discord_id, confirmer_discord_id, confirmed_at) VALUES (2,'u2',3,2,0,'u2','u3',datetime('now'))").run();

  const standings = computeStandings(db, 1);
  assert.equal(standings[0].discord_user_id, 'u1');
  assert.equal(standings[0].points, 3);
  assert.equal(standings[1].discord_user_id, 'u2');
  assert.equal(standings[2].discord_user_id, 'u3');

  db.close();
});


test('generateDoubleRoundRobinFixtures can run repeatedly without duplicating history', () => {
  const db = setupDb();

  const first = generateDoubleRoundRobinFixtures(db, 1);
  assert.equal(first.ok, true);
  assert.match(first.message, /Generated 6 new fixtures/);

  const second = generateDoubleRoundRobinFixtures(db, 1);
  assert.equal(second.ok, true);
  assert.match(second.message, /No new fixtures generated/);

  const total = db.prepare('SELECT COUNT(1) AS c FROM fixtures WHERE league_id = 1').get().c;
  assert.equal(total, 6);

  db.close();
});
