const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'core', 'app-runtime.js'), 'utf8');

// 1) No inline scripts
const scriptTags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
const inlineScripts = scriptTags.filter((tag) => !/\bsrc\s*=/.test(tag));
assert.strictEqual(inlineScripts.length, 0, 'No debe haber <script> inline sin src');

// 2) No inline onXXX handlers
const inlineHandlers = [...html.matchAll(/\son[a-z]+\s*=/gi)];
assert.strictEqual(inlineHandlers.length, 0, 'No debe haber handlers inline onXXX en index.html');

// 3) CSP script-src sin unsafe-inline
const cspTag = html.match(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i);
assert.ok(cspTag, 'Debe existir meta CSP');
const cspContentMatch = cspTag[0].match(/content="([\s\S]*?)"/i);
assert.ok(cspContentMatch, 'Meta CSP debe tener content');
const cspContent = cspContentMatch[1];
const scriptSrc = cspContent.match(/script-src\s+([^;]+);/i);
assert.ok(scriptSrc, 'CSP debe incluir script-src');
assert.ok(!/unsafe-inline/i.test(scriptSrc[1]), 'script-src no debe usar unsafe-inline');

// 4) Sin fallback profile legacy
assert.ok(!runtime.includes('_eventSelectProfile'), 'No debe existir _eventSelectProfile');
assert.ok(!runtime.includes('_attachmentSelectProfile'), 'No debe existir _attachmentSelectProfile');
assert.ok(!runtime.includes('events_select_profile_fallback'), 'No debe existir events_select_profile_fallback');
assert.ok(!runtime.includes('attachments_select_profile_fallback'), 'No debe existir attachments_select_profile_fallback');

// 5) SELECT principal con columnas esperadas
const expectedColumns = [
  'url',
  'locked',
  'is_holiday',
  'last_synced_at',
  'remote_missing',
  'remote_missing_at',
  'needs_gcal_sync',
  'gcal_updated',
  'gcal_etag',
  'google_event_id',
  'google_calendar_id',
  'meta'
];
for (const col of expectedColumns) {
  assert.ok(runtime.includes(col), `SELECT/row mapping debe contemplar columna ${col}`);
}

// 6) Primitivas críticas intactas
assert.ok(runtime.includes('function runGoogleSyncCycle'), 'runGoogleSyncCycle debe existir');
assert.ok(runtime.includes('withWriteLock('), 'withWriteLock debe existir');
assert.ok(runtime.includes('flushOutbox('), 'flushOutbox debe existir');

console.log('stability-production-hardening tests passed');
