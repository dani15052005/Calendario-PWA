const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');

assert.ok(
  source.includes("syncLog('manual_full_bootstrap_forced', { reason: 'user_manual_sync' })"),
  'debe loguear manual_full_bootstrap_forced en sync manual'
);

assert.ok(
  source.includes('const isManualFullBootstrap = reason === \'manual\';'),
  'runGoogleSyncCycle debe tener branch manual full bootstrap'
);

assert.ok(
  source.includes('sinceISO: MANUAL_FULL_BOOTSTRAP_TIME_MIN'),
  'sync manual full bootstrap debe usar timeMin fijo 2009'
);

assert.ok(
  source.includes('forceBootstrap: true')
  && source.includes('ignoreWatermark: true')
  && source.includes("modeOverride: 'manual_full_bootstrap'")
  && source.includes('allowDeletes: false'),
  'sync manual full bootstrap debe forzar bootstrap sin watermark, sin borrados y con modo manual_full_bootstrap'
);

assert.ok(
  source.includes("const MANUAL_FULL_BOOTSTRAP_TIME_MIN = '2009-01-01T00:00:00Z';"),
  'timeMin manual debe ser exactamente 2009-01-01T00:00:00Z'
);

assert.ok(
  !source.includes('const isManualFullBootstrap = reason === \'manual\';\n        const linkedGoogleEventsCount = await sbCountEventsWithGoogleLink();'),
  'branch manual no debe depender de linkedGoogleEventsCount'
);

console.log('manual-full-bootstrap-forced tests passed');
