require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ThreadAutoArchiveDuration,
} = require('discord.js');

const { openDb, initDb } = require('./db');
const { encryptString, decryptString, maskEmail, maskPhone } = require('./crypto');
const { isValidEmail, isValidPhone, normalizeEmail, normalizePhone, cleanTekkenTag, cleanName } = require('./validate');
const { generateDoubleRoundRobinFixtures, computeStandings, getCompletionStats, getTodayISO } = require('./league');
const { validateTournamentSetupInput } = require('./tournament-config');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MATCH_CHANNEL_ID = process.env.MATCH_CHANNEL_ID;

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}
if (!MATCH_CHANNEL_ID) {
  console.error('Missing MATCH_CHANNEL_ID in .env');
  process.exit(1);
}

const db = openDb();
initDb(db);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function getConfiguredAdminRoleIds() {
  return db.prepare('SELECT role_id FROM admin_roles WHERE league_id = 1 ORDER BY role_id ASC').all().map(r => r.role_id);
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

function isAdmin(interaction) {
  if (interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) return true;

  const configured = getConfiguredAdminRoleIds();
  if (!configured.length) return false;

  const roleIds = getInteractionRoleIds(interaction);
  return roleIds.some(id => configured.includes(id));
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

function getReadyQueueSnapshot() {
  return db.prepare(`
    SELECT p.tekken_tag, rq.discord_user_id, rq.since_ts
    FROM ready_queue rq
    LEFT JOIN players p ON p.league_id = rq.league_id AND p.discord_user_id = rq.discord_user_id
    WHERE rq.league_id = 1
    ORDER BY rq.since_ts ASC
  `).all();
}

function buildStandingsMessage() {
  const standings = computeStandings(db, 1);
  if (!standings.length) return '**Standings**\nNo active players yet. Use /signup to join the league.';

  const completion = getCompletionStats(db, 1);
  const eligPct = db.prepare('SELECT eligibility_min_percent AS p FROM leagues WHERE league_id=1').get().p;

  const lines = standings.slice(0, 20).map((s, idx) => {
    const comp = completion.map.get(s.discord_user_id);
    const eligible = (comp?.percent ?? 0) >= eligPct;
    const completionPct = comp ? Math.round((comp.percent || 0) * 100) : 0;
    return `${String(idx + 1).padStart(2, '0')}. ${s.tekken_tag} — ${s.points} pts | ${s.wins}-${s.losses} | diff ${s.diff} | GW ${s.games_won} | ${completionPct}%${eligible ? '' : ' (ineligible)'}`;
  });

  return `**Standings**\n${lines.join('\n')}`;
}


function getLeagueSettings() {
  return db.prepare(`
    SELECT
      name,
      timezone,
      season_days,
      attendance_min_days,
      eligibility_min_percent,
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

  return [
    '**Tournament Settings**',
    `League: ${s.name}`,
    `Timezone: ${s.timezone}`,
    `No. of Players (max): ${s.max_players}`,
    `No. of Timeslots: ${s.timeslot_count}`,
    `Duration of Time slots: ${s.timeslot_duration_minutes} minutes`,
    `Start of each time slot: ${s.timeslot_starts}`,
    `Total tournament days: ${s.season_days}`,
    `Minimum show up %: ${minShowupPercent}%`,
    `Minimum check-in days required: ${minAttendanceDays}`,
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

function hasActiveMatch(discord_user_id) {
  const row = db.prepare(`
    SELECT 1
    FROM matches m
    JOIN fixtures f ON f.fixture_id = m.fixture_id
    WHERE f.league_id = 1
      AND m.state IN ('pending_accept','active','awaiting_confirmation','disputed')
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

async function createPendingMatch(fixture, channel) {
  // Create a match request message with Accept/Decline buttons
  const a = fixture.player_a_discord_id;
  const b = fixture.player_b_discord_id;

  const insertPending = db.prepare(`
    INSERT INTO pending_matches (league_id, fixture_id, player_a_discord_id, player_b_discord_id)
    VALUES (1, ?, ?, ?)
  `);
  const res = insertPending.run(fixture.fixture_id, a, b);
  const pendingId = res.lastInsertRowid;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pend_accept:${pendingId}`).setLabel('Accept').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`pend_decline:${pendingId}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  );

  const msg = await channel.send({
    content: `**Official Match Request (Leg ${fixture.leg_number}/2)**\n<@${a}> vs <@${b}> — **BO5 (First to 3)**\nClick **Accept** to start.`,
    components: [row],
    allowed_mentions: { users: [a, b], roles: [], replied_user: false },
  });

  db.prepare(`
    UPDATE pending_matches SET message_id = ?, channel_id = ? WHERE pending_id = ?
  `).run(String(msg.id), String(channel.id), pendingId);

  // Remove both from ready queue so they can't be matched again while pending.
  clearReadyQueueForUsers([a, b]);

  // Create a match row in pending_accept state
  db.prepare(`
    INSERT INTO matches (league_id, fixture_id, player_a_discord_id, player_b_discord_id, state)
    VALUES (1, ?, ?, ?, 'pending_accept')
  `).run(fixture.fixture_id, a, b);

  // Lock the fixture so it can't be picked again
  db.prepare(`UPDATE fixtures SET status = 'locked_in_match' WHERE fixture_id = ?`).run(fixture.fixture_id);

  return { pendingId, messageId: msg.id };
}

async function tryMatchmake(guild) {
  const channel = await guild.channels.fetch(MATCH_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // Build list of ready users who are not already in active matches
  const ready = popReadyUsers().filter(id => !hasActiveMatch(id));
  if (ready.length < 2) return;

  // Try to create as many pending matches as possible
  // We loop but stop if no fixture exists for the remaining ready users.
  let pool = [...ready];
  for (;;) {
    if (pool.length < 2) break;

    const fixture = pickNextFixtureBetweenReadyPlayers(pool);
    if (!fixture) break;

    await createPendingMatch(fixture, channel);

    // Remove the paired players from pool
    pool = pool.filter(id => id !== fixture.player_a_discord_id && id !== fixture.player_b_discord_id);
  }
}

async function startMatchThreadFromPending(pendingId, interaction) {
  const pending = db.prepare('SELECT * FROM pending_matches WHERE pending_id = ?').get(pendingId);
  if (!pending) {
    await interaction.reply({ content: 'This match request no longer exists.', ephemeral: true });
    return;
  }

  const match = db.prepare(`
    SELECT * FROM matches WHERE league_id = 1 AND fixture_id = ? ORDER BY match_id DESC LIMIT 1
  `).get(pending.fixture_id);
  if (!match) {
    await interaction.reply({ content: 'Internal error: match record missing.', ephemeral: true });
    return;
  }

  // Only create thread when both accepted
  if (!(pending.accept_a && pending.accept_b)) return;

  // Fetch the original message and start a thread
  const channel = await interaction.guild.channels.fetch(pending.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.reply({ content: 'Cannot create thread: match channel not found.', ephemeral: true });
    return;
  }

  const msg = await channel.messages.fetch(pending.message_id).catch(() => null);
  if (!msg) {
    await interaction.reply({ content: 'Cannot create thread: match message not found.', ephemeral: true });
    return;
  }

  const fixture = db.prepare('SELECT * FROM fixtures WHERE fixture_id = ?').get(pending.fixture_id);
  const threadName = `Match: ${pending.player_a_discord_id.slice(-4)} vs ${pending.player_b_discord_id.slice(-4)} (Leg ${fixture.leg_number}/2)`;

  const thread = await msg.startThread({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
  });

  db.prepare(`
    UPDATE matches SET state = 'active', thread_id = ? WHERE match_id = ?
  `).run(String(thread.id), match.match_id);

  // Add control buttons inside thread
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`report:${match.match_id}`).setLabel('Report Result').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`forfeit:${match.match_id}`).setLabel('Claim Forfeit').setStyle(ButtonStyle.Secondary),
  );

  await thread.send({
    content: `**Official BO5 (First to 3)**\nPlayers: <@${pending.player_a_discord_id}> vs <@${pending.player_b_discord_id}>\n\nWhen finished, click **Report Result**. Opponent must confirm.`,
    components: [controls],
    allowed_mentions: { users: [pending.player_a_discord_id, pending.player_b_discord_id], roles: [], replied_user: false },
  });

  // Disable buttons on the original request message
  await msg.edit({ components: [] }).catch(() => null);

  // Remove pending row
  db.prepare('DELETE FROM pending_matches WHERE pending_id = ?').run(pendingId);
}

function parseScoreInput(raw) {
  const s = String(raw || '').trim();
  // Accept formats like "3-1" or "3:1"
  const m = s.match(/^(3)\s*[-:]\s*([0-2])$/);
  if (!m) return null;
  return { winner: 3, loser: Number(m[2]) };
}

function parseWinnerInput(raw, playerAId, playerBId) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'a' || s === '1') return playerAId;
  if (s === 'b' || s === '2') return playerBId;
  if (s === playerAId) return playerAId;
  if (s === playerBId) return playerBId;
  return null;
}

async function handleReportModalSubmit(interaction, matchId) {
  const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
  if (!match) {
    await interaction.reply({ content: 'Match not found.', ephemeral: true });
    return;
  }

  const existing = db.prepare('SELECT * FROM results WHERE match_id = ? AND confirmed_at IS NULL').get(matchId);
  if (existing) {
    await interaction.reply({ content: 'A result is already awaiting confirmation for this match.', ephemeral: true });
    return;
  }

  const scoreRaw = interaction.fields.getTextInputValue('score');
  const winnerRaw = interaction.fields.getTextInputValue('winner');

  const score = parseScoreInput(scoreRaw);
  if (!score) {
    await interaction.reply({ content: 'Invalid score. Use 3-0, 3-1, or 3-2.', ephemeral: true });
    return;
  }

  const winnerId = parseWinnerInput(winnerRaw, match.player_a_discord_id, match.player_b_discord_id);
  if (!winnerId) {
    await interaction.reply({ content: 'Invalid winner. Type A or B (see the thread message for who is A/B).', ephemeral: true });
    return;
  }

  // Convert to score_a / score_b
  let scoreA = 0;
  let scoreB = 0;
  if (winnerId === match.player_a_discord_id) {
    scoreA = 3;
    scoreB = score.loser;
  } else {
    scoreA = score.loser;
    scoreB = 3;
  }

  const ins = db.prepare(`
    INSERT INTO results (match_id, winner_discord_id, score_a, score_b, is_forfeit, reporter_discord_id)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(matchId, winnerId, scoreA, scoreB, interaction.user.id);

  const resultId = ins.lastInsertRowid;

  db.prepare(`UPDATE matches SET state = 'awaiting_confirmation' WHERE match_id = ?`).run(matchId);

  const opponentId = (interaction.user.id === match.player_a_discord_id) ? match.player_b_discord_id : match.player_a_discord_id;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${resultId}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dispute:${resultId}`).setLabel('Dispute').setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ content: 'Result submitted. Waiting for opponent confirmation.', ephemeral: true });

  // Post confirmation request in thread
  const thread = interaction.channel;
  await thread.send({
    content: `Result reported: **<@${winnerId}> wins ${scoreA}-${scoreB}**\nOpponent <@${opponentId}>: please **Confirm** or **Dispute**.`,
    components: [row],
    allowed_mentions: { users: [opponentId], roles: [], replied_user: false },
  });
}

async function handleForfeitClaim(interaction, matchId) {
  const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
  if (!match) {
    await interaction.reply({ content: 'Match not found.', ephemeral: true });
    return;
  }

  if (![match.player_a_discord_id, match.player_b_discord_id].includes(interaction.user.id)) {
    await interaction.reply({ content: 'Only the players in this match can claim a forfeit.', ephemeral: true });
    return;
  }

  const already = db.prepare('SELECT * FROM results WHERE match_id = ? AND confirmed_at IS NULL').get(matchId);
  if (already) {
    await interaction.reply({ content: 'A result is already awaiting confirmation for this match.', ephemeral: true });
    return;
  }

  const winnerId = interaction.user.id;
  const scoreA = (winnerId === match.player_a_discord_id) ? 3 : 0;
  const scoreB = (winnerId === match.player_b_discord_id) ? 3 : 0;

  const ins = db.prepare(`
    INSERT INTO results (match_id, winner_discord_id, score_a, score_b, is_forfeit, reporter_discord_id)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(matchId, winnerId, scoreA, scoreB, interaction.user.id);

  const resultId = ins.lastInsertRowid;
  db.prepare(`UPDATE matches SET state = 'awaiting_confirmation' WHERE match_id = ?`).run(matchId);

  const opponentId = (winnerId === match.player_a_discord_id) ? match.player_b_discord_id : match.player_a_discord_id;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${resultId}`).setLabel('Confirm Forfeit').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`dispute:${resultId}`).setLabel('Dispute').setStyle(ButtonStyle.Danger),
  );

  await interaction.reply({ content: 'Forfeit claimed. Waiting for opponent confirmation.', ephemeral: true });

  await interaction.channel.send({
    content: `Forfeit claimed by <@${winnerId}>. If confirmed, it will be recorded as **3-0** and **3 points** for the winner.\nOpponent <@${opponentId}>: confirm or dispute.`,
    components: [row],
    allowed_mentions: { users: [opponentId], roles: [], replied_user: false },
  });
}

async function finalizeResult(interaction, resultId, action) {
  const result = db.prepare(`
    SELECT r.*, m.player_a_discord_id, m.player_b_discord_id, m.fixture_id
    FROM results r
    JOIN matches m ON m.match_id = r.match_id
    WHERE r.result_id = ?
  `).get(resultId);

  if (!result) {
    await interaction.reply({ content: 'Result not found.', ephemeral: true });
    return;
  }

  const A = result.player_a_discord_id;
  const B = result.player_b_discord_id;
  const reporter = result.reporter_discord_id;
  const opponent = (reporter === A) ? B : A;

  if (![A, B].includes(interaction.user.id)) {
    await interaction.reply({ content: 'Only players in this match can confirm/dispute.', ephemeral: true });
    return;
  }

  if (interaction.user.id === reporter) {
    await interaction.reply({ content: 'The reporter cannot confirm their own result. Opponent must confirm.', ephemeral: true });
    return;
  }

  if (action === 'dispute') {
    db.prepare(`UPDATE matches SET state = 'disputed' WHERE match_id = ?`).run(result.match_id);
    await interaction.reply({ content: 'Marked as disputed. An organizer will review.', ephemeral: true });
    await interaction.message.edit({ components: [] }).catch(() => null);
    return;
  }

  // Confirm
  db.prepare(`
    UPDATE results
    SET confirmer_discord_id = ?, confirmed_at = datetime('now')
    WHERE result_id = ?
  `).run(interaction.user.id, resultId);

  db.prepare(`UPDATE matches SET state = 'confirmed', ended_at = datetime('now') WHERE match_id = ?`).run(result.match_id);
  db.prepare(`UPDATE fixtures SET status = 'confirmed', confirmed_at = datetime('now') WHERE fixture_id = ?`).run(result.fixture_id);

  await interaction.reply({ content: 'Result confirmed.', ephemeral: true });
  await interaction.message.edit({ components: [] }).catch(() => null);

  // Offer immediate second leg if still available
  const remaining = db.prepare(`
    SELECT fixture_id, leg_number
    FROM fixtures
    WHERE league_id = 1
      AND status = 'unplayed'
      AND ((player_a_discord_id = ? AND player_b_discord_id = ?) OR (player_a_discord_id = ? AND player_b_discord_id = ?))
    ORDER BY leg_number ASC
    LIMIT 1
  `).get(A, B, B, A);

  if (remaining) {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`secondleg:${A}:${B}:${remaining.fixture_id}`).setLabel('Play second leg now').setStyle(ButtonStyle.Primary),
    );

    await interaction.channel.send({
      content: `Second leg is still available for <@${A}> vs <@${B}>. If you both want to play it now, click the button.`,
      components: [row],
      allowed_mentions: { users: [A, B], roles: [], replied_user: false },
    });
  }
}

async function handleSecondLegStart(interaction, A, B, fixtureId) {
  if (![A, B].includes(interaction.user.id)) {
    await interaction.reply({ content: 'Only the two players can start the second leg.', ephemeral: true });
    return;
  }

  // Track two-step acceptance for starting second leg
  const key = `secondleg_accept:${fixtureId}`;
  const existing = db.prepare(`SELECT payload_json FROM audit_log WHERE league_id = 1 AND action_type = ? ORDER BY audit_id DESC LIMIT 1`).get(key);
  let payload = existing ? JSON.parse(existing.payload_json) : { fixtureId: Number(fixtureId), A, B, clicks: {} };
  payload.clicks[interaction.user.id] = true;

  db.prepare(`INSERT INTO audit_log (league_id, actor_discord_id, action_type, payload_json) VALUES (1, ?, ?, ?)`).run(
    interaction.user.id,
    key,
    JSON.stringify(payload),
  );

  if (payload.clicks[A] && payload.clicks[B]) {
    // Both agreed: create pending match immediately
    const fixture = db.prepare(`SELECT * FROM fixtures WHERE fixture_id = ? AND status = 'unplayed'`).get(fixtureId);
    if (!fixture) {
      await interaction.reply({ content: 'Second leg is no longer available.', ephemeral: true });
      await interaction.message.edit({ components: [] }).catch(() => null);
      return;
    }

    const channel = await interaction.guild.channels.fetch(MATCH_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: 'Match channel not found.', ephemeral: true });
      return;
    }

    await createPendingMatch(fixture, channel);
    await interaction.reply({ content: 'Second leg match request created in the match channel.', ephemeral: true });
    await interaction.message.edit({ components: [] }).catch(() => null);
  } else {
    await interaction.reply({ content: 'Waiting for the other player to click too.', ephemeral: true });
  }
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Keep last seen name updated if signed up
    const displayName = getDisplayNameFromInteraction(interaction);
    const existing = getPlayer(interaction.user.id);
    if (existing) upsertLastSeenDisplayName(interaction.user.id, displayName);

    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;

      if (name === 'ping') {
        await interaction.reply({ content: 'pong', ephemeral: true });
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
          await interaction.reply({ content: 'You are not signed up yet. Use /signup first.', ephemeral: true });
          return;
        }

        const realName = decryptString(p.real_name_enc);
        const email = decryptString(p.email_enc);
        const phone = decryptString(p.phone_enc);

        await interaction.reply({
          ephemeral: true,
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
          await interaction.reply({ content: 'You must /signup before checking in.', ephemeral: true });
          return;
        }

        const today = getTodayISO(true);
        db.prepare(`
          INSERT OR REPLACE INTO attendance (league_id, discord_user_id, date, checked_in)
          VALUES (1, ?, ?, 1)
        `).run(interaction.user.id, today);

        logAudit('checkin', interaction.user.id, { date: today });
        await interaction.reply({ content: `Checked in for ${today}.`, ephemeral: true });
        return;
      }

      if (name === 'ready') {
        const p = ensureSignedUp(interaction);
        if (!p) {
          await interaction.reply({ content: 'You must /signup before using /ready.', ephemeral: true });
          return;
        }

        if (!hasCheckedInToday(interaction.user.id)) {
          await interaction.reply({ content: 'Please /checkin for today first (attendance rule).', ephemeral: true });
          return;
        }

        if (hasActiveMatch(interaction.user.id)) {
          await interaction.reply({ content: 'You already have an active/pending match. Finish it before queueing again.', ephemeral: true });
          return;
        }

        addToReadyQueue(interaction.user.id);
        logAudit('queue_join', interaction.user.id);
        await interaction.reply({ content: 'You are in the queue. Waiting for an opponent...', ephemeral: true });
        await tryMatchmake(interaction.guild);
        return;
      }

      if (name === 'unready') {
        removeFromReadyQueue(interaction.user.id);
        logAudit('queue_leave', interaction.user.id);
        await interaction.reply({ content: 'Removed from queue.', ephemeral: true });
        return;
      }

      if (name === 'standings' || name === 'table') {
        await interaction.reply({
          content: buildStandingsMessage(),
          ephemeral: false,
        });
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

      if (name === 'help') {
        await interaction.reply({
          content: [
            '**League Bot Quick Help**',
            '• /signup — register or update your league profile',
            "• /checkin — mark today's availability (attendance requirement)",
            '• /ready and /unready — join/leave live matchmaking queue',
            '• /queue — view current ready players',
            '• /standings or /table — view live standings table anytime',
            '• /mydata — view your private stored profile details',
            'Admins: /admin_status, /admin_tournament_settings, /admin_setup_tournament, /admin_generate_fixtures, /admin_force_result, /admin_void_match, /admin_reset_league',
          ].join('\n'),
          ephemeral: true,
        });
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
        const activeMatches = db.prepare("SELECT COUNT(1) AS c FROM matches WHERE league_id = 1 AND state IN ('pending_accept','active','awaiting_confirmation','disputed')").get().c;

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
        const totalTournamentDays = interaction.options.getInteger('total_tournament_days');
        const minimumShowupPercent = interaction.options.getNumber('minimum_showup_percent');

        const hasAnyUpdate = [maxPlayers, timeslotCount, timeslotDurationMinutes, timeSlotStartsRaw, totalTournamentDays, minimumShowupPercent]
          .some(v => v !== null && v !== undefined);
        if (!hasAnyUpdate) {
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
          totalTournamentDays,
          minimumShowupPercent,
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
        };

        if (merged.timeslot_starts.split(',').length !== merged.timeslot_count) {
          await interaction.reply({
            content: `No. of timeslots (${merged.timeslot_count}) must match start times count (${merged.timeslot_starts.split(',').length}).`,
            ephemeral: true,
          });
          return;
        }

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
            attendance_min_days = ?
          WHERE league_id = 1
        `).run(
          merged.max_players,
          merged.timeslot_count,
          merged.timeslot_duration_minutes,
          merged.timeslot_starts,
          merged.season_days,
          merged.eligibility_min_percent,
          minAttendanceDays,
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

      if (name === 'admin_reset_league') {
        if (!isAdmin(interaction)) {
          await interaction.reply({ content: 'Admin only.', ephemeral: true });
          return;
        }
        // Wipe league state (keep players)
        db.exec(`
          DELETE FROM fixtures;
          DELETE FROM pending_matches;
          DELETE FROM matches;
          DELETE FROM results;
          DELETE FROM ready_queue;
          DELETE FROM attendance;
        `);
        logAudit('admin_reset_league', interaction.user.id);
        await interaction.reply({ content: 'League data reset (players preserved).', ephemeral: true });
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
          const parsed = parseScoreInput(scoreRaw);
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
          await interaction.reply({ content: 'Real name and Tekken tag are required.', ephemeral: true });
          return;
        }

        if (!isValidEmail(email)) {
          await interaction.reply({ content: 'Invalid email format.', ephemeral: true });
          return;
        }
        if (!isValidPhone(phone)) {
          await interaction.reply({ content: 'Invalid phone format. Include country code if possible.', ephemeral: true });
          return;
        }

        const displayName = getDisplayNameFromInteraction(interaction);

        const existing = getPlayer(interaction.user.id);
        if (!existing) {
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

        logAudit('signup_upsert', interaction.user.id, { tekkenTag });
        await interaction.reply({
          content: 'Signup saved. Use /checkin daily and /ready when you are free to play.',
          ephemeral: true,
        });
        return;
      }
    }

    if (interaction.isButton()) {
      const [kind, rest] = interaction.customId.split(':');

      if (kind === 'pend_accept' || kind === 'pend_decline') {
        const pendingId = Number(rest);
        const pending = db.prepare('SELECT * FROM pending_matches WHERE pending_id = ?').get(pendingId);
        if (!pending) {
          await interaction.reply({ content: 'This match request is no longer valid.', ephemeral: true });
          return;
        }

        const a = pending.player_a_discord_id;
        const b = pending.player_b_discord_id;
        if (![a, b].includes(interaction.user.id)) {
          await interaction.reply({ content: 'Only the matched players can respond.', ephemeral: true });
          return;
        }

        if (kind === 'pend_decline') {
          // Unlock fixture and clean up
          db.prepare(`UPDATE fixtures SET status = 'unplayed' WHERE fixture_id = ?`).run(pending.fixture_id);
          db.prepare(`DELETE FROM pending_matches WHERE pending_id = ?`).run(pendingId);
          db.prepare(`UPDATE matches SET state = 'cancelled', ended_at = datetime('now') WHERE fixture_id = ? AND state='pending_accept'`).run(pending.fixture_id);

          await interaction.reply({ content: 'Declined. You can /ready again when free.', ephemeral: true });

          // Disable message buttons
          await interaction.message.edit({ components: [] }).catch(() => null);
          return;
        }

        // Accept
        const col = interaction.user.id === a ? 'accept_a' : 'accept_b';
        db.prepare(`UPDATE pending_matches SET ${col} = 1 WHERE pending_id = ?`).run(pendingId);

        const updated = db.prepare('SELECT * FROM pending_matches WHERE pending_id = ?').get(pendingId);

        await interaction.reply({ content: 'Accepted.', ephemeral: true });

        if (updated.accept_a && updated.accept_b) {
          await startMatchThreadFromPending(pendingId, interaction);
        }
        return;
      }

      if (kind === 'report') {
        const matchId = Number(rest);
        const match = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(matchId);
        if (!match) {
          await interaction.reply({ content: 'Match not found.', ephemeral: true });
          return;
        }
        if (![match.player_a_discord_id, match.player_b_discord_id].includes(interaction.user.id)) {
          await interaction.reply({ content: 'Only the players can report results.', ephemeral: true });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId(`report_modal:${matchId}`)
          .setTitle('Report BO5 Result');

        const winner = new TextInputBuilder()
          .setCustomId('winner')
          .setLabel('Winner: type A or B')
          .setPlaceholder(`A=<@${match.player_a_discord_id}>  B=<@${match.player_b_discord_id}>`)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10);

        const score = new TextInputBuilder()
          .setCustomId('score')
          .setLabel('Score (winner-loser): 3-0, 3-1, or 3-2')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(10);

        modal.addComponents(
          new ActionRowBuilder().addComponents(winner),
          new ActionRowBuilder().addComponents(score),
        );

        await interaction.showModal(modal);
        return;
      }

      if (kind === 'forfeit') {
        const matchId = Number(rest);
        await handleForfeitClaim(interaction, matchId);
        return;
      }

      if (kind === 'confirm') {
        const resultId = Number(rest);
        await finalizeResult(interaction, resultId, 'confirm');
        return;
      }

      if (kind === 'dispute') {
        const resultId = Number(rest);
        await finalizeResult(interaction, resultId, 'dispute');
        return;
      }

      if (kind === 'secondleg') {
        // customId: secondleg:A:B:fixtureId
        const parts = interaction.customId.split(':');
        const A = parts[1];
        const B = parts[2];
        const fixtureId = Number(parts[3]);
        await handleSecondLegStart(interaction, A, B, fixtureId);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const [kind, matchIdRaw] = interaction.customId.split(':');
      if (kind === 'report_modal') {
        const matchId = Number(matchIdRaw);
        await handleReportModalSubmit(interaction, matchId);
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
    db.close();
  } catch (err) {
    console.error('Failed to close database cleanly:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.login(DISCORD_TOKEN);
