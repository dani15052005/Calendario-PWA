const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'manifest.json');
const cssPath = path.join(root, 'styles.css');
const runtimePath = path.join(root, 'core', 'app-runtime.js');

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const css = fs.readFileSync(cssPath, 'utf8');
const runtime = fs.readFileSync(runtimePath, 'utf8');

assert.ok(
  String(manifest.display || '').trim().toLowerCase() === 'standalone',
  'manifest debe mantener display=standalone'
);

assert.ok(
  String(manifest.orientation || '').trim().toLowerCase() !== 'portrait',
  'manifest orientation no debe ser portrait'
);

assert.ok(
  /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-width:\s*1024px\)/m.test(css),
  'styles.css debe incluir media query de landscape móvil'
);

assert.ok(
  !/body[^{]*\{[^}]*transform\s*:\s*rotate\(/gim.test(css),
  'no debe aplicarse transform: rotate al body'
);

assert.ok(
  runtime.includes("window.addEventListener('resize', () => {")
    && runtime.includes("window.matchMedia('(orientation: landscape)').matches")
    && runtime.includes("'is-landscape'"),
  'app-runtime.js debe incluir listener resize para clase is-landscape'
);

console.log('landscape-support tests passed');
