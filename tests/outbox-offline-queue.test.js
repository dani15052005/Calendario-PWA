const assert = require('assert');
const fs = require('fs');
const path = require('path');

const runtime = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'app-runtime.js'),
  'utf8'
);
const html = fs.readFileSync(
  path.join(__dirname, '..', 'index.html'),
  'utf8'
);

assert.ok(
  runtime.includes("const OUTBOX_STORE = 'outbox';"),
  'debe existir store outbox en IndexedDB'
);

assert.ok(
  runtime.includes('async function enqueueOutboxOperation('),
  'debe existir enqueueOutboxOperation'
);

assert.ok(
  runtime.includes('async function flushOutbox('),
  'debe existir flushOutbox'
);

assert.ok(runtime.includes('op,'), 'cola debe incluir campo op');
assert.ok(runtime.includes('payload,'), 'cola debe incluir campo payload');
assert.ok(runtime.includes('createdAt:'), 'cola debe incluir campo createdAt');
assert.ok(runtime.includes('retries:'), 'cola debe incluir campo retries');

assert.ok(
  runtime.includes("await enqueueOutboxOperation('event_upsert'"),
  'sbUpsertEvent debe encolar event_upsert en error de red'
);

assert.ok(
  runtime.includes("await enqueueOutboxOperation('event_delete'"),
  'sbDeleteEventById debe encolar event_delete en error de red'
);

assert.ok(
  html.includes('id="syncStatusPill"'),
  'debe existir #syncStatusPill persistente en topbar'
);

console.log('outbox-offline-queue tests passed');
