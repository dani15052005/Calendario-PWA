const assert = require('assert');
const fs = require('fs');
const path = require('path');

function toLocalDateTime(dateStr, timeStr = '00:00') {
  const [Y, M, D] = String(dateStr || '').split('-').map(Number);
  const [h, m] = String(timeStr || '00:00').split(':').map(Number);
  return new Date(Y, (M || 1) - 1, D || 1, h || 0, m || 0, 0, 0);
}

function parseDateInput(v) {
  const [y, m, d] = String(v || '').split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function getEventBoundsMsForDayDistribution(evt) {
  const startDate = String(evt?.startDate || evt?.date || '').trim();
  const endDate = String(evt?.endDate || startDate || '').trim();
  if (!startDate || !endDate) return null;

  const allDay = !!evt?.allDay || !!evt?.all_day;
  const startTime = allDay ? '00:00' : String(evt?.startTime || evt?.time || '00:00');
  const endTime = allDay ? '23:59' : String(evt?.endTime || evt?.time || evt?.startTime || '00:00');

  const startMs = toLocalDateTime(startDate, startTime).getTime();
  let endMs = toLocalDateTime(endDate, endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) endMs = startMs + 60 * 1000;
  return { startMs, endMs };
}

function getDayBoundsMs(dayKey) {
  const day = parseDateInput(dayKey);
  const startMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).getTime();
  const endMs = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0).getTime();
  return { startMs, endMs };
}

function distributeEventsByVisibleDays(events, dayKeys) {
  const keys = [...new Set((dayKeys || []).filter(Boolean))];
  const out = new Map(keys.map((k) => [k, []]));
  if (!keys.length || !Array.isArray(events) || !events.length) return out;

  const dayBounds = keys.map((dayKey) => ({ dayKey, ...getDayBoundsMs(dayKey) }));

  for (const evt of events) {
    const evtBounds = getEventBoundsMsForDayDistribution(evt);
    if (!evtBounds) continue;
    for (const day of dayBounds) {
      if (evtBounds.startMs < day.endMs && evtBounds.endMs > day.startMs) {
        out.get(day.dayKey).push(evt);
      }
    }
  }
  return out;
}

const visibleDays = ['2026-05-01', '2026-05-02', '2026-05-03'];

const timedMultiday = {
  id: 'evt-timed',
  startDate: '2026-05-01',
  startTime: '10:00',
  endDate: '2026-05-03',
  endTime: '18:00',
  allDay: false
};

const allDayMultiday = {
  id: 'evt-allday',
  startDate: '2026-06-01',
  endDate: '2026-06-03',
  allDay: true
};

const timedMap = distributeEventsByVisibleDays([timedMultiday], visibleDays);
for (const day of visibleDays) {
  assert.strictEqual(
    timedMap.get(day).some((e) => e.id === 'evt-timed'),
    true,
    `el evento 1->3 debe aparecer en ${day}`
  );
}

const allDayMap = distributeEventsByVisibleDays([allDayMultiday], ['2026-06-01', '2026-06-02', '2026-06-03']);
for (const day of ['2026-06-01', '2026-06-02', '2026-06-03']) {
  assert.strictEqual(
    allDayMap.get(day).some((e) => e.id === 'evt-allday'),
    true,
    `el evento all_day 1->3 debe aparecer en ${day}`
  );
}

const scriptPath = path.join(__dirname, '..', 'script.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');
assert.ok(
  scriptSource.includes('function distributeEventsByVisibleDays('),
  'script.js debe contener distribucion por dias visibles'
);
assert.ok(
  scriptSource.includes('distributeEventsByVisibleDays(events, dayKeys)'),
  'loadMonthEvents debe distribuir por interseccion diaria'
);

console.log('multiday-distribution tests passed');
