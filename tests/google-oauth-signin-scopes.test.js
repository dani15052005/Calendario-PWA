const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'app-runtime.js'),
  'utf8'
);

const signInCalls = (source.match(/signInWithOAuth\(/g) || []).length;
assert.strictEqual(
  signInCalls,
  1,
  'debe existir una unica llamada signInWithOAuth para evitar login alternativo sin scopes'
);

assert.ok(
  source.includes("const GOOGLE_OAUTH_SIGNIN_SCOPES = ["),
  'debe existir constante de scopes para login OAuth'
);
assert.ok(
  source.includes("'https://www.googleapis.com/auth/calendar'"),
  'login OAuth debe pedir scope calendar'
);
assert.ok(
  source.includes("'https://www.googleapis.com/auth/drive.file'"),
  'login OAuth debe pedir scope drive.file'
);
assert.ok(
  source.includes('scope: GOOGLE_OAUTH_SIGNIN_SCOPES'),
  'signInWithOAuth debe incluir scope explicito en queryParams'
);
assert.ok(
  source.includes("access_type: 'offline'"),
  'signInWithOAuth debe solicitar access_type=offline'
);
assert.ok(
  source.includes("prompt: 'consent'"),
  'signInWithOAuth debe forzar prompt=consent'
);

assert.ok(
  source.includes('provider_token'),
  'el flujo usa provider_token en runtime'
);
assert.ok(
  source.includes('scope: GOOGLE_OAUTH_SIGNIN_SCOPES'),
  'si se usa provider_token, el login base debe pedir scopes de Calendar/Drive'
);

console.log('google-oauth-signin-scopes tests passed');
