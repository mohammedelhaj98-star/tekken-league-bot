const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function getRecentWindowStart(days = 28) {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

function reliabilityFromDqCount(dqCount) {
  const dqs = Math.max(0, Math.trunc(Number(dqCount) || 0));
  if (dqs <= 0) return 100;
  if (dqs === 1) return 75;
  if (dqs === 2) return 40;
  return 0;
}

function getPlayerBaseRows(db, leagueId = 1) {
  return db.prepare(`
    SELECT
      discord_user_id,
      tekken_tag,
      discord_display_name_last_seen,
      status,
      dq_count,
      ranked_tier_score,
      ranked_recent_win_rate,
      ranked_recent_matches,
      ranked_recent_activity
    FROM players
    WHERE league_id = ?
  `).all(leagueId);
}

function getConfirmedMatches(db, leagueId = 1) {
  return db.prepare(`
    SELECT
      m.match_id,
      m.player_a_discord_id,
      m.player_b_discord_id,
      r.winner_discord_id,
      r.score_a,
      r.score_b,
      r.confirmed_at
    FROM matches m
    JOIN results r ON r.match_id = m.match_id
    WHERE m.league_id = ? AND r.confirmed_at IS NOT NULL
  `).all(leagueId);
}

function getRecentAttendanceCounts(db, leagueId = 1, recentStartIso = getRecentWindowStart(28)) {
  const rows = db.prepare(`
    SELECT discord_user_id, COUNT(1) AS count
    FROM attendance
    WHERE league_id = ? AND checked_in = 1 AND checked_in_at >= ?
    GROUP BY discord_user_id
  `).all(leagueId, recentStartIso);
  return new Map(rows.map((r) => [r.discord_user_id, Number(r.count || 0)]));
}

function buildLeagueMatchStats(matches) {
  const stats = new Map();
  const add = (id, pointsEarned, setWin, roundDiff, oppId) => {
    if (!stats.has(id)) {
      stats.set(id, {
        matchesPlayed: 0,
        pointsEarnedSum: 0,
        setWins: 0,
        roundDiffSum: 0,
        opponents: [],
      });
    }
    const row = stats.get(id);
    row.matchesPlayed += 1;
    row.pointsEarnedSum += pointsEarned;
    row.setWins += setWin;
    row.roundDiffSum += roundDiff;
    row.opponents.push(oppId);
  };

  for (const m of matches) {
    const aWon = m.winner_discord_id === m.player_a_discord_id;
    const bWon = m.winner_discord_id === m.player_b_discord_id;
    const aSweepLoss = bWon && Number(m.score_b) === 3 && Number(m.score_a) === 0;
    const bSweepLoss = aWon && Number(m.score_a) === 3 && Number(m.score_b) === 0;

    const pointsA = aWon ? (Number(m.score_a) === 3 && Number(m.score_b) === 0 ? 3 : 2) : (aSweepLoss ? 0 : 1);
    const pointsB = bWon ? (Number(m.score_b) === 3 && Number(m.score_a) === 0 ? 3 : 2) : (bSweepLoss ? 0 : 1);

    add(m.player_a_discord_id, pointsA, aWon ? 1 : 0, Number(m.score_a) - Number(m.score_b), m.player_b_discord_id);
    add(m.player_b_discord_id, pointsB, bWon ? 1 : 0, Number(m.score_b) - Number(m.score_a), m.player_a_discord_id);
  }

  return stats;
}

function buildPerPlayerOpponentPpm(leagueStats) {
  const ppm = new Map();
  for (const [id, st] of leagueStats.entries()) {
    const v = st.matchesPlayed > 0 ? st.pointsEarnedSum / st.matchesPlayed : 0;
    ppm.set(id, v);
  }
  return ppm;
}

function calculatePowerComponents(row, context) {
  const leagueStats = context.leagueStats.get(row.discord_user_id);
  const hasLeagueParticipation = !!leagueStats && leagueStats.matchesPlayed > 0;

  let leagueStrength = 50;
  if (hasLeagueParticipation) {
    const ppmNorm = clamp((leagueStats.pointsEarnedSum / leagueStats.matchesPlayed) / 3 * 100);
    const setWinPct = clamp((leagueStats.setWins / leagueStats.matchesPlayed) * 100);
    const roundDiffNorm = clamp(((leagueStats.roundDiffSum / leagueStats.matchesPlayed) + 3) / 6 * 100);

    const oppPpmValues = leagueStats.opponents.map((oppId) => context.playerPpm.get(oppId) || 0);
    const avgOppPpm = oppPpmValues.length
      ? oppPpmValues.reduce((a, b) => a + b, 0) / oppPpmValues.length
      : 0;
    const sosNorm = context.maxPpm > 0 ? clamp((avgOppPpm / context.maxPpm) * 100) : 50;

    leagueStrength = clamp(
      (0.40 * ppmNorm)
      + (0.25 * setWinPct)
      + (0.20 * roundDiffNorm)
      + (0.15 * sosNorm)
    );
  }

  const rankTier = clamp(row.ranked_tier_score);
  const rankedWinRate = clamp(row.ranked_recent_win_rate);
  const volumeConfidence = clamp((Math.min(Number(row.ranked_recent_matches || 0), 50) / 50) * 100);
  const rankedStrength = clamp((0.55 * rankTier) + (0.25 * rankedWinRate) + (0.20 * volumeConfidence));

  const recentRankedActivity = clamp(Math.max(Number(row.ranked_recent_activity || 0) * 100, volumeConfidence));
  const recentLeagueActivity = clamp(((context.recentAttendanceCounts.get(row.discord_user_id) || 0) / 28) * 100);
  const recentResultsCount = context.recentResultsCounts.get(row.discord_user_id) || 0;
  const recentResultsTrend = clamp((recentResultsCount / 20) * 100);
  const activityMomentum = clamp((0.50 * recentRankedActivity) + (0.30 * recentLeagueActivity) + (0.20 * recentResultsTrend));

  const reliabilityIndex = clamp(reliabilityFromDqCount(row.dq_count));
  const totalPowerPlayerRating = clamp(
    (0.45 * leagueStrength)
    + (0.25 * rankedStrength)
    + (0.15 * activityMomentum)
    + (0.15 * reliabilityIndex)
  );

  const dqCount = Math.max(0, Math.trunc(Number(row.dq_count) || 0));
  const seedingRestriction = dqCount >= 3
    ? 'lowest_seed_pool'
    : dqCount >= 2
      ? 'bottom_quarter_cap'
      : 'none';

  return {
    leagueStrength,
    rankedStrength,
    activityMomentum,
    reliabilityIndex,
    totalPowerPlayerRating,
    seedingRestriction,
    seedingAsterisk: dqCount >= 3 ? 1 : 0,
    dqCount,
  };
}

function recalculateAndStorePowerRankings(db, leagueId = 1) {
  const players = getPlayerBaseRows(db, leagueId);
  const matches = getConfirmedMatches(db, leagueId);
  const recentStart = getRecentWindowStart(28);
  const recentAttendanceCounts = getRecentAttendanceCounts(db, leagueId, recentStart);

  const leagueStats = buildLeagueMatchStats(matches);
  const playerPpm = buildPerPlayerOpponentPpm(leagueStats);
  const maxPpm = Math.max(0, ...playerPpm.values());

  const recentResultsCounts = new Map();
  for (const m of matches) {
    if (String(m.confirmed_at) < recentStart) continue;
    recentResultsCounts.set(m.player_a_discord_id, (recentResultsCounts.get(m.player_a_discord_id) || 0) + 1);
    recentResultsCounts.set(m.player_b_discord_id, (recentResultsCounts.get(m.player_b_discord_id) || 0) + 1);
  }

  const context = {
    leagueStats,
    playerPpm,
    maxPpm,
    recentAttendanceCounts,
    recentResultsCounts,
  };

  const tx = db.transaction((rows) => {
    const update = db.prepare(`
      UPDATE players
      SET
        league_strength_score = ?,
        ranked_strength_score = ?,
        activity_momentum_score = ?,
        reliability_index_score = ?,
        power_player_rating = ?,
        seeding_restriction = ?,
        seeding_asterisk = ?
      WHERE league_id = ? AND discord_user_id = ?
    `);

    for (const row of rows) {
      const c = calculatePowerComponents(row, context);
      update.run(
        c.leagueStrength,
        c.rankedStrength,
        c.activityMomentum,
        c.reliabilityIndex,
        c.totalPowerPlayerRating,
        c.seedingRestriction,
        c.seedingAsterisk,
        leagueId,
        row.discord_user_id,
      );
    }
  });

  tx(players);
  return getPowerRankings(db, leagueId);
}

function getPowerRankings(db, leagueId = 1) {
  return db.prepare(`
    SELECT
      discord_user_id,
      tekken_tag,
      discord_display_name_last_seen,
      status,
      dq_count,
      league_strength_score,
      ranked_strength_score,
      activity_momentum_score,
      reliability_index_score,
      power_player_rating,
      seeding_restriction,
      seeding_asterisk
    FROM players
    WHERE league_id = ?
    ORDER BY power_player_rating DESC, reliability_index_score DESC, tekken_tag ASC
  `).all(leagueId);
}

function generateSeedsFromPowerRankings(rankings, entrantsCount = null) {
  const entrants = Number.isFinite(Number(entrantsCount)) && Number(entrantsCount) > 0
    ? rankings.slice(0, Math.trunc(Number(entrantsCount)))
    : [...rankings];

  if (!entrants.length) return [];

  const total = entrants.length;
  const cutoff = Math.ceil(total * 0.75);

  const eligibleTop = entrants.filter((r) => r.seeding_restriction === 'none');
  const dq2 = entrants.filter((r) => r.seeding_restriction === 'bottom_quarter_cap');
  const dq3 = entrants.filter((r) => r.seeding_restriction === 'lowest_seed_pool');

  const seeds = [];
  for (const row of eligibleTop) seeds.push(row);

  while (seeds.length < cutoff && dq2.length) {
    seeds.push(dq2.shift());
  }

  for (const row of dq2) seeds.push(row);
  for (const row of dq3) seeds.push(row);

  return seeds.map((row, idx) => ({
    seed: idx + 1,
    discord_user_id: row.discord_user_id,
    tekken_tag: row.tekken_tag,
    power_player_rating: row.power_player_rating,
    dq_count: row.dq_count,
    seeding_restriction: row.seeding_restriction,
    seeding_asterisk: row.seeding_asterisk,
  }));
}

function buildPowerRankingsTablePages(rankings, { pageSize = 20, includeTimestamp = true } = {}) {
  if (!rankings.length) return ['**Power Player Rankings**\nNo players found.'];

  const rows = rankings.map((r, i) => {
    const name = (r.discord_display_name_last_seen || r.tekken_tag || r.discord_user_id || '').slice(0, 18);
    const dqMark = Number(r.seeding_asterisk) ? '*' : '';
    return `${String(i + 1).padStart(3, ' ')} ${(name + dqMark).padEnd(19, ' ')} ${Number(r.power_player_rating || 0).toFixed(1).padStart(5, ' ')} ${Number(r.league_strength_score || 0).toFixed(1).padStart(6, ' ')} ${Number(r.ranked_strength_score || 0).toFixed(1).padStart(6, ' ')} ${Number(r.activity_momentum_score || 0).toFixed(1).padStart(6, ' ')} ${Number(r.reliability_index_score || 0).toFixed(1).padStart(6, ' ')} ${String(Math.max(0, Math.trunc(Number(r.dq_count) || 0))).padStart(2, ' ')}`;
  });

  const pages = [];
  const totalPages = Math.ceil(rows.length / pageSize);
  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * pageSize;
    const chunk = rows.slice(start, start + pageSize);
    const ts = includeTimestamp ? `\nLast Updated: ${new Date().toISOString()}` : '';
    pages.push([
      `**Power Player Rankings** (page ${page}/${totalPages})`,
      '```',
      'Pos Player                Total League Ranked Activ. Reliab DQ',
      ...chunk,
      '```',
      '*DQ>=3 marked with `*`; DQ restrictions apply for tournament seeding.*',
      ts,
    ].join('\n'));
  }
  return pages;
}

function getPowerRankingsRenderHash(pages) {
  return pages.join('\n---\n');
}

module.exports = {
  calculatePowerComponents,
  recalculateAndStorePowerRankings,
  getPowerRankings,
  generateSeedsFromPowerRankings,
  buildPowerRankingsTablePages,
  getPowerRankingsRenderHash,
  reliabilityFromDqCount,
};
