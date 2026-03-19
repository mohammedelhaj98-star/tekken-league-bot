const { WavuApiService, normalizeTekken8Id } = require('./wavu-api');

async function syncPlayerWavuData(db, discordUserId, { leagueId = 1, wavuApi = new WavuApiService() } = {}) {
  const player = db.prepare(`
    SELECT discord_user_id, tekken8_id
    FROM players
    WHERE league_id = ? AND discord_user_id = ?
  `).get(leagueId, String(discordUserId));

  if (!player) return { ok: false, reason: 'player_not_found' };
  if (!player.tekken8_id) {
    db.prepare(`
      UPDATE players
      SET wavu_linked = 0, ranked_source = 'unavailable'
      WHERE league_id = ? AND discord_user_id = ?
    `).run(leagueId, String(discordUserId));
    return { ok: false, reason: 'unlinked' };
  }

  const lookup = await wavuApi.lookupByTekken8Id(player.tekken8_id);
  if (!lookup.ok || !lookup.value) {
    db.prepare(`
      UPDATE players
      SET wavu_linked = 0, ranked_source = 'unavailable'
      WHERE league_id = ? AND discord_user_id = ?
    `).run(leagueId, String(discordUserId));
    return { ok: false, reason: 'wavu_unavailable', detail: lookup };
  }

  const v = lookup.value;
  db.prepare(`
    UPDATE players
    SET
      wavu_player_id = ?,
      tekken_name = ?,
      tekken_platform = ?,
      ranked_tier_score = ?,
      ranked_recent_win_rate = ?,
      ranked_recent_matches = ?,
      ranked_recent_activity = ?,
      ranked_source = 'wavu',
      wavu_linked = 1,
      last_wavu_sync_at = datetime('now')
    WHERE league_id = ? AND discord_user_id = ?
  `).run(
    v.wavuPlayerId,
    v.tekkenName,
    v.tekkenPlatform,
    v.rankedTierScore,
    v.rankedRecentWinRate,
    v.rankedRecentMatches,
    v.rankedRecentActivity,
    leagueId,
    String(discordUserId),
  );

  return { ok: true, reason: 'synced', value: v };
}

async function syncAllLinkedPlayersWavuData(db, { leagueId = 1, wavuApi = new WavuApiService() } = {}) {
  const players = db.prepare(`
    SELECT discord_user_id, tekken8_id
    FROM players
    WHERE league_id = ?
  `).all(leagueId);

  let changed = 0;
  const results = [];
  for (const p of players) {
    if (!p.tekken8_id) {
      results.push({ discordUserId: p.discord_user_id, ok: false, reason: 'unlinked' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await syncPlayerWavuData(db, p.discord_user_id, { leagueId, wavuApi });
    if (r.ok) changed += 1;
    results.push({ discordUserId: p.discord_user_id, ...r });
  }

  return { ok: true, changed, total: players.length, results };
}

function parseTekken8Id(raw) {
  return normalizeTekken8Id(raw);
}

module.exports = {
  syncPlayerWavuData,
  syncAllLinkedPlayersWavuData,
  parseTekken8Id,
};
