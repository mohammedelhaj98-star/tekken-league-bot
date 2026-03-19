const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { initDb } = require('../src/db');
const { WavuApiService, normalizeTekken8Id, isValidTekken8Id } = require('../src/services/wavu-api');
const { syncPlayerWavuData } = require('../src/services/wavu-sync');

test('Tekken8 ID normalization and validation', () => {
  assert.equal(normalizeTekken8Id(' 1234-5678-abcd '), '1234-5678-ABCD');
  assert.equal(isValidTekken8Id('1234-5678-ABCD'), true);
  assert.equal(isValidTekken8Id('invalid-id'), false);
});

test('WavuApiService lookup normalizes payload from endpoint', async () => {
  const fetchFn = async (url) => ({
    ok: url.includes('/api/player/'),
    status: url.includes('/api/player/') ? 200 : 404,
    text: async () => JSON.stringify({
      player: {
        id: 'wavu-1',
        name: 'RankMonster',
        platform: 'PC',
        rank_tier: 78,
        recent_win_rate: 64,
        recent_matches: 40,
      },
    }),
  });

  const svc = new WavuApiService({ fetchFn, cacheTtlMs: 1000 });
  const result = await svc.lookupByTekken8Id('1234-5678-ABCD');
  assert.equal(result.ok, true);
  assert.equal(result.value.wavuPlayerId, 'wavu-1');
  assert.equal(result.value.rankedRecentMatches, 40);
  assert.equal(result.value.rankedRecentActivity > 0, true);
});

test('syncPlayerWavuData updates player ranked fields from Wavu data', async () => {
  const db = new Database(':memory:');
  initDb(db);
  db.prepare(`
    INSERT INTO players (league_id, discord_user_id, tekken_tag, real_name_enc, email_enc, phone_enc, tekken8_id)
    VALUES (1, 'u1', 'Tag', 'a', 'b', 'c', '1234-5678-ABCD')
  `).run();

  const fetchFn = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      player: {
        id: 'wavu-2',
        name: 'Synced',
        platform: 'PS5',
        rank_tier: 66,
        recent_win_rate: 55,
        recent_matches: 12,
      },
    }),
  });

  const wavuApi = new WavuApiService({ fetchFn });
  const result = await syncPlayerWavuData(db, 'u1', { wavuApi });
  assert.equal(result.ok, true);

  const row = db.prepare('SELECT wavu_player_id, tekken_name, ranked_tier_score, ranked_source, wavu_linked FROM players WHERE discord_user_id = ?').get('u1');
  assert.equal(row.wavu_player_id, 'wavu-2');
  assert.equal(row.tekken_name, 'Synced');
  assert.equal(Number(row.ranked_tier_score), 66);
  assert.equal(row.ranked_source, 'wavu');
  assert.equal(Number(row.wavu_linked), 1);

  db.close();
});
