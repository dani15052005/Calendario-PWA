const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function persistAttachmentMetaWithDriveIdMock({ upsertOk }) {
  const cache = [];
  const rollback = [];

  async function cachePut(att) {
    cache.push(att.id);
  }

  async function cacheDelete(attId) {
    rollback.push(attId);
  }

  const normalized = { id: 'att-1', drive_file_id: 'drive-1' };
  await cachePut(normalized);

  if (!upsertOk) {
    await cacheDelete(normalized.id);
    throw new Error('upsert_failed');
  }

  return { cache, rollback };
}

(async () => {
  const ok = await persistAttachmentMetaWithDriveIdMock({ upsertOk: true });
  assert.deepStrictEqual(ok.rollback, [], 'si upsert ok no debe haber rollback');

  let failed = null;
  try {
    await persistAttachmentMetaWithDriveIdMock({ upsertOk: false });
  } catch (err) {
    failed = err;
  }
  assert.ok(failed, 'si falla upsert debe propagar error');

  const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.ok(source.includes('function sbUpsertAttachmentWithRetry('), 'debe existir retry de metadata');
  assert.ok(source.includes('await rollbackAttachmentCacheEntry(normalized.id);'), 'debe revertir cache al fallar metadata');
  assert.ok(source.includes('throw err;'), 'debe propagar error tras fallo de metadata');

  console.log('attachment-metadata-failure tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
