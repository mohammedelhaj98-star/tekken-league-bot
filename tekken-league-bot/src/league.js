const { nanoid } = require('nanoid');

// Points rules (per user spec)
function pointsForPlayedMatch(winnerScore, loserScore) {
  // winnerScore is always 3, loserScore is 0..2
  if (winnerScore === 3 && loserScore === 0) return 3; // clean win
  return 2; // 3-1 or 3-2
}

function calcMatchPoints({ score_a, score_b, winner_discord_id, player_a_discord_id, player_b_discord_id, is_forfeit }) {
  // Returns { pointsA, pointsB }
  const A = player_a_discord_id;
  const B = player_b_discord_id;
  if (is_forfeit) {
    if (winner_discord_id === A) return { pointsA: 3, pointsB: 0 };
    return { pointsA: 0, pointsB: 3 };
  }

  // Played match: loser always gets 1 point
  if (winner_discord_id === A) {
    const winnerPts = pointsForPlayedMatch(score_a, score_b);
    return { pointsA: winnerPts, pointsB: 1 };
  } else {
    const winnerPts = pointsForPlayedMatch(score_b, score_a);
    return { pointsA: 1, pointsB: winnerPts };
  }
}

function generateDoubleRoundRobinFixtures(db, league_id = 1) {
  const players = db.prepare(`SELECT discord_user_id FROM players WHERE league_id = ? AND status = 'active' ORDER BY discord_user_id`).all(league_id);
  if (players.length < 2) {
    return { ok: false, message: 'Need at least 2 signed-up players to generate fixtures.' };
  }

  const existing = db.prepare('SELECT COUNT(1) AS c FROM fixtures WHERE league_id = ?').get(league_id).c;
  if (existing > 0) {
    return { ok: false, message: 'Fixtures already exist. Use /admin_reset_league if you really want to wipe and regenerate.' };
  }

  const ids = players.map(p => p.discord_user_id);
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
        insert.run(league_id, a, b, 1);
        insert.run(league_id, a, b, 2);
        count += 2;
      }
    }
  });
  tx();

  return { ok: true, message: `Generated ${count} fixtures (double round robin).` };
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

function computeStandings(db, league_id = 1) {
  // Build base rows
  const players = db.prepare(`
    SELECT discord_user_id, tekken_tag, discord_display_name_last_seen
    FROM players
    WHERE league_id = ? AND status = 'active'
  `).all(league_id);

  const rows = new Map();
  for (const p of players) {
    rows.set(p.discord_user_id, {
      discord_user_id: p.discord_user_id,
      name: p.discord_display_name_last_seen || p.tekken_tag,
      tekken_tag: p.tekken_tag,
      points: 0,
      wins: 0,
      losses: 0,
      games_won: 0,
      games_lost: 0,
    });
  }

  // Join confirmed results with match+fixture to get players
  const confirmed = db.prepare(`
    SELECT
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

  for (const r of confirmed) {
    const A = rows.get(r.player_a_discord_id);
    const B = rows.get(r.player_b_discord_id);
    if (!A || !B) continue;

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
    });

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
};
