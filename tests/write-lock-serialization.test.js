const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'app-runtime.js'),
  'utf8'
);

assert.ok(
  source.includes('async function withWriteLock('),
  'debe existir withWriteLock global'
);

assert.ok(
  source.includes('operation: `sbUpsertEvent:${source}`') && source.includes('() => sbUpsertEventCore(evt, options)'),
  'sbUpsertEvent debe ejecutarse via withWriteLock'
);

assert.ok(
  source.includes('operation: `sbDeleteEventById:${source}`') && source.includes('() => sbDeleteEventByIdCore(eventId, options)'),
  'sbDeleteEventById debe ejecutarse via withWriteLock'
);

assert.ok(
  source.includes('operation: `sbUpsertAttachment:${source}`') && source.includes('() => sbUpsertAttachmentCore(att, eventId)'),
  'sbUpsertAttachment debe ejecutarse via withWriteLock'
);

assert.ok(
  source.includes('await waitForWriteLockIdle({ timeoutMs: 12000, pollMs: 25 });'),
  'withGoogleSyncLock debe esperar a que el lock de escritura esté libre'
);

assert.ok(
  source.includes('_syncWriteBarrierActive = true;'),
  'withGoogleSyncLock debe activar barrera de escrituras durante sync'
);

console.log('write-lock-serialization tests passed');
