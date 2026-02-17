const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'app-runtime.js'),
  'utf8'
);

assert.ok(
  source.includes("if (event === 'INITIAL_SESSION')"),
  'onAuthStateChange must skip INITIAL_SESSION'
);
assert.ok(
  source.includes("if (event === 'SIGNED_OUT')"),
  'onAuthStateChange must handle SIGNED_OUT explicitly'
);
assert.ok(
  source.includes("if (event !== 'SIGNED_IN' && event !== 'TOKEN_REFRESHED')"),
  'auto sync trigger must be limited to SIGNED_IN/TOKEN_REFRESHED'
);
assert.ok(
  source.includes("if (!session?.user?.id)"),
  'guard must skip when session.user.id is missing'
);
assert.ok(
  source.includes("scope: 'google_sync_cycle'"),
  'google sync bootstrap must check auth readiness'
);
assert.ok(
  source.includes("scope: 'holiday_seed_year'") && source.includes("scope: 'holiday_seed_years'"),
  'holiday sync must check auth readiness'
);

console.log('auth-sync-startup-guard tests passed');
