const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEXT_EXTS = new Set(['.js', '.html', '.css', '.json', '.sql', '.txt', '.md']);
const SKIP_DIRS = new Set(['icons', 'node_modules', '.git', '.vscode', '.idea']);

const suspiciousTokens = [
  '\u00C3',
  '\u00C2',
  '\u00E2\u20AC',
  '\uFFFD'
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(full));
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (TEXT_EXTS.has(ext)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const offenders = [];

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const token of suspiciousTokens) {
    if (source.includes(token)) {
      offenders.push({
        file: path.relative(ROOT, file),
        token
      });
      break;
    }
  }
}

assert.deepStrictEqual(offenders, [], `Se detectó mojibake: ${JSON.stringify(offenders, null, 2)}`);

console.log('no-mojibake tests passed');
