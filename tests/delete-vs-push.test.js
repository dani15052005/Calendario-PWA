const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TOMBSTONE_TTL_MS = 30 * 60 * 1000;

function hasEventDeletedTombstone(map, eventId, nowMs = Date.now()) {
  if (!eventId) return false;
  const ts = map.get(String(eventId));
  return Number.isFinite(ts) && (nowMs - ts) <= TOMBSTONE_TTL_MS;
}

async function revalidateLocalEventBeforeGooglePushMock(localEvent, {
  tombstones,
  nowMs,
  fetchById,
  markDeleted
}) {
  const localEventId = localEvent?.id || null;
  if (!localEventId) return null;

  if (hasEventDeletedTombstone(tombstones, localEventId, nowMs)) {
    return null;
  }

  const latest = await fetchById(localEventId);
  if (!latest) {
    markDeleted(localEventId, nowMs);
    return null;
  }

  if (hasEventDeletedTombstone(tombstones, localEventId, nowMs)) {
    return null;
  }

  return latest;
}

(async () => {
  const now = Date.now();
  const tombstones = new Map();

  tombstones.set('evt-a', now - 1000);
  const skipByTombstone = await revalidateLocalEventBeforeGooglePushMock({ id: 'evt-a' }, {
    tombstones,
    nowMs: now,
    fetchById: async () => ({ id: 'evt-a', title: 'A' }),
    markDeleted: () => {}
  });
  assert.strictEqual(skipByTombstone, null, 'evento en tombstone no debe pusharse');

  let marked = null;
  const missingRemote = await revalidateLocalEventBeforeGooglePushMock({ id: 'evt-b' }, {
    tombstones,
    nowMs: now,
    fetchById: async () => null,
    markDeleted: (id, ts) => { marked = { id, ts }; tombstones.set(id, ts); }
  });
  assert.strictEqual(missingRemote, null, 'evento borrado localmente no debe resucitarse');
  assert.ok(marked && marked.id === 'evt-b', 'debe marcar tombstone al no existir ya en Supabase');

  const valid = await revalidateLocalEventBeforeGooglePushMock({ id: 'evt-c' }, {
    tombstones,
    nowMs: now,
    fetchById: async (id) => ({ id, title: 'Persistente' }),
    markDeleted: () => {}
  });
  assert.ok(valid && valid.id === 'evt-c', 'evento existente debe continuar a push');

  const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  assert.ok(source.includes('function revalidateLocalEventBeforeGooglePush('), 'script.js debe incluir revalidacion pre-push');
  assert.ok(source.includes('markEventDeletedTombstone('), 'script.js debe marcar tombstone en borrado/revalidacion');
  assert.ok(source.includes('push_skip_deleted_revalidated'), 'script.js debe loggear skip por revalidacion');

  console.log('delete-vs-push tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
