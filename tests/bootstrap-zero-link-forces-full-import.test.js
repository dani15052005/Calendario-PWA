const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');

assert.ok(
  source.includes('const mustBootstrapFullImport = linkedGoogleEventsCount === 0;'),
  'bootstrap debe activarse cuando linkedCount es 0'
);

assert.ok(
  source.includes("syncLog('bootstrap_forced_due_to_zero_links'"),
  'debe existir log bootstrap_forced_due_to_zero_links'
);

assert.ok(
  source.includes('linkedCount: linkedGoogleEventsCount'),
  'el log debe incluir linkedCount'
);

assert.ok(
  source.includes('const knownLinkedLocal = linkedLocalForBootstrap.filter((evt) => hasGoogleLinkColumns(evt)).length;'),
  'knownLinkedLocal debe contar solo por columnas de vínculo Google'
);

assert.ok(
  !source.includes('const mustBootstrapFullImport = linkedGoogleEventsCount === 0 && knownLinkedLocal'),
  'bootstrap no debe depender de knownLinkedLocal'
);

console.log('bootstrap-zero-link-forces-full-import tests passed');
