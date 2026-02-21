// Points rules are configurable per league row.
function normalizePointRules(pointRules = {}) {
  const toSafeInt = (v, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.trunc(n));
  };

  return {
    points_win: toSafeInt(pointRules.points_win, 2),
    points_loss: toSafeInt(pointRules.points_loss, 1),
    points_no_show: toSafeInt(pointRules.points_no_show, 3),
    points_sweep_bonus: toSafeInt(pointRules.points_sweep_bonus, 1),
  };
}

function pointsForPlayedMatch(winnerScore, loserScore, pointRules = {}) {
  const rules = normalizePointRules(pointRules);
  if (winnerScore > loserScore && loserScore === 0) {
    return rules.points_win + rules.points_sweep_bonus;
  }
  return rules.points_win;
}

function calcMatchPoints({ score_a, score_b, winner_discord_id, player_a_discord_id, player_b_discord_id, is_forfeit }, pointRules = {}) {
  // Returns { pointsA, pointsB }
  const A = player_a_discord_id;
  const B = player_b_discord_id;
  const rules = normalizePointRules(pointRules);
  if (is_forfeit) {
    if (winner_discord_id === A) return { pointsA: rules.points_no_show, pointsB: 0 };
    return { pointsA: 0, pointsB: rules.points_no_show };
  }

  if (winner_discord_id === A) {
    const winnerPts = pointsForPlayedMatch(score_a, score_b, rules);
    return { pointsA: winnerPts, pointsB: rules.points_loss };
  }

  const winnerPts = pointsForPlayedMatch(score_b, score_a, rules);
  return { pointsA: rules.points_loss, pointsB: winnerPts };
}

function generateDoubleRoundRobinFixtures(db, league_id = 1) {
  const players = db.prepare(`
    SELECT discord_user_id
    FROM players
    WHERE league_id = ? AND status = 'active'
    ORDER BY discord_user_id
  `).all(league_id);

  if (players.length < 2) {
    return { ok: false, message: 'Need at least 2 signed-up players to generate fixtures.' };
  }

  const ids = players.map(p => p.discord_user_id);

  // Keep full fixture history and only add missing pair/leg combinations.
  const existing = db.prepare(`
    SELECT player_a_discord_id, player_b_discord_id, leg_number
    FROM fixtures
    WHERE league_id = ?
  `).all(league_id);

  const existingKeys = new Set(existing.map((f) => {
    const low = f.player_a_discord_id < f.player_b_discord_id ? f.player_a_discord_id : f.player_b_discord_id;
    const high = f.player_a_discord_id < f.player_b_discord_id ? f.player_b_discord_id : f.player_a_discord_id;
    return `${low}|${high}|${f.leg_number}`;
  }));

  const insert = db.prepare(`
    INSERT INTO fixtures (league_id, player_a_discord_id, player_b_discord_id, leg_number)
    VALUES (?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i];
        const b = ids[j];
        for (const leg of [1, 2]) {
          const key = `${a}|${b}|${leg}`;
          if (existingKeys.has(key)) continue;
          insert.run(league_id, a, b, leg);
          existingKeys.add(key);
          count += 1;
        }
      }
    }
  });
  tx();

  if (count === 0) {
    return { ok: true, message: 'No new fixtures generated. All active player pairings already exist in fixture history.' };
  }

  return { ok: true, message: `Generated ${count} new fixtures (history preserved, no duplicate pair/leg).` };
}


function getTodayISO(qatarTime = true) {
  const now = new Date();
  if (!qatarTime) {
    return now.toISOString().slice(0, 10);
  }

  // Use built-in Intl with Asia/Qatar to avoid external dependencies.
  // Produces YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Qatar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const year = parts.find(p => p.type === 'year')?.value;
  const month = parts.find(p => p.type === 'month')?.value;
  const day = parts.find(p => p.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

function getLeaguePointRules(db, league_id = 1) {
  const row = db.prepare(`
    SELECT points_win, points_loss, points_no_show, points_sweep_bonus
    FROM leagues
    WHERE league_id = ?
  `).get(league_id);
  return normalizePointRules(row || {});
}

function computeStandings(db, league_id = 1) {
  // Build base rows
  const players = db.prepare(`
    SELECT discord_user_id, tekken_tag, discord_display_name_last_seen, status
    FROM players
    WHERE league_id = ? AND status IN ('active', 'disqualified')
  `).all(league_id);

  const rows = new Map();
  for (const p of players) {
    rows.set(p.discord_user_id, {
      discord_user_id: p.discord_user_id,
      name: p.discord_display_name_last_seen || p.tekken_tag,
      tekken_tag: p.tekken_tag,
      status: p.status || 'active',
      points: 0,
      wins: 0,
      losses: 0,
      games_won: 0,
      games_lost: 0,
    });
  }

  const pointRules = getLeaguePointRules(db, league_id);

  const dqIds = new Set(players.filter((p) => p.status === 'disqualified').map((p) => p.discord_user_id));

  // Join confirmed results with match+fixture to get players (keyed by fixture)
  const confirmed = db.prepare(`
    SELECT
      f.fixture_id,
      m.player_a_discord_id,
      m.player_b_discord_id,
      r.winner_discord_id,
      r.score_a,
      r.score_b,
      r.is_forfeit
    FROM results r
    JOIN matches m ON m.match_id = r.match_id
    JOIN fixtures f ON f.fixture_id = m.fixture_id
    WHERE f.league_id = ? AND r.confirmed_at IS NOT NULL
  `).all(league_id);
  const confirmedByFixture = new Map(confirmed.map((r) => [r.fixture_id, r]));

  // Iterate every fixture so disqualification can override all matches (retroactive + future).
  const fixtures = db.prepare(`
    SELECT fixture_id, player_a_discord_id, player_b_discord_id
    FROM fixtures
    WHERE league_id = ?
  `).all(league_id);

  for (const fixture of fixtures) {
    const A = rows.get(fixture.player_a_discord_id);
    const B = rows.get(fixture.player_b_discord_id);
    if (!A || !B) continue;

    const aIsDq = dqIds.has(fixture.player_a_discord_id);
    const bIsDq = dqIds.has(fixture.player_b_discord_id);

    // If one side is DQ, that side always loses 0-3.
    if (aIsDq !== bIsDq) {
      const winnerId = aIsDq ? fixture.player_b_discord_id : fixture.player_a_discord_id;
      const loserId = aIsDq ? fixture.player_a_discord_id : fixture.player_b_discord_id;

      const winner = rows.get(winnerId);
      const loser = rows.get(loserId);
      if (!winner || !loser) continue;

      winner.games_won += 3;
      winner.games_lost += 0;
      loser.games_won += 0;
      loser.games_lost += 3;
      winner.wins += 1;
      loser.losses += 1;

      const pts = calcMatchPoints({
        score_a: winnerId === fixture.player_a_discord_id ? 3 : 0,
        score_b: winnerId === fixture.player_b_discord_id ? 3 : 0,
        winner_discord_id: winnerId,
        player_a_discord_id: fixture.player_a_discord_id,
        player_b_discord_id: fixture.player_b_discord_id,
        is_forfeit: 1,
      }, pointRules);

      A.points += pts.pointsA;
      B.points += pts.pointsB;
      continue;
    }

    const r = confirmedByFixture.get(fixture.fixture_id);
    if (!r) continue;

    A.games_won += r.score_a;
    A.games_lost += r.score_b;
    B.games_won += r.score_b;
    B.games_lost += r.score_a;

    if (r.winner_discord_id === r.player_a_discord_id) {
      A.wins += 1;
      B.losses += 1;
    } else {
      B.wins += 1;
      A.losses += 1;
    }

    const pts = calcMatchPoints({
      score_a: r.score_a,
      score_b: r.score_b,
      winner_discord_id: r.winner_discord_id,
      player_a_discord_id: r.player_a_discord_id,
      player_b_discord_id: r.player_b_discord_id,
      is_forfeit: r.is_forfeit,
    }, pointRules);

    A.points += pts.pointsA;
    B.points += pts.pointsB;
  }

  const list = Array.from(rows.values()).map(x => ({
    ...x,
    diff: x.games_won - x.games_lost,
    played: x.wins + x.losses,
  }));

  list.sort((p, q) => {
    if (q.points !== p.points) return q.points - p.points;
    if (q.diff !== p.diff) return q.diff - p.diff;
    if (q.games_won !== p.games_won) return q.games_won - p.games_won;
    return p.tekken_tag.localeCompare(q.tekken_tag);
  });

  return list;
}

function getCompletionStats(db, league_id = 1) {
  // required per player = (n-1)*2
  const n = db.prepare(`SELECT COUNT(1) AS c FROM players WHERE league_id = ? AND status='active'`).get(league_id).c;
  const required = n > 1 ? (n - 1) * 2 : 0;

  const completed = db.prepare(`
    SELECT player_id, discord_user_id
    FROM players
    WHERE league_id = ? AND status='active'
  `).all(league_id).map(p => {
    const done = db.prepare(`
      SELECT COUNT(1) AS c
      FROM fixtures f
      WHERE f.league_id = ?
        AND f.status = 'confirmed'
        AND (f.player_a_discord_id = ? OR f.player_b_discord_id = ?)
    `).get(league_id, p.discord_user_id, p.discord_user_id).c;

    return {
      discord_user_id: p.discord_user_id,
      completed: done,
      required,
      percent: required ? done / required : 0,
    };
  });

  const map = new Map(completed.map(x => [x.discord_user_id, x]));
  return { required_per_player: required, map };
}

module.exports = {
  generateDoubleRoundRobinFixtures,
  computeStandings,
  getCompletionStats,
  calcMatchPoints,
  getTodayISO,
  getLeaguePointRules,
  normalizePointRules,
};
