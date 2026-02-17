const assert = require('assert');
const fs = require('fs');
const path = require('path');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function ownerTokenMatches(ownerEmail, tokenEmail) {
  return normalizeEmail(ownerEmail) === normalizeEmail(tokenEmail);
}

assert.strictEqual(ownerTokenMatches('andres5871@gmail.com', 'ANDRES5871@gmail.com'), true);
assert.strictEqual(ownerTokenMatches('andres5871@gmail.com', ' andres5871@gmail.com '), true);
assert.strictEqual(ownerTokenMatches('andres5871@gmail.com', 'otra.persona@gmail.com'), false);

const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
assert.ok(source.includes('https://www.googleapis.com/oauth2/v3/userinfo'), 'debe validar token via userinfo');
assert.ok(source.includes('createGoogleOwnerMismatchError'), 'debe crear error dedicado de owner mismatch');
assert.ok(source.includes("err.code = 'GOOGLE_OWNER_MISMATCH'"), 'debe identificar mismatch por codigo');
assert.ok(source.includes('abortGoogleNetworkRequests(\'google_owner_mismatch\')'), 'debe abortar operaciones en mismatch');

console.log('google-token-owner tests passed');
