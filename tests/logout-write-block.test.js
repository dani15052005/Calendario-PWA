const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

assert.ok(source.includes('let _logoutInProgress = false;'), 'debe existir flag global de logout en progreso');
assert.ok(source.includes('function assertWritesAllowed('), 'debe existir guardia de escritura');
assert.ok(source.includes("_logoutInProgress = true;"), 'logout debe activar bloqueo de escrituras');
assert.ok(source.includes("assertWritesAllowed('sbUpsertEvent')"), 'upsert de evento debe estar protegido');
assert.ok(source.includes("assertWritesAllowed('sbDeleteEventById')"), 'delete de evento debe estar protegido');
assert.ok(source.includes("assertWritesAllowed('sbUpsertAttachment')"), 'upsert de adjunto debe estar protegido');

console.log('logout-write-block tests passed');

