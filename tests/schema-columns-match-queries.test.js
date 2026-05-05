// Verifica que toda columna que el frontend SELECTeará en data/queries.js
// existe en alguna de las migraciones canónicas (schema_task*.sql).
//
// Si este test falla, hay un schema drift entre el código y la BD esperada.
// Solución: añadir un add column en una nueva migración o quitar la columna
// del SELECT del frontend.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const queriesSrc = fs.readFileSync(path.join(root, 'data', 'queries.js'), 'utf8');

function extractListConst(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`No se encontró const ${name} en data/queries.js`);
  return m[1]
    .split(',')
    .map((line) => line.replace(/['"\s]/g, ''))
    .filter(Boolean);
}

const eventCols = extractListConst(queriesSrc, 'SB_EVENT_SELECT_COLUMNS');
const attachmentCols = extractListConst(queriesSrc, 'SB_ATTACHMENT_SELECT_COLUMNS');

// Recolectar SQL de todas las migraciones canónicas (excluyendo deprecadas y tests).
const migrationsDir = path.join(root, 'supabase');
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter((f) => /\.sql$/i.test(f))
  .filter((f) => !f.startsWith('_DEPRECATED_'))
  .filter((f) => !f.includes('_test'))
  .filter((f) => !f.includes('_probe'));

assert.ok(
  migrationFiles.length >= 8,
  `Esperaba >=8 migraciones canónicas, encontradas ${migrationFiles.length}`
);

const allSql = migrationFiles
  .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
  .join('\n')
  .toLowerCase();

// Helpers
function hasColumnInTable(sql, table, col) {
  // create table public.<table> (... col ...) o add column if not exists col
  const colLower = col.toLowerCase();
  const addCol = new RegExp(`add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?${colLower}\\b`, 'i');
  if (addCol.test(sql)) return true;
  // create table que mencione la columna en su lista de campos
  const createTable = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\);`,
    'i'
  );
  const m = sql.match(createTable);
  if (m) {
    const body = m[1].toLowerCase();
    const colInBody = new RegExp(`\\b${colLower}\\b`, 'i');
    if (colInBody.test(body)) return true;
  }
  return false;
}

const missingEventCols = eventCols.filter((c) => !hasColumnInTable(allSql, 'events', c));
const missingAttachmentCols = attachmentCols.filter((c) => !hasColumnInTable(allSql, 'attachments', c));

assert.deepStrictEqual(
  missingEventCols,
  [],
  `Columnas de events seleccionadas por queries.js pero ausentes en migraciones canónicas: ${missingEventCols.join(', ')}`
);
assert.deepStrictEqual(
  missingAttachmentCols,
  [],
  `Columnas de attachments seleccionadas por queries.js pero ausentes en migraciones canónicas: ${missingAttachmentCols.join(', ')}`
);

// Y al revés: el deprecado NO debe estar listado como migración canónica.
assert.ok(
  !migrationFiles.some((f) => f.includes('full_production')),
  'schema_full_production.sql debería estar deprecado (renombrado a .txt)'
);

console.log(`schema-columns-match-queries OK — events: ${eventCols.length} cols, attachments: ${attachmentCols.length} cols, migraciones: ${migrationFiles.length}`);
