const assert = require('assert');
const fs = require('fs');
const path = require('path');

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre'
];

function shiftMonth(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function renderTopMonthLabel(date) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Flecha izquierda: mes anterior.
const may = new Date(2026, 4, 1);
assert.strictEqual(
  renderTopMonthLabel(shiftMonth(may, -1)),
  'abril 2026',
  'al navegar a la izquierda desde mayo debe mostrarse abril'
);

// Flecha derecha: mes siguiente.
assert.strictEqual(
  renderTopMonthLabel(shiftMonth(may, 1)),
  'junio 2026',
  'al navegar a la derecha desde mayo debe mostrarse junio'
);

// Cruce de anio al navegar hacia atras.
const jan = new Date(2026, 0, 1);
assert.strictEqual(
  renderTopMonthLabel(shiftMonth(jan, -1)),
  'diciembre 2025',
  'enero -> izquierda debe pasar a diciembre del anio anterior'
);

// Cruce de anio al navegar hacia adelante.
const dec = new Date(2026, 11, 1);
assert.strictEqual(
  renderTopMonthLabel(shiftMonth(dec, 1)),
  'enero 2027',
  'diciembre -> derecha debe pasar a enero del anio siguiente'
);

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');
assert.ok(runtimeSource.includes('function goToPrevMonth('), 'debe existir goToPrevMonth');
assert.ok(runtimeSource.includes('function goToNextMonth('), 'debe existir goToNextMonth');
assert.ok(
  /on\('#prevMonthBtn','click',\s*goToPrevMonth\);/.test(runtimeSource),
  'la flecha izquierda debe usar goToPrevMonth'
);
assert.ok(
  /on\('#nextMonthBtn','click',\s*goToNextMonth\);/.test(runtimeSource),
  'la flecha derecha debe usar goToNextMonth'
);
assert.ok(
  runtimeSource.includes('console.log("Month navigation mode: arrows");'),
  'debe loguear modo de navegacion por flechas al iniciar'
);
assert.ok(
  !runtimeSource.includes('monthPicker'),
  'app-runtime.js no debe contener monthPicker'
);
assert.ok(
  !runtimeSource.includes('monthDropBtn'),
  'app-runtime.js no debe contener monthDropBtn'
);

const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
assert.ok(htmlSource.includes('id="prevMonthBtn"'), 'index.html debe tener prevMonthBtn');
assert.ok(htmlSource.includes('aria-label="Mes anterior"'), 'prevMonthBtn debe tener aria-label');
assert.ok(htmlSource.includes('id="currentMonthLabel"'), 'index.html debe tener currentMonthLabel');
assert.ok(htmlSource.includes('id="nextMonthBtn"'), 'index.html debe tener nextMonthBtn');
assert.ok(htmlSource.includes('aria-label="Mes siguiente"'), 'nextMonthBtn debe tener aria-label');
assert.ok(!htmlSource.includes('id="monthDropBtn"'), 'el dropdown de meses no debe existir en index.html');

console.log('monthly-nav tests passed');
