const assert = require('assert');

// Regla nueva (solapamiento):
// event.start_at < rangeEnd && event.end_at > rangeStart
function overlapsRange(eventStartIso, eventEndIso, rangeStartIso, rangeEndIso) {
  const eventStart = Date.parse(eventStartIso);
  const eventEnd = Date.parse(eventEndIso);
  const rangeStart = Date.parse(rangeStartIso);
  const rangeEnd = Date.parse(rangeEndIso);
  return eventStart < rangeEnd && eventEnd > rangeStart;
}

// Regla anterior (solo start_at dentro de rango)
function oldStartOnlyFilter(eventStartIso, _eventEndIso, rangeStartIso, rangeEndIso) {
  const eventStart = Date.parse(eventStartIso);
  const rangeStart = Date.parse(rangeStartIso);
  const rangeEnd = Date.parse(rangeEndIso);
  return eventStart >= rangeStart && eventStart < rangeEnd;
}

const rangeStart = '2026-03-10T00:00:00.000Z';
const rangeEnd = '2026-03-11T00:00:00.000Z';

const events = [
  {
    id: 'inside',
    start: '2026-03-10T10:00:00.000Z',
    end: '2026-03-10T11:00:00.000Z',
    expectedOverlap: true
  },
  {
    id: 'starts-before-ends-inside',
    start: '2026-03-09T22:00:00.000Z',
    end: '2026-03-10T01:00:00.000Z',
    expectedOverlap: true
  },
  {
    id: 'starts-inside-ends-after',
    start: '2026-03-10T23:00:00.000Z',
    end: '2026-03-11T02:00:00.000Z',
    expectedOverlap: true
  },
  {
    id: 'covers-whole-range',
    start: '2026-03-09T00:00:00.000Z',
    end: '2026-03-12T00:00:00.000Z',
    expectedOverlap: true
  },
  {
    id: 'ends-exactly-at-range-start',
    start: '2026-03-09T20:00:00.000Z',
    end: '2026-03-10T00:00:00.000Z',
    expectedOverlap: false
  },
  {
    id: 'starts-exactly-at-range-end',
    start: '2026-03-11T00:00:00.000Z',
    end: '2026-03-11T02:00:00.000Z',
    expectedOverlap: false
  },
  {
    id: 'outside-before',
    start: '2026-03-09T10:00:00.000Z',
    end: '2026-03-09T11:00:00.000Z',
    expectedOverlap: false
  }
];

for (const evt of events) {
  const next = overlapsRange(evt.start, evt.end, rangeStart, rangeEnd);
  assert.strictEqual(
    next,
    evt.expectedOverlap,
    `overlap mismatch en ${evt.id}`
  );
}

const oldIds = events
  .filter((evt) => oldStartOnlyFilter(evt.start, evt.end, rangeStart, rangeEnd))
  .map((evt) => evt.id)
  .sort();

const newIds = events
  .filter((evt) => overlapsRange(evt.start, evt.end, rangeStart, rangeEnd))
  .map((evt) => evt.id)
  .sort();

// Antes (filtro antiguo): pierde eventos multidia que empezaron antes del rango.
assert.deepStrictEqual(oldIds, ['inside', 'starts-inside-ends-after']);

// Despues (filtro por solapamiento): incluye todos los eventos que intersectan el rango.
assert.deepStrictEqual(newIds, [
  'covers-whole-range',
  'inside',
  'starts-before-ends-inside',
  'starts-inside-ends-after'
]);

console.log('range-overlap tests passed');
