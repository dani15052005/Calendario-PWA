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
  'styles.css debe usar body.is-landscape para overrides de landscape'
);

assert.ok(
  /@media\s*\(orientation:\s*landscape\)/m.test(css),
  'styles.css debe incluir media query de orientacion landscape'
);

assert.ok(
  /body\.is-landscape\s+\.calendar-day[\s\S]*min-height:\s*82px/i.test(css),
  'landscape debe usar celdas de mes balanceadas (>=80px)'
);

assert.ok(
  /body\.is-landscape[\s\S]*\.calendar-grid[\s\S]*gap:\s*1px/i.test(css),
  'landscape debe ajustar separacion fina del grid mensual'
);

assert.ok(
  /body\.is-landscape[\s\S]*\.time-slot[\s\S]*height:\s*44px/i.test(css),
  'landscape debe incluir ajuste de legibilidad en time-slot (>=44px)'
);

assert.ok(
  /body\.is-landscape[\s\S]*(\.topbar\.calendar-toolbar|\.calendar-header)[\s\S]*(min-height:\s*52px|height:\s*52px)/i.test(css),
  'landscape debe compactar topbar/header'
);

assert.ok(
  /body\.is-landscape\s+\.calendar-wrapper[\s\S]*max-width:\s*1200px/i.test(css),
  'landscape debe limitar ancho del wrapper para mejor respiracion lateral'
);

assert.ok(
  /body\.is-landscape\s+\.calendar-day[\s\S]*min-height:\s*(78|82|100|115)px/i.test(css),
  'calendar-day en landscape debe mantener alturas sanas (78/82/100/115)'
);

assert.ok(
  /body\.is-landscape\s+\.time-slot[\s\S]*height:\s*(42|44|50|56)px/i.test(css),
  'time-slot en landscape debe mantener alturas sanas (42/44/50/56)'
);

assert.ok(
  !/body[^{]*\{[^}]*transform\s*:\s*rotate\(/gim.test(css),
  'no debe usarse rotate hack en body para landscape'
);

assert.ok(
  runtime.includes("'is-landscape'")
    && runtime.includes("window.matchMedia('(orientation: landscape)').matches"),
  'runtime debe mantener listener de orientacion landscape'
);

// Guardrails: visual tuning no debe eliminar primitives criticas de sync/locks.
assert.ok(runtime.includes('function runGoogleSyncCycle'), 'runGoogleSyncCycle debe seguir presente');
assert.ok(runtime.includes('withWriteLock('), 'withWriteLock debe seguir presente');
assert.ok(runtime.includes('flushOutbox('), 'flushOutbox debe seguir presente');

console.log('landscape-optimized-layout tests passed');
