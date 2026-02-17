const assert = require('assert');

function safeISODateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function isRemoteGoogleVersionNewer(remoteUpdated, localKnownUpdated) {
  const remoteIso = safeISODateTime(remoteUpdated);
  const localIso = safeISODateTime(localKnownUpdated);
  if (!remoteIso) return false;
  if (!localIso) return true;
  return new Date(remoteIso).getTime() > new Date(localIso).getTime();
}

function hasRemoteVersionChanged(remoteUpdated, localKnownUpdated, remoteEtag, localKnownEtag) {
  if (isRemoteGoogleVersionNewer(remoteUpdated, localKnownUpdated)) return true;
  if (remoteEtag && localKnownEtag && String(remoteEtag) !== String(localKnownEtag)) return true;
  return false;
}

function shouldApplyGoogleOverLocal(localEvent, remoteUpdated, remoteEtag = null) {
  if (!localEvent) return true;
  if (!localEvent.needsGCalSync) return true;
  if (!localEvent.gcalUpdated && !localEvent.gcalEtag) return true;
  return hasRemoteVersionChanged(remoteUpdated, localEvent.gcalUpdated, remoteEtag, localEvent.gcalEtag);
}

assert.strictEqual(shouldApplyGoogleOverLocal(null, '2026-02-15T10:00:00Z'), true, 'inserta remoto si no existe local');
assert.strictEqual(
  shouldApplyGoogleOverLocal({ needsGCalSync: false, gcalUpdated: '2026-02-15T10:00:00Z' }, '2026-02-15T10:00:00Z'),
  true,
  'si local esta limpio, aplica remoto'
);
assert.strictEqual(
  shouldApplyGoogleOverLocal({ needsGCalSync: true, gcalUpdated: null, gcalEtag: null }, '2026-02-15T10:00:00Z'),
  true,
  'si local sucio sin version remota previa, aplica remoto'
);
assert.strictEqual(
  shouldApplyGoogleOverLocal({ needsGCalSync: true, gcalUpdated: '2026-02-15T10:00:00Z', gcalEtag: 'v1' }, '2026-02-15T10:00:00Z', 'v1'),
  false,
  'si local sucio y remoto igual, no sobreescribe'
);
assert.strictEqual(
  shouldApplyGoogleOverLocal({ needsGCalSync: true, gcalUpdated: '2026-02-15T10:00:00Z', gcalEtag: 'v1' }, '2026-02-15T10:01:00Z', 'v1'),
  true,
  'si remoto tiene updated mas nuevo, Google gana'
);
assert.strictEqual(
  shouldApplyGoogleOverLocal({ needsGCalSync: true, gcalUpdated: '2026-02-15T10:00:00Z', gcalEtag: 'v1' }, '2026-02-15T10:00:00Z', 'v2'),
  true,
  'si etag cambia aunque updated sea igual, Google gana'
);

console.log('google-sync-reconcile tests passed');
