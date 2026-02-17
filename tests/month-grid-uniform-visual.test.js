const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

assert.ok(
  /\.calendar-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(7,\s*1fr\)/m.test(css),
  'calendar-grid debe usar repeat(7, 1fr)'
);

assert.ok(
  /\.calendar-grid\s*\{[\s\S]*gap:\s*2px\s*!important/m.test(css),
  'calendar-grid debe usar gap 2px en vista mensual compacta'
);

assert.ok(
  /\.calendar-grid\s*>\s*\.calendar-day\s*\{[\s\S]*min-height:\s*140px[\s\S]*max-height:\s*140px[\s\S]*height:\s*140px/m.test(css)
    || /\.calendar-grid\s*>\s*\.calendar-day\s*\{[\s\S]*height:\s*140px[\s\S]*min-height:\s*140px[\s\S]*max-height:\s*140px/m.test(css),
  'calendar-day debe tener altura fija 140px'
);

assert.ok(
  /\.calendar-day\s*\.badge[\s\S]*display:\s*none\s*!important/m.test(css)
    || /\.day\s*\.badge[\s\S]*display:\s*none\s*!important/m.test(css)
    || /\.day-badge[\s\S]*display:\s*none\s*!important/m.test(css),
  'no debe existir day-badge visible'
);

assert.ok(
  /\.calendar-grid\s+\.calendar-event[\s\S]*background:\s*(none|transparent)\s*!important/m.test(css),
  'los eventos mensuales deben renderizar sin fondo'
);

assert.ok(
  /\.calendar-grid\s+\.calendar-event::before\s*\{[\s\S]*border-radius:\s*50%[\s\S]*background:\s*var\(--event-color/m.test(css),
  'los eventos mensuales deben mostrar punto de color a la izquierda'
);

console.log('month-grid-uniform-visual tests passed');
