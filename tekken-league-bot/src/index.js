require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionsBitField,
  Partials,
} = require('discord.js');
const { randomBytes } = require('node:crypto');

const { openDb, initDb } = require('./db');
const { encryptString, decryptString, maskEmail, maskPhone } = require('./crypto');
const { isValidEmail, isValidPhone, normalizeEmail, normalizePhone, cleanTekkenTag, cleanName } = require('./validate');
const { generateDoubleRoundRobinFixtures, computeStandings, getTodayISO, getLeaguePointRules, normalizePointRules } = require('./league');
const { validateTournamentSetupInput } = require('./tournament-config');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MATCH_CHANNEL_ID = process.env.MATCH_CHANNEL_ID;
const MATCHMAKER_INTERVAL_MS = Number(process.env.MATCHMAKER_INTERVAL_MS || 30000);

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}
if (!MATCH_CHANNEL_ID) {
  console.warn('MATCH_CHANNEL_ID is not set in .env. Configure results channel via /bot_settings set_results_channel.');
}

const db = openDb();
initDb(db);

const TABLE_PAGE_SIZE = 8;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

function getConfiguredAdminRoleIds(guildId) {
  return db.prepare(`
    SELECT role_id FROM admin_roles
    WHERE league_id = 1 AND (guild_id = ? OR guild_id IS NULL)
    ORDER BY role_id ASC
  `).all(String(guildId || '')).map(r => r.role_id);
}

function getInteractionRoleIds(interaction) {
  const memberRoles = interaction.member?.roles;
  if (!memberRoles) return [];

  if (Array.isArray(memberRoles)) return memberRoles;

  if (memberRoles.cache && typeof memberRoles.cache.values === 'function') {
    return Array.from(memberRoles.cache.values()).map(role => role.id);
  }

  return [];
}

function isAdminMember(member, guildId) {
  if (member?.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;

  const configured = getConfiguredAdminRoleIds(guildId);
  if (!configured.length) return false;

  const roleIds = member?.roles?.cache
    ? Array.from(member.roles.cache.values()).map((role) => role.id)
    : [];

  return roleIds.some((id) => configured.includes(id));
}

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) return true;

  const configured = getConfiguredAdminRoleIds(interaction.guildId);
  if (!configured.length) return false;

  const roleIds = getInteractionRoleIds(interaction);
  return roleIds.some(id => configured.includes(id));
}

async function getAdminNotificationUserIds(guild) {
  const members = await guild.members.fetch().catch(() => null);
  if (!members) return [];

  const ids = [];
  for (const member of members.values()) {
    if (member.user?.bot) continue;
    if (isAdminMember(member, guild.id)) ids.push(member.id);
  }
  return [...new Set(ids)];
}

async function notifyAdminsAboutReset(guild, requestedByUser, message) {
  const adminIds = await getAdminNotificationUserIds(guild);
  if (!adminIds.length) {
    await requestedByUser.send({ content: message }).catch(() => null);
    return;
  }

  for (const id of adminIds) {
    const user = await guild.client.users.fetch(id).catch(() => null);
    if (!user) continue;
    await user.send({ content: message }).catch(() => null);
  }
}

function runLeagueReset(level) {
  const today = getTodayISO(true);

  if (level === 'checkins') {
    db.prepare('DELETE FROM ready_queue WHERE league_id = 1').run();
    db.prepare('DELETE FROM attendance WHERE league_id = 1 AND date = ?').run(today);
    return `Reset level: checkins (cleared today's attendance + ready queue for ${today}).`;
  }

  if (level === 'everything') {
    db.exec(`
      DELETE FROM rematch_votes;
      DELETE FROM admin_match_overrides;
      DELETE FROM match_reports;
      DELETE FROM results;
      DELETE FROM matches;
      DELETE FROM fixtures;
      DELETE FROM ready_queue;
      DELETE FROM attendance;
      DELETE FROM players;
    `);
    return 'Reset level: everything (league state + signups removed).';
  }

  db.exec(`
    DELETE FROM rematch_votes;
    DELETE FROM admin_match_overrides;
    DELETE FROM match_reports;
    DELETE FROM results;
    DELETE FROM matches;
    DELETE FROM fixtures;
    DELETE FROM ready_queue;
    DELETE FROM attendance;
  `);
  return 'Reset level: league (players preserved).';
}

const pendingResetTokens = new Map();

function generateResetToken() {
  return randomBytes(4).toString('hex').toUpperCase();
}

function createResetRequest(interaction, level, auditAction) {
  const token = generateResetToken();
  pendingResetTokens.set(token, {
    guildId: interaction.guildId,
    requestedByUserId: interaction.user.id,
    requesterTag: interaction.user.tag,
    level,
    auditAction,
    expiresAt: Date.now() + (5 * 60 * 1000),
  });
  return token;
}

function consumeResetToken(token) {
  const normalized = String(token || '').trim().toUpperCase();
  const pending = pendingResetTokens.get(normalized);
  if (!pending) return { ok: false, error: 'Invalid reset token.' };
  if (Date.now() > pending.expiresAt) {
    pendingResetTokens.delete(normalized);
    return { ok: false, error: 'Reset token expired. Run /admin_reset again.' };
  }
  pendingResetTokens.delete(normalized);
  return { ok: true, pending };
}

function getDisplayNameFromInteraction(interaction) {
  const member = interaction.member;
  if (member && typeof member.displayName === 'string') return member.displayName;
  return interaction.user.globalName || interaction.user.username;
}

function upsertLastSeenDisplayName(discord_user_id, displayName) {
  db.prepare(`
    UPDATE players
    SET discord_display_name_last_seen = ?
    WHERE league_id = 1 AND discord_user_id = ?
  `).run(displayName, discord_user_id);
}

function getPlayer(discord_user_id) {
  return db.prepare(`
    SELECT * FROM players WHERE league_id = 1 AND discord_user_id = ?
  `).get(discord_user_id);
}

function ensureSignedUp(interaction) {
  const p = getPlayer(interaction.user.id);
  return p;
}

function logAudit(actionType, actorDiscordId, payload = null) {
  db.prepare(`
    INSERT INTO audit_log (league_id, actor_discord_id, action_type, payload_json)
    VALUES (1, ?, ?, ?)
  `).run(actorDiscordId || null, actionType, payload ? JSON.stringify(payload) : null);
}


function getGuildSettings(guildId) {
  const id = String(guildId || '');
  let row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(id);
  if (!row) {
    db.prepare(`
      INSERT INTO guild_settings (
        guild_id,
        results_channel_id,
        tournament_name,
        timezone
      ) VALUES (?, ?, ?, 'Asia/Qatar')
    `).run(id, MATCH_CHANNEL_ID || null, process.env.LEAGUE_NAME || 'Tekken League');
    row = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(id);
  }
  return row;
}

function updateGuildSetting(guildId, patch) {
  const current = getGuildSettings(guildId);
  const merged = { ...current, ...patch };
  db.prepare(`
    UPDATE guild_settings
    SET
      results_channel_id = ?,
      admin_channel_id = ?,
      standings_channel_id = ?,
      dispute_channel_id = ?,
      activity_channel_id = ?,
      match_format = ?,
      allow_public_player_commands = ?,
      tournament_name = ?,
      timezone = ?,
      cleanup_policy = ?,
      cleanup_days = ?,
      enable_diagnostics = ?,
      updated_at = datetime('now')
    WHERE guild_id = ?
  `).run(
    merged.results_channel_id || null,
    merged.admin_channel_id || null,
    merged.standings_channel_id || null,
    merged.dispute_channel_id || null,
    merged.activity_channel_id || null,
    merged.match_format || 'FT3',
    merged.allow_public_player_commands ? 1 : 0,
    merged.tournament_name || 'Tekken League',
    merged.timezone || 'Asia/Qatar',
    merged.cleanup_policy || 'keep',
    merged.cleanup_days || null,
    merged.enable_diagnostics ? 1 : 0,
    String(guildId || ''),
  );
}

function getScoreReactionsForFormat(format) {
  return format === 'FT2' ? ['0️⃣', '1️⃣'] : ['0️⃣', '1️⃣', '2️⃣'];
}


function getDisputeNotificationChannelId(settings) {
  return settings.dispute_channel_id || settings.admin_channel_id || null;
}

async function sendDisputeNotification(guild, settings, content) {
  const channelId = getDisputeNotificationChannelId(settings);
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  await channel.send({ content }).catch(() => null);
}

async function sendActivityNotification(guild, settings, content) {
  const channelId = settings.activity_channel_id || settings.admin_channel_id || null;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  await channel.send({ content }).catch(() => null);
}

async function sendAdminNotification(guild, settings, content) {
  const channelId = settings.admin_channel_id || null;
  if (!channelId) return;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  await channel.send({ content }).catch(() => null);
}

function scoreFromCode(format, code) {
  if (format === 'FT2') {
    if (code === 0) return [2, 0];
    if (code === 1) return [2, 1];
  }
  if (format === 'FT3') {
    if (code === 0) return [3, 0];
    if (code === 1) return [3, 1];
    if (code === 2) return [3, 2];
  }
  return null;
}

function parseAdminScore(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(3)\s*[-:]\s*([0-2])$/);
  if (!m) return null;
  return { winner: 3, loser: Number(m[2]) };
}

function daysBetweenInclusive(startDateIso, endDateIso) {
  const start = new Date(`${startDateIso}T00:00:00Z`);
  const end = new Date(`${endDateIso}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  const diffMs = end.getTime() - start.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
  return Math.max(1, days);
}

function buildMatchAssignmentMessage(match, settings, status = 'Pending', details = '') {
  const scoreGuide = settings.match_format === 'FT2'
    ? 'Score reactions: 0️⃣ = winner 2-0, 1️⃣ = winner 2-1'
    : 'Score reactions: 0️⃣ = winner 3-0, 1️⃣ = winner 3-1, 2️⃣ = winner 3-2';

  return [
    `**${settings.tournament_name || 'Tekken League'}**`,
    `Match ${match.match_id}`,
    `Player A: <@${match.player_a_discord_id}> vs Player B: <@${match.player_b_discord_id}>`,
    `Status: ${status}`,
    'Step 1 Winner: react 🇦 or 🇧',
    `Step 2 Score (${settings.match_format}): ${scoreGuide}`,
    'Admin override: react ❗ then submit winner + score reactions to force final result',
    details || '',
  ].filter(Boolean).join('\n');
}

function getReadyQueueSnapshot() {
  return db.prepare(`
    SELECT p.tekken_tag, rq.discord_user_id, rq.since_ts
    FROM ready_queue rq
    LEFT JOIN players p ON p.league_id = rq.league_id AND p.discord_user_id = rq.discord_user_id
    WHERE rq.league_id = 1
    ORDER BY rq.since_ts ASC
  `).all();
}


function buildMatchesMessage(limit = 30, discordUserId = null) {
  const rows = discordUserId
    ? db.prepare(`
      SELECT
        m.match_id,
        m.player_a_discord_id,
        m.player_b_discord_id,
        m.state,
        r.score_a,
        r.score_b,
        r.confirmed_at
      FROM matches m
      LEFT JOIN results r ON r.match_id = m.match_id AND r.confirmed_at IS NOT NULL
      WHERE m.league_id = 1
        AND (m.player_a_discord_id = ? OR m.player_b_discord_id = ?)
      ORDER BY m.match_id DESC
      LIMIT ?
    `).all(discordUserId, discordUserId, limit)
    : db.prepare(`
      SELECT
        m.match_id,
        m.player_a_discord_id,
        m.player_b_discord_id,
        m.state,
        r.score_a,
        r.score_b,
        r.confirmed_at
      FROM matches m
      LEFT JOIN results r ON r.match_id = m.match_id AND r.confirmed_at IS NOT NULL
      WHERE m.league_id = 1
      ORDER BY m.match_id DESC
      LIMIT ?
    `).all(limit);

  if (!rows.length) {
    return discordUserId
      ? `No matches found yet for <@${discordUserId}>.`
      : 'No matches created yet.';
  }

  const lines = rows.map((m) => {
    const score = (m.score_a == null || m.score_b == null) ? '-' : `${m.score_a}-${m.score_b}`;
    return `#${m.match_id} | <@${m.player_a_discord_id}> vs <@${m.player_b_discord_id}> | ${m.state} | score: ${score}`;
  });

  const title = discordUserId
    ? `**Matches for <@${discordUserId}> (latest ${rows.length})**`
    : `**Recent Matches (latest ${rows.length})**`;

  return `${title}\n${lines.join('\n')}`;
}

function buildLeftToPlayMessage(discordUserId) {
  const standings = computeStandings(db, 1);
  const rankById = new Map(standings.map((row, idx) => [row.discord_user_id, idx + 1]));

  const rows = db.prepare(`
    SELECT
      CASE
        WHEN f.player_a_discord_id = ? THEN f.player_b_discord_id
        ELSE f.player_a_discord_id
      END AS opponent_id,
      p.tekken_tag AS opponent_tag,
      COUNT(1) AS matches_left
    FROM fixtures f
    LEFT JOIN players p
      ON p.league_id = f.league_id
      AND p.discord_user_id = CASE
        WHEN f.player_a_discord_id = ? THEN f.player_b_discord_id
        ELSE f.player_a_discord_id
      END
    WHERE f.league_id = 1
      AND (f.player_a_discord_id = ? OR f.player_b_discord_id = ?)
      AND f.status IN ('unplayed', 'locked_in_match')
    GROUP BY opponent_id, opponent_tag
  `).all(discordUserId, discordUserId, discordUserId, discordUserId);

  if (!rows.length) {
    return '**Left to Play**\nYou have completed all scheduled matches.';
  }

  const sorted = rows
    .map((row) => ({
      opponentId: row.opponent_id,
      opponentTag: row.opponent_tag || row.opponent_id,
      matchesLeft: Number(row.matches_left || 0),
      standingsRank: rankById.get(row.opponent_id) || Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => {
      if (b.matchesLeft !== a.matchesLeft) return b.matchesLeft - a.matchesLeft;
      if (a.standingsRank !== b.standingsRank) return a.standingsRank - b.standingsRank;
      return a.opponentTag.localeCompare(b.opponentTag, undefined, { sensitivity: 'base' });
    });

  const lines = sorted.map((row, idx) => {
    const rankText = Number.isFinite(row.standingsRank) && row.standingsRank !== Number.MAX_SAFE_INTEGER
      ? `#${row.standingsRank}`
      : 'N/A';
    return `${idx + 1}. ${row.opponentTag} (<@${row.opponentId}>) — ${row.matchesLeft} left (standings ${rankText})`;
  });

  return `**Left to Play**\n${lines.join('\n')}`;
}

function buildStandingsListMessage() {
  const standings = computeStandings(db, 1);
  if (!standings.length) return '**Standings**\nNo active players yet. Use /signup to join the league.';

  const lines = standings.map((s, idx) => `${idx + 1}. ${s.tekken_tag}`);
  return `**Standings**\n${lines.join('\n')}`;
}

function buildStandingsTablePages() {
  const standings = computeStandings(db, 1);
  if (!standings.length) return ['**Table**\nNo active players yet. Use /signup to join the league.'];

  const league = getLeagueSettings();
  const seasonDays = Math.max(1, Number(league.season_days || 20));
  const startDate = String(league.tournament_start_date || getTodayISO(true));
  const today = getTodayISO(true);
  const elapsedDays = Math.max(1, daysBetweenInclusive(startDate, today));
  const tournamentDaysElapsed = Math.min(seasonDays, elapsedDays);
  const missedAllowance = 5;
  const minCheckinsRequired = Math.max(0, tournamentDaysElapsed - missedAllowance);
  const activePlayerCount = db.prepare(`
    SELECT COUNT(1) AS c
    FROM players
    WHERE league_id = 1 AND status = 'active'
  `).get().c;
  const requiredFixturesPerPlayer = activePlayerCount > 1 ? (activePlayerCount - 1) * 2 : 0;
  const completionRows = db.prepare(`
    SELECT
      p.discord_user_id,
      SUM(CASE WHEN f.status = 'confirmed' THEN 1 ELSE 0 END) AS completed
    FROM players p
    LEFT JOIN fixtures f
      ON f.league_id = p.league_id
      AND (f.player_a_discord_id = p.discord_user_id OR f.player_b_discord_id = p.discord_user_id)
    WHERE p.league_id = 1 AND p.status = 'active'
    GROUP BY p.discord_user_id
  `).all();
  const completedByPlayer = new Map(completionRows.map((r) => [r.discord_user_id, Number(r.completed || 0)]));
  const attendanceRows = db.prepare(`
    SELECT discord_user_id, COUNT(DISTINCT date) AS checkin_days
    FROM attendance
    WHERE league_id = 1 AND checked_in = 1
    GROUP BY discord_user_id
  `).all();
  const attendanceById = new Map(attendanceRows.map((r) => [r.discord_user_id, Number(r.checkin_days || 0)]));
  const formatCell = (value, maxLen = 32) => {
    const text = String(value ?? '');
    if (text.length <= maxLen) return text;
    if (maxLen <= 1) return text.slice(0, maxLen);
    return `${text.slice(0, maxLen - 1)}…`;
  };

  const rows = standings.map((s, idx) => {
    const checkins = attendanceById.get(s.discord_user_id) || 0;
    const missedDays = Math.max(0, tournamentDaysElapsed - checkins);
    const showPct = Math.max(0, Math.min(100, Math.round(((tournamentDaysElapsed - missedDays) / tournamentDaysElapsed) * 100)));
    const completed = completedByPlayer.get(s.discord_user_id) || 0;
    const finishedMatches = requiredFixturesPerPlayer > 0 && completed >= requiredFixturesPerPlayer;
    const allowanceRemaining = Math.max(0, missedAllowance - missedDays);
    const allowanceText = finishedMatches ? `EXEMPT (${allowanceRemaining})` : `${allowanceRemaining}`;

    return {
      rank: String(idx + 1),
      player: formatCell(s.tekken_tag, 24),
      pts: String(s.points),
      gp: String(s.played),
      w: String(s.wins),
      l: String(s.losses),
      diff: String(s.diff),
      gw: String(s.games_won),
      show: `${showPct}%`,
      allowance: formatCell(allowanceText, 12),
    };
  });

  const cols = [
    { key: 'rank', header: '#' },
    { key: 'player', header: 'PLAYER' },
    { key: 'pts', header: 'PTS' },
    { key: 'gp', header: 'GP' },
    { key: 'w', header: 'W' },
    { key: 'l', header: 'L' },
    { key: 'diff', header: 'DIFF' },
    { key: 'gw', header: 'GW' },
    { key: 'show', header: 'SHOW%' },
    { key: 'allowance', header: 'ALLOW' },
  ];

  for (const col of cols) {
    col.width = col.header.length;
    for (const row of rows) col.width = Math.max(col.width, String(row[col.key]).length);
  }

  const legend = [
    'Legend: #=Rank | PLAYER=Tag | PTS=Points | GP=Games played | W/L=Wins/Losses | DIFF=Game diff | GW=Games won | SHOW%=Attendance | ALLOW=Missed check-ins left',
    `Attendance starts at 100% and decreases by missed days since start (${startDate}). Check-in allowance left is shown as a number (max ${missedAllowance}).`,
    `Elapsed days: ${tournamentDaysElapsed}/${seasonDays}. Minimum check-ins now: ${minCheckinsRequired}. Finished all fixtures early => EXEMPT.`,
    '',
  ].join('\n');

  const pad = (text, width, left = false) => left ? String(text).padEnd(width, ' ') : String(text).padStart(width, ' ');
  const top = `+${cols.map(c => '-'.repeat(c.width + 2)).join('+')}+`;
  const header = `| ${cols.map(c => pad(c.header, c.width, c.key === 'player')).join(' | ')} |`;
  const render = (rowsToRender, page, totalPages) => {
    const body = rowsToRender.map(r => `| ${cols.map(c => pad(r[c.key], c.width, c.key === 'player')).join(' | ')} |`).join('\n');
    const extra = `\nPage ${page}/${totalPages} • Showing ${rowsToRender.length} rows on this page (${standings.length} total players).\nUse /table page:<number> to view another page.`;
    return `**Table**\n${legend}\`\`\`\n${top}\n${header}\n${top}\n${body}\n${top}\n\`\`\`${extra}`;
  };

  const pages = [];
  const totalPages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  for (let i = 0; i < totalPages; i++) {
    const start = i * TABLE_PAGE_SIZE;
    const rowsToRender = rows.slice(start, start + TABLE_PAGE_SIZE);
    let output = render(rowsToRender, i + 1, totalPages);
    while (output.length > 1900 && rowsToRender.length > 1) {
      rowsToRender.pop();
      output = render(rowsToRender, i + 1, totalPages);
    }
    if (output.length > 1900) {
      output = `**Table**\nUnable to render full ASCII table safely for Discord message limits.\nUse /standings for ranking list and shorten player tags if needed.`;
    }
    pages.push(output);
  }

  return pages;
}

function getLeagueSettings() {
  return db.prepare(`
    SELECT
      name,
      timezone,
      season_days,
      attendance_min_days,
      tournament_start_date,
      eligibility_min_percent,
      points_win,
      points_loss,
      points_no_show,
      points_sweep_bonus,
      max_players,
      timeslot_count,
      timeslot_duration_minutes,
      timeslot_starts
    FROM leagues
    WHERE league_id = 1
  `).get();
}

function buildTournamentSettingsMessage() {
  const s = getLeagueSettings();
  const minShowupPercent = Math.round((s.eligibility_min_percent || 0) * 100);
  const minAttendanceDays = Math.ceil((s.season_days || 0) * (s.eligibility_min_percent || 0));
  const missedAllowance = 5;
  const requiredByAllowance = Math.max(0, (s.season_days || 0) - missedAllowance);
  const effectiveMinAttendanceDays = Math.max(minAttendanceDays, requiredByAllowance);
  const maxMissedDays = Math.max(0, (s.season_days || 0) - effectiveMinAttendanceDays);
  const dropPerDay = (s.season_days || 0) > 0 ? (100 / s.season_days).toFixed(2) : '0.00';
  const startDate = String(s.tournament_start_date || getTodayISO(true));
  const today = getTodayISO(true);
  const elapsedDays = Math.max(1, Math.min(s.season_days || 0, daysBetweenInclusive(startDate, today)));
  const points = getLeaguePointRules(db, 1);

  return [
    '**Tournament Settings**',
    `League: ${s.name}`,
    `Timezone: ${s.timezone}`,
    `No. of Players (max): ${s.max_players}`,
    `No. of Timeslots: ${s.timeslot_count}`,
    `Duration of Time slots: ${s.timeslot_duration_minutes} minutes`,
    `Start of each time slot: ${s.timeslot_starts}`,
    `Total tournament days: ${s.season_days}`,
    `Tournament start date: ${startDate}`,
    `Elapsed tournament days (for attendance): ${elapsedDays}`,
    `SHOW% behavior: starts at 100% and drops by ${dropPerDay}% per missed day`,
    `Minimum show up % required (eligibility threshold): ${minShowupPercent}%`,
    `Minimum check-in days required: ${effectiveMinAttendanceDays} (includes max ${missedAllowance} missed check-ins allowance)`,
    `Maximum missed check-in days allowed: ${maxMissedDays}`,
    'If a player finishes all required fixtures early, no further check-ins are required.',
    `Points: win=${points.points_win}, loss=${points.points_loss}, no-show=${points.points_no_show}, 3-0 sweep bonus=${points.points_sweep_bonus}`,
  ].join('\n');
}

function hasCheckedInToday(discord_user_id) {
  const today = getTodayISO(true);
  const row = db.prepare(`
    SELECT 1 FROM attendance WHERE league_id = 1 AND discord_user_id = ? AND date = ?
  `).get(discord_user_id, today);
  return !!row;
}

function addToReadyQueue(discord_user_id) {
  db.prepare(`
    INSERT OR IGNORE INTO ready_queue (league_id, discord_user_id)
    VALUES (1, ?)
  `).run(discord_user_id);
}

function removeFromReadyQueue(discord_user_id) {
  db.prepare(`
    DELETE FROM ready_queue WHERE league_id = 1 AND discord_user_id = ?
  `).run(discord_user_id);
}

function popReadyUsers() {
  return db.prepare(`
    SELECT discord_user_id FROM ready_queue WHERE league_id = 1 ORDER BY since_ts ASC
  `).all().map(r => r.discord_user_id);
}

function clearReadyQueueForUsers(userIds) {
  const del = db.prepare('DELETE FROM ready_queue WHERE league_id = 1 AND discord_user_id = ?');
  const tx = db.transaction((ids) => {
    for (const id of ids) del.run(id);
  });
  tx(userIds);
}

function getEligibleOpponentsForPlayer(discordUserId) {
  return db.prepare(`
    SELECT DISTINCT
      CASE WHEN f.player_a_discord_id = ? THEN f.player_b_discord_id ELSE f.player_a_discord_id END AS opponent_id,
      p.tekken_tag
    FROM fixtures f
    JOIN players p ON p.league_id = f.league_id
      AND p.discord_user_id = CASE WHEN f.player_a_discord_id = ? THEN f.player_b_discord_id ELSE f.player_a_discord_id END
    WHERE f.league_id = 1
      AND f.status = 'unplayed'
      AND (f.player_a_discord_id = ? OR f.player_b_discord_id = ?)
    ORDER BY LOWER(p.tekken_tag) ASC
  `).all(discordUserId, discordUserId, discordUserId, discordUserId);
}

function getNextUnplayedFixtureBetween(playerAId, playerBId) {
  return db.prepare(`
    SELECT * FROM fixtures
    WHERE league_id = 1
      AND status = 'unplayed'
      AND ((player_a_discord_id = ? AND player_b_discord_id = ?) OR (player_a_discord_id = ? AND player_b_discord_id = ?))
    ORDER BY leg_number ASC, fixture_id ASC
    LIMIT 1
  `).get(playerAId, playerBId, playerBId, playerAId);
}

function hasActiveMatch(discord_user_id) {
  const row = db.prepare(`
    SELECT 1
    FROM matches m
    JOIN fixtures f ON f.fixture_id = m.fixture_id
    WHERE f.league_id = 1
      AND m.state IN ('pending','reported','active','disputed')
      AND (m.player_a_discord_id = ? OR m.player_b_discord_id = ?)
    LIMIT 1
  `).get(discord_user_id, discord_user_id);
  return !!row;
}

function pickNextFixtureBetweenReadyPlayers(readyIds) {
  if (readyIds.length < 2) return null;

  const placeholders = readyIds.map(() => '?').join(',');
  const sql = `
    SELECT
      MIN(f.fixture_id) AS fixture_id,
      CASE WHEN f.player_a_discord_id < f.player_b_discord_id THEN f.player_a_discord_id ELSE f.player_b_discord_id END AS p1,
      CASE WHEN f.player_a_discord_id < f.player_b_discord_id THEN f.player_b_discord_id ELSE f.player_a_discord_id END AS p2,
      SUM(1) AS legs_remaining
    FROM fixtures f
    WHERE f.league_id = 1
      AND f.status = 'unplayed'
      AND f.player_a_discord_id IN (${placeholders})
      AND f.player_b_discord_id IN (${placeholders})
    GROUP BY p1, p2
    ORDER BY legs_remaining DESC, RANDOM()
    LIMIT 1
  `;

  const row = db.prepare(sql).get(...readyIds, ...readyIds);
  if (!row) return null;

  const fixture = db.prepare('SELECT * FROM fixtures WHERE fixture_id = ?').get(row.fixture_id);
  if (!fixture) return null;

  return fixture;
}

async function createPendingMatch(fixture, channel, guildId) {
  const a = fixture.player_a_discord_id;
  const b = fixture.player_b_discord_id;
  const settings = getGuildSettings(guildId);

  const lock = db.prepare(`
    UPDATE fixtures
    SET status = 'locked_in_match'
    WHERE fixture_id = ? AND status = 'unplayed'
  `).run(fixture.fixture_id);

  if (lock.changes !== 1) {
    return { ok: false, reason: 'fixture_already_locked' };
  }

  let matchId = null;
  try {
    const res = db.prepare(`
      INSERT INTO matches (league_id, guild_id, fixture_id, player_a_discord_id, player_b_discord_id, state, match_channel_id)
      VALUES (1, ?, ?, ?, ?, 'pending', ?)
    `).run(String(guildId), fixture.fixture_id, a, b, String(channel.id));

    matchId = Number(res.lastInsertRowid);
    const matchRow = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);

    const msg = await channel.send({
      content: buildMatchAssignmentMessage(matchRow, settings, 'Pending'),
      allowed_mentions: { users: [a, b], roles: [], replied_user: false },
    });

    // DM each player with their specific fixture details (best effort).
    const dmText = [
      `You have a new league fixture in **${settings.tournament_name || 'Tekken League'}**.`,
      `Match ${matchRow.match_id}`,
      `Player A: <@${a}> vs Player B: <@${b}>`,
      `Please report in <#${channel.id}> using the reactions on the match message.`,
    ].join('\n');

    await channel.client.users.fetch(a).then(u => u.send(dmText)).catch(() => null);
    await channel.client.users.fetch(b).then(u => u.send(dmText)).catch(() => null);

    await msg.react('🇦').catch(() => null);
    await msg.react('🇧').catch(() => null);
    await msg.react('❗').catch(() => null);
    for (const emoji of getScoreReactionsForFormat(settings.match_format)) {
      await msg.react(emoji).catch(() => null);
    }

    db.prepare('UPDATE matches SET match_message_id = ? WHERE match_id = ?').run(String(msg.id), matchId);
    clearReadyQueueForUsers([a, b]);

    return { ok: true, matchId, messageId: msg.id };
  } catch (err) {
    db.prepare(`
      UPDATE fixtures
      SET status = 'unplayed'
      WHERE fixture_id = ? AND status = 'locked_in_match'
    `).run(fixture.fixture_id);

    if (matchId) {
      db.prepare(`
        UPDATE matches
        SET state = 'cancelled', ended_at = datetime('now')
        WHERE match_id = ?
      `).run(matchId);
    }

    logAudit('match_post_failed', null, {
      fixture_id: fixture.fixture_id,
      guildId: String(guildId || ''),
      channelId: String(channel?.id || ''),
      error: String(err?.message || err),
    });

    return { ok: false, reason: 'message_post_failed' };
  }
}

async function tryMatchmake(guild) {
  const settings = getGuildSettings(guild.id);
  const channelId = settings.results_channel_id || MATCH_CHANNEL_ID;
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    logAudit('matchmaking_channel_missing', null, { guildId: guild.id, channelId });
    return;
  }

  // Auto-generate any missing fixtures so admins do not need to manually regenerate each time.
  const autoGen = generateDoubleRoundRobinFixtures(db, 1);
  if (autoGen.ok && autoGen.message.startsWith('Generated ')) {
    logAudit('auto_generate_fixtures', null, { guildId: guild.id, message: autoGen.message });
  }

  const ready = popReadyUsers().filter(id => !hasActiveMatch(id));
  if (ready.length < 2) return;

  let pool = [...ready];
  let made = 0;
  for (;;) {
    if (pool.length < 2) break;
    const fixture = pickNextFixtureBetweenReadyPlayers(pool);
    if (!fixture) break;

    const created = await createPendingMatch(fixture, channel, guild.id);
    if (created.ok) {
      pool = pool.filter(id => id !== fixture.player_a_discord_id && id !== fixture.player_b_discord_id);
      made += 1;
      continue;
    }
    if (created.reason === 'fixture_already_locked') {
      continue;
    }
    logAudit('matchmaking_create_pending_failed', null, { guildId: guild.id, fixtureId: fixture.fixture_id, reason: created.reason });
    continue;
  }

  if (made === 0) {
    logAudit('matchmaking_no_fixture', null, { guildId: guild.id, readyCount: ready.length });
  }
}

function getMatchByMessage(guildId, channelId, messageId) {
  return db.prepare(`
    SELECT * FROM matches
    WHERE league_id = 1 AND guild_id = ? AND match_channel_id = ? AND match_message_id = ?
    LIMIT 1
  `).get(String(guildId), String(channelId), String(messageId));
}

function upsertMatchReport(matchId, userId, patch) {
  const existing = db.prepare('SELECT * FROM match_reports WHERE match_id = ? AND reporter_discord_id = ?').get(matchId, userId);
  const winnerSide = patch.winner_side !== undefined ? patch.winner_side : (existing?.winner_side || null);
  const scoreCode = patch.score_code !== undefined ? patch.score_code : (existing?.score_code ?? null);

  if (!existing) {
    db.prepare(`
      INSERT INTO match_reports (match_id, reporter_discord_id, winner_side, score_code)
      VALUES (?, ?, ?, ?)
    `).run(matchId, userId, winnerSide, scoreCode);
  } else {
    db.prepare(`
      UPDATE match_reports SET winner_side = ?, score_code = ?, updated_at = datetime('now')
      WHERE match_id = ? AND reporter_discord_id = ?
    `).run(winnerSide, scoreCode, matchId, userId);
  }
}

async function editMatchMessage(guild, matchId, content) {
  const m = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
  if (!m?.match_channel_id || !m?.match_message_id) return;
  const ch = await guild.channels.fetch(m.match_channel_id).catch(() => null);
  if (!ch || !ch.isTextBased()) return;
  const msg = await ch.messages.fetch(m.match_message_id).catch(() => null);
  if (!msg) return;
  await msg.edit({ content }).catch(() => null);
}

function getAdminOverride(matchId) {
  return db.prepare('SELECT * FROM admin_match_overrides WHERE match_id = ?').get(matchId);
}

function setAdminOverride(matchId, adminUserId, winnerSide = null, scoreCode = null, active = true, winnerSelected = false) {
  const existing = getAdminOverride(matchId);
  const persistedWinnerSide = winnerSide || existing?.winner_side || 'A';
  if (!existing) {
    db.prepare('INSERT INTO admin_match_overrides (match_id, admin_discord_id, winner_side, score_code, active, winner_selected) VALUES (?, ?, ?, ?, ?, ?)').run(
      matchId,
      adminUserId,
      persistedWinnerSide,
      scoreCode,
      active ? 1 : 0,
      winnerSelected ? 1 : 0,
    );
    return true;
  }

  if (existing.admin_discord_id !== adminUserId) return false;

  db.prepare(`
    UPDATE admin_match_overrides
    SET winner_side = ?, score_code = ?, active = ?, winner_selected = ?, updated_at = datetime('now')
    WHERE match_id = ?
  `).run(persistedWinnerSide, scoreCode, active ? 1 : 0, winnerSelected ? 1 : 0, matchId);
  return true;
}

function clearAdminOverride(matchId) {
  db.prepare('DELETE FROM admin_match_overrides WHERE match_id = ?').run(matchId);
}

async function reconcileFromPlayerReports(match, settings, guild) {
  const adminOverride = getAdminOverride(match.match_id);

  const reports = db.prepare('SELECT * FROM match_reports WHERE match_id = ?').all(match.match_id);
  const ra = reports.find(r => r.reporter_discord_id === match.player_a_discord_id);
  const rb = reports.find(r => r.reporter_discord_id === match.player_b_discord_id);

  const completeA = ra && ra.winner_side && ra.score_code !== null && ra.score_code !== undefined;
  const completeB = rb && rb.winner_side && rb.score_code !== null && rb.score_code !== undefined;

  if (adminOverride?.active && adminOverride.winner_selected && adminOverride.winner_side && adminOverride.score_code !== null && adminOverride.score_code !== undefined) {
    const winnerSide = adminOverride.winner_side;
    const score = scoreFromCode(settings.match_format, Number(adminOverride.score_code));
    if (!score) return;

    let scoreA; let scoreB; let winnerId;
    if (winnerSide === 'A') {
      [scoreA, scoreB] = score;
      winnerId = match.player_a_discord_id;
    } else {
      [scoreB, scoreA] = score;
      winnerId = match.player_b_discord_id;
    }

    db.prepare('DELETE FROM results WHERE match_id = ?').run(match.match_id);
    db.prepare(`
      INSERT INTO results (match_id, winner_discord_id, score_a, score_b, is_forfeit, reporter_discord_id, confirmer_discord_id, confirmed_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, datetime('now'))
    `).run(match.match_id, winnerId, scoreA, scoreB, adminOverride.admin_discord_id, adminOverride.admin_discord_id);

    db.prepare("UPDATE matches SET state = 'confirmed', ended_at = datetime('now') WHERE match_id = ?").run(match.match_id);
    db.prepare("UPDATE fixtures SET status = 'confirmed', confirmed_at = datetime('now') WHERE fixture_id = ?").run(match.fixture_id);

    logAudit('admin_reaction_finalized_match', adminOverride.admin_discord_id, { matchId: match.match_id, winnerSide, scoreA, scoreB, via: 'exclamation_override' });
    await editMatchMessage(guild, match.match_id, buildMatchAssignmentMessage(match, settings, 'Confirmed', `Final: ${scoreA}-${scoreB} (Admin override by <@${adminOverride.admin_discord_id}>)`));

    const ch = await guild.channels.fetch(match.match_channel_id).catch(() => null);
    if (ch && ch.isTextBased()) {
      const msg = await ch.messages.fetch(match.match_message_id).catch(() => null);
      if (msg) await msg.react('🔁').catch(() => null);
    }
    return;
  }

  if (!(completeA && completeB)) {
    const anyReport = (ra && (ra.winner_side || ra.score_code !== null && ra.score_code !== undefined))
      || (rb && (rb.winner_side || rb.score_code !== null && rb.score_code !== undefined));
    db.prepare('DELETE FROM results WHERE match_id = ?').run(match.match_id);
    db.prepare("UPDATE matches SET state = ?, ended_at = NULL WHERE match_id = ?").run(anyReport ? 'reported' : 'pending', match.match_id);
    db.prepare("UPDATE fixtures SET status = 'locked_in_match', confirmed_at = NULL WHERE fixture_id = ?").run(match.fixture_id);

    await editMatchMessage(guild, match.match_id, buildMatchAssignmentMessage(match, settings, anyReport ? 'Reported' : 'Pending', 'Awaiting winner + score from both players.'));
    return;
  }

  if (ra.winner_side !== rb.winner_side || Number(ra.score_code) !== Number(rb.score_code)) {
    db.prepare('DELETE FROM results WHERE match_id = ?').run(match.match_id);
    db.prepare("UPDATE matches SET state = 'disputed', ended_at = NULL WHERE match_id = ?").run(match.match_id);
    const details = `Disputed
Player A report: winner=${ra.winner_side}, scoreCode=${ra.score_code}
Player B report: winner=${rb.winner_side}, scoreCode=${rb.score_code}`;
    await editMatchMessage(guild, match.match_id, buildMatchAssignmentMessage(match, settings, 'Disputed', details));
    await sendDisputeNotification(guild, settings, `⚠️ Match ${match.match_id} is disputed. Please review in <#${match.match_channel_id}>.`);
    return;
  }

  const winnerSide = ra.winner_side;
  const score = scoreFromCode(settings.match_format, Number(ra.score_code));
  if (!score) return;

  let scoreA; let scoreB; let winnerId;
  if (winnerSide === 'A') {
    [scoreA, scoreB] = score;
    winnerId = match.player_a_discord_id;
  } else {
    [scoreB, scoreA] = score;
    winnerId = match.player_b_discord_id;
  }

  db.prepare('DELETE FROM results WHERE match_id = ?').run(match.match_id);
  db.prepare(`
    INSERT INTO results (match_id, winner_discord_id, score_a, score_b, is_forfeit, reporter_discord_id, confirmer_discord_id, confirmed_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, datetime('now'))
  `).run(match.match_id, winnerId, scoreA, scoreB, ra.reporter_discord_id, rb.reporter_discord_id);

  db.prepare("UPDATE matches SET state = 'confirmed', ended_at = datetime('now') WHERE match_id = ?").run(match.match_id);
  db.prepare("UPDATE fixtures SET status = 'confirmed', confirmed_at = datetime('now') WHERE fixture_id = ?").run(match.fixture_id);
  await editMatchMessage(guild, match.match_id, buildMatchAssignmentMessage(match, settings, 'Confirmed', `Final: ${scoreA}-${scoreB} (Confirmed)`));

  const ch = await guild.channels.fetch(match.match_channel_id).catch(() => null);
  if (ch && ch.isTextBased()) {
    const msg = await ch.messages.fetch(match.match_message_id).catch(() => null);
    if (msg) await msg.react('🔁').catch(() => null);
  }
}

async function handleRematchReactionAdd(match, userId, guild, settings) {
  if (![match.player_a_discord_id, match.player_b_discord_id].includes(userId)) return;

  db.prepare('INSERT OR IGNORE INTO rematch_votes (match_id, discord_user_id) VALUES (?, ?)').run(match.match_id, userId);

  const votes = db.prepare('SELECT discord_user_id FROM rematch_votes WHERE match_id = ?').all(match.match_id).map((r) => r.discord_user_id);
  const bothReady = votes.includes(match.player_a_discord_id) && votes.includes(match.player_b_discord_id);
  if (!bothReady) return;

  const nextFixture = db.prepare(`
    SELECT fixture_id, player_a_discord_id, player_b_discord_id
    FROM fixtures
    WHERE league_id = 1
      AND status = 'unplayed'
      AND ((player_a_discord_id = ? AND player_b_discord_id = ?) OR (player_a_discord_id = ? AND player_b_discord_id = ?))
    ORDER BY leg_number ASC, fixture_id ASC
    LIMIT 1
  `).get(match.player_a_discord_id, match.player_b_discord_id, match.player_b_discord_id, match.player_a_discord_id);

  if (!nextFixture) return;

  const channel = await guild.channels.fetch(match.match_channel_id || settings.results_channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  await createPendingMatch(nextFixture, channel, guild.id);
  db.prepare('DELETE FROM rematch_votes WHERE match_id = ?').run(match.match_id);

  await channel.send({
    content: `🔁 Rematch accepted for Match ${match.match_id}. New match posted for <@${match.player_a_discord_id}> and <@${match.player_b_discord_id}>.`,
    allowed_mentions: { users: [match.player_a_discord_id, match.player_b_discord_id], roles: [], replied_user: false },
  }).catch(() => null);
}

function handleRematchReactionRemove(match, userId) {
  db.prepare('DELETE FROM rematch_votes WHERE match_id = ? AND discord_user_id = ?').run(match.match_id, userId);
}

async function handleReactionResultFlow(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const msg = reaction.message;
  if (!msg?.guildId) return;

  const match = getMatchByMessage(msg.guildId, msg.channelId, msg.id);
  if (!match) return;

  const guild = msg.guild;
  const emoji = reaction.emoji.name;
  const settings = getGuildSettings(msg.guildId);
  const validScores = getScoreReactionsForFormat(settings.match_format);

  const isPlayer = [match.player_a_discord_id, match.player_b_discord_id].includes(user.id);
  const member = await guild.members.fetch(user.id).catch(() => null);
  const isAdminActor = member ? isAdminMember(member, msg.guildId) : false;

  if (!isPlayer && !isAdminActor) {
    await reaction.users.remove(user.id).catch(() => null);
    return;
  }

  if (match.state === 'cancelled') {
    await reaction.users.remove(user.id).catch(() => null);
    return;
  }

  if (emoji === '🔁') {
    if (match.state !== 'confirmed') {
      await reaction.users.remove(user.id).catch(() => null);
      return;
    }
    await handleRematchReactionAdd(match, user.id, guild, settings);
    return;
  }

  if (isAdminActor && emoji === '❗') {
    const accepted = setAdminOverride(match.match_id, user.id, null, null, true, false);
    if (!accepted) {
      await reaction.users.remove(user.id).catch(() => null);
      return;
    }
    await reconcileFromPlayerReports(match, settings, guild);
    return;
  }

  const override = getAdminOverride(match.match_id);
  const hasAdminOverride = !!(override && override.active);
  if (match.state === 'confirmed' && !hasAdminOverride) {
    await reaction.users.remove(user.id).catch(() => null);
    return;
  }

  if (emoji === '🇦' || emoji === '🇧') {
    if (isAdminActor) {
      const canUseAdminOverride = !!(override && override.admin_discord_id === user.id && override.active);
      if (canUseAdminOverride) {
        const winnerSide = emoji === '🇦' ? 'A' : 'B';
        setAdminOverride(match.match_id, user.id, winnerSide, override.score_code, true, true);
        for (const e of validScores) await msg.react(e).catch(() => null);
        await reconcileFromPlayerReports(match, settings, guild);
        return;
      }

      if (!isPlayer) {
        await reaction.users.remove(user.id).catch(() => null);
        return;
      }
    }

    const winnerSide = emoji === '🇦' ? 'A' : 'B';
    upsertMatchReport(match.match_id, user.id, { winner_side: winnerSide });

    for (const e of validScores) await msg.react(e).catch(() => null);
    await reconcileFromPlayerReports(match, settings, guild);
    return;
  }

  if (!validScores.includes(emoji)) return;

  const code = validScores.indexOf(emoji);
  if (isAdminActor) {
    const canUseAdminOverride = !!(override && override.admin_discord_id === user.id && override.active);
    if (canUseAdminOverride) {
      setAdminOverride(match.match_id, user.id, override.winner_side, code, true, Boolean(override.winner_selected));
      await reconcileFromPlayerReports(match, settings, guild);
      return;
    }

    if (!isPlayer) {
      await reaction.users.remove(user.id).catch(() => null);
      return;
    }
  }

  upsertMatchReport(match.match_id, user.id, { score_code: code });
  await reconcileFromPlayerReports(match, settings, guild);
}

async function handleReactionResultFlowRemove(reaction, user) {
  if (user.bot) return;
  if (reaction.partial) await reaction.fetch().catch(() => null);
  const msg = reaction.message;
  if (!msg?.guildId) return;

  const match = getMatchByMessage(msg.guildId, msg.channelId, msg.id);
  if (!match) return;

  const guild = msg.guild;
  const emoji = reaction.emoji.name;
  const settings = getGuildSettings(msg.guildId);

  if (emoji === '🔁') {
    handleRematchReactionRemove(match, user.id);
    return;
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  const isAdminActor = member ? isAdminMember(member, msg.guildId) : false;
  if (!isAdminActor) return;
  const scoreReactions = getScoreReactionsForFormat(settings.match_format);
  if (emoji !== '🇦' && emoji !== '🇧' && emoji !== '❗' && !scoreReactions.includes(emoji)) return;

  const override = getAdminOverride(match.match_id);
  if (!override) return;
  if (override.admin_discord_id !== user.id) return;
  if (emoji === '❗') {
    clearAdminOverride(match.match_id);
    logAudit('admin_reaction_override_removed', user.id, { matchId: match.match_id, type: 'exclamation' });
    await reconcileFromPlayerReports(match, settings, guild);
    return;
  }

  if (emoji === '🇦' && override.winner_side !== 'A') return;
  if (emoji === '🇧' && override.winner_side !== 'B') return;
  if (scoreReactions.includes(emoji) && Number(override.score_code) !== scoreReactions.indexOf(emoji)) return;

  clearAdminOverride(match.match_id);
  logAudit('admin_reaction_override_removed', user.id, { matchId: match.match_id });
  await reconcileFromPlayerReports(match, settings, guild);
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await handleReactionResultFlow(reaction, user);
  } catch (err) {
    console.error('Reaction flow error:', err);
  }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  try {
    await handleReactionResultFlowRemove(reaction, user);
  } catch (err) {
    console.error('Reaction remove flow error:', err);
  }
});

let matchmakerTimer = null;

async function runMatchmakingTick() {
  for (const guild of client.guilds.cache.values()) {
    await tryMatchmake(guild).catch((err) => {
      console.error('Background matchmaking tick error:', err);
    });
  }
}

function invokeMatchmakingTickSafely() {
  if (typeof runMatchmakingTick !== 'function') {
    console.error('Matchmaking tick skipped: runMatchmakingTick is not defined');
    return;
  }
  runMatchmakingTick().catch((err) => {
    console.error('Background matchmaking tick failed:', err);
  });
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (!Number.isFinite(MATCHMAKER_INTERVAL_MS) || MATCHMAKER_INTERVAL_MS < 5000) {
    console.warn(`Invalid MATCHMAKER_INTERVAL_MS=${MATCHMAKER_INTERVAL_MS}; defaulting to 30000ms.`);
  }

  const interval = Number.isFinite(MATCHMAKER_INTERVAL_MS) && MATCHMAKER_INTERVAL_MS >= 5000
    ? MATCHMAKER_INTERVAL_MS
    : 30000;

  matchmakerTimer = setInterval(() => {
    invokeMatchmakingTickSafely();
  }, interval);

  // Kick one immediate pass on startup.
  invokeMatchmakingTickSafely();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    const isTableCommand = interaction.isChatInputCommand() && interaction.commandName === 'table';
    // Acknowledge /table ASAP to avoid Discord's 3-second interaction timeout.
    if (isTableCommand && !interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: false });
    }

    // Keep last seen name updated if signed up
    const displayName = getDisplayNameFromInteraction(interaction);
    const existing = getPlayer(interaction.user.id);
    if (existing) upsertLastSeenDisplayName(interaction.user.id, displayName);

    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === 'ping') {
        await interaction.reply({ content: 'pong' });
        return;
      }

      if (name === 'signup') {
        const modal = new ModalBuilder()
          .setCustomId('signup_modal')
          .setTitle('Tekken League Signup');

        const realName = new TextInputBuilder()
          .setCustomId('real_name')
          .setLabel('Real name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(80);

        const tekkenTag = new TextInputBuilder()
          .setCustomId('tekken_tag')
          .setLabel('Tekken tag / IGN')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40);

        const email = new TextInputBuilder()
          .setCustomId('email')
          .setLabel('Email')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(120);

        const phone = new TextInputBuilder()
          .setCustomId('phone')
          .setLabel('Phone number')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(40);

        modal.addComponents(
          new ActionRowBuilder().addComponents(realName),
          new ActionRowBuilder().addComponents(tekkenTag),
          new ActionRowBuilder().addComponents(email),
          new ActionRowBuilder().addComponents(phone),
        );

        await interaction.showModal(modal);
        return;
      }

      if (name === 'mydata') {
        const p = ensureSignedUp(interaction);
        if (!p) {
          await interaction.reply({ content: 'You are not signed up yet. Use /signup first.' });
          return;
        }

        const realName = decryptString(p.real_name_enc);
        const email = decryptString(p.email_enc);
        const phone = decryptString(p.phone_enc);

        await interaction.reply({
          content: [
            `Real name: ${realName}`,
            `Tekken tag: ${p.tekken_tag}`,
            `Email: ${maskEmail(email)}`,
            `Phone: ${maskPhone(phone)}`,
            `Discord: ${p.discord_display_name_last_seen || p.discord_display_name_at_signup || interaction.user.username}`,
          ].join('\n'),
        });
        return;
      }

      if (name === 'checkin') {
        const p = ensureSignedUp(interaction);
        if (!p) {
          await interaction.reply({ content: 'You must /signup before checking in.' });
          return;
        }

        const today = getTodayISO(true);
        const existing = db.prepare(`
          SELECT checked_in FROM attendance
          WHERE league_id = 1 AND discord_user_id = ? AND date = ?
        `).get(interaction.user.id, today);

        db.prepare(`
          INSERT INTO attendance (league_id, discord_user_id, date, checked_in, checked_in_at)
          VALUES (1, ?, ?, 1, datetime('now'))
          ON CONFLICT(league_id, discord_user_id, date)
          DO UPDATE SET
            checked_in = 1,
            checked_in_at = datetime('now')
        `).run(interaction.user.id, today);

        logAudit('checkin', interaction.user.id, { date: today });
        await sendActivityNotification(interaction.guild, getGuildSettings(interaction.guildId), `✅ Check-in: <@${interaction.user.id}> on ${today}.`).catch(() => null);
        if (existing && Number(existing.checked_in) === 1) {
          await interaction.reply({ content: `Already checked in for ${today}.` });
          return;
        }

        await interaction.reply({ content: `Checked in for ${today}.` });
        return;
      }

      if (name === 'ready') {
        const p = ensureSignedUp(interaction);
        if (!p) {
          await interaction.reply({ content: 'You must /signup before using /ready.' });
          return;
        }

        if (!hasCheckedInToday(interaction.user.id)) {
          await interaction.reply({ content: 'Please /checkin for today first (attendance rule).' });
          return;
        }

        if (hasActiveMatch(interaction.user.id)) {
          await interaction.reply({ content: 'You already have an active/pending match. Finish it before queueing again.' });
          return;
        }

        addToReadyQueue(interaction.user.id);
        logAudit('queue_join', interaction.user.id);
        await sendActivityNotification(interaction.guild, getGuildSettings(interaction.guildId), `🟢 Ready: <@${interaction.user.id}> joined the queue.`).catch(() => null);
        await interaction.reply({ content: 'You are in the queue. Waiting for an opponent...' });
        await tryMatchmake(interaction.guild);
        return;
      }

      if (name === 'unready') {
        removeFromReadyQueue(interaction.user.id);
        logAudit('queue_leave', interaction.user.id);
        await interaction.reply({ content: 'Removed from queue.' });
        return;
      }

      if (name === 'standings') {
        await interaction.reply({
          content: buildStandingsListMessage(),
          ephemeral: false,
        });
        return;
      }

      if (name === 'table') {
        let pages;
        try {
          pages = buildStandingsTablePages();
        } catch (err) {
          console.error('Failed to build table pages:', err);
          await interaction.editReply({ content: 'Unable to generate the table right now. Please try again.' });
          return;
        }

        const totalPages = pages.length;
        const requestedPageRaw = interaction.options.getInteger('page') || 1;
        const requestedPage = Math.max(1, Math.min(totalPages, requestedPageRaw));
        const pageContent = pages[requestedPage - 1];

        try {
          await interaction.editReply({ content: pageContent });
        } catch (err) {
          console.error('Failed to send table page response:', err);
          const fallback = buildStandingsListMessage();
          await interaction.editReply({ content: `${fallback}\n\n(Table fallback: ASCII render failed in this context.)` }).catch(() => null);
          return;
        }
        return;
      }

      if (name === 'queue') {
        const queue = getReadyQueueSnapshot();
        if (!queue.length) {
          await interaction.reply({ content: 'Ready queue is currently empty.', ephemeral: false });
          return;
        }

        const lines = queue.map((row, idx) => `${idx + 1}. ${row.tekken_tag || row.discord_user_id} (<@${row.discord_user_id}>)`);
        await interaction.reply({ content: `**Ready Queue (${queue.length})**
${lines.join('\n')}`, ephemeral: false });
        return;
      }

      if (name === 'left') {
        const p = ensureSignedUp(interaction);
        if (!p) {
          await interaction.reply({ content: 'You must /signup before using /left.' });
          return;
        }

        const report = buildLeftToPlayMessage(interaction.user.id);
        try {
          await interaction.user.send({ content: report });
          await interaction.reply({ content: 'I sent your remaining matches report to your DMs.', ephemeral: true });
        } catch {
          await interaction.reply({ content: 'I could not DM you. Please enable DMs from server members and try again.', ephemeral: true });
        }
        return;
      }

      if (name === 'matches') {
        await interaction.reply({ content: buildMatchesMessage(), ephemeral: false });
        return;
      }

      if (name === 'help') {
        await interaction.reply({
          content: [
            '**League Bot Quick Help**',
            '• /signup — register or update your league profile',
            "• /checkin — mark today's availability (attendance requirement)",
            '• /ready and /unready — join/leave live matchmaking queue',
            '• /queue — view current ready players',
            '• /left — see who you still need to play and remaining matches',
            '• /standings or /table — view live standings table anytime',
            '• /matches — view recent match IDs and statuses',
            '• /mydata — view your private stored profile details',
            'Admins: /adminhelp, /points, /admin_vs, /bot_settings, /admin_status, /admin_player_matches, /admin_player_left, /admin_tournament_settings, /admin_setup_tournament, /admin_generate_fixtures, /admin_force_result, /admin_void_match, /admin_dispute_match, /admin_reset, /admin_reset_confirm, /admin_reset_league',
          ].join('\n'),
        });
        return;
      }


      if (name === 'helpplayer' || name === 'playerhelp') {
        await interaction.reply({
          content: [
            '**Player Help**',
            '1) `/signup` to register your league details.',
            '2) `/checkin` daily to count attendance.',
            '3) `/ready` when you can play now, `/unready` when you cannot.',
            '4) Use `/standings` or `/table` anytime for the league table.',
            '5) Use `/queue` to see who is currently available.',
            '6) Use `/left` to see opponents and remaining matches sorted by priority.',
            '7) Use `/mydata` to view your saved profile (private).',
            'Tip: `/playerhelp` is an alias if `/helpplayer` is hard to find.',
          ].join('\n'),
        });
        return;
      }

      if (name === 'adminhelp') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        await interaction.reply({
          content: [
            '**Admin Commands Help**',
            '• /admin_status — quick league health + queue snapshot.',
            '• /admin_generate_fixtures — generate missing round-robin fixtures.',
            '• /admin_player_matches — inspect one player match list.',
            '• /admin_player_left — inspect one player remaining opponents.',
            '• /admin_tournament_settings — view current tournament setup + points.',
            '• /admin_setup_tournament — update setup fields (days, slots, show%).',
            '• /points — set points for win, loss, no-show, and 3-0 sweep bonus.',
            '• /admin_vs — create a specific match between two eligible players.',
            '• /admin_force_result — force a result for no-show/dispute scenarios.',
            '• /admin_void_match — remove result and reopen fixture.',
            '• /admin_dispute_match — mark a match disputed and notify staff.',
            '• /admin_reset and /admin_reset_league — request reset token (5 min expiry).',
            '• /admin_reset_confirm — confirm pending reset with your token.',
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (name === 'points') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const rules = normalizePointRules({
          points_win: interaction.options.getInteger('win', true),
          points_loss: interaction.options.getInteger('loss', true),
          points_no_show: interaction.options.getInteger('no_show', true),
          points_sweep_bonus: interaction.options.getInteger('sweep_bonus', true),
        });

        db.prepare(`
          UPDATE leagues
          SET points_win = ?, points_loss = ?, points_no_show = ?, points_sweep_bonus = ?
          WHERE league_id = 1
        `).run(rules.points_win, rules.points_loss, rules.points_no_show, rules.points_sweep_bonus);

        logAudit('admin_points_update', interaction.user.id, rules);
        await interaction.reply({
          content: `Points updated: win=${rules.points_win}, loss=${rules.points_loss}, no-show=${rules.points_no_show}, 3-0 sweep bonus=${rules.points_sweep_bonus}.`,
          ephemeral: true,
        });
        return;
      }

      if (name === 'admin_vs') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const playerA = interaction.options.getUser('player_a', true);
        const playerB = interaction.options.getUser('player_b', true);
        if (playerA.id === playerB.id) {
          await interaction.reply({ content: 'Select two different players.', ephemeral: true });
          return;
        }

        const pA = getPlayer(playerA.id);
        const pB = getPlayer(playerB.id);
        if (!pA || !pB) {
          await interaction.reply({ content: 'Both selected users must be signed up.', ephemeral: true });
          return;
        }

        const eligibleOpponentIds = getEligibleOpponentsForPlayer(playerA.id).map((row) => row.opponent_id);
        if (!eligibleOpponentIds.includes(playerB.id)) {
          const choices = getEligibleOpponentsForPlayer(playerA.id).map((row) => row.tekken_tag || row.opponent_id);
          await interaction.reply({
            content: choices.length
              ? `That opponent is not eligible for ${pA.tekken_tag}. Eligible opponents: ${choices.join(', ')}`
              : `${pA.tekken_tag} has no eligible opponents left.`,
            ephemeral: true,
          });
          return;
        }

        const fixture = getNextUnplayedFixtureBetween(playerA.id, playerB.id);
        if (!fixture) {
          await interaction.reply({ content: 'No unplayed fixture remains between these players.', ephemeral: true });
          return;
        }

        const settings = getGuildSettings(interaction.guildId);
        const channelId = settings.results_channel_id || MATCH_CHANNEL_ID;
        const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          await interaction.reply({ content: 'Results channel not found. Configure it with /bot_settings set_results_channel.', ephemeral: true });
          return;
        }

        await createPendingMatch(fixture, channel, interaction.guildId);
        logAudit('admin_vs_create_match', interaction.user.id, { fixtureId: fixture.fixture_id, playerA: playerA.id, playerB: playerB.id });
        await interaction.reply({ content: `Created pending match for <@${playerA.id}> vs <@${playerB.id}>.`, ephemeral: true });
        return;
      }


      if (name === 'bot_settings') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        if (sub === 'view') {
          const gs = getGuildSettings(guildId);
          const roles = getConfiguredAdminRoleIds(guildId);
          await interaction.reply({
            content: [
              '**Bot Settings**',
              `resultsChannelId: ${gs.results_channel_id || '(not set)'}`,
              `adminChannelId: ${gs.admin_channel_id || '(not set)'}`,
              `standingsChannelId: ${gs.standings_channel_id || '(not set)'}`,
              `disputeChannelId: ${gs.dispute_channel_id || '(not set)'}`,
              `activityChannelId: ${gs.activity_channel_id || '(not set)'}`,
              `matchFormat: ${gs.match_format}`,
              `allowPublicPlayerCommands: ${gs.allow_public_player_commands ? 'true' : 'false'}`,
              `tournamentName: ${gs.tournament_name}`,
              `timezone: ${gs.timezone}`,
              `cleanupPolicy: ${gs.cleanup_policy}${gs.cleanup_days ? ` (${gs.cleanup_days} days)` : ''}`,
              `enableDiagnostics: ${gs.enable_diagnostics ? 'true' : 'false'}`,
              `adminRoles: ${roles.length ? roles.map(r => `<@&${r}>`).join(', ') : '(none)'}`,
            ].join('\n'),
            ephemeral: true,
          });
          return;
        }

        if (sub === 'set_admin_roles') {
          const roles = [
            interaction.options.getRole('role_1', true),
            interaction.options.getRole('role_2'),
            interaction.options.getRole('role_3'),
            interaction.options.getRole('role_4'),
            interaction.options.getRole('role_5'),
          ].filter(Boolean);

          const ids = [...new Set(roles.map(r => r.id))];
          db.transaction((roleIds) => {
            db.prepare('DELETE FROM admin_roles WHERE league_id = 1 AND (guild_id = ? OR guild_id IS NULL)').run(String(guildId));
            const ins = db.prepare('INSERT INTO admin_roles (league_id, guild_id, role_id) VALUES (1, ?, ?)');
            for (const id of roleIds) ins.run(String(guildId), id);
          })(ids);

          logAudit('bot_settings_set_admin_roles', interaction.user.id, { guildId, roleIds: ids });
          await interaction.reply({ content: `Admin roles set: ${ids.map(id => `<@&${id}>`).join(', ')}`, ephemeral: true });
          return;
        }

        const patch = {};
        if (sub === 'set_results_channel') patch.results_channel_id = interaction.options.getChannel('channel', true).id;
        if (sub === 'set_admin_channel') patch.admin_channel_id = interaction.options.getChannel('channel', true).id;
        if (sub === 'set_match_format') patch.match_format = interaction.options.getString('format', true);
        if (sub === 'set_tournament_name') patch.tournament_name = interaction.options.getString('name', true).trim();
        if (sub === 'set_timezone') patch.timezone = interaction.options.getString('tz', true).trim();
        if (sub === 'set_standings_channel') patch.standings_channel_id = interaction.options.getChannel('channel', true).id;
        if (sub === 'set_dispute_channel') patch.dispute_channel_id = interaction.options.getChannel('channel', true).id;
        if (sub === 'set_activity_channel') patch.activity_channel_id = interaction.options.getChannel('channel', true).id;
        if (sub === 'set_diagnostics') patch.enable_diagnostics = interaction.options.getBoolean('enabled', true) ? 1 : 0;
        if (sub === 'set_allow_public_player_commands') patch.allow_public_player_commands = interaction.options.getBoolean('enabled', true) ? 1 : 0;
        if (sub === 'set_cleanup_policy') {
          const policy = interaction.options.getString('policy', true);
          const days = interaction.options.getInteger('days');
          if (policy === 'archive' && (!days || days < 1 || days > 365)) {
            await interaction.reply({ content: 'For archive policy, days must be between 1 and 365.', ephemeral: true });
            return;
          }
          patch.cleanup_policy = policy;
          patch.cleanup_days = policy === 'archive' ? days : null;
        }

        if (patch.timezone) {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: patch.timezone }).format(new Date());
          } catch {
            await interaction.reply({ content: 'Invalid timezone. Use IANA format like Asia/Qatar.', ephemeral: true });
            return;
          }
        }

        updateGuildSetting(guildId, patch);
        logAudit('bot_settings_update', interaction.user.id, { guildId, subcommand: sub, patch });
        await interaction.reply({ content: `Updated ${sub}.`, ephemeral: true });
        return;
      }

      if (name === 'admin_generate_fixtures') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }
        const r = generateDoubleRoundRobinFixtures(db, 1);
        logAudit('admin_generate_fixtures', interaction.user.id, { ok: r.ok, message: r.message });
        await interaction.reply({ content: r.message, ephemeral: true });
        return;
      }





      if (name === 'admin_status') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const players = db.prepare("SELECT COUNT(1) AS c FROM players WHERE league_id = 1 AND status = 'active'").get().c;
        const fixtures = db.prepare("SELECT COUNT(1) AS c FROM fixtures WHERE league_id = 1").get().c;
        const confirmedFixtures = db.prepare("SELECT COUNT(1) AS c FROM fixtures WHERE league_id = 1 AND status = 'confirmed'").get().c;
        const queueCount = db.prepare('SELECT COUNT(1) AS c FROM ready_queue WHERE league_id = 1').get().c;
        const activeMatches = db.prepare("SELECT COUNT(1) AS c FROM matches WHERE league_id = 1 AND state IN ('pending','reported','active','disputed')").get().c;

        await interaction.reply({
          content: [
            '**League Admin Status**',
            `Players (active): ${players}`,
            `Fixtures: ${fixtures} total / ${confirmedFixtures} confirmed`,
            `Ready queue: ${queueCount}`,
            `Open matches: ${activeMatches}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }


      if (name === 'admin_player_matches') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const target = interaction.options.getUser('player', true);
        await interaction.reply({ content: buildMatchesMessage(30, target.id), ephemeral: true });
        return;
      }

      if (name === 'admin_player_left') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const target = interaction.options.getUser('player', true);
        const p = getPlayer(target.id);
        if (!p) {
          await interaction.reply({ content: 'That user is not signed up in the league.', ephemeral: true });
          return;
        }

        await interaction.reply({ content: buildLeftToPlayMessage(target.id), ephemeral: true });
        return;
      }

      if (name === 'admin_tournament_settings') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        await interaction.reply({ content: buildTournamentSettingsMessage(), ephemeral: true });
        return;
      }

      if (name === 'admin_setup_tournament') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const maxPlayers = interaction.options.getInteger('max_players');
        const timeslotCount = interaction.options.getInteger('timeslot_count');
        const timeslotDurationMinutes = interaction.options.getInteger('timeslot_duration_minutes');
        const timeSlotStartsRaw = interaction.options.getString('timeslot_starts');
        const clearTimeslotStarts = interaction.options.getBoolean('clear_timeslot_starts') === true;
        const totalTournamentDays = interaction.options.getInteger('total_tournament_days');
        const minimumShowupPercent = interaction.options.getNumber('minimum_showup_percent');
        const tournamentStartDateRaw = interaction.options.getString('tournament_start_date');

        if (clearTimeslotStarts && timeSlotStartsRaw) {
          await interaction.reply({
            content: 'Use either `timeslot_starts` or `clear_timeslot_starts:true`, not both at the same time.',
            ephemeral: true,
          });
          return;
        }

        const hasAnyUpdate = [maxPlayers, timeslotCount, timeslotDurationMinutes, timeSlotStartsRaw, totalTournamentDays, minimumShowupPercent, tournamentStartDateRaw]
          .some(v => v !== null && v !== undefined);
        if (!hasAnyUpdate && !clearTimeslotStarts) {
          await interaction.reply({
            content: `No values supplied.
${buildTournamentSettingsMessage()}`,
            ephemeral: true,
          });
          return;
        }

        const validated = validateTournamentSetupInput({
          maxPlayers,
          timeslotCount,
          timeslotDurationMinutes,
          timeSlotStartsRaw,
          clearTimeslotStarts,
          totalTournamentDays,
          minimumShowupPercent,
          tournamentStartDateRaw,
        });

        if (!validated.ok) {
          await interaction.reply({ content: validated.error, ephemeral: true });
          return;
        }

        const current = getLeagueSettings();
        const merged = {
          max_players: validated.values.max_players ?? current.max_players,
          timeslot_count: validated.values.timeslot_count ?? current.timeslot_count,
          timeslot_duration_minutes: validated.values.timeslot_duration_minutes ?? current.timeslot_duration_minutes,
          timeslot_starts: validated.values.timeslot_starts ?? current.timeslot_starts,
          season_days: validated.values.season_days ?? current.season_days,
          eligibility_min_percent: validated.values.eligibility_min_percent ?? current.eligibility_min_percent,
          tournament_start_date: validated.values.tournament_start_date ?? current.tournament_start_date,
        };

        if (clearTimeslotStarts && validated.values.timeslot_starts === '') {
          merged.timeslot_starts = '';
          merged.timeslot_count = 0;
        }

        const timeslotStartsList = String(merged.timeslot_starts || '').split(',').map((x) => x.trim()).filter(Boolean);
        const isTimeslotConfigCleared = merged.timeslot_count === 0 && timeslotStartsList.length === 0;
        if (!isTimeslotConfigCleared && timeslotStartsList.length !== merged.timeslot_count) {
          await interaction.reply({
            content: `No. of timeslots (${merged.timeslot_count}) must match start times count (${timeslotStartsList.length}).`,
            ephemeral: true,
          });
          return;
        }

        merged.timeslot_starts = timeslotStartsList.join(',');

        const minAttendanceDays = Math.ceil(merged.season_days * merged.eligibility_min_percent);

        db.prepare(`
          UPDATE leagues
          SET
            max_players = ?,
            timeslot_count = ?,
            timeslot_duration_minutes = ?,
            timeslot_starts = ?,
            season_days = ?,
            eligibility_min_percent = ?,
            attendance_min_days = ?,
            tournament_start_date = ?
          WHERE league_id = 1
        `).run(
          merged.max_players,
          merged.timeslot_count,
          merged.timeslot_duration_minutes,
          merged.timeslot_starts,
          merged.season_days,
          merged.eligibility_min_percent,
          minAttendanceDays,
          merged.tournament_start_date,
        );

        logAudit('admin_setup_tournament', interaction.user.id, {
          updated: validated.values,
          computed_attendance_min_days: minAttendanceDays,
        });

        await interaction.reply({
          content: `Tournament settings updated.
${buildTournamentSettingsMessage()}`,
          ephemeral: true,
        });
        return;
      }

      if (name === 'admin_reset') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const level = interaction.options.getString('level', true);
        const token = createResetRequest(interaction, level, 'admin_reset');
        const gs = getGuildSettings(interaction.guildId);
        await sendAdminNotification(
          interaction.guild,
          gs,
          `⚠️ Reset requested by ${interaction.user.tag} (${interaction.user.id}).\nLevel: ${level}. Awaiting /admin_reset_confirm by requester.`
        ).catch(() => null);
        await interaction.reply({
          content: `Reset requested. To confirm, run /admin_reset_confirm token:${token} within 5 minutes.`,
          ephemeral: true,
        });
        return;
      }

      if (name === 'admin_reset_league') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const token = createResetRequest(interaction, 'league', 'admin_reset_league');
        const gs = getGuildSettings(interaction.guildId);
        await sendAdminNotification(
          interaction.guild,
          gs,
          `⚠️ Reset requested by ${interaction.user.tag} (${interaction.user.id}).\nLevel: league. Awaiting /admin_reset_confirm by requester.`
        ).catch(() => null);
        await interaction.reply({
          content: `Reset requested. To confirm, run /admin_reset_confirm token:${token} within 5 minutes.`,
          ephemeral: true,
        });
        return;
      }

      if (name === 'admin_reset_confirm') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const token = interaction.options.getString('token', true);
        const consumed = consumeResetToken(token);
        if (!consumed.ok) {
          await interaction.reply({ content: consumed.error, ephemeral: true });
          return;
        }

        const pending = consumed.pending;
        if (pending.requestedByUserId !== interaction.user.id) {
          pendingResetTokens.set(String(token).trim().toUpperCase(), pending);
          await interaction.reply({ content: 'Only the original requester can confirm this reset token.', ephemeral: true });
          return;
        }

        const summary = runLeagueReset(pending.level);
        logAudit(pending.auditAction, pending.requestedByUserId, {
          level: pending.level,
          summary,
          confirmed_via: 'token_command',
          token: String(token).trim().toUpperCase(),
        });

        const gs = getGuildSettings(interaction.guildId);
        await sendAdminNotification(
          interaction.guild,
          gs,
          `✅ Reset completed by ${interaction.user.tag} (${interaction.user.id}).\n${summary}`
        ).catch(() => null);

        await interaction.reply({ content: summary, ephemeral: true });
        return;
      }

      if (name === 'admin_force_result') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const matchId = interaction.options.getInteger('match_id', true);
        const winnerUser = interaction.options.getUser('winner', true);
        const scoreRaw = interaction.options.getString('score', true);
        const isForfeit = interaction.options.getBoolean('forfeit') === true;

        const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
        if (!match) {
          await interaction.reply({ content: 'Match not found.', ephemeral: true });
          return;
        }

        if (![match.player_a_discord_id, match.player_b_discord_id].includes(winnerUser.id)) {
          await interaction.reply({ content: 'Winner must be one of the two players in this match.', ephemeral: true });
          return;
        }

        // Remove any previous unconfirmed results for this match
        db.prepare('DELETE FROM results WHERE match_id = ? AND confirmed_at IS NULL').run(matchId);

        // If already confirmed, require void first
        const alreadyConfirmed = db.prepare('SELECT 1 FROM results WHERE match_id = ? AND confirmed_at IS NOT NULL').get(matchId);
        if (alreadyConfirmed) {
          await interaction.reply({ content: 'This match already has a confirmed result. Use /admin_void_match first if you need to change it.', ephemeral: true });
          return;
        }

        let scoreA = 0;
        let scoreB = 0;
        if (isForfeit) {
          scoreA = winnerUser.id === match.player_a_discord_id ? 3 : 0;
          scoreB = winnerUser.id === match.player_b_discord_id ? 3 : 0;
        } else {
          const parsed = parseAdminScore(scoreRaw);
          if (!parsed) {
            await interaction.reply({ content: 'Invalid score. Use 3-0, 3-1, or 3-2.', ephemeral: true });
            return;
          }
          if (winnerUser.id === match.player_a_discord_id) {
            scoreA = 3;
            scoreB = parsed.loser;
          } else {
            scoreA = parsed.loser;
            scoreB = 3;
          }
        }

        const ins = db.prepare(`
          INSERT INTO results (match_id, winner_discord_id, score_a, score_b, is_forfeit, reporter_discord_id, confirmer_discord_id, confirmed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(matchId, winnerUser.id, scoreA, scoreB, isForfeit ? 1 : 0, interaction.user.id, interaction.user.id);

        db.prepare(`UPDATE matches SET state = 'confirmed', ended_at = datetime('now') WHERE match_id = ?`).run(matchId);
        db.prepare(`UPDATE fixtures SET status = 'confirmed', confirmed_at = datetime('now') WHERE fixture_id = ?`).run(match.fixture_id);

        logAudit('admin_force_result', interaction.user.id, { matchId, winner: winnerUser.id, scoreA, scoreB, isForfeit, resultId: Number(ins.lastInsertRowid) });
        await interaction.reply({
          content: `Forced result recorded: <@${winnerUser.id}> wins ${scoreA}-${scoreB}${isForfeit ? ' (FORFEIT)' : ''}. (result_id=${ins.lastInsertRowid})`,
          ephemeral: true,
        });
        return;
      }


      if (name === 'admin_dispute_match') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const matchId = interaction.options.getInteger('match_id', true);
        const reason = (interaction.options.getString('reason') || 'Manual admin dispute').trim();
        const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
        if (!match) {
          await interaction.reply({ content: 'Match not found.', ephemeral: true });
          return;
        }

        db.prepare("UPDATE matches SET state = 'disputed' WHERE match_id = ?").run(matchId);
        logAudit('admin_dispute_match', interaction.user.id, { matchId, reason });

        const gs = getGuildSettings(interaction.guildId);
        await sendDisputeNotification(
          interaction.guild,
          gs,
          `⚠️ Admin marked match ${matchId} as disputed. Reason: ${reason}. Review channel: <#${match.match_channel_id || gs.results_channel_id || ''}>`
        );

        await interaction.reply({ content: `Match ${matchId} marked as disputed.`, ephemeral: true });
        return;
      }

      if (name === 'admin_void_match') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }

        const matchId = interaction.options.getInteger('match_id', true);
        const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
        if (!match) {
          await interaction.reply({ content: 'Match not found.', ephemeral: true });
          return;
        }

        // Delete results, reopen fixture, cancel match
        db.prepare('DELETE FROM results WHERE match_id = ?').run(matchId);
        db.prepare("UPDATE fixtures SET status = 'unplayed', confirmed_at = NULL WHERE fixture_id = ?").run(match.fixture_id);
        db.prepare("UPDATE matches SET state = 'cancelled', ended_at = datetime('now') WHERE match_id = ?").run(matchId);
        logAudit('admin_void_match', interaction.user.id, { matchId });

        await interaction.reply({ content: `Match ${matchId} voided and fixture reopened.`, ephemeral: true });
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'signup_modal') {
        const realName = cleanName(interaction.fields.getTextInputValue('real_name'));
        const tekkenTag = cleanTekkenTag(interaction.fields.getTextInputValue('tekken_tag'));
        const email = normalizeEmail(interaction.fields.getTextInputValue('email'));
        const phone = normalizePhone(interaction.fields.getTextInputValue('phone'));

        if (!realName || !tekkenTag) {
          await interaction.reply({ content: 'Real name and Tekken tag are required.' });
          return;
        }

        if (!isValidEmail(email)) {
          await interaction.reply({ content: 'Invalid email format.' });
          return;
        }
        if (!isValidPhone(phone)) {
          await interaction.reply({ content: 'Invalid phone format. Include country code if possible.' });
          return;
        }

        const displayName = getDisplayNameFromInteraction(interaction);

        const existing = getPlayer(interaction.user.id);
        const isNewSignup = !existing;
        if (isNewSignup) {
          db.prepare(`
            INSERT INTO players (
              league_id,
              discord_user_id,
              discord_username_at_signup,
              discord_display_name_at_signup,
              discord_display_name_last_seen,
              real_name_enc,
              tekken_tag,
              email_enc,
              phone_enc
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            interaction.user.id,
            interaction.user.username,
            displayName,
            displayName,
            encryptString(realName),
            tekkenTag,
            encryptString(email),
            encryptString(phone),
          );
        } else {
          db.prepare(`
            UPDATE players
            SET real_name_enc = ?, tekken_tag = ?, email_enc = ?, phone_enc = ?, discord_display_name_last_seen = ?
            WHERE league_id = 1 AND discord_user_id = ?
          `).run(
            encryptString(realName),
            tekkenTag,
            encryptString(email),
            encryptString(phone),
            displayName,
            interaction.user.id,
          );
        }

        const gs = getGuildSettings(interaction.guildId);
        await sendAdminNotification(
          interaction.guild,
          gs,
          [
            `📥 **Signup ${isNewSignup ? 'NEW' : 'UPDATE'}**`,
            `User: <@${interaction.user.id}> (${interaction.user.id})`,
            `Discord username: ${interaction.user.username}`,
            `Display name: ${displayName}`,
            `Real name: ${realName}`,
            `Tekken tag: ${tekkenTag}`,
            `Email: ${email}`,
            `Phone: ${phone}`,
          ].join('\n')
        ).catch(() => null);

        logAudit('signup_upsert', interaction.user.id, { tekkenTag, mode: isNewSignup ? 'new' : 'update' });
        await sendActivityNotification(interaction.guild, gs, `📝 Signup: <@${interaction.user.id}> registered/updated as **${tekkenTag}**.`).catch(() => null);
        await interaction.reply({
          content: 'Signup saved. Use /checkin daily and /ready when you are free to play.',
          ephemeral: true,
        });
        return;
      }
    }

  } catch (err) {
    console.error(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: 'An error occurred.', ephemeral: true });
      } else {
        await interaction.reply({ content: 'An error occurred.', ephemeral: true });
      }
    } catch (_) {
      // ignore
    }
  }
});


function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);
  try {
    if (matchmakerTimer) clearInterval(matchmakerTimer);
    db.close();
  } catch (err) {
    console.error('Failed to close database cleanly:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN);
