const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexPath = path.join(root, 'index.html');
const bootFinalPath = path.join(root, 'core', 'boot-final.js');

const html = fs.readFileSync(indexPath, 'utf8');

const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
const inlineScripts = scriptTags.filter((tag) => !/\bsrc\s*=/.test(tag));

assert.strictEqual(
  inlineScripts.length,
  0,
  `No debe haber <script> inline sin src. Encontrados: ${inlineScripts.join(' | ')}`
);

const inlineHandlers = [...html.matchAll(/\son[a-z]+\s*=/gi)];
assert.strictEqual(
  inlineHandlers.length,
  0,
  `No debe haber handlers inline onXXX. Encontrados: ${inlineHandlers.map((m) => m[0]).join(' | ')}`
);

const cspMetaTagMatch = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i);
assert.ok(cspMetaTagMatch, 'Debe existir meta CSP en index.html');
const cspMetaTag = cspMetaTagMatch[0];
const cspMetaMatch = cspMetaTag.match(/content="([\s\S]*?)"/i);
assert.ok(cspMetaMatch, 'Debe existir meta CSP en index.html');
const cspContent = cspMetaMatch[1];

const scriptSrcMatch = cspContent.match(/script-src\s+([^;]+);/i);
assert.ok(scriptSrcMatch, 'CSP debe contener directiva script-src');
assert.ok(
  !/unsafe-inline/i.test(scriptSrcMatch[1]),
  'script-src no debe contener unsafe-inline'
);

assert.ok(fs.existsSync(bootFinalPath), 'Debe existir core/boot-final.js');

console.log('csp-no-inline-scripts tests passed');
