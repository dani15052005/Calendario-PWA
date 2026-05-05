const assert = require('assert');
const fs = require('fs');
const path = require('path');

const runtimeSource = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'app-runtime.js'),
  'utf8'
);
// schema_full_production.sql fue deprecado por incompatibilidad de columnas
// (gcal_event_id vs google_event_id). Las policies canónicas viven en
// schema_task_owner_email_rls.sql.
const schemaSource = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'schema_task_owner_email_rls.sql'),
  'utf8'
);

function between(source, startToken, endToken) {
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end);
}

const sbFetchEventsRangeBlock = between(
  runtimeSource,
  'async function sbFetchEventsRange(',
  'async function sbFetchAllEvents('
);

assert.ok(sbFetchEventsRangeBlock, 'debe existir sbFetchEventsRange');
assert.ok(
  sbFetchEventsRangeBlock.includes('const ctx = await getReadDataContext();'),
  'sbFetchEventsRange debe usar contexto de lectura'
);
assert.ok(
  sbFetchEventsRangeBlock.includes('runEventSelectWithProfileFallback('),
  'sbFetchEventsRange debe usar fallback de perfil de columnas'
);
assert.ok(
  sbFetchEventsRangeBlock.includes("operation: 'fetch_events_range'")
  || sbFetchEventsRangeBlock.includes("'fetch_events_range'"),
  'sbFetchEventsRange debe registrar operación con contexto'
);
assert.ok(
  sbFetchEventsRangeBlock.includes('start_at_lt') && sbFetchEventsRangeBlock.includes('end_at_gt'),
  'sbFetchEventsRange debe loggear filtros de solapamiento'
);
assert.ok(
  !runtimeSource.includes('getReadyDataContext('),
  'no debe quedar getReadyDataContext (causa de fallo en runtime)'
);

assert.ok(
  runtimeSource.includes('dataLog(\'supabase_call_error\''),
  'debe existir logging estructurado de errores Supabase'
);

// La policy canónica se llama events_select_owner_email (sufijo _email
// añadido en schema_task_owner_email_rls.sql).
const eventsSelectPolicyRegex = /create policy events_select_owner(?:_email)?[\s\S]*?using\s*\(\s*auth\.uid\(\)\s*=\s*user_id[\s\S]*?auth\.jwt\(\)\s*->>\s*'email'\s*=\s*'andres5871@gmail\.com'[\s\S]*?\)/i;
assert.ok(
  eventsSelectPolicyRegex.test(schemaSource),
  'events_select_owner_email debe exigir auth.uid() y email owner'
);

function ownerPolicyAllowsSelect({ authUid, rowUserId, email }) {
  return String(authUid || '') === String(rowUserId || '')
    && String(email || '').trim().toLowerCase() === 'andres5871@gmail.com';
}

assert.strictEqual(
  ownerPolicyAllowsSelect({ authUid: 'u-1', rowUserId: 'u-1', email: 'andres5871@gmail.com' }),
  true,
  'owner autenticado debe poder hacer SELECT sobre sus eventos'
);
assert.strictEqual(
  ownerPolicyAllowsSelect({ authUid: 'u-1', rowUserId: 'u-1', email: 'otro.usuario@gmail.com' }),
  false,
  'usuario autenticado no-owner debe quedar bloqueado por policy'
);

console.log('month-events-supabase-access tests passed');
