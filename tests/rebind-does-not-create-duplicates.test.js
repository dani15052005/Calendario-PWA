const assert = require('assert');
const fs = require('fs');
const path = require('path');

function simulateRebind({ localUnlinked, remoteEntries, alreadyLinkedGoogleIds }) {
  const byKey = new Map();
  for (const r of remoteEntries) {
    const list = byKey.get(r.key) || [];
    list.push(r);
    byKey.set(r.key, list);
  }

  const linkedIds = new Set(alreadyLinkedGoogleIds || []);
  const assigned = [];
  let matched = 0;
  let unmatched = 0;

  for (const local of localUnlinked) {
    const candidates = byKey.get(local.key) || [];
    if (candidates.length !== 1) {
      unmatched++;
      continue;
    }
    const remote = candidates[0];
    if (linkedIds.has(remote.googleEventId)) {
      unmatched++;
      continue;
    }
    linkedIds.add(remote.googleEventId);
    assigned.push({ localId: local.id, googleEventId: remote.googleEventId });
    matched++;
  }

  return { matched, unmatched, assigned };
}

const result = simulateRebind({
  localUnlinked: [
    { id: 'l1', key: 'a|2026-01-01T10:00:00.000Z|2026-01-01T11:00:00.000Z' },
    { id: 'l2', key: 'a|2026-01-01T10:00:00.000Z|2026-01-01T11:00:00.000Z' },
    { id: 'l3', key: 'b|2026-01-02T10:00:00.000Z|2026-01-02T11:00:00.000Z' }
  ],
  remoteEntries: [
    { key: 'a|2026-01-01T10:00:00.000Z|2026-01-01T11:00:00.000Z', googleEventId: 'g-a', googleCalendarId: 'primary' },
    { key: 'b|2026-01-02T10:00:00.000Z|2026-01-02T11:00:00.000Z', googleEventId: 'g-b', googleCalendarId: 'primary' }
  ],
  alreadyLinkedGoogleIds: ['g-a']
});

assert.strictEqual(result.matched, 1, 'solo debe vincular evento no usado');
assert.strictEqual(result.unmatched, 2, 'los conflictos/no-match quedan intactos');
assert.deepStrictEqual(result.assigned, [{ localId: 'l3', googleEventId: 'g-b' }]);

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');
assert.ok(runtimeSource.includes('async function rebindLocalEventsWithGoogle'), 'debe existir función rebind');
assert.ok(runtimeSource.includes('if (existingLinkedGoogleIds.has(remoteEntry.googleEventId))'), 'debe impedir duplicar google_event_id ya vinculado');
assert.ok(runtimeSource.includes("syncLog('rebind_complete', { matched, unmatched })"), 'debe registrar resultado rebind');

console.log('rebind-does-not-create-duplicates tests passed');
