const assert = require('assert');
const fs = require('fs');
const path = require('path');

function attachmentToSupabaseRowStrict(att, eventId, userId) {
  const driveId = String(att?.gdriveId || att?.drive_file_id || '').trim();
  if (!driveId) throw new Error('Adjunto sin drive_file_id');
  return {
    id: att.id || 'test-id',
    event_id: eventId,
    user_id: userId,
    drive_file_id: driveId
  };
}

assert.throws(
  () => attachmentToSupabaseRowStrict({}, 'evt', 'usr'),
  /Adjunto sin drive_file_id/
);

const ok = attachmentToSupabaseRowStrict({ gdriveId: 'drive_123' }, 'evt', 'usr');
assert.strictEqual(ok.drive_file_id, 'drive_123');

const scriptPath = path.join(__dirname, '..', 'script.js');
const source = fs.readFileSync(scriptPath, 'utf8');

assert.ok(
  source.includes("throw new Error('Adjunto sin drive_file_id')"),
  'script.js debe rechazar metadatos de adjunto sin drive_file_id'
);

assert.ok(
  !/drive_file_id:\s*[^,\n]+(?:\|\|\s*null)/.test(source),
  'script.js no debe mapear drive_file_id con fallback null'
);

console.log('attachments-drive-id tests passed');
