const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');

assert.ok(
  source.includes('async function sbCountEventsWithGoogleLink'),
  'debe existir conteo de eventos ya vinculados a Google'
);
assert.ok(
  source.includes('linkedGoogleEventsCount === 0'),
  'debe activar bootstrap full import cuando count de vinculados es 0'
);
assert.ok(
  source.includes('bootstrap_full_import_start'),
  'debe registrar bootstrap_full_import_start'
);
assert.ok(
  source.includes('bootstrap_full_import_complete'),
  'debe registrar bootstrap_full_import_complete'
);
assert.ok(
  source.includes("sinceISO: '2009-01-01T00:00:00Z'")
  || source.includes("sinceISO: GOOGLE_SYNC_DEFAULTS.sinceISO"),
  'bootstrap debe usar timeMin base 2009'
);
assert.ok(
  source.includes("url.searchParams.set('timeMin', sinceISO)"),
  'full import debe usar timeMin'
);
assert.ok(
  source.includes("url.searchParams.set('maxResults', '2500')"),
  'full import debe usar maxResults 2500'
);
assert.ok(
  source.includes('if (pageToken) url.searchParams.set(\'pageToken\', pageToken);')
  && source.includes('} while (pageToken);'),
  'full import debe paginar completamente'
);
assert.ok(
  source.includes('forceBootstrap: true'),
  'runGoogleSyncCycle debe forzar modo bootstrap full'
);

console.log('bootstrap-full-import-required tests passed');
