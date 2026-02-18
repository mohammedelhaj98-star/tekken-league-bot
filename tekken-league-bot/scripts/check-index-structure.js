const fs = require('node:fs');

const text = fs.readFileSync('src/index.js', 'utf8');

function fail(message) {
  console.error(`index.js structure check failed: ${message}`);
  process.exit(1);
}

const checks = [
  {
    re: /client\.on\(Events\.InteractionCreate,\s*async\s*\(interaction\)\s*=>\s*\{/g,
    expected: 1,
    label: 'async InteractionCreate handler',
  },
  {
    re: /client\.once\(Events\.ClientReady,\s*\(\)\s*=>\s*\{/g,
    expected: 1,
    label: 'ClientReady handler',
  },
  {
    re: /client\.on\(Events\.MessageReactionAdd,\s*async\s*\(reaction,\s*user\)\s*=>\s*\{/g,
    expected: 1,
    label: 'MessageReactionAdd handler',
  },
  {
    re: /client\.on\(Events\.MessageReactionRemove,\s*async\s*\(reaction,\s*user\)\s*=>\s*\{/g,
    expected: 1,
    label: 'MessageReactionRemove handler',
  },
];

for (const { re, expected, label } of checks) {
  const count = (text.match(re) || []).length;
  if (count !== expected) {
    fail(`expected ${expected} ${label}, found ${count}`);
  }
}

console.log('index.js structure check passed.');
