const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const cssPremium = fs.existsSync(path.join(root, 'styles-premium.css'))
  ? fs.readFileSync(path.join(root, 'styles-premium.css'), 'utf8')
  : '';
const allCss = css + '\n' + cssPremium;

// Grid debe ser 7 columnas (mes), aceptamos 1fr o minmax(0,1fr).
assert.ok(
  /\.calendar-grid[^{]*\{[\s\S]*grid-template-columns:\s*repeat\(7\s*,\s*(?:minmax\(0\s*,\s*1fr\)|1fr)\)/m.test(allCss),
  'calendar-grid debe usar repeat(7, 1fr) o repeat(7, minmax(0,1fr))'
);

// Gap razonable (2..8px). El valor exacto depende del breakpoint.
assert.ok(
  /\.calendar-grid[^{]*\{[\s\S]*gap:\s*[2-8]px/m.test(allCss),
  'calendar-grid debe definir un gap entre 2px y 8px'
);

// Las celdas día deben definir altura mínima (fija o responsive).
assert.ok(
  /\.calendar-(?:grid\s*>\s*\.)?(?:calendar-)?day[^{]*\{[\s\S]*min-height:\s*(?:\d+px|clamp\([^)]+\))/m.test(allCss),
  'calendar-day debe tener una min-height definida (px fijo o clamp responsive)'
);

// No debe haber badges visibles en el día (se ocultan o no se renderizan).
assert.ok(
  /\.calendar-day\s*\.badge[\s\S]*display:\s*none\s*!important/m.test(allCss)
    || /\.day\s*\.badge[\s\S]*display:\s*none\s*!important/m.test(allCss)
    || /\.day-badge[\s\S]*display:\s*none\s*!important/m.test(allCss),
  'no debe existir day-badge visible'
);

// Los pills/eventos del mes no deben tener un background "duro" — usamos
// dot + texto sobre un fondo sutil. Aceptamos transparent / none / var(--tag-bg).
assert.ok(
  /\.calendar-grid\s+\.calendar-event[\s\S]*background:\s*(none|transparent|var\()/m.test(allCss)
    || /\.event-tag[\s\S]*background:\s*var\(--tag-bg/m.test(allCss),
  'los eventos mensuales deben renderizar sin fondo duro o usando var(--tag-bg)'
);

// Punto de color a la izquierda del evento (estilo Google Calendar).
assert.ok(
  /\.calendar-grid\s+\.calendar-event::before\s*\{[\s\S]*border-radius:\s*50%[\s\S]*background:\s*var\(--event-color/m.test(allCss)
    || /\.event-tag::before[\s\S]*border-radius:\s*50%/m.test(allCss),
  'los eventos mensuales deben mostrar un punto de color a la izquierda'
);

console.log('month-grid-uniform-visual tests passed');
