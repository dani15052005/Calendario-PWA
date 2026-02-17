const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'core', 'app-runtime.js'),
  'utf8'
);

assert.ok(
  !/\balert\s*\(/.test(source),
  'no debe quedar ningun alert() en app-runtime.js'
);
assert.ok(
  !/\bconfirm\s*\(/.test(source),
  'no debe quedar ningun confirm() nativo en app-runtime.js'
);
assert.ok(
  !/\bprompt\s*\(/.test(source),
  'no debe quedar ningun prompt() en app-runtime.js'
);

assert.ok(
  source.includes('function showToast('),
  'debe existir showToast() como sistema unificado'
);

assert.ok(
  source.includes("document.getElementById('btnGoogleConnect')"),
  'debe existir boton dinamico btnGoogleConnect'
);
assert.ok(
  source.includes("btn.textContent = 'Desconectar Google'")
    && source.includes("btn.textContent = 'Conectar Google'"),
  'el boton de Google debe alternar Conectar/Desconectar'
);

assert.ok(
  source.includes('function updateNotificationButton()'),
  'debe existir updateNotificationButton()'
);
assert.ok(
  source.includes("document.getElementById('btnNotifications')"),
  'debe existir boton dinamico btnNotifications'
);
assert.ok(
  source.includes("btn.textContent = 'Desactivar notificaciones'")
    && source.includes("btn.textContent = 'Activar notificaciones'"),
  'el boton de notificaciones debe alternar Activar/Desactivar'
);

console.log('toast-replaces-alerts tests passed');
