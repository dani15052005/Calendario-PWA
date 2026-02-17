const assert = require('assert');
const fs = require('fs');
const path = require('path');

function normalizeGoogleCalendarId(value, fallback = 'primary') {
  const clean = String(value || '').trim();
  return clean || fallback;
}

function getEventGoogleCalendarId(evt, fallback = 'primary') {
  return normalizeGoogleCalendarId(
    evt?.googleCalendarId || evt?.google_calendar_id || evt?.calendarId || null,
    fallback
  );
}

function resolvePushCalendarId(localEvent, requestedCalendarId) {
  return normalizeGoogleCalendarId(
    requestedCalendarId || getEventGoogleCalendarId(localEvent, 'primary'),
    'primary'
  );
}

assert.strictEqual(
  resolvePushCalendarId({ googleCalendarId: 'team-calendar' }, null),
  'team-calendar',
  'push debe usar google_calendar_id del evento'
);

assert.strictEqual(
  resolvePushCalendarId({ googleCalendarId: null }, null),
  'primary',
  'eventos legacy sin calendarId deben usar primary'
);

assert.strictEqual(
  resolvePushCalendarId({ googleCalendarId: 'team-calendar' }, 'forced-calendar'),
  'forced-calendar',
  'si se fuerza calendarId explicito debe prevalecer'
);

const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');
assert.ok(
  runtimeSource.includes("calendarId || getEventGoogleCalendarId(localEvent, 'primary')"),
  'pushEventToGCal debe resolver calendarId desde el evento'
);
assert.ok(
  runtimeSource.includes('googleCalendarId: targetCalendarId'),
  'pushEventToGCal debe persistir googleCalendarId tras push'
);

console.log('event-calendar-association tests passed');
