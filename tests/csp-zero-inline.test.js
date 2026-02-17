const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexPath = path.join(root, 'index.html');
const bootProductionPath = path.join(root, 'core', 'boot-production.js');
const html = fs.readFileSync(indexPath, 'utf8');

// 1) No <script> inline sin src
const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
const inlineScripts = scriptTags.filter((tag) => !/\bsrc\s*=/.test(tag));
assert.strictEqual(
  inlineScripts.length,
  0,
  `index.html no debe tener <script> inline sin src. Encontrados: ${inlineScripts.join(' | ')}`
);

// 2) No atributos onXXX inline
const inlineHandlers = [...html.matchAll(/\son[a-z]+\s*=/gi)];
assert.strictEqual(
  inlineHandlers.length,
  0,
  `index.html no debe tener handlers inline onXXX=. Encontrados: ${inlineHandlers.map((m) => m[0]).join(' | ')}`
);

// 3) CSP script-src estricto: sin unsafe-inline, sin nonce, sin hash
const cspTag = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i);
assert.ok(cspTag, 'Debe existir meta CSP');
const cspContentMatch = cspTag[0].match(/content="([\s\S]*?)"/i);
assert.ok(cspContentMatch, 'Meta CSP debe incluir content');
const cspContent = cspContentMatch[1];
const scriptSrcMatch = cspContent.match(/script-src\s+([^;]+);/i);
assert.ok(scriptSrcMatch, 'CSP debe incluir script-src');
const scriptSrc = scriptSrcMatch[1];
assert.ok(!/unsafe-inline/i.test(scriptSrc), "script-src no debe contener 'unsafe-inline'");
assert.ok(!/nonce-/i.test(scriptSrc), 'script-src no debe usar nonce');
assert.ok(!/sha(256|384|512)-/i.test(scriptSrc), 'script-src no debe usar hash');

// 4) No nonce attrs en scripts
assert.ok(!/\snonce\s*=/i.test(html), 'index.html no debe usar nonce en scripts');

// 5) bootstrap externo existe
assert.ok(fs.existsSync(bootProductionPath), 'Debe existir core/boot-production.js');

console.log('csp-zero-inline tests passed');
