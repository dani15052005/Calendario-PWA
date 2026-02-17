const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const cssPath = path.join(root, 'styles.css');
const runtimePath = path.join(root, 'core', 'app-runtime.js');

const css = fs.readFileSync(cssPath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

assert.ok(
  css.includes('body.is-landscape'),
  'debe existir soporte visual basado en body.is-landscape'
);

assert.ok(
  /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-width:\s*900px\)\s*and\s*\(pointer:\s*coarse\)/m.test(css),
  'debe existir breakpoint de movil horizontal <=900'
);

assert.ok(
  /@media\s*\(orientation:\s*landscape\)\s*and\s*\(min-width:\s*901px\)\s*and\s*\(max-width:\s*1200px\)\s*and\s*\(pointer:\s*coarse\)/m.test(css),
  'debe existir breakpoint de tablet horizontal 901-1200'
);

assert.ok(
  /@media\s*\(orientation:\s*landscape\)\s*and\s*\(min-width:\s*1201px\)\s*and\s*\(max-width:\s*1366px\)\s*and\s*\(pointer:\s*coarse\)/m.test(css),
  'debe existir breakpoint de tablet grande horizontal 1201-1366'
);

assert.ok(
  /max-width:\s*1100px/i.test(css),
  'debe existir max-width 1100 para landscape tablet'
);

assert.ok(
  /max-width:\s*1280px/i.test(css),
  'debe existir max-width 1280 para landscape tablet grande'
);

assert.ok(
  /min-height:\s*100px/i.test(css),
  'debe existir min-height >=100 para celdas en tablet landscape'
);

const slotHeights = [...css.matchAll(/\.time-slot[\s\S]*?height:\s*(\d+)px/gi)]
  .map((m) => Number(m[1]))
  .filter((n) => Number.isFinite(n));
assert.ok(slotHeights.some((n) => n >= 50), 'debe existir time-slot >=50 para tablet landscape');
assert.ok(slotHeights.every((n) => n > 30), 'no deben existir heights extremos <=30 en time-slot');

assert.ok(
  !/body[^{]*\{[^}]*transform\s*:\s*rotate\(/gim.test(css),
  'no debe usarse rotate hack en body'
);

assert.ok(runtime.includes('function runGoogleSyncCycle'), 'runGoogleSyncCycle debe seguir presente');
assert.ok(runtime.includes('withWriteLock('), 'withWriteLock debe seguir presente');
assert.ok(runtime.includes('flushOutbox('), 'flushOutbox debe seguir presente');

console.log('landscape-pro-layout tests passed');
