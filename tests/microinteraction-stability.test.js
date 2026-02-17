const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'core', 'app-runtime.js'), 'utf8');

assert.ok(
  /button:active\s*\{[^}]*scale\(\.98\)/i.test(css),
  'botones deben tener microinteracción activa scale(.98)'
);

assert.ok(
  /:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--primary\)[^}]*outline-offset:\s*2px/i.test(css),
  'debe existir foco visible moderno con contraste'
);

assert.ok(
  /\.sync-status-pill\{[\s\S]*150ms[\s\S]*\}/i.test(css),
  'syncStatusPill debe animar cambios de estado suavemente (150ms)'
);

assert.ok(
  css.includes('.sync-status-pill::before')
    && css.includes('[data-state="syncing"]::before')
    && css.includes('[data-state="ok"]::before')
    && css.includes('[data-state="offline"]::before')
    && css.includes('[data-state="error"]::before'),
  'syncStatusPill debe incluir iconografía inline por estado'
);

assert.ok(
  /@media\s*\(hover:hover\)\s*and\s*\(pointer:fine\)[\s\S]*\.calendar-event\.event-card:hover[\s\S]*translateY\(-1px\)/i.test(css),
  'hover refinado debe aplicarse solo en pointer fine'
);

assert.ok(
  /\.calendar-day\.today\{[\s\S]*todayPulseIn[\s\S]*\}/i.test(css)
    && /@keyframes\s+todayPulseIn/i.test(css),
  'día actual debe tener pulso sutil de entrada'
);

assert.ok(
  runtime.includes('renderSyncStatusPill')
    && runtime.includes("pill.dataset.state = state"),
  'estado visual de sync debe seguir cableado en runtime'
);

assert.ok(runtime.includes('function runGoogleSyncCycle'), 'runGoogleSyncCycle debe seguir presente');
assert.ok(runtime.includes('withWriteLock('), 'withWriteLock debe seguir presente');
assert.ok(runtime.includes('flushOutbox('), 'flushOutbox debe seguir presente');

console.log('microinteraction-stability tests passed');
