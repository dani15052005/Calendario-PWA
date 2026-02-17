const assert = require('assert');
const fs = require('fs');
const path = require('path');

function normalizeGoogleCalendarId(value, fallback = 'primary') {
  const clean = String(value || '').trim();
  return clean || fallback;
}

function normalizeGoogleCalendarList(input) {
  const list = Array.isArray(input) ? input : [];
  const map = new Map();
  for (const row of list) {
    const id = normalizeGoogleCalendarId(row?.id, 'primary');
    const entry = {
      id,
      summary: String(row?.summary || '').trim() || (id === 'primary' ? 'Principal' : id),
      primary: !!row?.primary || id === 'primary'
    };
    if (!map.has(id) || entry.primary) map.set(id, entry);
  }
  if (!map.has('primary')) map.set('primary', { id: 'primary', summary: 'Principal', primary: true });
  return Array.from(map.values()).sort((a, b) => {
    if (a.primary && !b.primary) return -1;
    if (!a.primary && b.primary) return 1;
    return a.summary.localeCompare(b.summary, 'es', { sensitivity: 'base' });
  });
}

function filterWritableCalendars(items) {
  return normalizeGoogleCalendarList(
    (items || [])
      .filter((c) => c && (c.accessRole === 'owner' || c.accessRole === 'writer'))
      .map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary }))
  );
}

const detected = filterWritableCalendars([
  { id: 'primary', summary: 'Principal', primary: true, accessRole: 'owner' },
  { id: 'work-team', summary: 'Equipo', primary: false, accessRole: 'writer' },
  { id: 'readonly', summary: 'Solo lectura', primary: false, accessRole: 'reader' }
]);

assert.deepStrictEqual(
  detected.map((c) => c.id),
  ['primary', 'work-team'],
  'solo deben detectarse calendarios owner/writer'
);

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');
assert.ok(runtimeSource.includes('async function listWritableGoogleCalendars'), 'debe existir listWritableGoogleCalendars');
assert.ok(runtimeSource.includes("syncLog('calendars_detected'"), 'debe registrar calendars_detected');

console.log('multi-calendar-detection tests passed');
