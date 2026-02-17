const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runCycleByCalendars(calendars, syncSingleCalendar) {
  const executed = [];
  for (const calendar of calendars) {
    executed.push(calendar.id);
    await syncSingleCalendar(calendar.id);
  }
  return executed;
}

(async () => {
  const calls = [];
  const calendars = [{ id: 'primary' }, { id: 'team' }, { id: 'family' }];
  const executed = await runCycleByCalendars(calendars, async (calendarId) => {
    calls.push(calendarId);
  });

  assert.deepStrictEqual(executed, ['primary', 'team', 'family']);
  assert.deepStrictEqual(calls, ['primary', 'team', 'family']);

  const runtimeSource = fs.readFileSync(path.join(__dirname, '..', 'core', 'app-runtime.js'), 'utf8');
  assert.ok(runtimeSource.includes('async function syncSingleCalendar'), 'debe existir syncSingleCalendar');
  assert.ok(runtimeSource.includes('for (const calendar of calendars)'), 'runGoogleSyncCycle debe iterar calendarios');
  assert.ok(runtimeSource.includes('await syncSingleCalendar(calendar.id'), 'runGoogleSyncCycle debe delegar en syncSingleCalendar');

  console.log('multi-calendar-sync-iteration tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
