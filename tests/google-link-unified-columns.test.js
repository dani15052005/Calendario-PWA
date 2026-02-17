const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');

assert.ok(
  source.includes(".or('gcal_event_id.not.is.null,google_event_id.not.is.null')"),
  'el conteo/filtro de vinculados debe usar OR entre gcal_event_id y google_event_id'
);

assert.ok(
  source.includes("'fetch_linked_google_events_in_range'"),
  'debe existir fetch_linked_google_events_in_range'
);

assert.ok(
  source.includes("google_id_columns: ['gcal_event_id', 'google_event_id']"),
  'el filtro de vinculados por rango debe contemplar ambas columnas'
);

assert.ok(
  source.includes("syncLog('google_link_columns_unified'"),
  'debe existir log google_link_columns_unified'
);

console.log('google-link-unified-columns tests passed');
