const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const runtime = fs.readFileSync(path.join(root, 'core', 'app-runtime.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

assert.ok(
  runtime.includes('const AGENDA_VIRTUALIZATION_THRESHOLD = 500;'),
  'threshold de virtualización de agenda debe ser 500'
);

assert.ok(
  runtime.includes('const AGENDA_VIRTUAL_OVERSCAN_ROWS = 20;'),
  'overscan de virtualización de agenda debe estar definido'
);

assert.ok(
  runtime.includes('function mountAgendaVirtualization('),
  'debe existir montaje de virtualización de agenda'
);

assert.ok(
  runtime.includes('events.length > AGENDA_VIRTUALIZATION_THRESHOLD'),
  'virtualización debe activarse solo cuando eventos > 500'
);

assert.ok(
  runtime.includes("list.addEventListener('scroll', onScroll, { passive: true });")
    && runtime.includes('requestAnimationFrame(() => {'),
  'virtualización debe renderizar por scroll con raf (batch visual)'
);

assert.ok(
  runtime.includes('renderAgendaRowsSlice(list, rows, 0, rows.length);'),
  'render clásico debe mantenerse para listas pequeñas'
);

assert.ok(
  runtime.includes("list.classList.toggle('agenda-heavy', events.length > 1000);")
    && css.includes('.agenda-list-view.agenda-heavy .agenda-item.calendar-event.event-card'),
  'modo visual liviano debe activarse con alto volumen'
);

assert.ok(runtime.includes('function runGoogleSyncCycle'), 'runGoogleSyncCycle debe seguir presente');
assert.ok(runtime.includes('withWriteLock('), 'withWriteLock debe seguir presente');
assert.ok(runtime.includes('flushOutbox('), 'flushOutbox debe seguir presente');

console.log('agenda-virtualization-lite tests passed');
