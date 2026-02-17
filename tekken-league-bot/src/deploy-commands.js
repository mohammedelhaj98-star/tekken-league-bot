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
    .setDescription('Alias for /standings'),

  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show who is currently in the ready queue'),

  new SlashCommandBuilder()
    .setName('admin_generate_fixtures')
    .setDescription('Admin: generate double round robin fixtures for all signed-up players')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),


  new SlashCommandBuilder()
    .setName('admin_set_roles')
    .setDescription('Admin: set which server roles can use admin bot commands')
    .addRoleOption(o => o
      .setName('role_1')
      .setDescription('Admin role 1')
      .setRequired(true))
    .addRoleOption(o => o
      .setName('role_2')
      .setDescription('Admin role 2')
      .setRequired(false))
    .addRoleOption(o => o
      .setName('role_3')
      .setDescription('Admin role 3')
      .setRequired(false))
    .addRoleOption(o => o
      .setName('role_4')
      .setDescription('Admin role 4')
      .setRequired(false))
    .addRoleOption(o => o
      .setName('role_5')
      .setDescription('Admin role 5')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_list_roles')
    .setDescription('Admin: list configured bot admin roles')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_clear_roles')
    .setDescription('Admin: clear configured bot admin roles (fallback to Discord Administrator only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_status')
    .setDescription('Admin: quick snapshot of league health and queue state')
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
    .addIntegerOption(o => o
      .setName('total_tournament_days')
      .setDescription('Total tournament days (1-365)')
      .setRequired(false))
    .addNumberOption(o => o
      .setName('minimum_showup_percent')
      .setDescription('Minimum show-up percentage required (0-100)')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_tournament_settings')
    .setDescription('Admin: view current tournament setup settings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_status')
    .setDescription('Admin: quick snapshot of league health and queue state')
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
    .addIntegerOption(o => o
      .setName('total_tournament_days')
      .setDescription('Total tournament days (1-365)')
      .setRequired(false))
    .addNumberOption(o => o
      .setName('minimum_showup_percent')
      .setDescription('Minimum show-up percentage required (0-100)')
      .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('admin_tournament_settings')
    .setDescription('Admin: view current tournament setup settings')
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
    .setName('admin_void_match')
    .setDescription('Admin: void a match (removes result and re-opens the fixture)')
    .addIntegerOption(o => o
      .setName('match_id')
      .setDescription('Match ID')
      .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

];

const names = commands.map(c => c.name);
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
