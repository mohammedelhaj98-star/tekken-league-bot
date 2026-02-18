const { execSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

try {
  const trackedPath = run("git ls-files --full-name -- src/index.js");
  if (!trackedPath) {
    throw new Error('Could not resolve tracked path for src/index.js');
  }

  const blob = execSync(`git show HEAD:${trackedPath}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync('src/index.js', blob, 'utf8');
  process.stdout.write(`Repaired src/index.js from HEAD:${trackedPath}\n`);
} catch (err) {
  process.stderr.write(`Failed to repair src/index.js: ${err.message}\n`);
  process.exit(1);
}
