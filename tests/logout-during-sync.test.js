const assert = require('assert');
const fs = require('fs');
const path = require('path');

function createSyncAbortError(stage = 'unknown') {
  const err = new Error('SYNC_ABORTED');
  err.code = 'SYNC_ABORTED';
  err.stage = stage;
  return err;
}

function throwIfSyncAbortRequested(syncAbortRequested, stage = 'unknown') {
  if (!syncAbortRequested) return;
  throw createSyncAbortError(stage);
}

assert.doesNotThrow(() => throwIfSyncAbortRequested(false, 'loop'));
assert.throws(
  () => throwIfSyncAbortRequested(true, 'loop'),
  (err) => err && err.code === 'SYNC_ABORTED' && err.stage === 'loop'
);

const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
assert.ok(source.includes("_syncAbortRequested = true;"), 'logout debe solicitar abort de sync');
assert.ok(source.includes("abortGoogleNetworkRequests('logout')"), 'logout debe abortar fetch activos');
assert.ok(source.includes("throwIfSyncAbortRequested('pushAllDirtyToGoogle:loop_start')"), 'push loop debe consultar cancelacion cooperativa');
assert.ok(source.includes("throwIfSyncAbortRequested('importAllFromGoogle:loop_start')"), 'pull loop debe consultar cancelacion cooperativa');

console.log('logout-during-sync tests passed');
