require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID or GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Health check'),

  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show a quick guide to league commands'),

  new SlashCommandBuilder()
    .setName('helpplayer')
    .setDescription('Show player-focused help and quick usage'),

  new SlashCommandBuilder()
    .setName('playerhelp')
    .setDescription('Alias for /helpplayer'),

  new SlashCommandBuilder()
    .setName('adminhelp')
    .setDescription('Admin: show what each admin command does')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('signup')
    .setDescription('Register for the league (Real name, Tekken tag, email, phone)'),

  new SlashCommandBuilder()
    .setName('mydata')
    .setDescription('View the personal data you submitted (private)'),

  new SlashCommandBuilder()
    .setName('checkin')
    .setDescription('Mark yourself available for today (counts toward 15/20)'),

  new SlashCommandBuilder()
    .setName('ready')
    .setDescription('Enter matchmaking queue (you are free to play now)'),

  new SlashCommandBuilder()
    .setName('unready')
    .setDescription('Leave matchmaking queue'),

  new SlashCommandBuilder()
    .setName('standings')
    .setDescription('Show current league standings'),

  new SlashCommandBuilder()
    .setName('table')
    .setDescription('Show detailed standings table (optionally choose a page)')
    .addIntegerOption(o => o
      .setName('page')
      .setDescription('Page number to display (default 1)')
      .setRequired(false)
      .setMinValue(1)),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show who is currently in the ready queue'),

  new SlashCommandBuilder()
    .setName('left')
    .setDescription('Show opponents you still need to play and matches remaining'),

  new SlashCommandBuilder()
    .setName('matches')
    .setDescription('Show recent matches with match IDs and statuses'),


  new SlashCommandBuilder()
    .setName('bot_settings')
    .setDescription('Admin: view or update bot configuration')
    .addSubcommand(sc => sc
      .setName('view')
      .setDescription('View current bot settings'))
    .addSubcommand(sc => sc
      .setName('set_results_channel')
      .setDescription('Set channel for match assignments and results')
      .addChannelOption(o => o.setName('channel').setDescription('Results channel').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('set_admin_channel')
      .setDescription('Set channel for dispute/admin alerts')
      .addChannelOption(o => o.setName('channel').setDescription('Admin alerts channel').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('set_match_format')
      .setDescription('Set match format')
      .addStringOption(o => o.setName('format').setDescription('Match format').setRequired(true).addChoices(
        { name: 'FT2', value: 'FT2' },
        { name: 'FT3', value: 'FT3' },
      )))
    .addSubcommand(sc => sc
      .setName('set_tournament_name')
      .setDescription('Set tournament name')
      .addStringOption(o => o.setName('name').setDescription('Tournament name').setRequired(true).setMaxLength(100)))
    .addSubcommand(sc => sc
      .setName('set_timezone')
      .setDescription('Set display timezone (IANA)')
      .addStringOption(o => o.setName('tz').setDescription('Timezone, e.g. Asia/Qatar').setRequired(true).setMaxLength(80)))
    .addSubcommand(sc => sc
      .setName('set_standings_channel')
      .setDescription('Set optional standings channel')
      .addChannelOption(o => o.setName('channel').setDescription('Standings channel').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('set_dispute_channel')
      .setDescription('Set channel for dispute notifications')
      .addChannelOption(o => o.setName('channel').setDescription('Dispute channel').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('set_activity_channel')
      .setDescription('Set channel for signup/checkin/ready activity notifications')
      .addChannelOption(o => o.setName('channel').setDescription('Activity channel').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('set_cleanup_policy')
      .setDescription('Set message cleanup policy')
      .addStringOption(o => o.setName('policy').setDescription('Policy').setRequired(true).addChoices(
        { name: 'Keep forever', value: 'keep' },
        { name: 'Archive after days', value: 'archive' },
      ))
      .addIntegerOption(o => o.setName('days').setDescription('Days for archive policy').setRequired(false)))
    .addSubcommand(sc => sc
      .setName('set_diagnostics')
      .setDescription('Enable or disable diagnostics')
      .addBooleanOption(o => o.setName('enabled').setDescription('Enable diagnostics').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('set_allow_public_player_commands')
      .setDescription('Set whether player commands are public by default')
      .addBooleanOption(o => o.setName('enabled').setDescription('Enabled').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('set_admin_roles')
      .setDescription('Set which roles can access admin commands')
      .addRoleOption(o => o.setName('role_1').setDescription('Admin role 1').setRequired(true))
      .addRoleOption(o => o.setName('role_2').setDescription('Admin role 2').setRequired(false))
      .addRoleOption(o => o.setName('role_3').setDescription('Admin role 3').setRequired(false))
      .addRoleOption(o => o.setName('role_4').setDescription('Admin role 4').setRequired(false))
      .addRoleOption(o => o.setName('role_5').setDescription('Admin role 5').setRequired(false)))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_generate_fixtures')
    .setDescription('Admin: generate double round robin fixtures for all signed-up players')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),



  new SlashCommandBuilder()
    .setName('admin_status')
    .setDescription('Admin: quick snapshot of league health and queue state')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),


  new SlashCommandBuilder()
    .setName('admin_player_matches')
    .setDescription('Admin: view matches for a specific player')
    .addUserOption(o => o
      .setName('player')
      .setDescription('Player to inspect')
      .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_player_left')
    .setDescription('Admin: view who a specific player still has to play')
    .addUserOption(o => o
      .setName('player')
      .setDescription('Player to inspect')
      .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),


  new SlashCommandBuilder()
    .setName('admin_setup_tournament')
    .setDescription('Admin: configure tournament settings for this league')
    .addIntegerOption(o => o
      .setName('max_players')
      .setDescription('Maximum players (2-1024)')
      .setRequired(false))
    .addIntegerOption(o => o
      .setName('timeslot_count')
      .setDescription('No. of timeslots per day (1-24)')
      .setRequired(false))
    .addIntegerOption(o => o
      .setName('timeslot_duration_minutes')
      .setDescription('Duration of each timeslot in minutes (15-1440)')
      .setRequired(false))
    .addStringOption(o => o
      .setName('timeslot_starts')
      .setDescription('Comma-separated start times in 24h format, e.g. 18:00,20:00')
      .setRequired(false))
    .addBooleanOption(o => o
      .setName('clear_timeslot_starts')
      .setDescription('Clear previously set timeslot starts')
      .setRequired(false))
    .addIntegerOption(o => o
      .setName('total_tournament_days')
      .setDescription('Total tournament days (1-365)')
      .setRequired(false))
    .addNumberOption(o => o
      .setName('minimum_showup_percent')
      .setDescription('Minimum show-up percentage required (0-100)')
      .setRequired(false))
    .addStringOption(o => o
      .setName('tournament_start_date')
      .setDescription('Tournament start date in YYYY-MM-DD')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Admin: configure league points values')
    .addIntegerOption(o => o.setName('win').setDescription('Points for a normal win').setRequired(true).setMinValue(0).setMaxValue(20))
    .addIntegerOption(o => o.setName('loss').setDescription('Points for a played loss').setRequired(true).setMinValue(0).setMaxValue(20))
    .addIntegerOption(o => o.setName('no_show').setDescription('Points for no-show/forfeit win').setRequired(true).setMinValue(0).setMaxValue(20))
    .addIntegerOption(o => o.setName('sweep_bonus').setDescription('Extra points for 3-0 sweep').setRequired(true).setMinValue(0).setMaxValue(20))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_vs')
    .setDescription('Admin: create a specific match-up if an unplayed fixture exists')
    .addUserOption(o => o.setName('player_a').setDescription('First player').setRequired(true))
    .addUserOption(o => o.setName('player_b').setDescription('Second player').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_tournament_settings')
    .setDescription('Admin: view current tournament setup settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),


  new SlashCommandBuilder()
    .setName('admin_reset')
    .setDescription('Admin: reset checkins, league state, or everything')
    .addStringOption(o => o
      .setName('level')
      .setDescription('Reset level')
      .setRequired(true)
      .addChoices(
        { name: 'checkins', value: 'checkins' },
        { name: 'league', value: 'league' },
        { name: 'everything (includes signups)', value: 'everything' },
      ))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_reset_confirm')
    .setDescription('Admin: confirm a pending reset with token')
    .addStringOption(o => o
      .setName('token')
      .setDescription('Reset confirmation token')
      .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_reset_league')
    .setDescription('Admin: reset fixtures + matches + results (dangerous)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_force_result')
    .setDescription('Admin: force a match result (used for no-show/DQ/forfeit)')
    .addIntegerOption(o => o
      .setName('match_id')
      .setDescription('Match ID')
      .setRequired(true))
    .addUserOption(o => o
      .setName('winner')
      .setDescription('Winner')
      .setRequired(true))
    .addStringOption(o => o
      .setName('score')
      .setDescription('Score from winner perspective')
      .setRequired(true)
      .addChoices(
        { name: '3-0 (clean win)', value: '3-0' },
        { name: '3-1', value: '3-1' },
        { name: '3-2', value: '3-2' },
      ))
    .addBooleanOption(o => o
      .setName('forfeit')
      .setDescription('Set true for no-show/DQ/forfeit (loser gets 0 points)')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_dispute_match')
    .setDescription('Admin: mark a match as disputed and notify dispute channel')
    .addIntegerOption(o => o
      .setName('match_id')
      .setDescription('Match ID')
      .setRequired(true))
    .addStringOption(o => o
      .setName('reason')
      .setDescription('Reason for dispute')
      .setRequired(false)
      .setMaxLength(200))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_void_match')
    .setDescription('Admin: void a match (removes result and re-opens the fixture)')
    .addIntegerOption(o => o
      .setName('match_id')
      .setDescription('Match ID')
      .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

];

const names = commands.map(c => c.toJSON().name);
const seen = new Set();
for (const n of names) {
  if (seen.has(n)) {
    throw new Error(`Duplicate command name detected in deploy-commands.js: ${n}`);
  }
  seen.add(n);
}

const commandPayload = commands.map(c => c.toJSON());


const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`Deploying ${commands.length} commands to guild ${guildId}...`);
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandPayload });
    console.log('Done.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
