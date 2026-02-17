const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'core', 'app-runtime.js'), 'utf8');

assert.ok(
  css.includes('.calendar-header'),
  'debe existir la clase .calendar-header en CSS'
);
assert.ok(
  css.includes('.calendar-day'),
  'debe existir la clase .calendar-day en CSS'
);
assert.ok(
  css.includes('.calendar-event'),
  'debe existir la clase .calendar-event en CSS'
);
assert.ok(
  css.includes('.event-card'),
  'debe existir la clase .event-card en CSS'
);

assert.ok(
  html.includes('class="top-month-nav calendar-header"'),
  'la cabecera superior debe usar calendar-header'
);
assert.ok(
  html.includes('class="calendar-nav calendar-header"'),
  'la cabecera de la vista mes debe usar calendar-header'
);
assert.ok(
  html.includes('class="event-pill calendar-event event-card"'),
  'el template de eventos debe renderizarse como tarjeta event-card'
);

assert.ok(
  runtime.includes('function updateAppTitleForMonth('),
  'debe existir updateAppTitleForMonth'
);
assert.ok(
  runtime.includes("const titleEl = $('#currentMonthLabel') || $('#appTitle');"),
  'updateAppTitleForMonth debe apuntar al label principal del header'
);
assert.ok(
  runtime.includes('titleEl.textContent = formatted;'),
  'el texto del header debe actualizarse al cambiar mes'
);
assert.ok(
  runtime.includes('cell.className = \'day calendar-day\''),
  'las celdas del mes deben usar calendar-day'
);
assert.ok(
  runtime.includes('event-overflow-indicator'),
  'debe existir indicador +X para dias con muchos eventos'
);

console.log('calendar-visual-cards tests passed');
