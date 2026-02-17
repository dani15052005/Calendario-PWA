const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'core', 'app-runtime.js'), 'utf8');

assert.ok(
  css.includes('.month-transition-enter') && css.includes('.month-transition-active'),
  'deben existir clases de transición de mes'
);

assert.ok(
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none\s*!important[\s\S]*transition:\s*none\s*!important/i.test(css),
  'debe existir guardrail global para reduced motion'
);

assert.ok(
  /\.drawer\{[\s\S]*170ms[\s\S]*\}/i.test(css),
  'drawer debe usar transición corta (<=180ms)'
);

assert.ok(
  /\.sheet\{[\s\S]*170ms[\s\S]*\}/i.test(css),
  'sheet debe usar transición corta (<=180ms)'
);

assert.ok(
  /\.sheet\.open\{[\s\S]*170ms/i.test(css),
  'animación de apertura de sheet debe ser <=180ms'
);

assert.ok(
  !/\.month-(out|in)[^{]*\{[^}]*([2-9]\d\d)ms/gi.test(css),
  'transiciones de mes no deben superar 200ms'
);

assert.ok(
  !/\.view-enter-(month|time)[^{]*\{[^}]*([2-9]\d\d)ms/gi.test(css),
  'animaciones de entrada de vista no deben superar 200ms'
);

assert.ok(
  runtime.includes('month-transition-enter')
    && runtime.includes('month-transition-active')
    && runtime.includes('function animateMonth('),
  'runtime debe usar clases de transición de mes'
);

assert.ok(runtime.includes('function runGoogleSyncCycle'), 'runGoogleSyncCycle debe seguir presente');
assert.ok(runtime.includes('withWriteLock('), 'withWriteLock debe seguir presente');
assert.ok(runtime.includes('flushOutbox('), 'flushOutbox debe seguir presente');

console.log('animation-guardrails tests passed');
