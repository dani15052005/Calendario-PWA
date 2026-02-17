const assert = require('assert');
const fs = require('fs');
const path = require('path');

const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const requiredModules = [
  'utils/helpers.js',
  'core/state.js',
  'core/auth.js',
  'data/queries.js',
  'data/supabase.js',
  'sync/reconcile.js',
  'sync/google-sync.js',
  'attachments/drive.js',
  'reminders/reminders.js',
  'ui/month.js',
  'ui/week.js',
  'ui/day.js',
  'ui/agenda.js'
];

for (const src of requiredModules) {
  assert.ok(index.includes(src), `index.html debe cargar ${src}`);
}

assert.ok(index.indexOf('ui/agenda.js') < index.indexOf('script.js'), 'los modulos deben cargar antes del monolito');

console.log('module-load-order tests passed');


