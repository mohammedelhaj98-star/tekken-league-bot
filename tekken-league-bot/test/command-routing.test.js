const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function extractDeployCommandNames(text) {
  return [...text.matchAll(/\.setName\('([^']+)'\)/g)]
    .map((m) => m[1])
    // Keep only top-level slash command names (exclude option/subcommand names).
    .filter((name) => {
      return [
        'ping', 'help', 'helpplayer', 'playerhelp', 'adminhelp', 'signup', 'mydata', 'settekkenid', 'checkin',
        'ready', 'unready', 'standings', 'power_rankings', 'table', 'queue', 'left', 'matches', 'bot_settings',
        'admin_generate_fixtures', 'admin_status', 'admin_player_matches', 'admin_player_left',
        'admin_export_counted_matches', 'admin_refresh_power_rankings', 'admin_generate_power_seeds', 'settekkenid_admin',
        'removetekkenid', 'admin_sync_wavu', 'admin_sync_wavu_player', 'admin_setup_tournament', 'points', 'admin_vs', 'admin_tournament_settings',
        'admin_reset', 'admin_reset_confirm', 'admin_reset_league', 'admin_force_result',
        'admin_dispute_match', 'admin_void_match', 'admin_dq_player', 'admin_dq_remain', 'admin_rename_player', 'admin_allowance_player',
      ].includes(name);
    });
}

function extractHandledCommandNames(text) {
  return new Set([...text.matchAll(/name === '([^']+)'/g)].map((m) => m[1]));
}

test('all deployed top-level slash commands have runtime handlers', () => {
  const deployText = fs.readFileSync('src/deploy-commands.js', 'utf8');
  const indexText = fs.readFileSync('src/index.js', 'utf8');

  const deployCommands = extractDeployCommandNames(deployText);
  const handled = extractHandledCommandNames(indexText);

  const missing = deployCommands.filter((name) => !handled.has(name));
  assert.deepEqual(missing, [], `Missing handlers for deployed commands: ${missing.join(', ')}`);
});

test('index.js keeps exactly one primary discord event wiring for key handlers', () => {
  const indexText = fs.readFileSync('src/index.js', 'utf8');

  const interactionCount = (indexText.match(/client\.on\(Events\.InteractionCreate,/g) || []).length;
  const readyCount = (indexText.match(/client\.once\(Events\.ClientReady,/g) || []).length;
  const reactionAddCount = (indexText.match(/client\.on\(Events\.MessageReactionAdd,/g) || []).length;
  const reactionRemoveCount = (indexText.match(/client\.on\(Events\.MessageReactionRemove,/g) || []).length;

  assert.equal(interactionCount, 1, 'Expected exactly one InteractionCreate handler.');
  assert.equal(readyCount, 1, 'Expected exactly one ClientReady handler.');
  assert.equal(reactionAddCount, 1, 'Expected exactly one MessageReactionAdd handler.');
  assert.equal(reactionRemoveCount, 1, 'Expected exactly one MessageReactionRemove handler.');
});

test('interaction handler is explicitly async (await-safe)', () => {
  const indexText = fs.readFileSync('src/index.js', 'utf8');
  const asyncInteractionHandler = /client\.on\(Events\.InteractionCreate,\s*async\s*\(interaction\)\s*=>\s*\{/g;
  const matches = indexText.match(asyncInteractionHandler) || [];
  assert.equal(matches.length, 1, 'Expected one async InteractionCreate handler declaration.');
});
