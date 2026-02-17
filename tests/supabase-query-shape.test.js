const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

assert.ok(source.includes('const SB_EVENT_SELECT_COLUMNS'), 'debe definir columnas explícitas de eventos');
assert.ok(source.includes('const SB_ATTACHMENT_SELECT_COLUMNS'), 'debe definir columnas explícitas de adjuntos');
assert.ok(source.includes('function sbApplyRangeOverlap('), 'debe centralizar filtro de solapamiento');
assert.ok(!source.includes(".select('*')"), 'no debe usar select(*) en queries críticas');

console.log('supabase-query-shape tests passed');

