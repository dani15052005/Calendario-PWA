window.__APP_BOOT__ = 'OK';
console.log('[Calendario] JS cargado');
// ===== Versionado obligatorio =====
window.__APP_VERSION__ = '1.2.17';
const VERSION_ENDPOINT = './app-version.json';

async function fetchVersionManifest() {
  const res = await fetch(VERSION_ENDPOINT, { cache: 'no-store' }); // evita caché
  if (!res.ok) throw new Error('No se pudo leer app-version.json');
  return res.json();
}


// Evita aplicar resultados de renders antiguos
let monthRenderToken = 0;

// ===================== Utilidades =====================
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function cmpSemver(a,b){
  const norm = (v) =>
    String(v).trim()
      .replace(/[,]+/g, '.')          // comas → puntos
      .replace(/[^0-9.]/g, '')        // quita raros
      .split('.').slice(0,3)
      .map(n => parseInt(n || 0, 10));

  const pa = norm(a), pb = norm(b);
  for (let i=0;i<3;i++){
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function qs(el){ return document.querySelector(el); }

function showUpdateGate(minReq, latest, notes){
  let gate = qs('#updateGate');
  if (!gate) {
    // si no existe, crea un gate mínimo para no dejar el body bloqueado “a ciegas”
    gate = document.createElement('div');
    gate.id = 'updateGate';
    gate.className = 'update-gate';
    gate.innerHTML = `
      <div class="card">
        <h3>Actualización requerida</h3>
        <p id="currentVer"></p>
        <p id="requiredVer"></p>
        <a id="releaseNotesLink" href="#" style="display:none">Notas de versión</a>
        <button id="updateNowBtn" class="btn primary">Actualizar</button>
      </div>`;
    document.body.appendChild(gate);
  }

  document.body.classList.add('update-block');

  const elCur = qs('#currentVer');
if (elCur) elCur.textContent = `Actual: ${window.__APP_VERSION__}`;

const elReq = qs('#requiredVer');
if (elReq) elReq.textContent = `Requerida: ${minReq}`;

  const link = qs('#releaseNotesLink');
  if (link) {
    if (notes && /^https?:\/\//.test(notes)) {
      link.href = notes;
      link.style.display = 'block';
      link.setAttribute('target','_blank');
      link.setAttribute('rel','noopener');
    } else {
      link.style.display = 'none';
      link.removeAttribute('href');
    }
  }

  gate.setAttribute('aria-hidden','false');
  gate.classList.remove('hidden');
  localStorage.setItem('forceUpdate.min', minReq);
}

function toLocalDateTime(dateStr, timeStr='00:00'){
  const [Y,M,D] = dateStr.split('-').map(Number);
  const [h,m]   = timeStr.split(':').map(Number);
  return new Date(Y, M-1, D, h||0, m||0, 0, 0);
}
function addMinutes(dateStr, timeStr, minutes=0){
  const dt = toLocalDateTime(dateStr, timeStr);
  dt.setMinutes(dt.getMinutes() + minutes);
  return { date: ymd(dt), time: `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}` };
}

function setAllDayUI(isAllDay){
  const row = document.getElementById('rowDateTime');
  if (!row) return;
  row.classList.toggle('all-day', !!isAllDay);
  const st = document.getElementById('eventStartTime');
  const et = document.getElementById('eventEndTime');
  if (st) st.disabled = !!isAllDay;
  if (et) et.disabled = !!isAllDay;
}

function hideUpdateGate(){
  document.body.classList.remove('update-block');
  const gate = qs('#updateGate');
  if (!gate) return;
  gate.classList.add('hidden');
  gate.setAttribute('aria-hidden','true');   // <-- y esto
  localStorage.removeItem('forceUpdate.min');
}


const on = (selOrEl, evt, handler, opts) => {
  const el = typeof selOrEl === 'string' ? $(selOrEl) : selOrEl;
  if (!el) { console.warn('No se encontró el selector para listener:', selOrEl); return; }
  el.addEventListener(evt, handler, opts);
};
const MONTHS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const WEEKDAYS_MIN = ["L","M","X","J","V","S","D"];
const pad2 = (n) => String(n).padStart(2,'0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const parseDateInput = (v) => { const [y,m,da] = v.split('-').map(Number); return new Date(y, m-1, da); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Horas visibles en las vistas de tiempo
const DAY_START_H = 7;
const DAY_END_H   = 18;
const PX_PER_HOUR = 60;
const PX_PER_MIN  = PX_PER_HOUR / 60;
// Pointer “coarse” = móvil/tablet
const IS_COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

function injectDrawerVersion(){
  const el = document.getElementById('appVersionLabel');
  if (el) el.textContent = 'v' + (window.__APP_VERSION__ || '0.0.0');
}

// ===== Back manager (hardware back) =====
const backMgr = (() => {
  const stack = [];
  let ignoreNextPop = false;

  function push(kind, onBack) {
    stack.push({ kind, onBack });
    try { history.pushState({ app:'cal', kind, t:Date.now() }, ''); } catch {}
  }
  function consumeOne() {
    // Llamar cuando cerramos manualmente (X, tap fuera…)
    ignoreNextPop = true;
    try { history.back(); } catch {}
  }

  window.addEventListener('popstate', () => {
    if (ignoreNextPop) { ignoreNextPop = false; return; }
    const top = stack.pop();
    if (top && typeof top.onBack === 'function') {
      // Cierre “silencioso”: la función NO debe volver a tocar history.back()
      top.onBack();
    }
  });

  return { push, consumeOne };
})();

// ===== Snapshot & Restore de eventos + adjuntos =====
async function snapshotEventAndAttachments(eventId){
  let ev = null;
  const atts = [];
  await tx(['events','attachments'], 'readonly', (eventsStore, attStore) => {
    const g = eventsStore.get(eventId);
    g.onsuccess = () => { if (g.result) ev = { ...g.result }; };
    const idx = attStore.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(eventId));
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      atts.push({ ...cur.value }); // clon superficial suficiente (Blob se mantiene)
      cur.continue();
    };
  });
  return { event: ev, atts };
}

async function deleteAllAttachmentsForEvent(eventId){
  await tx(['attachments'], 'readwrite', (attStore) => {
    const idx = attStore.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(eventId));
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      attStore.delete(cur.primaryKey);
      cur.continue();
    };
  });
}

async function restoreEventAndAttachments(ev, atts){
  if (!ev) return;
  // 1) borrar adjuntos actuales
  await deleteAllAttachmentsForEvent(ev.id);
  // 2) restaurar adjuntos del snapshot
  await tx(['attachments'], 'readwrite', (attStore) => {
    for (const a of atts) attStore.put(a);
  });
  // 3) restaurar el propio evento (campos)
  await tx(['events'], 'readwrite', (eventsStore) => eventsStore.put(ev));
}

// ===== Confirm "nativo" con <dialog> (fallback a window.confirm) =====
function ensureConfirmDialog() {
  let dlg = document.getElementById('confirmModal');
  if (dlg) return dlg;

  dlg = document.createElement('dialog');
  dlg.id = 'confirmModal';
  dlg.className = 'confirm-modal';
  dlg.innerHTML = `
    <form method="dialog">
      <div class="confirm-wrap">
        <div class="confirm-head">
          <div class="confirm-icon" aria-hidden="true">⚠️</div>
          <div>
            <div class="confirm-title" id="cmTitle">Confirmar</div>
            <p class="confirm-text" id="cmText"></p>
          </div>
        </div>
      </div>
      <div class="confirm-actions">
        <button value="cancel" type="submit" class="btn" id="cmCancel">Cancelar</button>
        <button value="ok"     type="submit" class="btn primary" id="cmOk">Aceptar</button>
      </div>
    </form>
  `;
  document.body.appendChild(dlg);
  return dlg;
}

/**
 * confirmNative({ title, message, confirmText, cancelText, destructive })
 * @returns {Promise<boolean>}
 */
function confirmNative(opts = {}) {
  const support = typeof window.HTMLDialogElement === 'function';
  if (!support) {
    return Promise.resolve(window.confirm(opts.message || '¿Seguro?'));
  }
  const {
    title = 'Confirmar',
    message = '¿Seguro?',
    confirmText = 'Aceptar',
    cancelText = 'Cancelar',
    destructive = false
  } = opts;

  const dlg = ensureConfirmDialog();
  const titleEl = dlg.querySelector('#cmTitle');
  const textEl  = dlg.querySelector('#cmText');
  const okBtn   = dlg.querySelector('#cmOk');
  const cancelBtn = dlg.querySelector('#cmCancel');

  titleEl.textContent = title;
  textEl.textContent  = message;
  okBtn.textContent   = confirmText;
  cancelBtn.textContent = cancelText;

  okBtn.classList.toggle('danger', !!destructive);
  okBtn.classList.toggle('primary', !destructive);

  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose, { once: true });

    // Accesibilidad: Enter = confirmar, Esc = cancelar (lo maneja el dialog)
    // Foco inicial en Cancelar (como hace iOS), cambiar a okBtn si prefieres
    setTimeout(() => cancelBtn.focus(), 0);

    dlg.showModal();
  });
}

// Si ya definiste MONTHS_SHORT antes, no lo dupliques
window.MONTHS_SHORT ||= ["ene","feb","mar","abr","may","jun","jul","ago","sept","oct","nov","dic"];
const MONTHS_SHORT = window.MONTHS_SHORT;

function ensureSearchFullUI(){
  let o = document.getElementById('searchFull');
  if (o) return o;
  o = document.createElement('div');
  o.id = 'searchFull';
  o.className = 'sf-overlay';
  o.innerHTML = `
    <div class="sf-panel" role="dialog" aria-modal="true" aria-labelledby="sfHeading">
      <div class="sf-header">
        <div id="sfHeading" class="sf-title">Resultados</div>
        <button id="sfClose" class="sf-close" aria-label="Cerrar">✕</button>
      </div>
      <div id="sfList" class="sf-list"></div>
    </div>
  `;
  document.body.appendChild(o);

  // cerrar al pulsar fuera del panel
  o.addEventListener('mousedown', (ev)=>{ 
    const panel = o.querySelector('.sf-panel');
    if (panel && !panel.contains(ev.target)) closeSearchFull();
  });
  o.querySelector('#sfClose').addEventListener('click', closeSearchFull);
  return o;
}

function openSearchFull(){
  const o = ensureSearchFullUI();
  if (!o.classList.contains('open')) {
    backMgr.push('search', () => { o.classList.remove('open'); document.body.classList.remove('search-full-open'); });
  }
  o.classList.add('open');
  document.body.classList.add('search-full-open');
}
function closeSearchFull(){
  const o = document.getElementById('searchFull');
  if (o && o.classList.contains('open')) {
    backMgr.consumeOne();
    o.classList.remove('open');
    document.body.classList.remove('search-full-open');
  }
}

function showSearchFull(items, highlightTerms = []){
  injectSearchFullStyles();
  const o = ensureSearchFullUI();
  openSearchFull();
  const list = o.querySelector('#sfList');
  list.innerHTML = '';

  const firstTerm = (highlightTerms && highlightTerms.length) ? highlightTerms[0] : '';
  const addHL = (text) => highlightFragment(text, firstTerm); // usa tu helper existente

  items.forEach(e => {
    const d = parseDateInput(e.date);
    const month = MONTHS_SHORT[d.getMonth()];
    const day   = d.getDate();

    const btn = document.createElement('button');
    btn.type  = 'button';
    btn.className = `sf-item cat-${e.category || ''}`;

    const dateBox = document.createElement('div');
    dateBox.className = 'sf-date';
    dateBox.innerHTML = `<div class="sf-month">${month}</div><div class="sf-day">${day}</div>`;

    const text = document.createElement('div');
    text.className = 'sf-text';
    const title = document.createElement('div'); title.className = 'sf-titleline';
    const meta  = document.createElement('div'); meta.className  = 'sf-meta';

    const catLabel = (e.category === 'Otros' && e.categoryOther) ? e.categoryOther : e.category;
    const range = e.allDay || e.category === 'Festivo'
      ? 'Todo el día'
      : (e.endTime ? `${e.time || ''} – ${e.endTime}` : (e.time || ''));
    const metaTextParts = [range];
    if (e.location) metaTextParts.push(` · ${e.location}`);
    if (catLabel)   metaTextParts.push(` · ${catLabel}`);

    title.append( addHL(e.title || '(Sin título)') );
    meta.append( addHL(metaTextParts.join('')) );

    text.appendChild(title);
    text.appendChild(meta);

    btn.appendChild(dateBox);
    btn.appendChild(text);

    btn.addEventListener('click', () => {
      closeSearchFull();
      openSheetForEdit(e);
    });

    list.appendChild(btn);
  });
}

function ensureAgendaDialog(){
  let dlg = document.getElementById('dayAgendaModal');
  if (dlg) return dlg;

  dlg = document.createElement('dialog');
  dlg.id = 'dayAgendaModal';
  dlg.className = 'agenda-modal';
  dlg.innerHTML = `
    <form method="dialog" class="agenda-card">
      <div class="ag-head">
        <div class="ag-date">
          <span class="ag-daynum" id="agDayNum">--</span>
          <div>
            <div class="ag-dow" id="agDow">—</div>
            <div class="ag-sub" id="agSub">—</div>
          </div>
        </div>
        <button class="ag-close" value="cancel" aria-label="Cerrar">✕</button>
      </div>
      <div class="ag-list" id="agList"></div>
      <div class="ag-footer">
        <button class="btn small" value="cancel" type="submit">Cerrar</button>
      </div>
    </form>
  `;
  document.body.appendChild(dlg);
  return dlg;
}

function canUseDialog(){ return typeof window.HTMLDialogElement === 'function'; }

function showDayAgenda(dateObj, events){
  if (!canUseDialog()) {
    if (events.length === 1) return openSheetForEdit(events[0]);
    return; // (o tu overlay alternativo)
  }
  injectAgendaStyles();
  const dlg = ensureAgendaDialog();

  // --- cabecera ---
  const d = dateObj;
  dlg.querySelector('#agDayNum').textContent = String(d.getDate());
  dlg.querySelector('#agDow').textContent = new Intl.DateTimeFormat('es-ES',{ weekday:'long' }).format(d);
  dlg.querySelector('#agSub').textContent = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;

  // --- lista ---
  const list = dlg.querySelector('#agList');
  list.innerHTML = '';
  const sorted = events.slice().sort((a,b)=>{
    const ta = (a.allDay || a.category === 'Festivo') ? '00:00' : (a.time || '23:59');
    const tb = (b.allDay || b.category === 'Festivo') ? '00:00' : (b.time || '23:59');
    return ta.localeCompare(tb);
  });

  sorted.forEach((evt, i) => {
    if (i>0) list.appendChild(Object.assign(document.createElement('div'), { className:'ag-sep' }));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ag-item cat-${evt.category}`;
    const timeEl = Object.assign(document.createElement('div'), { className:'ag-time' });
    timeEl.textContent = (evt.allDay || evt.category === 'Festivo') ? 'Todo el día' : (evt.time || '--:--');
    const main = Object.assign(document.createElement('div'), { className:'ag-main' });
    const titleEl = Object.assign(document.createElement('div'), { className:'ag-title' });
    titleEl.textContent = evt.title || '(Sin título)';
    const metaEl = Object.assign(document.createElement('div'), { className:'ag-meta' });
    const range = (evt.allDay || evt.category === 'Festivo') ? '' : (evt.endTime ? `${evt.time} – ${evt.endTime}` : (evt.time || ''));
    const loc = evt.location ? `   ${evt.location}` : '';
    metaEl.textContent = `${range}${loc}`;
    main.appendChild(titleEl); main.appendChild(metaEl);
    btn.appendChild(timeEl); btn.appendChild(main);
    btn.addEventListener('click', () => { dlg.close(); openSheetForEdit(evt); });
    list.appendChild(btn);
  });

  dlg.showModal();

  // 👇 NUEVO: hardware back cierra este diálogo
  backMgr.push('agenda', () => { try { dlg.close(); } catch {} });

  // 👇 NUEVO: si se cierra “a mano”, consumir la entrada del back
  dlg.addEventListener('close', function onCloseOnce() {
    dlg.removeEventListener('close', onCloseOnce);
    backMgr.consumeOne();
  }, { once: true });

  const first = dlg.querySelector('.ag-item');
  if (first) setTimeout(()=> first.focus(), 0);
}


function setMonthDensity(mode){
  state.monthDensity = (mode === 'expanded') ? 'expanded' : 'compact';
  localStorage.setItem('month.density', state.monthDensity);
  applyMonthDensity();
  if (state.viewMode === 'month') renderCalendar(state.currentMonth);
}

function applyMonthDensity(){
  document.body.classList.toggle('month-expanded', state.monthDensity === 'expanded');
  document.body.classList.toggle('month-compact',  state.monthDensity !== 'expanded');
}

// ===================== Estado =====================
const state = {
  db: null,
  theme: (localStorage.getItem('theme') || 'dark'),
  viewMode: 'month',
  currentMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDate: null,
  filters: new Set(['Trabajo','Tarea','Citas','Cumpleaños','Otros','Festivo']),
  holidaysCache: new Map(),
  monthDensity: localStorage.getItem('month.density') || 'compact', // ⬅️ aquí
};

const ALL_CATS = ['Trabajo','Tarea','Citas','Cumpleaños','Otros','Festivo'];
if (!(state.filters instanceof Set) || state.filters.size === 0) {
  state.filters = new Set(ALL_CATS);
}

// ===================== IndexedDB =====================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('calendarDB', 3);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      let events;
      if (!db.objectStoreNames.contains('events')) {
        events = db.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('by_date','date',{unique:false});
        events.createIndex('by_title','title',{unique:false});
        events.createIndex('by_client','client',{unique:false});
        events.createIndex('by_month','monthKey',{unique:false});
        events.createIndex('by_category','category',{unique:false});
      } else {
        const tx = e.target.transaction;
        events = tx.objectStore('events');
        if (!events.indexNames.contains('by_date'))     events.createIndex('by_date','date',{unique:false});
        if (!events.indexNames.contains('by_title'))    events.createIndex('by_title','title',{unique:false});
        if (!events.indexNames.contains('by_client'))   events.createIndex('by_client','client',{unique:false});
        if (!events.indexNames.contains('by_month'))    events.createIndex('by_month','monthKey',{unique:false});
        if (!events.indexNames.contains('by_category')) events.createIndex('by_category','category',{unique:false});
      }
      let atts;
      if (!db.objectStoreNames.contains('attachments')) {
        atts = db.createObjectStore('attachments', { keyPath:'id' });
        atts.createIndex('by_event','eventId',{unique:false});
      } else {
        const tx = e.target.transaction;
        atts = tx.objectStore('attachments');
        if (!atts.indexNames.contains('by_event')) atts.createIndex('by_event','eventId',{unique:false});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function tx(storeNames, mode, fn) {
  const db = state.db || (state.db = await openDB());
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = storeNames.map(n => t.objectStore(n));
    const res = fn(...stores);
    t.oncomplete = () => resolve(res);
    t.onerror    = () => reject(t.error);
  });
}

// ===================== Tema =====================
function toggleTheme() {
  state.theme = (state.theme === 'dark') ? 'light' : 'dark';
  applyTheme(state.theme);
}

// ===================== Drawer =====================
function openDrawer() {
  $('#drawer')?.classList.add('open');
  $('#drawer')?.setAttribute('aria-hidden','false');
  $('#drawerBackdrop')?.classList.add('open');
  $('#menuBtn')?.classList.add('active');
  $('#menuBtn')?.setAttribute('aria-expanded','true');
  backMgr.push('drawer', () => closeDrawer(/*silent*/true));
}
function closeDrawer(silent=false) {
  if (!silent) backMgr.consumeOne();
  $('#drawer')?.classList.remove('open');
  $('#drawer')?.setAttribute('aria-hidden','true');
  $('#drawerBackdrop')?.classList.remove('open');
  $('#menuBtn')?.classList.remove('active');
  $('#menuBtn')?.setAttribute('aria-expanded','false');
}


function toggleDrawer() {
  ($('#drawer')?.classList.contains('open')) ? closeDrawer() : openDrawer();
}

// ===================== Festivos (España - nacionales) =====================
function easterSunday(year){
  const a = year % 19;
  const b = Math.floor(year/100);
  const c = year % 100;
  const d = Math.floor(b/4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19*a + b - d - g + 15) % 30;
  const i = Math.floor(c/4);
  const k = c % 4;
  const l = (32 + 2*e + 2*i - h - k) % 7;
  const m = Math.floor((a + 11*h + 22*l) / 451);
  const month = Math.floor((h + l - 7*m + 114) / 31) - 1;
  const day = ((h + l - 7*m + 114) % 31) + 1;
  return new Date(year, month, day);
}
function goodFriday(year){
  const easter = easterSunday(year);
  const d = new Date(easter);
  d.setDate(easter.getDate() - 2);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function getNationalHolidaysMap(year){
  const cached = state.holidaysCache.get(year);
  if (cached) return cached;

  const list = [
    { m:0,  d:1,  name:'Año Nuevo' },
    { m:0,  d:6,  name:'Epifanía del Señor' },
    { m:4,  d:1,  name:'Día del Trabajador' },
    { m:7,  d:15, name:'Asunción de la Virgen' },
    { m:9,  d:12, name:'Fiesta Nacional de España' },
    { m:10, d:1,  name:'Todos los Santos' },
    { m:11, d:6,  name:'Día de la Constitución' },
    { m:11, d:8,  name:'Inmaculada Concepción' },
    { m:11, d:25, name:'Navidad del Señor' },
  ];
  const gf = goodFriday(year);
  list.push({ m: gf.getMonth(), d: gf.getDate(), name: 'Viernes Santo' });

  const map = new Map();
  for (const x of list){
    const ds = `${year}-${String(x.m+1).padStart(2,'0')}-${String(x.d).padStart(2,'0')}`;
    map.set(ds, x.name);
  }
  state.holidaysCache.set(year, map);
  return map;
}

// ===================== Render — Mes (pinta primero, hidrata después) =====================
function updateAppTitleForMonth() {
  const m = state.currentMonth;
  $('#appTitle') && ($('#appTitle').textContent = MONTHS[m.getMonth()]);
}

function renderCalendar(date = state.currentMonth) {
  const base = new Date(date.getFullYear(), date.getMonth(), 1);
  state.currentMonth = base;
  updateAppTitleForMonth();
  // refresca barra de meses y chip activo cada vez que cambiamos mes
try { renderMonthPickerBar(); markActiveMonthChip(); } catch {}
try { markActiveRoller(); } catch {}

  const year  = base.getFullYear();
  const month = base.getMonth();
  $('#monthTitle') && ($('#monthTitle').textContent = `${MONTHS[month]} ${year}`);

  const first = new Date(year, month, 1);
  const last  = new Date(year, month+1, 0);
  const startOffset = (first.getDay() + 6) % 7; // Lunes=0
  const totalDays   = last.getDate();
  const totalCells  = Math.ceil((startOffset + totalDays)/7)*7;

  const grid = $('#calendarGrid');
  if (!grid) return;

  const myToken = ++monthRenderToken;
  grid.innerHTML = '';

  const todayStr = ymd(new Date());
  const holidays = getNationalHolidaysMap(year);
  const tagRefs = new Map(); // YYYY-MM-DD -> contenedor de tags

  // 1) Pintar celdas inmediatamente (con festivos si procede)
  for (let i=0; i<totalCells; i++) {
    const dayNum = i - startOffset + 1;
    const d = new Date(year, month, dayNum);
    const out = (dayNum < 1 || dayNum > totalDays);
    const dStr = ymd(d);

    const cell = document.createElement('div');
    cell.className = 'day' + (out ? ' out' : '') + (dStr === todayStr ? ' today' : '');
    cell.tabIndex = 0;
    cell.setAttribute('role','button');
    cell.setAttribute('aria-label', `Día ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`);

    const head = document.createElement('div'); head.className = 'day-head';
    const num  = document.createElement('span'); num.className='num'; num.textContent = d.getDate();
    head.append(num);

    const tags = document.createElement('div');
    tags.className = 'events-tags';
    forceTagsBoxLayout(tags);
    tagRefs.set(dStr, tags);

    // Festivo visible al instante
    const festivoName = holidays.get(dStr);
    if (festivoName && state.filters.has('Festivo')) {
      const tagF = document.createElement('span');
      tagF.className = 'event-tag cat-Festivo';
      tagF.title = festivoName;
      tagF.textContent = `🎉 ${festivoName}`;
      tags.append(tagF);
    }

    cell.append(head, tags);

on(cell, 'click', () => handleDayCellClick(d));
on(cell, 'keydown', (ev) => {
  if (ev.key==='Enter' || ev.key===' ') {
    ev.preventDefault();
    handleDayCellClick(d);
  }
});

    grid.append(cell);
  }

 // 2) Hidratar eventos cuando IndexedDB responda (si este render sigue vigente)
loadMonthEvents(year, month).then((eventsByDayAll) => {
  if (myToken !== monthRenderToken) return;

  for (const [dateStr, list] of eventsByDayAll) {
    const box = tagRefs.get(dateStr);
    if (!box) continue;

    const dayEvts = list
      .filter(ev => state.filters.has(ev.category))
      .slice()
      .sort((a,b) => (a.time || '23:59').localeCompare(b.time || '23:59'));

    for (const evt of dayEvts) {
      const tag = document.createElement('span');
      tag.className = `event-tag cat-${evt.category}`;
      forceTagPillLayout(tag);

// (opcional) fuera: no uses data-abbr para evitar CSS heredado que lo mostraba en ::after
// tag.setAttribute('data-abbr', abbr);  // ← quítalo

// En móvil/tablet: mostrar los primeros N caracteres del título
// En modo expanded NO acortamos en móvil
const wantsShort = (state.monthDensity !== 'expanded') ? IS_COARSE_POINTER : false;
const maxCharsMobile = 12;
const core = wantsShort
  ? shortLabelFromTitle(evt.title, { mode: 'chars', maxChars: maxCharsMobile })
  : (evt.title || '');

const label = core;   // ← solo título

const spanTxt = document.createElement('span');
spanTxt.className = 'etxt';
spanTxt.textContent = label;
tag.appendChild(spanTxt);

// tooltip solo con el título
tag.title = evt.title || '';

// ¡clicable!
tag.setAttribute('role','button');
tag.tabIndex = 0;
tag.addEventListener('click', (ev)=>{ ev.stopPropagation(); openSheetForEdit(evt); });
tag.addEventListener('keydown', (ev)=>{ 
  if (ev.key==='Enter' || ev.key===' ') { ev.preventDefault(); openSheetForEdit(evt); }
});

box.append(tag);
    }
  }
});
}

async function handleDayCellClick(d){
  const ds = ymd(d);

  // 1) Eventos guardados para ese día (filtrados por categoría visible)
  let list = (await getEventsByDate(ds)).filter(ev => state.filters.has(ev.category));

  // 2) Si es festivo y el filtro lo permite, añadimos un stub para que se vea en el modal
  const holName = getNationalHolidaysMap(d.getFullYear()).get(ds);
  if (holName && state.filters.has('Festivo')) {
    list.unshift({
      id: `holiday:${ds}`,
      date: ds,
      time: '00:00',
      title: `🎉 ${holName}`,
      location: '',
      client: '',
      category: 'Festivo',
      categoryOther: '',
      monthKey: ds.slice(0,7),
      createdAt: 0,
      allDay: true,
      startDate: ds, startTime: '00:00',
      endDate: ds,   endTime: '23:59'
    });
  }

  // 3) Comportamiento:
  // - Si hay varios → lista/agenda
  // - Si hay uno y es festivo → también lista (no abrimos editor de un stub)
  // - Si hay uno normal → abrir editor
  // - Si no hay nada → ir a vista de día
  if (list.length >= 2) {
    showDayAgenda(d, list);
  } else if (list.length === 1) {
    (list[0].category === 'Festivo')
      ? showDayAgenda(d, list)
      : openSheetForEdit(list[0]);
  } else {
    state.selectedDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    setViewMode('day');
  }
}

async function loadMonthEvents(year, month) {
  const map = new Map();
  const key = `${year}-${pad2(month+1)}`;
  await tx(['events'], 'readonly', (store) => {
    const idx = store.index('by_month');
    const req = idx.openCursor(IDBKeyRange.only(key));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        const e = cur.value;
        if (!map.has(e.date)) map.set(e.date, []);
        map.get(e.date).push(e);
        cur.continue();
      }
    };
  });
  return map;
}

// ===================== Vistas de tiempo =====================
function setViewMode(mode) {
  state.viewMode = mode;
  document.body.classList.toggle('view-month', mode === 'month');
  $$('input[name="viewMode"]').forEach(r => { r.checked = (r.value === mode); });

  if (mode === 'month') {
    $('#timeView')?.classList.add('hidden');
    $('#monthView')?.classList.remove('hidden');
    renderCalendar(state.currentMonth);
    updateAppTitleForMonth();
    return;
  }

  $('#monthView')?.classList.add('hidden');
  $('#timeView')?.classList.remove('hidden');

  const anchor = state.selectedDate || new Date();
  state.selectedDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());

  renderTimeView(mode, state.selectedDate);
}

function startOfWeek(d) { const wd = (d.getDay() + 6) % 7; const nd = new Date(d); nd.setDate(d.getDate() - wd); return new Date(nd.getFullYear(), nd.getMonth(), nd.getDate()); }
function rangeDays(mode, anchor) {
  if (mode === 'day')   return [new Date(anchor)];
  if (mode === '3days') return [0,1,2].map(i => new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i));
  if (mode === 'week')  { const start = startOfWeek(anchor); return [...Array(7)].map((_,i)=> new Date(start.getFullYear(), start.getMonth(), start.getDate()+i)); }
  return [new Date(anchor)];
}
function formatRangeTitle(days) {
  if (days.length === 1) return new Intl.DateTimeFormat('es-ES', { dateStyle:'full' }).format(days[0]);
  const first = days[0], last = days[days.length-1];
  const sameMonth = (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear());
  if (sameMonth) return `${WEEKDAYS_MIN[(first.getDay()+6)%7]} ${first.getDate()} – ${WEEKDAYS_MIN[(last.getDay()+6)%7]} ${last.getDate()} · ${MONTHS[first.getMonth()]} ${first.getFullYear()}`;
  return `${first.getDate()} ${MONTHS[first.getMonth()]} ${first.getFullYear()} – ${last.getDate()} ${MONTHS[last.getMonth()]} ${last.getFullYear()}`;
}

function addHolidayStubsToMap(days, map){
  for (const d of days){
    const ds   = ymd(d);
    const name = getNationalHolidaysMap(d.getFullYear()).get(ds);
    if (!name) continue;
    const arr = map.get(ds) || [];
    // evita duplicar si ya lo añadimos
    if (!arr.some(e => e.id === `holiday:${ds}`)){
      arr.push({
        id: `holiday:${ds}`,
        date: ds,
        time: '00:00',              // se colocará arriba
        title: `🎉 ${name}`,
        location: '',
        client: '',
        category: 'Festivo',
        categoryOther: '',
        monthKey: ds.slice(0,7),
        createdAt: 0
      });
      map.set(ds, arr);
    }
  }
}

async function renderTimeView(mode, anchor) {
  const days = rangeDays(mode, anchor);
  $('#timeRangeTitle') && ($('#timeRangeTitle').textContent = formatRangeTitle(days));
  $('#appTitle') && ($('#appTitle').textContent = MONTHS[anchor.getMonth()]);

  const head = $('#timeDaysHeader'); if (!head) return;
  head.innerHTML = '';
  days.forEach(d => {
    const el = document.createElement('div');
    el.className = 'day-head-cell';
    const wd = WEEKDAYS_MIN[(d.getDay()+6)%7];
    el.textContent = `${wd} ${d.getDate()}`;
    head.append(el);
  });

  const allByDate = await getEventsByDates(days.map(ymd));
  addHolidayStubsToMap(days, allByDate);
  const hasAny = days.some(d => (allByDate.get(ymd(d))||[]).some(e => state.filters.has(e.category)));

  if (mode === 'day') $('#dayEmptyMsg')?.classList.toggle('hidden', hasAny);
  else $('#dayEmptyMsg')?.classList.add('hidden');

  const grid = $('#timeGrid'); if (!grid) return;
  grid.innerHTML = '';
  grid.classList.toggle('has-events', hasAny);

  const minHeight = (DAY_END_H - DAY_START_H) * PX_PER_HOUR;

  days.forEach(d => {
    const col = document.createElement('div');
    col.className = 'day-col';
    col.style.minHeight = `${minHeight}px`;
    grid.append(col);

    const evts = (allByDate.get(ymd(d)) || [])
      .filter(e => state.filters.has(e.category))
      .sort((a,b)=> a.time.localeCompare(b.time));

    const groupsByTime = new Map();
    evts.forEach((e) => {
      const k = e.time;
      if (!groupsByTime.has(k)) groupsByTime.set(k, []);
      groupsByTime.get(k).push(e);
    });

    evts.forEach(evt => {
      const [hh, mm] = evt.time.split(':').map(Number);
      let top = (hh - DAY_START_H) * PX_PER_HOUR + (mm * PX_PER_MIN);
      top = clamp(top, 0, minHeight - 36);

      const group = groupsByTime.get(evt.time) || [evt];
      const n = group.length;
      const idx = group.indexOf(evt);

      const tpl = $('#pillTpl');
      if (!tpl) return;
      const pill = tpl.content.firstElementChild.cloneNode(true);

      pill.style.top = `${top}px`;
pill.classList.add(`cat-${evt.category}`);

const title = (evt.category === 'Otros' && evt.categoryOther)
  ? `${evt.title} · ${evt.categoryOther}`
  : evt.title;
pill.querySelector('.pill-title').textContent = title;

// Hora mostrada: rango start–end; si es "todo el día" o festivo, sin hora y pegado arriba
let timeText = '';
if (evt.allDay || evt.category === 'Festivo') {
  pill.classList.add('all-day');
  pill.style.top = '0px';
  timeText = '';
} else {
  timeText = evt.endTime ? `${evt.time}–${evt.endTime}` : (evt.time || '');
}
pill.querySelector('.pill-time').textContent = timeText;

      pill.title = [
        evt.title,
        evt.location ? `· ${evt.location}` : '',
        evt.client ? `· ${evt.client}` : '',
        `· ${evt.category === 'Otros' && evt.categoryOther ? evt.categoryOther : evt.category}`
      ].join(' ').trim();

      if (n > 1) {
        const gutter = 4;
        pill.style.width = `calc((100% - 12px - ${(n - 1) * gutter}px) / ${n})`;
        pill.style.left = `calc(6px + ${idx} * ((100% - 12px - ${(n - 1) * gutter}px) / ${n} + ${gutter}px))`;
        pill.style.right = 'auto';
        pill.classList.add('clustered');
      } else {
        pill.style.left = '6px';
        pill.style.right = '6px';
      }

      on(pill, 'click', () => openSheetForEdit(evt));
      col.append(pill);
    });
  });

  // —— Línea de “ahora” y timer —— //
  paintNowLine();
  ensureNowLineTimer();
}

async function getEventsByDates(dateStrs) {
  const map = new Map(dateStrs.map(s => [s, []]));
  const months = [...new Set(dateStrs.map(s => s.slice(0,7)))];

  await tx(['events'], 'readonly', (store) => {
    const idx = store.index('by_month');
    let pending = months.length;

    months.forEach(m => {
      const req = idx.openCursor(IDBKeyRange.only(m));
      req.onsuccess = () => {
        const cur = req.result; if (!cur) {
          pending--; return;
        }
        const e = cur.value;
        if (map.has(e.date)) map.get(e.date).push(e);
        cur.continue();
      };
    });
  });

  return map;
}

// ===================== CRUD Eventos =====================
async function getEventsByDate(dateStr) {
  const res = [];
  await tx(['events'], 'readonly', (store) => {
    const idx = store.index('by_date');
    const req = idx.openCursor(IDBKeyRange.only(dateStr));
    req.onsuccess = () => { const cur = req.result; if (cur){ res.push(cur.value); cur.continue(); } };
  });
  return res;
}

async function getEventById(id){
  let out = null;
  await tx(['events'], 'readonly', (store) => {
    const req = store.get(id);
    req.onsuccess = () => { out = req.result || null; };
  });
  return out;
}

async function saveEvent(ev) {
  ev.preventDefault();

  const idInput = $('#eventId');
  const id = idInput?.value || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

  const title = $('#eventTitle')?.value?.trim();
  const location = $('#eventLocation')?.value?.trim() || '';
  const client = $('#eventClient')?.value?.trim() || '';
  const category = $('#eventCategory')?.value || 'Trabajo';
  const categoryOther = (category === 'Otros') ? ($('#eventCategoryOther')?.value?.trim() || '') : '';
  const files = $('#eventFiles')?.files;

  const allDay = !!$('#eventAllDay')?.checked;
  const sDate = $('#eventStartDate')?.value;
  let   sTime = $('#eventStartTime')?.value;
  let   eDate = $('#eventEndDate')?.value;
  let   eTime = $('#eventEndTime')?.value;

  const alertSel = $('#eventAlert')?.value || 'none';
  const repeatSel = $('#eventRepeat')?.value || 'none';
  const notes = $('#eventNotes')?.value?.trim() || '';
  const duplicateFromId = $('#duplicateFromId')?.value || '';

  if (!title || !sDate || (!allDay && !sTime)) return;

  if (allDay) {
    sTime = '00:00';
    eDate = eDate || sDate;
    eTime = '23:59';
  } else {
    eDate = eDate || sDate;
    if (!eTime) {
      const plus = addMinutes(sDate, sTime, 60); // +1h por defecto
      eDate = plus.date; eTime = plus.time;
    }
  }

  const isEdit = !!idInput?.value;
  let snapshot = null;
  if (isEdit) snapshot = await snapshotEventAndAttachments(id);

  const evt = {
    id,
    title, location,
    client,
    category, categoryOther,
    // compat con vistas existentes:
    date: sDate,
    time: sTime,
    monthKey: sDate.slice(0,7),
    createdAt: snapshot?.event?.createdAt || Date.now(),
    // nuevos campos:
    allDay,
    startDate: sDate, startTime: sTime,
    endDate: eDate,   endTime: eTime,
    alert: alertSel,
    repeat: repeatSel,
    notes,
    needsGCalSync: true
  };

  await tx(['events', 'attachments'], 'readwrite', (eventsStore, attStore) => {
    eventsStore.put(evt);
    if (files && files.length) {
      for (const f of files) {
        const aid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        attStore.put({ id: aid, eventId: id, name: f.name, type: f.type || 'application/octet-stream', blob: f });
      }
    }
  });

  closeSheet();
  reRender();

  // Si es una duplicación, copia los adjuntos del evento original al nuevo
// Si es una duplicación, copia los adjuntos del evento original al nuevo
if (duplicateFromId) {
  await tx(['attachments'], 'readwrite', (attStore) => {
    const idx = attStore.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(duplicateFromId));
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      const a = cur.value;
      const aid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
      attStore.put({
        id: aid,
        eventId: id,
        name: a.name,
        type: a.type || 'application/octet-stream',
        blob: a.blob
      });
      cur.continue();
    };
  });
}

  const createdMsg = duplicateFromId ? 'Evento duplicado' : 'Evento creado';
showToast(isEdit ? 'Evento actualizado' : createdMsg, {

    actionLabel: 'Deshacer',
    onUndo: async () => {
      if (isEdit && snapshot?.event) {
        await restoreEventAndAttachments(snapshot.event, snapshot.atts);
      } else {
        await deleteEvent(id, { silent: true });
      }
      reRender();
    }
  });
}

async function deleteEvent(id, { silent = false } = {}) {
  if (!id) return;

  // snapshot para poder deshacer la eliminación
  const snap = await snapshotEventAndAttachments(id);

  await tx(['events','attachments'], 'readwrite', (eventsStore, attStore) => {
    eventsStore.delete(id);
    const idx = attStore.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      attStore.delete(cur.primaryKey);
      cur.continue();
    };
  });

  // —— si el usuario lo activó, intenta borrar también en Google ——
try {
  const mirrorDelete = localStorage.getItem('gcal.deleteMirror') === '1';
  if (mirrorDelete && snap?.event) {
    await deleteRemoteEventIfLinked(snap.event, { calendarId:'primary' });
  }
} catch (e) {
  console.warn('Borrado remoto falló:', e);
}

  closeSheet();
  reRender();

  if (!silent) {
    showToast('Evento eliminado', {
      actionLabel: 'Deshacer',
      onUndo: async () => {
  await restoreEventAndAttachments(snap.event, snap.atts);
  // Si se había borrado también en Google, marcamos para volver a subir
  try {
    await tx(['events'], 'readwrite', (s) => {
      const restored = { ...snap.event, needsGCalSync: true };
      s.put(restored);
    });
  } catch {}
  reRender();
}
    });
  }
}

// Duplicar evento + adjuntos
async function duplicateEvent(originalId){
  // 1) Leer evento y adjuntos originales
  let orig = null;
  const atts = [];
  await tx(['events','attachments'], 'readonly', (eventsStore, attStore) => {
    const g = eventsStore.get(originalId);
    g.onsuccess = () => { if (g.result) orig = { ...g.result }; };

    const idx = attStore.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(originalId));
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      atts.push({ ...cur.value });
      cur.continue();
    };
  });

  if (!orig) throw new Error('Evento no encontrado');

  // 2) Preparar copia con nuevo id
  const newId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const copy  = { ...orig, id: newId, createdAt: Date.now() };
  delete copy.gcalUpdated; // metadato externo que no copiamos
  delete copy.gcalId;          // ← que no herede el evento remoto
  copy.needsGCalSync = true;   // ← que se suba como nuevo

  // monthKey según la fecha de inicio (o date)
  const baseDate = copy.startDate || copy.date;
  if (baseDate) copy.monthKey = baseDate.slice(0,7);

  // 3) Guardar copia y clonar adjuntos hacia el nuevo eventId
  await tx(['events','attachments'], 'readwrite', (eventsStore, attStore) => {
    eventsStore.put(copy);
    for (const a of atts) {
      const attId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      attStore.put({ id: attId, eventId: newId, name: a.name, type: a.type || 'application/octet-stream', blob: a.blob });
    }
  });

  return copy;
}

async function saveEventFromForm(ev, category){
  ev.preventDefault();
  const form     = ev.target;
  const idInput  = form.querySelector('[name="id"]');
  const dateStr  = form.querySelector('[name="date"]')?.value;
  const time     = form.querySelector('[name="time"]')?.value;
  const title    = form.querySelector('[name="title"]')?.value?.trim();
  const location = form.querySelector('[name="location"]')?.value?.trim() || '';
  const client   = form.querySelector('[name="client"]')?.value?.trim() || '';
  const filesEl  = form.querySelector('[name="files"]');

  if (!dateStr || !time || !title) return;

  const id  = (idInput?.value) || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
const plus = addMinutes(dateStr, time, 60); // +1h por defecto

const evt = {
  id,
  date: dateStr,
  time,
  title,
  location,
  client,
  category,
  categoryOther: '',
  monthKey: dateStr.slice(0,7),
  createdAt: Date.now(),
  // para sincronización con Google:
  allDay: false,
  startDate: dateStr,
  startTime: time,
  endDate: plus.date,
  endTime: plus.time,
  needsGCalSync: true
};

  await tx(['events','attachments'],'readwrite',(eventsStore, attStore) => {
    eventsStore.put(evt);
    if (filesEl && filesEl.files && filesEl.files.length){
      for (const f of filesEl.files){
        const aid = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
        attStore.put({ id: aid, eventId: id, name: f.name, type: f.type || 'application/octet-stream', blob: f });
      }
    }
  });

  if (category === 'Cumpleaños') closeSheetById('addBirthdaySheet');
  else if (category === 'Tarea') closeSheetById('addTaskSheet');

  reRender();
  showToast(`${category} creado`, {
    actionLabel: 'Deshacer',
    onUndo: async () => {
      await deleteEvent(id, { silent: true });
      reRender();
    }
  });
}

// ===================== Adjuntos =====================
let _previewURLs = new Map(); // eventId -> [blobUrls]

function ensurePreviewCleanupOnce() {
  if (ensurePreviewCleanupOnce._done) return; // evita registrarlo varias veces
  window.addEventListener('beforeunload', () => {
    try {
      for (const urls of _previewURLs.values()) {
        for (const u of urls) { try { URL.revokeObjectURL(u); } catch {} }
      }
    } finally {
      _previewURLs.clear();
    }
  });
  ensurePreviewCleanupOnce._done = true;
}

async function getAttachmentsByEvent(eventId) {
  const out = [];
  await tx(['attachments'],'readonly',(atts)=>{
    const idx = atts.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(eventId));
    req.onsuccess = () => { const cur = req.result; if (cur){ out.push(cur.value); cur.continue(); } };
  });
  return out;
}

async function renderAttachmentPreview(eventId) {
  injectAttachmentViewerStyles(); // por si no se ha llamado aún
  const wrap = $('#attachmentsPreview'); if (!wrap) return;

  // Revoca URLs anteriores de este evento
  (_previewURLs.get(eventId) || []).forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
  _previewURLs.set(eventId, []);

  wrap.innerHTML = '';
  if (!eventId) return;

  const atts = await getAttachmentsByEvent(eventId);
  for (const a of atts) {
    const card = document.createElement('div'); card.className='attachment-card';
    const url = URL.createObjectURL(a.blob);
    _previewURLs.get(eventId).push(url);

    // preview
    if (a.type && a.type.startsWith('image/')) {
      const img = document.createElement('img'); img.src = url; img.alt = a.name;
      card.append(img);
    } else if (a.type && a.type.startsWith('video/')) {
      const vid = document.createElement('video'); vid.src = url; vid.controls = true;
      card.append(vid);
    } else {
      const box = document.createElement('div');
      box.style.padding = '.6rem'; box.style.textAlign='center';
      box.textContent = '📄 ' + (a.name || 'archivo');
      card.append(box);
    }

    const name = document.createElement('div'); name.className='name'; name.textContent = a.name;
    card.append(name);

    // abrir visor a pantalla completa al pulsar en la tarjeta
    card.tabIndex = 0;
    card.addEventListener('click', () => openAttachmentViewer(a, url));
    card.addEventListener('keydown', (ev)=>{ if (ev.key==='Enter' || ev.key===' ') { ev.preventDefault(); openAttachmentViewer(a, url); } });

    // botón borrar (permanente)
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'att-del';
    delBtn.title = 'Eliminar adjunto';
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // no abrir visor
      handleAttachmentDelete(eventId, a);
    });
    card.append(delBtn);

    wrap.append(card);
  }
}

/* === Visor a pantalla completa + estilos mínimos === */
function injectAttachmentViewerStyles(){
  if (document.getElementById('att-viewer-css')) return;
  const css = `
  dialog#attViewer{border:0;padding:0;background:transparent}
  .attv-card{
    width:min(96vw,1100px); height:min(96vh,900px); display:flex; flex-direction:column;
    background:var(--panel,#0b1020); color:var(--text,#e6ecff);
    border:1px solid var(--border,rgba(255,255,255,.12)); border-radius:1rem;
    box-shadow:0 18px 40px rgba(0,0,0,.45); overflow:hidden;
  }
  .attv-head{display:flex;align-items:center;justify-content:space-between;padding:.6rem .8rem;border-bottom:1px solid var(--border,rgba(255,255,255,.12))}
  .attv-title{font-weight:700;opacity:.95;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .attv-close{background:transparent;border:0;color:inherit;cursor:pointer;font-size:1.1rem;opacity:.9}
  .attv-body{flex:1;display:flex;align-items:center;justify-content:center;background:#000}
  .attv-body img,.attv-body video,.attv-body iframe,.attv-body embed{max-width:100%;max-height:100%;width:auto;height:auto;display:block}
  /* Botón borrar en la tarjeta pequeña */
  .attachment-card{position:relative; cursor:pointer}
  .attachment-card .att-del{
    position:absolute; top:6px; right:6px; background:rgba(0,0,0,.55); color:#fff; border:0; border-radius:.5rem;
    padding:.25rem .45rem; cursor:pointer
  }
  `;
  const st = document.createElement('style');
  st.id = 'att-viewer-css';
  st.textContent = css;
  document.head.appendChild(st);
}

function ensureAttachmentViewerUI(){
  let dlg = document.getElementById('attViewer');
  if (dlg) return dlg;
  injectAttachmentViewerStyles();
  dlg = document.createElement('dialog');
  dlg.id = 'attViewer';
  dlg.innerHTML = `
    <form method="dialog" class="attv-card">
      <div class="attv-head">
        <div class="attv-title" id="attvTitle">Adjunto</div>
        <button class="attv-close" value="cancel" aria-label="Cerrar">✕</button>
      </div>
      <div class="attv-body"><div id="attvMedia"></div></div>
    </form>
  `;
  document.body.appendChild(dlg);
  return dlg;
}

function openAttachmentViewer(att, blobUrl){
  const dlg = ensureAttachmentViewerUI();
  const titleEl = dlg.querySelector('#attvTitle');
  const mediaBox = dlg.querySelector('#attvMedia');
  titleEl.textContent = att.name || 'Adjunto';
  mediaBox.innerHTML = '';

  const t = att.type || '';
  if (t.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = blobUrl; img.alt = att.name || '';
    mediaBox.appendChild(img);
  } else if (t.startsWith('video/')) {
    const vid = document.createElement('video');
    vid.src = blobUrl; vid.controls = true; vid.autoplay = true;
    mediaBox.appendChild(vid);
  } else if (t === 'application/pdf') {
    const frame = document.createElement('iframe');
    frame.src = blobUrl; frame.style.width='100%'; frame.style.height='100%';
    mediaBox.appendChild(frame);
  } else {
    const box = document.createElement('div');
    box.style.padding = '1rem'; box.style.textAlign = 'center';
    const p = document.createElement('p'); p.textContent = 'Tipo de archivo no previsualizable.';
    const a = document.createElement('a'); a.href = blobUrl; a.download = att.name || 'archivo'; a.textContent = 'Descargar';
    a.style.display='inline-block'; a.style.marginTop='.6rem';
    box.append(p,a); mediaBox.appendChild(box);
  }

  // abrir como modal + back hardware
  dlg.showModal();
  backMgr.push('attViewer', () => { try{ dlg.close(); }catch{} });
  dlg.addEventListener('close', function onCloseOnce(){
    dlg.removeEventListener('close', onCloseOnce);
    backMgr.consumeOne();
  }, { once:true });
}

function closeAttachmentViewer(){
  const dlg = document.getElementById('attViewer');
  if (!dlg) return;
  try { dlg.close(); } catch {}
}

function killMobileDots() {
  if (document.getElementById('kill-mobile-dots')) return;
  const st = document.createElement('style');
  st.id = 'kill-mobile-dots';
  st.textContent = `
  /* Mostrar SIEMPRE las etiquetas en móvil/tablet */
  @media (pointer: coarse), (max-width: 1024px) {
    .day .events-tags {
      display: flex !important;
      flex-wrap: wrap !important;
      gap: 4px !important;
      list-style: none !important;
      background-image: none !important;
      padding-left: 0 !important;
    }
    .day .events-tags .event-tag {
      display: inline-flex !important;
      align-items: center !important;
      max-width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      white-space: nowrap !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      border-radius: 999px !important;
      padding: 2px 8px !important;
    }
    .day .events-tags .event-tag::before,
    .day .events-tags .event-tag::after {
      content: none !important;
      display: none !important;
      width: 0 !important; height: 0 !important;
    }
    .day .events-tags .event-tag .etxt {
      display: inline !important;
      min-width: 0 !important;
      max-width: 100% !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
  }`;
  document.head.appendChild(st);
}

function injectTagsHardFixV3(){
  if (document.getElementById('tags-hardfix-v3')) return;
  const st = document.createElement('style');
  st.id = 'tags-hardfix-v3';
  st.textContent = `
  /* 1) Contenedor: multiplica en varias líneas y NUNCA absoluto */
  body.tags-v2 .day .events-tags{
    position: static !important;
    display: flex !important;
    flex-wrap: wrap !important;
    gap: 4px !important;
    align-content: flex-start !important;
    justify-content: flex-start !important;
    overflow: visible !important;
    background-image: none !important;
    list-style: none !important;
    padding-left: 0 !important;
    max-height: none !important;
    white-space: normal !important;
  }

  /* 2) Píldoras: visibles, con texto y sin pseudo-elementos “barra” */
  body.tags-v2 .events-tags .event-tag{
    display: inline-flex !important;
    align-items: center !important;
    height: auto !important;
    max-width: 100% !important; min-width: 0 !important;
    padding: 2px 8px !important; border-radius: 999px !important;
    font-size: 12px !important; line-height: 16px !important; font-weight: 700 !important;
    white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
  }
  body.tags-v2 .events-tags .event-tag::before,
  body.tags-v2 .events-tags .event-tag::after{
    content: none !important; display: none !important;
    width: 0 !important; height: 0 !important; border: 0 !important;
  }
  body.tags-v2 .events-tags .event-tag .etxt{
    display: inline !important; min-width: 0 !important; max-width: 100% !important;
  }

  /* 3) Colores (si algo los “aplana”, los volvemos a fijar) */
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#1a73e8; --tag-border:#1669c1; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Tarea      { --tag-bg:#16a34a; --tag-border:#12833c; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Citas      { --tag-bg:#f59e0b; --tag-border:#d97706; --tag-fg:#0b0f02; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Cumpleaños { --tag-bg:#9333ea; --tag-border:#7e22ce; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Otros      { --tag-bg:#64748b; --tag-border:#475569; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Festivo    { --tag-bg:#0ea5e9; --tag-border:#0284c7; --tag-fg:#04141c; }
  `;
  document.head.appendChild(st);
}

function nukeOldAbbrStyles(){
  if (document.getElementById('tags-abbr-nuker')) return;
  const st = document.createElement('style');
  st.id = 'tags-abbr-nuker';
  st.textContent = `
  /* Quita los pseudo-elementos que dibujan una sola inicial */
  .events-tags .event-tag::before,
  .events-tags .event-tag::after {
    content: none !important;
    display: none !important;
    width: 0 !important; height: 0 !important; border: 0 !important;
  }

  /* Asegura “píldora” con texto recortable, no círculo */
  .events-tags .event-tag,
  .event-tag {
    display: inline-flex !important;
    align-items: center !important;
    width: auto !important; height: auto !important;
    max-width: 100% !important; min-width: 0 !important;
    padding: 2px 8px !important;
    border-radius: 999px !important;
    white-space: nowrap !important;
    overflow: hidden !important;
    text-overflow: ellipsis !important;
    aspect-ratio: auto !important;
  }

  /* El texto real que metes en <span class="etxt"> manda */
  .events-tags .event-tag .etxt {
    display: inline !important;
    min-width: 0 !important; max-width: 100% !important;
    overflow: hidden !important; text-overflow: ellipsis !important;
  }

  /* Móvil: por si acaso */
  @media (pointer: coarse) {
    .day .events-tags { display:flex !important; flex-wrap:wrap !important; gap:4px !important; }
  }
  `;
  document.head.appendChild(st);
}
nukeOldAbbrStyles();

// --- Patches a prueba de "circulitos" antiguos ---
function forceTagsBoxLayout(box){
  const set = (p,v)=> box.style.setProperty(p, v, 'important');
  set('display','flex');
  set('flex-wrap','wrap');
  set('gap','4px');
  set('list-style','none');
  set('background-image','none');
  set('padding-left','0');
  set('position','static');
  set('overflow','visible');
  set('max-height','none');
}

function forceTagPillLayout(tag){
  const set = (p,v)=> tag.style.setProperty(p, v, 'important');
  set('display','inline-flex');
  set('align-items','center');
  set('width','auto');
  set('height','auto');
  set('max-width','100%');
  set('min-width','0');
  set('padding','2px 8px');
  set('border-radius','999px');
  set('white-space','nowrap');
  set('overflow','hidden');
  set('text-overflow','ellipsis');
  set('aspect-ratio','auto');
  // neutraliza trucos típicos de “solo inicial”
  set('font-size','12px');           // evita font-size:0 heredado
  set('letter-spacing','normal');
  set('text-indent','0');
  set('list-style','none');
  set('counter-reset','none');
  set('counter-increment','none');
}

function forceTagText(el){
  const set = (p,v)=> el.style.setProperty(p, v, 'important');
  set('display','inline');
  set('min-width','0');
  set('max-width','100%');
  set('white-space','nowrap');
  set('overflow','hidden');
  set('text-overflow','ellipsis');
  set('font-size','inherit');        // por si el padre tenía font-size:0
}

/* === Borrado definitivo de adjuntos (opcional: espejo en Drive) === */
async function deleteDriveFileIfAllowed(att){
  try{
    const delMirror = localStorage.getItem('gdrive.deleteMirror') === '1';
    if (!delMirror || !att.gdriveId) return;
    await ensureGoogleToken();
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(att.gdriveId)}`;
    const res = await gapiFetch(url, { method:'DELETE' });
    if (res.status !== 204 && !res.ok) console.warn('No se pudo borrar en Drive');
  }catch(e){ console.warn('Drive delete failed:', e); }
}

async function handleAttachmentDelete(eventId, att){
  const ok = await confirmNative({
    title: 'Eliminar adjunto',
    message: `¿Eliminar “${att.name}”? Esta acción es permanente.`,
    confirmText: 'Eliminar',
    cancelText: 'Cancelar',
    destructive: true
  });
  if (!ok) return;

  // (Opcional) borrar también de tu Drive si lo activas con localStorage.setItem('gdrive.deleteMirror','1')
  try { await deleteDriveFileIfAllowed(att); } catch {}

  // 1) borra en IndexedDB
  await tx(['attachments'], 'readwrite', (s)=> s.delete(att.id));

  // 2) cierra visor si estaba abierto
  try { closeAttachmentViewer(); } catch {}

  // 3) refresca la lista (esto también revoca las blob URLs antiguas)
  await renderAttachmentPreview(eventId);

  // 4) aviso simple (sin deshacer)
  showToast('Adjunto eliminado', { actionLabel: null, onUndo: null, duration: 3000 });
}

// ——— Garantiza que existe la UI de categoría en el sheet de evento ———
function ensureCategoryUI(){
  const sheet = document.getElementById('addEventSheet');
  if (!sheet) return;

  // mete el bloque DENTRO del form si existe; si no, dentro del sheet
  const form = sheet.querySelector('form') || sheet;

  // si ya existe, no lo duplicamos
  if (form.querySelector('#eventCategory')) return;

  const html = `
  <div class="row" id="categoryRow">
    <label for="eventCategory">Categoría</label>
    <select id="eventCategory" name="category">
      <option value="Trabajo">Trabajo</option>
      <option value="Tarea">Tarea</option>
      <option value="Citas">Citas</option>
      <option value="Cumpleaños">Cumpleaños</option>
      <option value="Otros">Otros</option>
      <option value="Festivo">Festivo</option>
    </select>
  </div>
  <div class="row hidden" id="categoryOtherWrap">
    <label for="eventCategoryOther">Otra categoría</label>
    <input id="eventCategoryOther" name="categoryOther" type="text" placeholder="Especifica la categoría">
  </div>
`;
const afterEl =
  form.querySelector('#eventNotes')?.closest('.row') ||
  form.querySelector('#eventLocation')?.closest('.row');

  if (afterEl) afterEl.insertAdjacentHTML('afterend', html);
  else form.insertAdjacentHTML('beforeend', html);

  // listener local para mostrar el campo “Otros”
  const sel = form.querySelector('#eventCategory');
  const otherWrap = form.querySelector('#categoryOtherWrap');
  sel.addEventListener('change', (e) => {
    const show = e.target.value === 'Otros';
    otherWrap?.classList.toggle('hidden', !show);
  });
}

// ===================== Sheets (Añadir/Editar) =====================
// — cierre al pulsar fuera —
const _sheetOutsideHandlers = new Map();
function attachOutsideCloseForSheet(sheetEl, closerFn){
  if (!sheetEl) return;
  const id = sheetEl.id || Math.random().toString(36).slice(2);
  if (_sheetOutsideHandlers.has(id)) return;
  const handler = (ev) => {
    if (!sheetEl.classList.contains('hidden') && !sheetEl.contains(ev.target)) {
      closerFn();
    }
  };
  document.addEventListener('mousedown', handler, { capture:true });
  document.addEventListener('touchstart', handler, { passive:true, capture:true });
  _sheetOutsideHandlers.set(id, handler);
}
function detachOutsideCloseForSheet(sheetEl){
  if (!sheetEl) return;
  const id = sheetEl.id;
  const handler = _sheetOutsideHandlers.get(id);
  if (!handler) return;
  document.removeEventListener('mousedown', handler, true);
  document.removeEventListener('touchstart', handler, true);
  _sheetOutsideHandlers.delete(id);
}

function autosizeNotes(){
  const ta = document.getElementById('eventNotes');
  if (!ta) return;
  ta.style.height = 'auto';                 // reset
  ta.style.height = ta.scrollHeight + 'px'; // ajusta a contenido
}
on('#eventNotes', 'input', autosizeNotes);

function openSheetNew() {
  const baseDate = state.selectedDate || new Date();
  const base = ymd(baseDate);
  const startTime = '10:00';
  const plus = addMinutes(base, startTime, 60);

  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Añadir evento');
  $('#deleteEventBtn')?.classList.add('hidden');

  $('#duplicateFromId') && ($('#duplicateFromId').value = ''); // limpiar
  $('#duplicateEventBtn')?.classList.add('hidden');

  const idEl = $('#eventId');      if (idEl) idEl.value = '';
  const ttlEl = $('#eventTitle');  if (ttlEl) ttlEl.value = '';

  // Todo el día OFF por defecto
  const allDayEl = $('#eventAllDay'); if (allDayEl) allDayEl.checked = false;
  setAllDayUI(false);

  $('#eventStartDate')?.setAttribute('value', base);
  $('#eventStartDate').value = base;
  $('#eventStartTime')?.setAttribute('value', startTime);
  $('#eventStartTime').value = startTime;

  $('#eventEndDate')?.setAttribute('value', plus.date);
  $('#eventEndDate').value = plus.date;
  $('#eventEndTime')?.setAttribute('value', plus.time);
  $('#eventEndTime').value = plus.time;

  $('#eventLocation')?.setAttribute('value', '');
  $('#eventLocation').value = '';

  $('#eventAlert') && ($('#eventAlert').value = 'none');
  $('#eventRepeat') && ($('#eventRepeat').value = 'none');
  $('#eventNotes') && ($('#eventNotes').value = '');

  $('#eventCategory') && ($('#eventCategory').value = 'Trabajo');
  $('#categoryOtherWrap')?.classList.add('hidden');
  $('#eventCategoryOther') && ($('#eventCategoryOther').value = '');

  $('#eventFiles') && ($('#eventFiles').value = '');
  $('#attachmentsPreview') && ($('#attachmentsPreview').innerHTML = '');
  openSheet();

  $('#eventNotes') && ($('#eventNotes').value = '');
  autosizeNotes();
}

async function openSheetForEdit(evt) {
  state.selectedDate = parseDateInput(evt.date);

  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Editar evento');
  $('#deleteEventBtn')?.classList.remove('hidden');

  $('#duplicateFromId') && ($('#duplicateFromId').value = ''); // limpiar
  $('#duplicateEventBtn')?.classList.remove('hidden');

  $('#eventId') && ($('#eventId').value = evt.id);
  $('#eventTitle') && ($('#eventTitle').value = evt.title || '');

  const allDay = !!evt.allDay;
  const sDate = evt.startDate || evt.date;
  const sTime = allDay ? '00:00' : (evt.startTime || evt.time || '10:00');
  const eDate = evt.endDate || sDate;
  const eTime = allDay ? '23:59' : (evt.endTime || '');

  const allDayEl = $('#eventAllDay'); if (allDayEl) allDayEl.checked = allDay;
  setAllDayUI(allDay);

  $('#eventStartDate') && ($('#eventStartDate').value = sDate);
  $('#eventStartTime') && ($('#eventStartTime').value = sTime);
  $('#eventEndDate')   && ($('#eventEndDate').value   = eDate);
  $('#eventEndTime')   && ($('#eventEndTime').value   = eTime);

  $('#eventLocation') && ($('#eventLocation').value = evt.location || '');

  $('#eventAlert') && ($('#eventAlert').value = evt.alert || 'none');
  $('#eventRepeat') && ($('#eventRepeat').value = evt.repeat || 'none');
  $('#eventNotes') && ($('#eventNotes').value = evt.notes || '');

  $('#eventCategory') && ($('#eventCategory').value = evt.category || 'Trabajo');
  if (evt.category === 'Otros') {
    $('#categoryOtherWrap')?.classList.remove('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = evt.categoryOther || '');
  } else {
    $('#categoryOtherWrap')?.classList.add('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = '');
  }

  $('#eventFiles') && ($('#eventFiles').value = '');
  await renderAttachmentPreview(evt.id);
  openSheet();

  $('#eventNotes') && ($('#eventNotes').value = evt.notes || '');
autosizeNotes();
}

async function startDuplicateFlow(originalId){
  const evt = await getEventById(originalId);
  if (!evt) { alert('No se encontró el evento a duplicar'); return; }

  // Título y botones
  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Duplicar evento');
  $('#deleteEventBtn')?.classList.add('hidden');     // no borrar en modo nuevo
  $('#duplicateEventBtn')?.classList.add('hidden');  // no mostrar duplicar dentro de un nuevo

  // Limpiar IDs para que sea un NUEVO evento
  $('#eventId') && ($('#eventId').value = '');
  $('#duplicateFromId') && ($('#duplicateFromId').value = originalId);

  // All-day y fechas/horas
  const allDay = !!evt.allDay;
  const sDate  = evt.startDate || evt.date;
  const sTime  = allDay ? '00:00' : (evt.startTime || evt.time || '10:00');
  const eDate  = evt.endDate || sDate;
  const eTime  = allDay ? '23:59' : (evt.endTime || '');

  const allDayEl = $('#eventAllDay'); if (allDayEl) allDayEl.checked = allDay;
  setAllDayUI(allDay);

  // Rellenar campos
  $('#eventTitle') && ($('#eventTitle').value = evt.title || '');
  $('#eventStartDate') && ($('#eventStartDate').value = sDate || '');
  $('#eventStartTime') && ($('#eventStartTime').value = sTime || '');
  $('#eventEndDate')   && ($('#eventEndDate').value   = eDate || '');
  $('#eventEndTime')   && ($('#eventEndTime').value   = eTime || '');
  $('#eventLocation')  && ($('#eventLocation').value  = evt.location || '');
  $('#eventAlert')     && ($('#eventAlert').value     = evt.alert || 'none');
  $('#eventRepeat')    && ($('#eventRepeat').value    = evt.repeat || 'none');
  $('#eventNotes')     && ($('#eventNotes').value     = evt.notes || '');

  $('#eventCategory')  && ($('#eventCategory').value  = evt.category || 'Trabajo');
  if (evt.category === 'Otros') {
    $('#categoryOtherWrap')?.classList.remove('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = evt.categoryOther || '');
  } else {
    $('#categoryOtherWrap')?.classList.add('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = '');
  }

  // No cargamos vista previa de adjuntos aquí: se copiarán al Guardar
  $('#eventFiles') && ($('#eventFiles').value = '');
  $('#attachmentsPreview') && ($('#attachmentsPreview').innerHTML = '');

  openSheet();
  showToast('Edita la fecha/hora y pulsa Guardar para crear la copia');
}

function openSheet() {
  const sheet = $('#addEventSheet'); if (!sheet) return;

  ensureCategoryUI();
  
  sheet.classList.remove('hidden');
  requestAnimationFrame(()=> sheet.classList.add('open'));
  attachOutsideCloseForSheet(sheet, () => closeSheet()); // tap fuera = cerrar
  // <- tecla atrás cierra esta hoja
  backMgr.push('sheet', () => { sheet.classList.remove('open'); setTimeout(()=> sheet.classList.add('hidden'), 250); detachOutsideCloseForSheet(sheet); });
}

function closeSheet() {
  const sheet = $('#addEventSheet'); if (!sheet) return;
  // consume la entrada del historial porque estamos cerrando “a mano”
  backMgr.consumeOne();
  sheet.classList.remove('open');
  setTimeout(()=> sheet.classList.add('hidden'), 250);
  detachOutsideCloseForSheet(sheet);
}


// Helpers para otros sheets
function openSheetById(id){
  const sheet = document.getElementById(id); if (!sheet) return;
  sheet.classList.remove('hidden');
  requestAnimationFrame(()=> sheet.classList.add('open'));
  attachOutsideCloseForSheet(sheet, ()=> closeSheetById(id));
  backMgr.push('sheet:'+id, () => { sheet.classList.remove('open'); setTimeout(()=> sheet.classList.add('hidden'), 250); detachOutsideCloseForSheet(sheet); });
}
function closeSheetById(id){
  const sheet = document.getElementById(id); if (!sheet) return;
  backMgr.consumeOne();
  sheet.classList.remove('open');
  setTimeout(()=> sheet.classList.add('hidden'), 250);
  detachOutsideCloseForSheet(sheet);
}


// ===================== Búsqueda (AVANZADA) =====================
function parseAdvancedQuery(raw) {
  const q = (raw || '').trim();
  const out = {
    terms: [],
    title: null,
    client: null,
    location: null,
    category: null,
    on: null,
    before: null,
    after: null,
    from: null,
    to: null,
    hasFiles: false,
  };
  if (!q) return out;

  const tokens = [];
  let i = 0;
  while (i < q.length) {
    if (q[i] === '"') {
      let j = i + 1, buf = '';
      while (j < q.length && q[j] !== '"') { buf += q[j++]; }
      tokens.push(buf);
      i = (j < q.length) ? j + 1 : j;
    } else if (/\s/.test(q[i])) {
      i++;
    } else {
      let j = i, buf = '';
      while (j < q.length && !/\s/.test(q[j])) { buf += q[j++]; }
      tokens.push(buf);
      i = j;
    }
  }

  const reKV = /^(title|client|location|category|on|before|after|from|to|has):(.+)$/i;
  tokens.forEach(tok => {
    const m = reKV.exec(tok);
    if (!m) { out.terms.push(tok.toLowerCase()); return; }
    const key = m[1].toLowerCase();
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
    switch (key) {
      case 'title': out.title = val.toLowerCase(); break;
      case 'client': out.client = val.toLowerCase(); break;
      case 'location': out.location = val.toLowerCase(); break;
      case 'category': out.category = val.toLowerCase(); break;
      case 'on': out.on = val; break;
      case 'before': out.before = val; break;
      case 'after': out.after = val; break;
      case 'from': out.from = val; break;
      case 'to': out.to = val; break;
      case 'has': out.hasFiles = (val.toLowerCase() === 'files' || val.toLowerCase() === 'file' || val.toLowerCase() === 'adjuntos'); break;
    }
  });

  return out;
}
function dateLTE(a, b) { return a <= b; }
function dateGTE(a, b) { return a >= b; }

async function loadEventIdsWithFiles() {
  const withFiles = new Set();
  await tx(['attachments'], 'readonly', (atts) => {
    const req = atts.openCursor();
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      const a = cur.value;
      if (a?.eventId) withFiles.add(a.eventId);
      cur.continue();
    };
  });
  return withFiles;
}

async function searchEventsAdvanced(queryRaw) {
  const q = parseAdvancedQuery(queryRaw);
  const needFiles = q.hasFiles;
  const fileSet = needFiles ? await loadEventIdsWithFiles() : null;

  const results = [];
  await tx(['events'], 'readonly', (store) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      const e = cur.value;

      const catText = (e.category === 'Otros' && e.categoryOther) ? e.categoryOther : e.category;

      if (q.title && !String(e.title||'').toLowerCase().includes(q.title)) { return cur.continue(); }
      if (q.client && !String(e.client||'').toLowerCase().includes(q.client)) { return cur.continue(); }
      if (q.location && !String(e.location||'').toLowerCase().includes(q.location)) { return cur.continue(); }
      if (q.category && String(e.category||'').toLowerCase() !== q.category) { return cur.continue(); }

      if (q.on && e.date !== q.on) { return cur.continue(); }
      if (q.before && !dateLTE(e.date, q.before)) { return cur.continue(); }
      if (q.after && !dateGTE(e.date, q.after)) { return cur.continue(); }
      if (q.from && q.to && !(dateGTE(e.date, q.from) && dateLTE(e.date, q.to))) { return cur.continue(); }

      if (needFiles && !fileSet.has(e.id)) { return cur.continue(); }

      if (q.terms.length) {
        const hay = `${e.title||''} ${e.client||''} ${e.location||''} ${catText||''}`.toLowerCase();
        const all = q.terms.every(t => hay.includes(t));
        if (!all) { return cur.continue(); }
      }

      results.push(e);
      cur.continue();
    };
  });

  results.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time));
  return results.slice(0, 200);
}

// ——— Resaltado seguro del primer término ———
function highlightFragment(text, term){
  const frag = document.createDocumentFragment();
  if (!term) { frag.append(document.createTextNode(text)); return frag; }
  const tLC = term.toLowerCase();
  let i = 0;
  while (i < text.length){
    const idx = text.toLowerCase().indexOf(tLC, i);
    if (idx === -1){
      frag.append(document.createTextNode(text.slice(i)));
      break;
    }
    if (idx > i) frag.append(document.createTextNode(text.slice(i, idx)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(idx, idx + term.length);
    frag.append(mark);
    i = idx + term.length;
  }
  return frag;
}

function shortLabelFromTitle(title, { mode='initials', maxLetters=4, maxChars=12 } = {}){
  const t = (title || '').trim();
  if (!t) return '';
  if (mode === 'initials'){
    // iniciales de cada palabra, ignorando huecos
    return t.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, maxLetters).toUpperCase();
  }
  // alternativa: primeros N caracteres
  return (t.length > maxChars) ? (t.slice(0, maxChars - 1) + '…') : t;
}

function showSearchResultsSafe(items, highlightTerms = []){
  const box = $('#searchResults'); if (!box) return;
  box.innerHTML = '';
  if (!items.length){ box.classList.remove('open'); return; }

  const firstTerm = (highlightTerms && highlightTerms.length) ? highlightTerms[0] : '';

  items.forEach(e => {
    const dateLabel = new Intl.DateTimeFormat('es-ES',{dateStyle:'medium'}).format(parseDateInput(e.date));
    const catLabel = (e.category === 'Otros' && e.categoryOther) ? e.categoryOther : e.category;

    const div = document.createElement('div');
    div.className = 'result';

    const strong = document.createElement('strong');
    const titleText = e.title || '(Sin título)';
    strong.append( highlightFragment(titleText, firstTerm) );

    const meta = document.createElement('div');
    meta.className = 'muted';
    const metaTextParts = [ `${dateLabel} · ${e.time || '--:--'}` ];
    if (e.client) metaTextParts.push(`· ${e.client}`);
    if (e.location) metaTextParts.push(`· ${e.location}`);
    if (catLabel) metaTextParts.push(`· ${catLabel}`);
    const metaText = metaTextParts.join(' ');
    meta.append( highlightFragment(metaText, firstTerm) );

    div.appendChild(strong);
    div.appendChild(meta);

    on(div, 'click', () => {
      box.classList.remove('open');
      const si = $('#searchInput'); if (si) si.value = '';
      state.selectedDate = parseDateInput(e.date);
      setViewMode('day');
      openSheetForEdit(e);
    });

    box.appendChild(div);
  });

  box.classList.add('open');
}

// Listeners de búsqueda avanzada
// —— Listeners de búsqueda a pantalla completa —— //
let searchTimer = null;

on('#searchInput','focus', () => {
  // abre overlay si ya hay texto
  const v = $('#searchInput')?.value?.trim();
  if (v) openSearchFull();
});

on('#searchInput','input', (e)=>{
  const raw = e.target.value;
  clearTimeout(searchTimer);

  if (!raw){
    closeSearchFull();
    $('#searchResults')?.classList.remove('open'); // ocultar dropdown antiguo
    return;
  }

  // abrimos overlay
  openSearchFull();

  searchTimer = setTimeout(async ()=>{
    const items  = await searchEventsAdvanced(raw);
    const parsed = parseAdvancedQuery(raw);
    showSearchFull(items, parsed.terms || []);
  }, 140);
});

on('#clearSearch','click', ()=>{
  const si = $('#searchInput'); if (!si) return;
  si.value = '';
  closeSearchFull();
  $('#searchResults')?.classList.remove('open'); // por si acaso
  si.focus();
});

// Escape para cerrar
document.addEventListener('keydown', (ev)=>{
  if (ev.key === 'Escape' && document.body.classList.contains('search-full-open')) {
    closeSearchFull();
  }
});

// ===================== Transición de mes =====================
// Inyecta estilos mínimos para la animación de mes + now-line + mark
function injectEnhancementStyles(){
  if (document.getElementById('cal-enhance-styles')) return;
  const css = `
  .calendar-grid{ will-change: transform,opacity }
  .month-out-left{ animation: calMonthOutLeft .22s ease both }
  .month-in-right{ animation: calMonthInRight .22s ease both }
  .month-out-right{ animation: calMonthOutRight .22s ease both }
  .month-in-left{ animation: calMonthInLeft .22s ease both }
  @keyframes calMonthOutLeft{ to{ transform:translateX(-12px); opacity:0 } }
  @keyframes calMonthInRight{ from{ transform:translateX(12px); opacity:0 } to{ transform:none; opacity:1 } }
  @keyframes calMonthOutRight{ to{ transform:translateX(12px); opacity:0 } }
  @keyframes calMonthInLeft{ from{ transform:translateX(-12px); opacity:0 } to{ transform:none; opacity:1 } }

  /* Now line */
  .now-line{ position:absolute; left:0; right:0; height:2px; background:#ef4444; box-shadow:0 0 0 2px rgba(239,68,68,.15) }
  .now-dot{ position:absolute; width:10px; height:10px; border-radius:999px; background:#ef4444; left:2px; top:-4px; animation: nowPing 1.6s ease-out infinite }
  @keyframes nowPing{ 0%{ box-shadow:0 0 0 0 rgba(239,68,68,.6) } 100%{ box-shadow:0 0 0 14px rgba(239,68,68,0) } }

  /* Highlight en resultados */
  .search-results mark{ background: rgba(14,165,233,.22); color: inherit; padding:0 .08em; border-radius:.2em }

  #calendarGrid, #timeGrid, #timeDaysHeader, #monthView, #timeView, .day-col { touch-action: pan-y; }
  /* En la vista de mes, no dejamos que el navegador “se lleve” el gesto vertical.
     Así nuestro JS puede decidir expandir/compactar sin que el grid haga scroll. */
  body.view-month #calendarGrid { touch-action: pan-x; }
`;
  
  const st = document.createElement('style');
  st.id = 'cal-enhance-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

// ===== Toasts con undo =====
function injectToastStyles(){
  if (document.getElementById('toast-styles')) return;
  const css = `
  .toast-host{position:fixed;z-index:9999;display:flex;flex-direction:column;gap:.5rem;pointer-events:none}
  .toast-host.br{right:12px;bottom:12px;align-items:flex-end}
  .toast-host.bl{left:12px;bottom:12px;align-items:flex-start}
  .toast{
    pointer-events:auto;background:var(--panel,#12182c);color:var(--text,#e6ecff);
    border:1px solid var(--border,rgba(255,255,255,.12));box-shadow:0 6px 20px rgba(0,0,0,.3);
    border-radius:.75rem;padding:.6rem .75rem;display:flex;gap:.75rem;align-items:center;
    max-width:min(480px,92vw);transform:translateY(8px);opacity:0;transition:transform .2s ease,opacity .2s ease
  }
  .toast.show{transform:translateY(0);opacity:1}
  .toast.leaving{transform:translateY(8px);opacity:0}
  .toast .msg{flex:1}
  .toast .btn-undo{
    background:transparent;border:0;font-weight:700;text-decoration:underline;cursor:pointer;
    color:var(--primary,#0ea5e9);padding:.2rem .3rem;border-radius:.4rem
  }
  .toast .btn-undo:focus{outline:2px solid var(--primary,#0ea5e9);outline-offset:2px}
  .toast .btn-close{background:transparent;border:0;cursor:pointer;color:inherit;opacity:.8;padding:.2rem;border-radius:.4rem}
  `;
  const st = document.createElement('style');
  st.id = 'toast-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectSearchFullStyles(){
  if (document.getElementById('sf-styles')) return;
  const css = `
  .sf-overlay{position:fixed;inset:0;z-index:10000;display:none;align-items:flex-start;justify-content:center;
              background:rgba(0,0,0,.55);padding:12px}
  .sf-overlay.open{display:flex}
  .sf-panel{width:min(760px,96vw);height:min(86vh,calc(100vh - 24px));background:var(--panel,#0b1020);
            color:var(--text,#e6ecff);border:1px solid var(--border,rgba(255,255,255,.12));border-radius:1rem;
            box-shadow:0 18px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}
  .sf-header{display:flex;align-items:center;justify-content:space-between;padding:.6rem .8rem;background:inherit;position:sticky;top:0;z-index:1}
  .sf-title{font-weight:700;opacity:.9}
  .sf-close{background:transparent;border:0;color:inherit;cursor:pointer;font-size:1.2rem;opacity:.9}
  .sf-list{padding:.6rem;overflow:auto;display:flex;flex-direction:column;gap:.6rem}
  .sf-item{display:flex;gap:.9rem;align-items:center;border:0;border-radius:.8rem;padding:.85rem 1rem;
           background:#159e8a;color:#052022;cursor:pointer;text-align:left}
  .sf-item:hover{filter:brightness(1.03)}
  .sf-date{width:52px;text-align:center}
  .sf-month{font-size:.8rem;opacity:.85;text-transform:lowercase}
  .sf-day{font-weight:800;font-size:1.35rem;line-height:1}
  .sf-text{flex:1;min-width:0}
  .sf-titleline{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sf-meta{font-size:.92rem;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* respeta tus colores por categoría si quieres */
  .sf-item.cat-Festivo{background:#0ea5e9;color:#04141c}
  `;
  const st = document.createElement('style');
  st.id = 'sf-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectAgendaStyles(){
  if (document.getElementById('agenda-styles')) return;
  const css = `
  dialog.agenda-modal { border:0; padding:0; background:transparent; }
  .agenda-card{
    width:min(520px,92vw); max-height:min(74vh,700px); overflow:auto;
    background:var(--panel,#0b1020); color:var(--text,#e6ecff);
    border:1px solid var(--border,rgba(255,255,255,.12)); border-radius:1rem;
    box-shadow:0 18px 40px rgba(0,0,0,.45);
  }
  .ag-head{display:flex; align-items:center; justify-content:space-between; padding:1rem 1rem .5rem 1rem; position:sticky; top:0; background:inherit; z-index:1}
  .ag-date{display:flex; align-items:center; gap:.75rem}
  .ag-daynum{display:inline-grid; place-items:center; width:42px; height:42px; border-radius:.75rem; background:#ef4444; color:#fff; font-weight:800}
  .ag-dow{font-weight:700; text-transform:capitalize}
  .ag-sub{font-size:.9rem; opacity:.8}
  .ag-close{background:transparent;border:0;cursor:pointer;color:inherit;font-size:1.1rem;opacity:.85}
  .ag-list{padding:.25rem 0 .25rem}
  .ag-item{
    width:100%; display:flex; gap:.9rem; align-items:flex-start; padding:.85rem 1rem; background:transparent; border:0; text-align:left; cursor:pointer;
  }
  .ag-item:hover{ background:rgba(255,255,255,.05) }
  .ag-time{min-width:3.6rem; font-weight:700}
  .ag-main{flex:1; min-width:0}
  .ag-title{font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .ag-meta{font-size:.9rem; opacity:.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .ag-sep{height:1px; background:var(--border,rgba(255,255,255,.12)); margin:.25rem 0}
  .ag-footer{padding:.6rem 1rem 1rem; display:flex; justify-content:flex-end}
  .btn.small{font-size:.9rem; padding:.35rem .7rem}
  `;
  const st = document.createElement('style');
  st.id = 'agenda-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

// ====== Menú de meses al lado del título ======
function injectMonthPickerStyles(){
  if (document.getElementById('mp-styles')) return;
  const css = `
  /* Botón junto al título */
  .monthdrop{display:inline-flex;align-items:center;gap:.35rem;background:transparent;border:0;color:inherit;font:inherit;cursor:pointer}
  .monthdrop .chev{display:inline-block;transform:translateY(1px);opacity:.9;transition:transform .18s ease}
  .monthdrop[aria-expanded="true"] .chev{transform:rotate(180deg) translateY(-1px)}

  /* Capa del menú */
  .mp-overlay{position:fixed;left:0;right:0;top:var(--topbar-h,56px);z-index:9000;display:none}
  .mp-overlay.open{display:block}
  .mp-bar{
    background:var(--panel,#0b1020);color:var(--text,#e6ecff);
    border-top:1px solid var(--border,rgba(255,255,255,.12));
    border-bottom:1px solid var(--border,rgba(255,255,255,.12));
    padding:.5rem .6rem; overflow:auto; display:flex; gap:.5rem; align-items:center;
    box-shadow:0 10px 24px rgba(0,0,0,.28)
  }
  .mp-chip{
    border:1px solid var(--border,rgba(255,255,255,.16));
    background:transparent;color:inherit;border-radius:.7rem;padding:.35rem .7rem;
    cursor:pointer; white-space:nowrap; font-weight:600
  }
  .mp-chip.active{background:#167E6B;color:#042321;border-color:#0b5b4d}
  .mp-chip.year{opacity:.75;cursor:default;border-style:dashed}
  @media (max-width:700px){ .mp-bar{padding:.45rem .4rem;gap:.4rem} }
    /* ===== Carril móvil (ruleta de meses) ===== */
  .mp-roller{
    display:none; position:relative;
    background:var(--panel,#0b1020); color:var(--text,#e6ecff);
    border-top:1px solid var(--border,rgba(255,255,255,.12));
    border-bottom:1px solid var(--border,rgba(255,255,255,.12));
    padding:.5rem .2rem .75rem;
  }
  .mp-roller .mr-year{
    position:absolute; right:.6rem; top:.35rem; font-size:.9rem; opacity:.7; pointer-events:none;
  }
  .mp-roller .mr-track{
    overflow-x:auto; overflow-y:hidden; white-space:nowrap;
    scroll-snap-type:x mandatory; padding:.2rem .4rem; -webkit-overflow-scrolling:touch;
  }
  .mr-item{
    display:inline-flex; align-items:center; justify-content:center;
    min-width:78px; margin:0 .28rem; padding:.55rem .8rem; border-radius:.75rem;
    border:1px solid var(--border,rgba(255,255,255,.16));
    font-weight:700; scroll-snap-align:center; user-select:none;
  }
  .mr-item.active{ background:#167E6B; color:#042321; border-color:#0b5b4d }
  .mr-item[data-m="0"]{ margin-left:.55rem }   /* un pelín más de aire en ene */
  .mr-item[data-m="11"]{ margin-right:.55rem } /* y en dic */

  /* Con pointer “coarse” (móvil) enseñamos carril; en desktop, la barra clásica */
  @media (pointer: coarse), (max-width: 700px){
    .mp-bar{ display:none }
    .mp-roller{ display:block }
  }
  @media (pointer: fine) and (min-width: 701px){
    .mp-roller{ display:none }
  }

    .mp-roller .mr-track{
    overflow-x:auto; overflow-y:hidden; white-space:nowrap;
    scroll-snap-type:x mandatory; padding:.2rem .4rem; -webkit-overflow-scrolling:touch;
    overscroll-behavior-x: contain;         /* ← evita “rebotes” que disparan prepend/append en bucle */
    scroll-behavior: smooth;                /* ← suaviza el snap manual */
  }
  .mr-item{
    display:inline-flex; align-items:center; justify-content:center;
    min-width:78px; margin:0 .28rem; padding:.55rem .8rem; border-radius:.75rem;
    border:1px solid var(--border,rgba(255,255,255,.16));
    font-weight:700; scroll-snap-align:center; user-select:none;
    scroll-snap-stop: always;               /* ← no se “salta” varios meses de golpe */
  }
  `;
  const st = document.createElement('style');
  st.id = 'mp-styles';
  st.textContent = css;
  document.head.appendChild(st);
}

function ensureMonthPickerUI(){
  // 1) Si el overlay no existe, créalo (una sola vez)
  let overlay = document.getElementById('monthPicker');
  if (!overlay){
    overlay = document.createElement('div');
    overlay.id = 'monthPicker';
    overlay.className = 'mp-overlay';
    overlay.innerHTML = `
      <div id="mpBar" class="mp-bar" role="menu"></div>
      <div id="mpRoller" class="mp-roller" role="menu" aria-label="Elegir mes (desliza)">
        <div class="mr-year" id="mrYear"></div>
        <div class="mr-track" id="mrTrack"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }


  // 2) Botón al lado del título — idempotente y con auto-reparación
  const currentLabel = (() => {
    const d = state?.currentMonth || new Date();
    try { return MONTHS[d.getMonth()] } catch { return (document.getElementById('appTitle')?.textContent || '') }
  })();

  let dropBtn = document.getElementById('monthDropBtn');
  if (!dropBtn) {
    // Primer montaje: reemplaza el nodo actual #appTitle por el botón
    const oldTitle = document.getElementById('appTitle');
    if (!oldTitle) return overlay; // nada que hacer
    dropBtn = document.createElement('button');
    dropBtn.id = 'monthDropBtn';
    dropBtn.className = 'monthdrop';
    dropBtn.setAttribute('aria-haspopup','true');
    dropBtn.setAttribute('aria-expanded','false');
    oldTitle.replaceWith(dropBtn);
  }

  // 3) REHIDRATAR el contenido del botón SIEMPRE (evita duplicados/anidamientos)
  dropBtn.innerHTML = '';  // ← limpia chevrons/nidos anteriores
  const span = document.createElement('span');
  span.id = 'appTitle';
  span.textContent = currentLabel || '';
  dropBtn.appendChild(span);

  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.setAttribute('aria-hidden','true');
  chev.textContent = '▾';
  dropBtn.appendChild(chev);

  return overlay;
}


function injectHorizontalTagPills(){
  if (document.getElementById('tags-pill-css')) return;
  const css = `
  /* Contenedor de tags: en horizontal, con salto a la siguiente línea */
  body.tags-v2 .events-tags{
    display:flex; flex-direction:row; flex-wrap:wrap;
    gap:4px; align-content:flex-start; min-width:0;
  }

  /* Píldora: inline-flex, texto elíptico y SIN pseudo-elementos */
  body.tags-v2 .events-tags .event-tag{
    display:inline-flex; align-items:center;
    max-width:100%; min-width:0; box-sizing:border-box;
    padding:2px 8px; border-radius:999px;
    background:var(--tag-bg, rgba(0,0,0,.06));
    border:1px solid var(--tag-border, rgba(0,0,0,.12));
    color:var(--tag-fg, #111) !important;
    font-size:12px; line-height:16px; font-weight:700;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    cursor:pointer;
  }
  body.tags-v2 .events-tags .event-tag::before,
  body.tags-v2 .events-tags .event-tag::after{ content:none !important; }

  /* El texto va “blindado” dentro y nunca se sale */
  body.tags-v2 .events-tags .event-tag .etxt{
    display:inline-block; min-width:0; max-width:100%;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }

  /* Colores por categoría (light) */
  body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#e8f0fe; --tag-border:#c7d2fe; --tag-fg:#174ea6; }
  body.tags-v2 .event-tag.cat-Tarea      { --tag-bg:#e6f4ea; --tag-border:#c7e3cf; --tag-fg:#0d652d; }
  body.tags-v2 .event-tag.cat-Citas      { --tag-bg:#fef7e0; --tag-border:#fde68a; --tag-fg:#8a4b00; }
  body.tags-v2 .event-tag.cat-Cumpleaños { --tag-bg:#f3e8ff; --tag-border:#e9d5ff; --tag-fg:#6b21a8; }
  body.tags-v2 .event-tag.cat-Otros      { --tag-bg:#eef2f7; --tag-border:#e5e7eb; --tag-fg:#334155; }
  body.tags-v2 .event-tag.cat-Festivo    { --tag-bg:#e0f2fe; --tag-border:#bae6fd; --tag-fg:#075985; }
  /* mata cualquier marcador heredado en el contenedor */
body.tags-v2 .events-tags::before,
body.tags-v2 .events-tags::after{
  content:none !important;
  display:none !important;
  width:0 !important;
  height:0 !important;
  background:transparent !important;
  border:0 !important;
}

/* por si acaso había bullets/imágenes de fondo antiguos */
body.tags-v2 .events-tags{
  list-style:none !important;
  background-image:none !important;
  padding-left:0 !important;
}

/* por si algún wrapper se cuela entre .events-tags y .event-tag */
body.tags-v2 .events-tags > * { min-width:0; }

/* si no usas injectTagPillsBlue y quieres el fix iOS aquí mismo: */
html[data-platform="ios"] body.tags-v2 .events-tags .event-tag .etxt{
  line-height:16px; padding-bottom:.5px;
}
  `;
  const st = document.createElement('style');
  st.id = 'tags-pill-css';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectTagPillsBlue(){
  if (document.getElementById('tags-pill-blue')) return;
  const css = `
  /* Usamos el layout de injectHorizontalTagPills, solo forzamos colores vivos
     y garantizamos que no se recorten letras */
  body.tags-v2 .events-tags .event-tag{
    background: var(--tag-bg) !important;
    border-color: var(--tag-border) !important;
    color: var(--tag-fg) !important;
  }
  body.tags-v2 .events-tags .event-tag .etxt{
    letter-spacing: normal !important;
    padding-left: 0 !important;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  /* Paleta "viva" */
  body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#1a73e8; --tag-border:#1669c1; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Tarea      { --tag-bg:#16a34a; --tag-border:#12833c; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Citas      { --tag-bg:#f59e0b; --tag-border:#d97706; --tag-fg:#0b0f02; }
  body.tags-v2 .event-tag.cat-Cumpleaños { --tag-bg:#9333ea; --tag-border:#7e22ce; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Otros      { --tag-bg:#64748b; --tag-border:#475569; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Festivo    { --tag-bg:#0ea5e9; --tag-border:#0284c7; --tag-fg:#04141c; }

  /* iOS: evita que se “coma” el primer píxel de las letras altas */
  html[data-platform="ios"] body.tags-v2 .events-tags .event-tag .etxt{
    line-height:16px; padding-bottom:.5px;
  }
  `;
  const st = document.createElement('style');
  st.id = 'tags-pill-blue';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectMobilePillAntidote(){
  if (document.getElementById('mobile-pill-antidote')) return;
  const css = `
@media (max-width: 1024px), (pointer: coarse) {
  /* Mostrar SIEMPRE las etiquetas en móvil */
  #calendarGrid .events-tags{
    display:flex !important; flex-wrap:wrap !important; gap:4px !important;
    list-style:none !important; background:none !important; padding-left:0 !important;
    position:static !important; overflow:visible !important;
  }
  /* Píldoras legibles (anula abreviadores agresivos) */
  #calendarGrid .events-tags .event-tag{
    display:inline-flex !important; align-items:center !important;
    max-width:100% !important; min-width:0 !important;
    padding:2px 8px !important; border-radius:999px !important;
    white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important;
    font-size:12px !important; line-height:16px !important; font-weight:700 !important;
    text-indent:0 !important; letter-spacing:normal !important;
  }
  #calendarGrid .events-tags .event-tag .etxt{
    display:inline !important; min-width:0 !important; max-width:100% !important;
    overflow:hidden !important; text-overflow:ellipsis !important; font-size:inherit !important;
  }
  /* Mata contadores/pseudo-elementos que dibujan "1." o bolitas */
  #calendarGrid .day::before,
  #calendarGrid .day::after,
  #calendarGrid .events-tags::before,
  #calendarGrid .events-tags::after,
  #calendarGrid .events-tags .event-tag::before,
  #calendarGrid .events-tags .event-tag::after,
  #calendarGrid .day .event-count,
  #calendarGrid .day .count,
  #calendarGrid .day .dots,
  #calendarGrid .day .badge{
    content:"" !important; display:none !important;
  }
}
  `;
  const st = document.createElement('style');
  st.id = 'mobile-pill-antidote';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectBiggerMonthCells(){
  if (document.getElementById('bigger-month-cells-css')) return;
  const st = document.createElement('style');
  st.id = 'bigger-month-cells-css';
  st.textContent = `
  /* Móvil / tablet: usa mejor el ancho y haz las celdas más grandes */
  @media (max-width: 1024px), (pointer: coarse){
    /* 1) Menos sangría a los lados del mes */
    #monthView { padding-inline: 6px !important; }

    /* 2) La rejilla ocupa todo el ancho, con poco gap */
    #calendarGrid{
      grid-template-columns: repeat(7, minmax(0,1fr)) !important;
      gap: 6px !important;
      padding: 0 !important;
    }

    /* 3) Celdas más altas (≈ cuadradas) y con menos “marco” interno */
    #calendarGrid .day{
      min-height: clamp(82px, 14vw, 140px) !important;
      padding: 8px !important;
      border-radius: 12px !important;
    }

    /* 4) Cabecera de día un pelín más compacta */
    #calendarGrid .day .day-head{ margin-bottom: 4px !important; }
  }`;
  document.head.appendChild(st);
}

function injectDenseTagText(){
  if (document.getElementById('dense-tag-text-css')) return;
  const st = document.createElement('style');
  st.id = 'dense-tag-text-css';
  st.textContent = `
  @media (max-width:1024px), (pointer:coarse){
    #calendarGrid .events-tags .event-tag{
      padding: 1px 6px !important;
      width: 100% !important;
      box-sizing: border-box !important;
      white-space: normal !important;   /* <- clave para permitir 2 líneas */
      align-items: flex-start !important;
    }
    #calendarGrid .events-tags .event-tag .etxt{
      font-size: 11px !important;
      line-height: 14px !important;
      white-space: normal !important;
      display: -webkit-box !important;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
  }`;
  document.head.appendChild(st);
}

function injectEvenBiggerMonth(){
  if (document.getElementById('even-bigger-month-css')) return;
  const st = document.createElement('style');
  st.id = 'even-bigger-month-css';
  st.textContent = `
  @media (max-width:1024px), (pointer:coarse){
    /* Reduce márgenes laterales del contenedor del mes */
    #monthView{ padding-inline: 4px !important; }
    /* Menos separación entre celdas ⇒ más ancho para el texto */
    #calendarGrid{ gap: 4px !important; padding: 0 !important; }
    /* Celdas más altas */
    #calendarGrid .day{
      min-height: clamp(96px, 16vw, 180px) !important;
      padding: 8px !important;
      border-radius: 12px !important;
    }
    #calendarGrid .day .day-head{ margin-bottom: 4px !important; }
  }`;
  document.head.appendChild(st);
}

// Mata contadores y marcadores tipo "1." en la vista de mes (móvil/tablet)
function nukeCountBadges(){
  if (document.getElementById('nuke-count-badges')) return;
  const css = `
@media (max-width: 1024px), (pointer: coarse) {
  /* Nada de bullets ni counters en el contenedor ni hijos */
  #calendarGrid .events-tags,
  #calendarGrid .events-tags *{
    list-style: none !important;
    counter-reset: none !important;
    counter-increment: none !important;
  }

  /* Oculta marcadores clásicos (el "1." suele venir de aquí) */
  #calendarGrid .day li::marker,
  #calendarGrid .events-tags li::marker,
  #calendarGrid .events-tags .event-tag::marker{
    content: "" !important;
  }

  /* Y cualquier badge/counter que se pinte con pseudo-elementos */
  #calendarGrid .day::before,
  #calendarGrid .day::after,
  #calendarGrid .events-tags::before,
  #calendarGrid .events-tags::after,
  #calendarGrid .events-tags .event-tag::before,
  #calendarGrid .events-tags .event-tag::after,
  #calendarGrid .day .count,
  #calendarGrid .day [class*="count"],
  #calendarGrid .day .badge,
  #calendarGrid .day .dots,
  #calendarGrid .day [data-count]{
    content: "" !important;
    display: none !important;
  }

  /* Asegura que la píldora es texto normal, no "círculo con cifra" */
  #calendarGrid .events-tags .event-tag{
    display: inline-flex !important;
    align-items: center !important;
    width: auto !important; height: auto !important; aspect-ratio: auto !important;
    font-size: 12px !important; line-height: 16px !important; text-indent: 0 !important;
    white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
  }
}
`;
  const st = document.createElement('style');
  st.id = 'nuke-count-badges';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectTighterTagMargins(){
  if (document.getElementById('tight-tag-margins')) return;
  const st = document.createElement('style');
  st.id = 'tight-tag-margins';
  st.textContent = `
  @media (max-width:1024px), (pointer:coarse){
    /* Menos borde interior del recuadro del día */
    #calendarGrid .day{
      padding: 6px !important;          /* antes 8px */
    }
    /* Menos separación debajo del número */
    #calendarGrid .day .day-head{
      margin-bottom: 2px !important;    /* antes 4px */
    }
    /* Píldoras: ocupar el ancho completo disponible */
    #calendarGrid .events-tags .event-tag{
      width: 100% !important;
      padding: 2px 8px !important;      /* mantenemos altura cómoda */
    }
    /* Opcional: sangra 1px para ganar un pelín más de ancho */
    #calendarGrid .events-tags{ margin-inline: -1px !important; }
    #calendarGrid .events-tags .event-tag{ max-width: calc(100% + 2px) !important; }
  }`;
  document.head.appendChild(st);
}

function injectEdgeToEdgeMonth(){
  if (document.getElementById('edge-to-edge-month')) return;
  const st = document.createElement('style');
  st.id = 'edge-to-edge-month';
  st.textContent = `
  @media (max-width:1024px), (pointer:coarse){
    /* 1) el contenedor del mes sin márgenes laterales */
    #monthView{
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    /* 2) si el calendario va dentro de una tarjeta/panel, reduce su padding */
    #monthView .panel,
    #monthView .card,
    #monthView .calendar-card,
    #monthView .month-card{
      padding-left: 6px !important;   /* ajusta a 4px si quieres aún más */
      padding-right: 6px !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    /* 3) el grid sin relleno ni márgenes, ocupando todo el ancho */
    #calendarGrid{
      padding-left: 0 !important;
      padding-right: 0 !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      width: 100% !important;
      grid-template-columns: repeat(7, minmax(0,1fr)) !important;
      gap: 4px !important;            /* puedes dejarlo en 6–8 si prefieres más aire */
    }

    /* 4) celdas un pelín más grandes para aprovechar el nuevo ancho */
    #calendarGrid .day{
      min-height: clamp(96px, 16vw, 180px) !important;
      padding: 6px !important;        /* combinado con el ajuste de etiquetas que ya pusimos */
      border-radius: 12px !important;
    }

    /* 5) que las etiquetas usen todo el carril disponible */
    #calendarGrid .events-tags{ margin-inline: -1px !important; }
    #calendarGrid .events-tags .event-tag{
      width: 100% !important;
      max-width: calc(100% + 2px) !important;
    }
  }`;
  document.head.appendChild(st);
}

function fixDarkTagColors(){
  if (document.getElementById('tag-dark-fix')) return;
  const st = document.createElement('style');
  st.id = 'tag-dark-fix';
  st.textContent = `
  /* Evita que el modo oscuro neutralice los colores por categoría */
  [data-theme="dark"] body.tags-v2 .events-tags .event-tag{
    --tag-bg: initial; --tag-border: initial; --tag-fg: initial;
  }
  /* Colores vivos por categoría también en dark */
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#1a73e8; --tag-border:#1669c1; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Tarea      { --tag-bg:#16a34a; --tag-border:#12833c; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Citas      { --tag-bg:#f59e0b; --tag-border:#d97706; --tag-fg:#0b0f02; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Cumpleaños { --tag-bg:#9333ea; --tag-border:#7e22ce; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Otros      { --tag-bg:#64748b; --tag-border:#475569; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Festivo    { --tag-bg:#0ea5e9; --tag-border:#0284c7; --tag-fg:#04141c; }
  `;
  document.head.appendChild(st);
}

// —— Estado del month picker infinito ——
const mpState = {
  inited: false,
  startY: 0, startM: 0,   // mes más antiguo cargado (inclusive)
  endY: 0,   endM: 0      // mes más moderno cargado (inclusive)
};

const ymKey = (y,m) => y*12 + m;
const cmpYM = (aY,aM,bY,bM) => Math.sign(ymKey(aY,aM) - ymKey(bY,bM));
const nextYM = (y,m) => (m === 11) ? { y:y+1, m:0 }  : { y, m:m+1 };
const prevYM = (y,m) => (m === 0)  ? { y:y-1, m:11 } : { y, m:m-1 };
const ymFromKey = (k) => ({ y: Math.floor(k/12), m: ((k%12)+12)%12 });

function createYearChip(y){
  const s = document.createElement('span');
  s.className = 'mp-chip year';
  s.textContent = y;
  return s;
}
function createMonthChip(y,m){
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mp-chip';
  b.dataset.y = y;
  b.dataset.m = m;
  b.textContent = MONTHS_SHORT[m];
  b.addEventListener('click', () => gotoMonth(y, m));
  return b;
}

function monthsAround(dateObj, prev=3, next=8){
  const base = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
  const list = [];
  for (let i = -prev; i <= next; i++){
    const d = new Date(base.getFullYear(), base.getMonth()+i, 1);
    list.push({ y:d.getFullYear(), m:d.getMonth(), label: MONTHS_SHORT[d.getMonth()] });
  }
  // inserta separadores de año donde cambie
  const withSeparators = [];
  let lastY = null;
  for (const x of list){
    if (lastY !== null && x.y !== lastY){
      withSeparators.push({ type:'year', y: x.y });
    }
    withSeparators.push({ type:'month', ...x });
    lastY = x.y;
  }
  return withSeparators;
}
// ===== Carril móvil (ruleta) =====
const mrState = {
  inited: false,
  startY: 0, startM: 0,
  endY: 0,   endM: 0,
  commitT: null,
  extendLockUntil: 0,   // ← throttle de prepend/append
  gesture: null         // ← info del gesto para snap
};

const MR_PRELOAD = 24;  // meses iniciales hacia cada lado
const MR_CHUNK   = 18;  // meses a añadir cuando te acercas al borde

function createRollerItem(y,m){
  const el = document.createElement('div');
  el.className = 'mr-item';
  el.dataset.y = y;
  el.dataset.m = m;
  el.textContent = MONTHS_SHORT[m];
  return el;
}

function renderMonthRoller(){
  const track = document.getElementById('mrTrack'); if (!track) return;
  const yearLab = document.getElementById('mrYear');
  const cur = state.currentMonth || new Date();

  if (!mrState.inited){
    track.innerHTML = '';
    // Semilla: MR_PRELOAD atrás/adelante
    const start = new Date(cur.getFullYear(), cur.getMonth() - MR_PRELOAD, 1);
    const end   = new Date(cur.getFullYear(), cur.getMonth() + MR_PRELOAD, 1);
    mrState.startY = start.getFullYear(); mrState.startM = start.getMonth();
    mrState.endY   = end.getFullYear();   mrState.endM   = end.getMonth();

    let y = mrState.startY, m = mrState.startM;
    while (cmpYM(y,m, mrState.endY, mrState.endM) <= 0){
      track.appendChild(createRollerItem(y,m));
      ({y,m} = nextYM(y,m));
    }

    // Scroll infinito en móvil
    track.addEventListener('scroll', onRollerScroll, { passive:true });
        // Snap al soltar
    const onPointerDown = ()=>{ mrState.gesture = { startScrollLeft: track.scrollLeft }; };
    const onPointerUp = ()=>{
      mrState.gesture = null;
      snapRollerToNearest(track);
    };
    track.addEventListener('pointerdown', onPointerDown, { passive:true });
    track.addEventListener('pointerup',   onPointerUp,   { passive:true });
    track.addEventListener('pointercancel', ()=>{ mrState.gesture=null; }, { passive:true });

    mrState.inited = true;
  }

  // Garantiza que el mes actual está cargado y visible
  ensureRollerContains(cur.getFullYear(), cur.getMonth());
  markActiveRoller();
  centerActiveRoller();

  // Etiqueta de año
  if (yearLab) yearLab.textContent = String(cur.getFullYear());
}

function onRollerScroll(e){
  const track = e.currentTarget;

  // 1) Extensión con throttle para que no entre en bucle
  const now = performance.now();
  const nearLeft  = track.scrollLeft < 120;
  const nearRight = (track.scrollWidth - (track.scrollLeft + track.clientWidth)) < 120;

  if (now > mrState.extendLockUntil) {
    if (nearLeft)  { prependRollerMonths(MR_CHUNK); mrState.extendLockUntil = now + 220; }
    if (nearRight) { appendRollerMonths(MR_CHUNK);  mrState.extendLockUntil = now + 220; }
  }

  // 2) Detecta el item centrado
  const mid = track.scrollLeft + track.clientWidth/2;
  let best = null, bestD = Infinity;
  track.querySelectorAll('.mr-item').forEach(it=>{
    const c = it.offsetLeft + it.offsetWidth/2;
    const d = Math.abs(c - mid);
    if (d < bestD){ bestD = d; best = it; }
  });
  if (!best) return;

  const y = +best.dataset.y, m = +best.dataset.m;
  setRollerActive(y,m);
  const yearLab = document.getElementById('mrYear'); if (yearLab) yearLab.textContent = String(y);

  // 3) “Compromete” el cambio de mes solo cuando se tranquiliza el scroll
  clearTimeout(mrState.commitT);
  mrState.commitT = setTimeout(()=>{
    const cur = state.currentMonth || new Date();
    const curIdx = ymKey(cur.getFullYear(), cur.getMonth());
    const newIdx = ymKey(y,m);
    // Limita salto por gesto (evita irse a 1964)
    const MAX_JUMP = 6;
    const clamped = clamp(newIdx, curIdx - MAX_JUMP, curIdx + MAX_JUMP);
    const t = ymFromKey(clamped);
    if (t.y === cur.getFullYear() && t.m === cur.getMonth()) return;

    const target = new Date(t.y, t.m, 1);
    const dir = monthDirection(state.currentMonth, target);
    animateMonth(dir, ()=>{ state.currentMonth = target; renderCalendar(state.currentMonth); });
  }, 240);
}

function setRollerActive(y,m){
  document.querySelectorAll('.mr-item').forEach(n=> n.classList.remove('active'));
  const chip = document.querySelector(`.mr-item[data-y="${y}"][data-m="${m}"]`);
  if (chip) chip.classList.add('active');
}

function markActiveRoller(){
  const cur = state.currentMonth || new Date();
  setRollerActive(cur.getFullYear(), cur.getMonth());
}

function centerActiveRoller(){
  const cur = state.currentMonth || new Date();
  const chip = document.querySelector(`.mr-item[data-y="${cur.getFullYear()}"][data-m="${cur.getMonth()}"]`);
  const track = document.getElementById('mrTrack');
  if (!chip || !track) return;
  const target = chip.offsetLeft - (track.clientWidth - chip.offsetWidth)/2;
  track.scrollTo({ left: target, behavior: 'instant' in track ? 'instant' : 'auto' });
}

function snapRollerToNearest(track){
  const mid = track.scrollLeft + track.clientWidth/2;
  let best = null, bestD = Infinity;
  track.querySelectorAll('.mr-item').forEach(it=>{
    const c = it.offsetLeft + it.offsetWidth/2;
    const d = Math.abs(c - mid);
    if (d < bestD){ bestD = d; best = it; }
  });
  if (!best) return;
  const targetLeft = best.offsetLeft - (track.clientWidth - best.offsetWidth)/2;
  track.scrollTo({ left: targetLeft, behavior: 'smooth' });
}

function appendRollerMonths(n){
  const track = document.getElementById('mrTrack'); if (!track) return;
  let y = mrState.endY, m = mrState.endM;
  for (let i=0;i<n;i++){ ({y,m} = nextYM(y,m)); track.appendChild(createRollerItem(y,m)); }
  mrState.endY = y; mrState.endM = m;
}
function prependRollerMonths(n){
  const track = document.getElementById('mrTrack'); if (!track) return;
  const firstLeft = track.firstElementChild ? track.firstElementChild.getBoundingClientRect().left : 0;

  let y = mrState.startY, m = mrState.startM;
  for (let i=0;i<n;i++){ ({y,m} = prevYM(y,m)); track.insertBefore(createRollerItem(y,m), track.firstChild); }
  mrState.startY = y; mrState.startM = m;

  // compensa el “salto” visual al hacer prepend
  const newFirstLeft = track.firstElementChild ? track.firstElementChild.getBoundingClientRect().left : 0;
  track.scrollLeft += (newFirstLeft - firstLeft);
}

function ensureRollerContains(y,m){
  const track = document.getElementById('mrTrack'); if (!track) return;
  while (cmpYM(y,m, mrState.startY, mrState.startM) < 0) prependRollerMonths(MR_CHUNK);
  while (cmpYM(y,m, mrState.endY,   mrState.endM)   > 0) appendRollerMonths(MR_CHUNK);
}

function renderMonthPickerBar(){
  const bar = document.getElementById('mpBar');
  if (!bar) return;

  const cur = state.currentMonth || new Date();

  // Primera vez: sembramos un rango y conectamos el “infinite scroll”
  if (!mpState.inited){
    bar.innerHTML = '';

    // Semilla: 24 meses atrás y 24 hacia delante
    let start = new Date(cur.getFullYear(), cur.getMonth() - 24, 1);
    let end   = new Date(cur.getFullYear(), cur.getMonth() + 24, 1);
    mpState.startY = start.getFullYear(); mpState.startM = start.getMonth();
    mpState.endY   = end.getFullYear();   mpState.endM   = end.getMonth();

    // Construimos de start → end (inclusive)
    let y = mpState.startY, m = mpState.startM;
    while (cmpYM(y,m, mpState.endY, mpState.endM) <= 0){
      if (m === 0) bar.appendChild(createYearChip(y));     // separador de año
      bar.appendChild(createMonthChip(y,m));
      ({y,m} = nextYM(y,m));
    }

    // Scroll infinito: añadir meses cuando te acercas al borde
    bar.addEventListener('scroll', () => {
      const nearLeft  = bar.scrollLeft < 80;
      const nearRight = (bar.scrollWidth - (bar.scrollLeft + bar.clientWidth)) < 80;

      if (nearLeft)  prependMonths(bar, 18);   // añade 18 meses a la IZQ
      if (nearRight) appendMonths(bar, 18);    // añade 18 meses a la DCHA
    }, { passive: true });

    mpState.inited = true;
  }

  // Asegura que el mes activo existe (si saltas muy lejos)
  ensureContainsMonth(cur.getFullYear(), cur.getMonth());

  // Marca activo y centra el chip actual
  markActiveMonthChip();
  centerActiveChip();
}

// Añade N meses por la derecha
function appendMonths(bar, n){
  let y = mpState.endY, m = mpState.endM;
  for (let i=0;i<n;i++){
    ({y,m} = nextYM(y,m));
    if (m === 0) bar.appendChild(createYearChip(y));
    bar.appendChild(createMonthChip(y,m));
  }
  mpState.endY = y; mpState.endM = m;
}

// Añade N meses por la izquierda (manteniendo posición visual estable)
function prependMonths(bar, n){
  const firstEl = bar.firstElementChild;
  const firstLeft = firstEl ? firstEl.getBoundingClientRect().left : 0;

  let y = mpState.startY, m = mpState.startM;
  for (let i=0;i<n;i++){
    ({y,m} = prevYM(y,m));
    // Si es enero, el separador de año va ANTES del chip de enero
    if (m === 0){
      bar.insertBefore(createYearChip(y), bar.firstChild);
    }
    bar.insertBefore(createMonthChip(y,m), bar.firstChild);
  }
  mpState.startY = y; mpState.startM = m;

  // Corrige scroll para no “saltar” tras el prepend
  const newFirstLeft = bar.firstElementChild ? bar.firstElementChild.getBoundingClientRect().left : 0;
  bar.scrollLeft += (newFirstLeft - firstLeft);
}

// Garantiza que (y,m) está cargado; si no, extiende hasta incluirlo
function ensureContainsMonth(y, m){
  if (!mpState.inited) return;
  const bar = document.getElementById('mpBar');
  if (!bar) return;

  // hacia la izquierda
  while (cmpYM(y,m, mpState.startY, mpState.startM) < 0){
    prependMonths(bar, 18);
  }
  // hacia la derecha
  while (cmpYM(y,m, mpState.endY, mpState.endM) > 0){
    appendMonths(bar, 18);
  }
}

function markActiveMonthChip(){
  const cur = state.currentMonth || new Date();
  const y = cur.getFullYear(), m = cur.getMonth();

  document.querySelectorAll('.mp-chip').forEach(ch => {
    if (!ch.classList.contains('year')) ch.classList.remove('active');
    ch.removeAttribute('aria-current');
  });

  const sel = document.querySelector(`.mp-chip[data-y="${y}"][data-m="${m}"]`);
  if (sel){
    sel.classList.add('active');
    sel.setAttribute('aria-current','true');
  }
}

function centerActiveChip(){
  const cur = state.currentMonth || new Date();
  const y = cur.getFullYear(), m = cur.getMonth();
  const chip = document.querySelector(`.mp-chip[data-y="${y}"][data-m="${m}"]`);
  const bar  = document.getElementById('mpBar');
  if (!chip || !bar) return;
  chip.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function openMonthPicker(){
  const overlay = ensureMonthPickerUI();
  injectMonthPickerStyles();
  renderMonthPickerBar();
  renderMonthRoller();
  if (!overlay.classList.contains('open')) {
    backMgr.push('monthPicker', () => { overlay.classList.remove('open'); document.getElementById('monthDropBtn')?.setAttribute('aria-expanded','false'); });
  }
  overlay.classList.add('open');
  document.getElementById('monthDropBtn')?.setAttribute('aria-expanded','true');
  document.body.addEventListener('mousedown', _mpOutside, { capture:true });
}
function closeMonthPicker(){
  const overlay = document.getElementById('monthPicker');
  if (!overlay || !overlay.classList.contains('open')) return;
  backMgr.consumeOne();
  overlay.classList.remove('open');
  document.getElementById('monthDropBtn')?.setAttribute('aria-expanded','false');
  document.body.removeEventListener('mousedown', _mpOutside, true);
}

function toggleMonthPicker(){
  const overlay = document.getElementById('monthPicker');
  if (!overlay || !overlay.classList.contains('open')) openMonthPicker();
  else closeMonthPicker();
}

function _mpOutside(ev){
  const overlay = document.getElementById('monthPicker');
  const btn = document.getElementById('monthDropBtn');
  if (!overlay) return;
  const inside = overlay.contains(ev.target) || (btn && (btn === ev.target || btn.contains(ev.target)));
  if (!inside) closeMonthPicker();
}

function gotoMonth(year, monthIndex){
  const target = new Date(year, monthIndex, 1);
  const dir = monthDirection(state.currentMonth, target);
  animateMonth(dir, () => {
    state.currentMonth = target;
    renderCalendar(state.currentMonth);
    closeMonthPicker();
    // aseguramos que el chip activo se remarca
    setTimeout(markActiveMonthChip, 0);
  });
}

// listeners
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeMonthPicker(); });

let _toastHost = null;
function ensureToastHost(){
  if (_toastHost) return _toastHost;
  _toastHost = document.createElement('div');
  _toastHost.id = 'toastHost';
  _toastHost.className = 'toast-host br';
  document.body.appendChild(_toastHost);
  return _toastHost;
}
function pickToastCorner(){
  // Si el FAB está abierto, usa abajo-izquierda para no taparlo
  return document.body.classList.contains('fab-open') ? 'bl' : 'br';
}
function positionToastHost(){
  const host = ensureToastHost();
  host.classList.remove('br','bl');
  host.classList.add(pickToastCorner());
}
window.addEventListener('resize', positionToastHost);
document.addEventListener('click', positionToastHost);

function showToast(text, { actionLabel = 'Deshacer', onUndo = null, duration = 6000 } = {}){
  injectToastStyles();
  const host = ensureToastHost();
  positionToastHost();

  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role','status');
  el.setAttribute('aria-live','polite');

  el.innerHTML = `
    <span class="msg"></span>
    ${onUndo ? `<button class="btn-undo" type="button">${actionLabel}</button>` : ''}
    <button class="btn-close" type="button" aria-label="Cerrar">✕</button>
  `;
  el.querySelector('.msg').textContent = text;

  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  let t = setTimeout(close, duration);
  el.addEventListener('mouseenter', () => { clearTimeout(t); });
  el.addEventListener('mouseleave', () => { t = setTimeout(close, duration); });

  function close(){
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }
  el.querySelector('.btn-close').addEventListener('click', close);
  if (onUndo){
    el.querySelector('.btn-undo').addEventListener('click', async () => {
      try { await onUndo(); } finally { close(); }
    });
  }
}

function reRender(){
  (state.viewMode === 'month')
    ? renderCalendar(state.currentMonth)
    : renderTimeView(state.viewMode, state.selectedDate || new Date());
}

function animateMonth(dir, rerender){
  const grid = $('#calendarGrid');
  if (!grid) return rerender();
  const outCls = (dir === 'next') ? 'month-out-left' : 'month-out-right';
  const inCls  = (dir === 'next') ? 'month-in-right' : 'month-in-left';
  grid.classList.add(outCls);
  setTimeout(()=>{
    rerender();
    grid.classList.remove(outCls);
    grid.classList.add(inCls);
    setTimeout(()=> grid.classList.remove(inCls), 260);
  }, 200);
}

function monthDirection(from, to){
  const a = from.getFullYear()*12 + from.getMonth();
  const b = to.getFullYear()*12 + to.getMonth();
  if (b > a) return 'next';
  if (b < a) return 'prev';
  return 'next';
}

function gcalDescToPlain(desc){
  if (!desc) return '';
  // convierte saltos típicos y elimina etiquetas
  const withNewlines = desc
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n');
  const tmp = document.createElement('div');
  tmp.innerHTML = withNewlines;
  return (tmp.textContent || tmp.innerText || '').trim();
}

// —— util: ocultar flechas de navegación clásicas —— //
function hideLegacyNavArrows(){
  ['#prevMonth','#nextMonth','#prevYear','#nextYear'].forEach(sel=>{
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.display = 'none';
    el.setAttribute('aria-hidden','true');
    el.setAttribute('tabindex','-1');
    if ('disabled' in el) el.disabled = true;
    try { el.inert = true; } catch {}
  });
}

function setPlatformClass() {
  const ua = navigator.userAgent || '';
  const isIOS = /iP(hone|ad|od)/.test(ua) || ((/Macintosh/.test(ua)) && 'ontouchend' in document);
  const isAndroid = /Android/i.test(ua);
  document.documentElement.setAttribute('data-platform', isIOS ? 'ios' : (isAndroid ? 'android' : 'other'));
}

// ===================== Listeners (generales) =====================
// Menú
on('#menuBtn','click', toggleDrawer);
on('#closeDrawer','click', closeDrawer);
on('#drawerBackdrop','click', closeDrawer);

// Tema
on('#themeToggle','click', toggleTheme);

// Vista (radios)
$$('input[name="viewMode"]').forEach(r=> on(r,'change', e => setViewMode(e.target.value)));

on('#updateNowBtn','click', async ()=>{
  const btn = qs('#updateNowBtn');
  btn.classList.add('loading');

  try{
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg){
      await reg.update();
      if (reg.waiting){ reg.waiting.postMessage({ type:'SKIP_WAITING' }); }
      else if (reg.installing){
        await new Promise(r => reg.installing.addEventListener('statechange', e=>{
          if (e.target.state === 'installed') r();
        }));
      }
    }
    if ('caches' in window){
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  }catch(e){ console.warn(e); }

  localStorage.removeItem('forceUpdate.min'); // <- evita bucle del cartel

  const base = location.href.split('#')[0].split('?')[0];
  location.replace(base + '?u=' + Date.now());
});


// Botón marcar/desmarcar todos
on('#toggleAllCats','click', ()=>{
  const all = ['Trabajo','Tarea','Citas','Cumpleaños','Otros','Festivo'];
  const allSelected = all.every(c => state.filters.has(c));
  state.filters = allSelected ? new Set() : new Set(all);
  $$('.cat-filter').forEach(cb => { cb.checked = state.filters.has(cb.value); });
  (state.viewMode === 'month') ? renderCalendar(state.currentMonth)
                               : renderTimeView(state.viewMode, state.selectedDate || new Date());
});

$$('.cat-filter').forEach(cb=> on(cb,'change', (e)=>{
  const val = e.target.value;
  e.target.checked ? state.filters.add(val) : state.filters.delete(val);
  (state.viewMode === 'month') ? renderCalendar(state.currentMonth)
                               : renderTimeView(state.viewMode, state.selectedDate || new Date());
}));

// Navegación mes (con animación)
on('#prevMonth','click', ()=>{
  const nextDate = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth()-1, 1);
  animateMonth('prev', ()=>{ state.currentMonth = nextDate; renderCalendar(state.currentMonth); });
});
on('#nextMonth','click', ()=>{
  const nextDate = new Date(state.currentMonth.getFullYear(), state.currentMonth.getMonth()+1, 1);
  animateMonth('next', ()=>{ state.currentMonth = nextDate; renderCalendar(state.currentMonth); });
});
on('#prevYear','click',  ()=>{
  const nextDate = new Date(state.currentMonth.getFullYear()-1, state.currentMonth.getMonth(), 1);
  animateMonth('prev', ()=>{ state.currentMonth = nextDate; renderCalendar(state.currentMonth); });
});
on('#nextYear','click',  ()=>{
  const nextDate = new Date(state.currentMonth.getFullYear()+1, state.currentMonth.getMonth(), 1);
  animateMonth('next', ()=>{ state.currentMonth = nextDate; renderCalendar(state.currentMonth); });
});
on('#todayBtn','click',  ()=>{
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), 1);
  const dir = monthDirection(state.currentMonth, target);
  animateMonth(dir, ()=>{ state.currentMonth = target; renderCalendar(state.currentMonth); });
});
on('#jumpBtn','click',   ()=>{
  const v=$('#jumpDate')?.value; if(!v) return;
  const d=parseDateInput(v);
  const target = new Date(d.getFullYear(), d.getMonth(), 1);
  const dir = monthDirection(state.currentMonth, target);
  animateMonth(dir, ()=>{ state.currentMonth = target; renderCalendar(state.currentMonth); });
});

// Vistas de tiempo
on('#backToMonth','click', ()=> setViewMode('month') );

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Cuando el SW nuevo toma el control, limpiamos el flag y recargamos con bust
    try { localStorage.removeItem('forceUpdate.min'); } catch {}
    location.replace(location.pathname + '?u=' + Date.now());
  });
}

// ===== FAB & Speed-dial =====
function setFabOpen(open){
  const fab = $('#globalAddFab');
  const menu = $('#fabMenu');
  document.body.classList.toggle('fab-open', open);

  if (fab) {
    fab.classList.toggle('spin', open);
    const plus = $('.icon-plus', fab);
    const cal  = $('.icon-cal', fab);
    if (plus && cal){
      plus.classList.toggle('hidden', open);
      cal.classList.toggle('hidden', !open);
    }
    if (open){
      fab.title = 'Evento';
      fab.setAttribute('aria-label','Evento');
    } else {
      fab.title = 'Añadir evento';
      fab.setAttribute('aria-label','Añadir evento');
    }
  }
  if (menu) menu.setAttribute('aria-hidden', open ? 'false' : 'true');
}

// FAB principal
on('#globalAddFab','click', ()=>{
  const isOpen = document.body.classList.contains('fab-open');
  if (isOpen){
    setFabOpen(false);
    openSheetNew();
  } else {
    setFabOpen(true);
  }
});

// Cerrar el menú al clicar fuera
document.addEventListener('click', (ev)=>{
  if (!document.body.classList.contains('fab-open')) return;
  const fab = $('#globalAddFab');
  const menu = $('#fabMenu');
  const insideFab  = fab && (fab === ev.target || fab.contains(ev.target));
  const insideMenu = menu && (menu === ev.target || menu.contains(ev.target));
  if (!insideFab && !insideMenu) setFabOpen(false);
});

// Mini-FAB: Cumpleaños -> su propio sheet
on('#fabBirthday','click', ()=>{
  setFabOpen(false);
  const form = $('#birthdayForm');
  if (form){
    const baseDate = state.selectedDate || new Date();
    form.querySelector('[name="id"]').value = '';
    form.querySelector('[name="date"]').value = ymd(baseDate);
    form.querySelector('[name="time"]').value = '10:00';
    form.querySelector('[name="title"]').value = '';
    form.querySelector('[name="location"]').value = '';
    form.querySelector('[name="client"]').value = '';
    form.querySelector('[name="files"]').value = '';
  }
  openSheetById('addBirthdaySheet');
});

// Mini-FAB: Tarea -> su propio sheet
on('#fabTask','click', ()=>{
  setFabOpen(false);
  const form = $('#taskForm');
  if (form){
    const baseDate = state.selectedDate || new Date();
    form.querySelector('[name="id"]').value = '';
    form.querySelector('[name="date"]').value = ymd(baseDate);
    form.querySelector('[name="time"]').value = '10:00';
    form.querySelector('[name="title"]').value = '';
    form.querySelector('[name="location"]').value = '';
    form.querySelector('[name="client"]').value = '';
    form.querySelector('[name="files"]').value = '';
  }
  openSheetById('addTaskSheet');
});

// Sheets existentes (Evento)
on('#closeSheet','click', closeSheet);
on('#cancelEventBtn','click', closeSheet);
on('#eventForm','submit', saveEvent);
// Botón Duplicar
on('#duplicateEventBtn','click', async () => {
  const id = $('#eventId')?.value;
  if (!id) return;
  try {
    await startDuplicateFlow(id);
  } catch (err) {
    console.error(err);
    alert('No se pudo iniciar la duplicación.');
  }
});


on('#deleteEventBtn','click', async ()=>{
  const id = $('#eventId')?.value; if (!id) return;

  const ok = await confirmNative({
    title: 'Eliminar evento',
    message: 'Se eliminará el evento y todos sus archivos adjuntos. ¿Seguro que quieres continuar?',
    confirmText: 'Eliminar',
    cancelText: 'Cancelar',
    destructive: true
  });

  if (ok) {
    await deleteEvent(id);
  }
});

// Listeners del formulario (globales, no dentro de “Eliminar”)
on('#eventAllDay','change', (e)=> setAllDayUI(!!e.target.checked));

on('#pickFilesBtn','click', ()=> $('#eventFiles')?.click());
on('#eventFiles','change', ()=> {
  const btn = $('#pickFilesBtn');
  const fi  = $('#eventFiles');
  if (btn && fi) {
    btn.textContent = fi.files?.length
      ? `Archivo adjunto (${fi.files.length})`
      : 'Archivo adjunto';
  }
});

// Sheets nuevos: Cumpleaños
on('#closeBirthdaySheet','click', ()=> closeSheetById('addBirthdaySheet'));
on('#cancelBirthdayBtn','click', ()=> closeSheetById('addBirthdaySheet'));
on('#birthdayForm','submit', (ev)=> saveEventFromForm(ev, 'Cumpleaños'));

// Sheets nuevos: Tarea
on('#closeTaskSheet','click', ()=> closeSheetById('addTaskSheet'));
on('#cancelTaskBtn','click', ()=> closeSheetById('addTaskSheet'));
on('#taskForm','submit', (ev)=> saveEventFromForm(ev, 'Tarea'));

// ===== Navegación por gestos (swipe) — versión Pointer Events =====
function addSwipeNavigation(){
  if (addSwipeNavigation._enabled) return;

  const isCoarse = window.matchMedia('(pointer: coarse)').matches;
  const smallScreen = window.matchMedia('(max-width: 1280px)').matches;
  if (!(isCoarse && smallScreen)) return;

  addSwipeNavigation._enabled = true;

  const targets = ['#calendarGrid','#timeGrid','#timeDaysHeader','#monthView','#timeView']
    .map(sel => document.querySelector(sel))
    .filter(Boolean);

  const touch = { active:false, startX:0, startY:0, startTime:0, id:null };

  // --- Pointer Events (Android/modern iOS) ---
  const onPointerDown = (e)=>{
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    touch.active = true;
    touch.startX = e.clientX;
    touch.startY = e.clientY;
    touch.startTime = performance.now();
    touch.id = e.pointerId;
    // Asegura que seguimos recibiendo los move/up aunque haya scroll
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e)=>{
  if (!touch.active || (e.pointerId !== touch.id)) return;
  const dx = e.clientX - touch.startX;
  const dy = e.clientY - touch.startY;

  // Gesto horizontal claro → bloqueo scroll
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10){
    e.preventDefault();
  } 
};

  const onPointerUp = (e)=>{
    if (!touch.active || (e.pointerId !== touch.id)) return;
    const dt = performance.now() - touch.startTime;
    const dx = e.clientX - touch.startX;
    const dy = e.clientY - touch.startY;
    touch.active = false; touch.id = null;

    const THRESHOLD = 60, SLOPE = 1.2, MAX_DT = 600;
if (dt < MAX_DT) {
  const horiz = Math.abs(dx) > THRESHOLD && Math.abs(dx) > Math.abs(dy)*SLOPE;
  if (horiz) { dx < 0 ? swipeNext() : swipePrev(); }
}
  };

  const onPointerCancel = ()=>{ touch.active = false; touch.id = null; };

  targets.forEach(el=>{
    el.addEventListener('pointerdown',  onPointerDown,  { passive:true,  capture:true });
    el.addEventListener('pointermove',  onPointerMove,  { passive:false, capture:true });
    el.addEventListener('pointerup',    onPointerUp,    { passive:true,  capture:true });
    el.addEventListener('pointercancel',onPointerCancel,{ passive:true,  capture:true });
  });

  // --- Fallback para navegadores sin Pointer Events (iOS muy viejo) ---
  if (!('PointerEvent' in window)) {
    const onStart = (e)=>{
      if (!e.touches || e.touches.length !== 1) return;
      const t = e.touches[0];
      touch.active = true; touch.startX = t.clientX; touch.startY = t.clientY; touch.startTime = Date.now();
    };
    const onMove = (e)=>{
  if (!touch.active) return;
  const t = e.touches[0];
  const dx = t.clientX - touch.startX;
  const dy = t.clientY - touch.startY;

  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
    e.preventDefault();                            // horizontal
  }
};

const onEnd = (e)=>{
  if (!touch.active) return;
  const t = e.changedTouches && e.changedTouches[0];
  const endX = t ? t.clientX : touch.startX;
  const endY = t ? t.clientY : touch.startY;
  const dx = endX - touch.startX;
  const dy = endY - touch.startY;
  const dt = Date.now() - touch.startTime;
  touch.active = false;

  const THRESHOLD = 60, SLOPE = 1.2;
  const horiz = dt < 600 && Math.abs(dx) > THRESHOLD && Math.abs(dx) > Math.abs(dy)*SLOPE;
if (horiz) { dx < 0 ? swipeNext() : swipePrev(); }
};

    targets.forEach(el=>{
      el.addEventListener('touchstart', onStart, { passive:true,  capture:true });
      el.addEventListener('touchmove',  onMove,  { passive:false, capture:true });
      el.addEventListener('touchend',   onEnd,   { passive:true,  capture:true });
      el.addEventListener('touchcancel',()=>{ touch.active=false; }, { passive:true, capture:true });
    });
  }
}
 
function swipePrev(){
  switch (state.viewMode) {
    case 'month': {
      const nextDate = new Date(
        state.currentMonth.getFullYear(),
        state.currentMonth.getMonth() - 1,
        1
      );
      // mismo slide que con el botón «Mes anterior»
      animateMonth('prev', () => {
        state.currentMonth = nextDate;
        renderCalendar(state.currentMonth);
      });
      break;
    }
    case 'week':
      state.selectedDate = shiftDate(state.selectedDate || new Date(), -7);
      renderTimeView('week', state.selectedDate);
      break;
    case '3days':
      state.selectedDate = shiftDate(state.selectedDate || new Date(), -3);
      renderTimeView('3days', state.selectedDate);
      break;
    case 'day':
    default:
      state.selectedDate = shiftDate(state.selectedDate || new Date(), -1);
      renderTimeView('day', state.selectedDate);
      break;
  }
}

function swipeNext(){
  switch (state.viewMode) {
    case 'month': {
      const nextDate = new Date(
        state.currentMonth.getFullYear(),
        state.currentMonth.getMonth() + 1,
        1
      );
      // mismo slide que con el botón «Mes siguiente»
      animateMonth('next', () => {
        state.currentMonth = nextDate;
        renderCalendar(state.currentMonth);
      });
      break;
    }
    case 'week':
      state.selectedDate = shiftDate(state.selectedDate || new Date(), +7);
      renderTimeView('week', state.selectedDate);
      break;
    case '3days':
      state.selectedDate = shiftDate(state.selectedDate || new Date(), +3);
      renderTimeView('3days', state.selectedDate);
      break;
    case 'day':
    default:
      state.selectedDate = shiftDate(state.selectedDate || new Date(), +1);
      renderTimeView('day', state.selectedDate);
      break;
  }
}


function shiftDate(baseDate, days){
  const d = new Date(baseDate || new Date());
  d.setDate(d.getDate() + days);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// ===================== Línea “ahora” (vista de tiempo) =====================
let _nowLineTimer = null;
function paintNowLine(){
  const grid = $('#timeGrid'); if (!grid) return;
  const now = new Date(), anchor = state.selectedDate || new Date();
  // Solo si estamos viendo HOY
  if (now.toDateString() !== anchor.toDateString()){
    grid.querySelector('.now-line')?.remove();
    return;
  }
  let line = grid.querySelector('.now-line');
  if (!line){
    line = document.createElement('div');
    line.className = 'now-line';
    const dot = document.createElement('div');
    dot.className = 'now-dot';
    line.append(dot);
    grid.append(line);
  }
  const minutes = now.getHours()*60 + now.getMinutes();
const inRange = minutes >= DAY_START_H*60 && minutes <= DAY_END_H*60;
if (!inRange) { grid.querySelector('.now-line')?.remove(); return; }

const top = (minutes - (DAY_START_H*60)) * PX_PER_MIN;
line.style.top = Math.max(0, top) + 'px';
}
function ensureNowLineTimer(){
  if (_nowLineTimer) return;
  _nowLineTimer = setInterval(paintNowLine, 60000);
}
window.addEventListener('resize', paintNowLine);
document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') paintNowLine(); });

/* ===================== Importación desde Google Calendar (con adjuntos de Drive) ===================== */
/* Requisitos:
   - Habilitar en Google Cloud Console las APIs: "Google Calendar API" y "Google Drive API".
   - Crear un OAuth 2.0 Client ID (tipo Web) y añadir tu origen HTTPS a "Authorized JavaScript origins".
   - Sustituir GOOGLE_CLIENT_ID por el tuyo.
*/
const GOOGLE_CLIENT_ID = '873672608509-dgmd92v2k8fdesd7n5vkg46p2cq8eug4.apps.googleusercontent.com';

// Scopes mínimos: leer eventos + leer ficheros adjuntos de Drive
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.events', // escribir/actualizar eventos
  'https://www.googleapis.com/auth/drive.file'       // subir/gestionar ficheros creados por la app
].join(' ');

const ALLDAY_DEFAULT_HOUR = 10; // hora por defecto para eventos de día completo (0..23)

let _googleAccessToken = null;
let _tokenClient = null;

function haveGIS(){
  return !!(window.google && google.accounts && google.accounts.oauth2);
}
function initTokenClient(){
  if (_tokenClient || !haveGIS()) return _tokenClient;
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GOOGLE_SCOPES,
    callback: (resp) => {}, // se sobreescribe en cada request
    error_callback: (err) => { console.error('GIS error_callback:', err); }
  });
  return _tokenClient;
}

/**
 * ensureGoogleToken({ interactive })
 * - interactive=false → intenta recuperar token en silencio (sin prompts)
 * - interactive=true  → puede mostrar consentimiento (úsalo en clicks del usuario)
 */
function ensureGoogleToken({ interactive = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')) {
      const msg = 'Falta GOOGLE_CLIENT_ID (tipo Web).';
      console.error(msg); return reject(new Error(msg));
    }
    if (_googleAccessToken) return resolve(_googleAccessToken);
    if (!haveGIS()) {
      const msg = 'Google Identity Services no cargado.';
      console.error(msg); return reject(new Error(msg));
    }

    const client = initTokenClient();
    client.callback = (resp) => {
      if (resp && resp.access_token) {
        _googleAccessToken = resp.access_token;
        try { ensureAutoSyncTimer(); } catch {}
        return resolve(_googleAccessToken);
      }
      const err = resp?.error || 'Respuesta sin access_token';
      reject(new Error(err));
    };

    try {
      client.requestAccessToken({
        prompt: interactive ? 'consent' : '' // ← silencioso si no es interactivo
      });
    } catch (e) {
      reject(e);
    }
  });
}


const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function driveUploadMultipart(file, { name, mimeType } = {}) {
  const boundary = '-------314159265358979323846';
  const metadata = {
    name: name || file.name || 'archivo',
    mimeType: mimeType || file.type || 'application/octet-stream'
    // si quieres carpeta, añade: parents: ['<FOLDER_ID>']
  };
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelim = `\r\n--${boundary}--`;

  const body = new Blob([
    delimiter,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    delimiter,
    `Content-Type: ${metadata.mimeType}\r\n\r\n`,
    file,
    closeDelim
  ], { type: `multipart/related; boundary=${boundary}` });

  const res = await gapiFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  if (!res.ok) throw new Error('Drive upload failed');
  return res.json(); // { id, name, mimeType, ... }
}

async function makeDriveFilePublic(fileId){
  await gapiFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ role:'reader', type:'anyone' })
  });
}

async function ensureDriveIdsForEventAttachments(localEventId){
  const atts = await getAttachmentsByEvent(localEventId);
  const out = [];
  for (const a of atts){
    // si ya lo subimos antes, guardamos a.gdriveId en IndexedDB
    if (!a.gdriveId){
      const up = await driveUploadMultipart(a.blob, { name: a.name, mimeType: a.type });
      a.gdriveId = up.id;
      // si quieres que sean públicos:
      // try { await makeDriveFilePublic(a.gdriveId); } catch{}
      await tx(['attachments'], 'readwrite', (s)=> s.put(a));
    }
    out.push({ fileId: a.gdriveId, title: a.name, mimeType: a.type });
  }
  return out;
}

async function gapiFetch(url, opts = {}, retry = 0) {
  const token = await ensureGoogleToken({ interactive: false });
  const doFetch = () => fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
  });

  let res = await doFetch();

  // token caducado → reintenta una vez con token nuevo
  if (res.status === 401) {
    _googleAccessToken = null;
    const token2 = await ensureGoogleToken();
    res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token2}` }
    });
  }

  // cuotas / rate limit → backoff exponencial hasta 5 intentos
  if ((res.status === 429 || res.status === 403) && retry < 5) {
    const wait = (2 ** retry) * 500 + Math.random() * 300;
    await sleep(wait);
    return gapiFetch(url, opts, retry + 1);
  }
  return res;
}


/* ---------- UI en el drawer: Conectar + Importar ---------- */
function injectGoogleImportUI(){
  const drawer = document.getElementById('drawer');
  if (!drawer || document.getElementById('gcalImportBtn')) return;

  const sec = document.createElement('div');
  sec.className = 'drawer-section';
  sec.innerHTML = `
    <h3>Google Calendar</h3>
    <div style="display:flex; gap:.5rem; flex-wrap:wrap">
      <button id="gcalAuthBtn" class="small">Conectar con Google</button>
      <button id="gcalImportBtn" class="small">Importar (2009 → hoy)</button>
    </div>
    <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem">
      <button id="gcalPushBtn" class="small">Sincronizar a Google (subir cambios)</button>
    </div>
    <p class="muted" style="margin:.5rem 0 0;font-size:.85rem">
  La importación trae adjuntos de Drive. La sincronización sube altas/cambios (sin borrar salvo que lo actives) y
  sube adjuntos locales a tu Drive, enlazándolos en Google Calendar.
</p>
  `;
  drawer.appendChild(sec);

  const authBtn  = sec.querySelector('#gcalAuthBtn');
  const importBtn= sec.querySelector('#gcalImportBtn');
  const pushBtn  = sec.querySelector('#gcalPushBtn');

  const rememberWrap = document.createElement('label');
rememberWrap.style.cssText='display:flex;align-items:center;gap:.5rem;margin-top:.25rem;cursor:pointer;font-size:.9rem';
rememberWrap.innerHTML = `<input id="gcalRemember" type="checkbox"> Mantener sesión iniciada`;
sec.appendChild(rememberWrap);

const rememberChk = rememberWrap.querySelector('#gcalRemember');
rememberChk.checked = (localStorage.getItem('google.remember') === '1');
rememberChk.addEventListener('change', ()=> {
  localStorage.setItem('google.remember', rememberChk.checked ? '1' : '0');
});

  // dentro de injectGoogleImportUI, tras crear pushBtn:
const autoWrap = document.createElement('label');
autoWrap.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.5rem;cursor:pointer;font-size:.9rem';
autoWrap.innerHTML = `<input id="gcalAutoSync" type="checkbox"> Auto-sync (subir cambios)`;
sec.appendChild(autoWrap);

const autoChk = autoWrap.querySelector('#gcalAutoSync');
autoChk.checked = (localStorage.getItem('autoSync.enabled') === '1');
autoChk.addEventListener('change', () => {
  setAutoSyncEnabled(!!autoChk.checked);
  showToast( autoChk.checked ? 'Auto-sync activado' : 'Auto-sync desactivado' );
});

  authBtn.addEventListener('click', async () => {
  try {
    await ensureGoogleToken({ interactive: true });
    alert('Conexión OK ✅');
  } catch (e) {
    console.error(e);
    alert('No se pudo conectar con Google');
  }
});

importBtn.addEventListener('click', async () => {
  try {
    importBtn.disabled = true;
    importBtn.textContent = 'Importando… 0';
    const { imported, duplicates, attsSaved } = await importAllFromGoogle({
      calendarId: 'primary',
      sinceISO: '2009-01-01T00:00:00Z',
      onProgress: ({ imported }) => { importBtn.textContent = `Importando… ${imported}`; },
      interactive: true
    });
    alert(`Importación completada.\nEventos importados: ${imported}\nDuplicados omitidos: ${duplicates}\nAdjuntos guardados: ${attsSaved}`);
    reRender();
  } catch (e) {
    console.error(e);
    alert('Hubo un problema al importar desde Google Calendar.\n' + (e?.message || ''));
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = 'Importar (2009 → hoy)';
  }
});

pushBtn.addEventListener('click', async () => {
  try {
    pushBtn.disabled = true;
    pushBtn.textContent = 'Sincronizando…';
    const { created, updated, failed } = await pushAllDirtyToGoogle({
      calendarId: 'primary',
      interactive: true
    });
    alert(`Sincronización terminada.\nCreados: ${created}\nActualizados: ${updated}\nFallidos: ${failed}`);
    reRender();
  } catch (e) {
    console.error(e);
    alert('No se pudo sincronizar con Google Calendar.\n' + (e?.message || ''));
  } finally {
    pushBtn.disabled = false;
    pushBtn.textContent = 'Sincronizar a Google (subir cambios)';
  }
});

  const delWrap = document.createElement('label');
delWrap.style.cssText='display:flex;align-items:center;gap:.5rem;margin-top:.25rem;cursor:pointer;font-size:.9rem';
delWrap.innerHTML = `<input id="gcalDeleteMirror" type="checkbox"> Borrar también en Google`;
sec.appendChild(delWrap);

const delChk = delWrap.querySelector('#gcalDeleteMirror');
delChk.checked = (localStorage.getItem('gcal.deleteMirror') === '1');
delChk.addEventListener('change', ()=> {
  localStorage.setItem('gcal.deleteMirror', delChk.checked ? '1' : '0');
});
}

/* ---------- Importar todos los eventos (expande recurrencias con singleEvents=true) ---------- */
async function mapLimit(arr, limit, mapper){
  const ret = [];
  let i = 0;
  const workers = Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      ret[idx] = await mapper(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

async function importAllFromGoogle({
  calendarId = 'primary',
  sinceISO = '2009-01-01T00:00:00Z',
  horizonYears = 2,          // ← cuantos años hacia adelante traemos
  onProgress,
  interactive = false   // ← nuevo
} = {}) {
  await ensureGoogleToken({ interactive });

  let pageToken = null;
  let imported = 0, duplicates = 0, attsSaved = 0;

  // ---- NUEVO: timeMax en el futuro ----
  const tm = new Date();
  tm.setFullYear(tm.getFullYear() + horizonYears);
  const timeMaxISO = tm.toISOString();

  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('timeMin', sinceISO);
    url.searchParams.set('timeMax', timeMaxISO);  // ← antes era "hoy"
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '2500');
    url.searchParams.set(
  'fields',
  'items(id,status,summary,location,description,start,end,updated,attachments(fileId,title,mimeType)),nextPageToken'
);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await gapiFetch(url.toString());
    if (!res.ok) throw new Error('Calendar API error: ' + res.status);
    const data = await res.json();

    for (const ev of (data.items || [])) {
      if (ev.status === 'cancelled') continue;

      const { wasDuplicate, localEvent } = await upsertLocalFromGoogleEvent(ev);
      wasDuplicate ? duplicates++ : imported++;

      if (!wasDuplicate && Array.isArray(ev.attachments) && ev.attachments.length) {
        const attaches = ev.attachments.filter(a => a.fileId);
        await mapLimit(attaches, 3, async (a) => {
          const blobFile = await downloadDriveBlob(a.fileId);
          if (!blobFile) return;
          const name = (blobFile.name || a.title || 'archivo');
          const mime = (blobFile.type || a.mimeType || 'application/octet-stream');
          const ok = await saveAttachmentBlob(localEvent.id, name, mime, blobFile, a.fileId);
          if (ok) attsSaved++;
        });
      }

      onProgress?.({ imported, duplicates, attsSaved });
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return { imported, duplicates, attsSaved };
}

/* ---------- Guardar un evento de Google en IndexedDB (sin duplicar) ---------- */
async function upsertLocalFromGoogleEvent(gev){
  const localId = `gcal:${gev.id}`;
  const notes = gcalDescToPlain(gev.description || '');

  // ¿existe?
  const existing = await new Promise(resolve => {
    tx(['events'],'readonly',(store)=>{
      const req = store.get(localId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  });

// Fecha/hora (respetando all-day)
let allDay = false;
let date, time, startDate, endDate, startTime, endTime;

if (gev?.start?.date) {
  // Evento de día completo
  allDay = true;
  startDate = gev.start.date;
  // Google usa end.date EXCLUSIVO → restamos 1 día para tener el fin INCLUSIVO local
  endDate = (gev.end && gev.end.date) ? addDaysISO(gev.end.date, -1) : startDate;

  // Compat con vistas
  date = startDate;
  time = '00:00';
  startTime = '00:00';
  endTime = '23:59';
} else if (gev?.start?.dateTime) {
  const sdt = new Date(gev.start.dateTime);
  const edt = gev.end?.dateTime ? new Date(gev.end.dateTime) : new Date(sdt.getTime() + 60*60000);

  startDate = ymd(sdt);
  startTime = `${pad2(sdt.getHours())}:${pad2(sdt.getMinutes())}`;
  endDate   = ymd(edt);
  endTime   = `${pad2(edt.getHours())}:${pad2(edt.getMinutes())}`;

  date = startDate;
  time = startTime;
} else {
  // Fallback
  const sdt = new Date();
  const edt = new Date(sdt.getTime() + 60*60000);
  startDate = ymd(sdt); endDate = ymd(edt);
  startTime = `${pad2(sdt.getHours())}:${pad2(sdt.getMinutes())}`;
  endTime   = `${pad2(edt.getHours())}:${pad2(edt.getMinutes())}`;
  date = startDate; time = startTime;
}

const title = (gev.summary || '').trim();
const location = (gev.location || '').trim();
const category = 'Citas';
const categoryOther = '';
const payload = {
  id: localId,
  date, time, title, location,
  client: '',
  category, categoryOther,
  monthKey: date.slice(0,7),
  createdAt: existing?.createdAt || Date.now(),
  gcalUpdated: gev.updated || null,
  gcalId: gev.id,
  needsGCalSync: false,
  allDay,
  startDate, startTime,
  endDate, endTime,
  notes
};

  if (!existing) {
  const same = await (async () => {
    let found = null;
    await tx(['events'], 'readonly', (store) => {
      const idx = store.index('by_date');
      const req = idx.openCursor(IDBKeyRange.only(payload.date));
      req.onsuccess = () => {
        const cur = req.result; if (!cur) return;
        const e = cur.value;
        if (e.time === payload.time && (e.title||'').trim().toLowerCase() === payload.title.toLowerCase()) {
          found = e;
        } else { cur.continue(); }
      };
    });
    return found;
  })();
  if (same) {
    return { wasDuplicate: true, localEvent: same };
  }
}

  // Si existe y no hay cambios → lo tratamos como duplicado
  if (existing && existing.gcalUpdated === payload.gcalUpdated) {
   const needsNotesBackfill = (!existing.notes || !existing.notes.trim()) && notes;
   if (!needsNotesBackfill) {
     return { wasDuplicate: true, localEvent: existing };
   }
   // sigue para hacer put(payload) y rellenar notas
  }

  await tx(['events'],'readwrite',(eventsStore)=> eventsStore.put(payload));
  return { wasDuplicate: false, localEvent: payload };
}


async function getDriveMeta(fileId){
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=mimeType,name,size`;
  const res = await gapiFetch(url);
  if (!res.ok) return null;
  return res.json();
}

const DRIVE_EXPORT_MAP = {
  'application/vnd.google-apps.document':   'application/pdf',
  'application/vnd.google-apps.spreadsheet':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation':'application/pdf'
};

const GOOGLE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function addDaysISO(dateStr, days){
  const d = parseDateInput(dateStr);
  d.setDate(d.getDate() + (days||0));
  return ymd(d);
}

function toGCalPayload(e){
  const cat = (e.category === 'Otros' && e.categoryOther) ? e.categoryOther : e.category;
  const descriptionParts = [];
  if (e.notes) descriptionParts.push(e.notes);
  if (cat) descriptionParts.push(`Categoría: ${cat}`);
  const description = descriptionParts.join('\n');

  const base = {
    summary: e.title || '',
    location: e.location || '',
    description
  };

  if (e.allDay) {
    // Google usa end.date EXCLUSIVO → +1 día
    const endDate = addDaysISO(e.endDate || e.startDate || e.date, 1);
    base.start = { date: e.startDate || e.date };
    base.end   = { date: endDate };
  } else {
    const sDate = e.startDate || e.date;
    const sTime = e.startTime || e.time || '10:00';
    const eDate = e.endDate || sDate;
    const eTime = e.endTime || sTime;
    base.start  = { dateTime: `${sDate}T${sTime}:00`, timeZone: GOOGLE_TZ };
    base.end    = { dateTime: `${eDate}T${eTime}:00`, timeZone: GOOGLE_TZ };
  }

  // Si quieres mapear recordatorios desde e.alert, hazlo aquí (opcional)
  // base.reminders = { useDefault: true };

  return base;
}

function getRemoteIdForEvent(e){
  if (e?.gcalId) return e.gcalId;
  if (e?.id && String(e.id).startsWith('gcal:')) return String(e.id).slice(5);
  return null;
}

// ——— BORRADO EN GOOGLE SI EL EVENTO ESTÁ VINCULADO ———
async function deleteRemoteEventIfLinked(localEvtOrId, { calendarId='primary' } = {}) {
  const e = typeof localEvtOrId === 'string' ? await getEventById(localEvtOrId) : localEvtOrId;
  if (!e) return false;
  const remoteId = getRemoteIdForEvent(e);
  if (!remoteId) return false;

  // aquí queremos poder mostrar el prompt si hace falta
  await ensureGoogleToken({ interactive: true });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`;
  const res = await gapiFetch(url, { method:'DELETE' });
  if (res.status !== 204 && !res.ok) throw new Error('No se pudo borrar en Google');
  return true;
}

async function pushEventToGCal(localEvent, calendarId='primary'){
  await ensureGoogleToken();
  const urlBase = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const existingId = getRemoteIdForEvent(localEvent);
  const attachments = await ensureDriveIdsForEventAttachments(localEvent.id);
  const payload = { ...toGCalPayload(localEvent), ...(attachments.length ? { attachments } : {}) };
  const q = '?supportsAttachments=true';

  let res;
  if (existingId) {
    res = await gapiFetch(`${urlBase}/${encodeURIComponent(existingId)}${q}`, {
      method:'PATCH', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload)
    });
    if (res.status === 404) {
      res = await gapiFetch(`${urlBase}${q}&sendUpdates=none`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload)
      });
    }
  } else {
    res = await gapiFetch(`${urlBase}${q}&sendUpdates=none`, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload)
    });
  }

  if (!res.ok){
    const txt = await res.text().catch(()=> '');
    throw new Error(`Error Google ${res.status}: ${txt}`);
  }
  const g = await res.json();
  await tx(['events'],'readwrite',(store)=> {
    store.put({ ...localEvent, gcalId:g.id, gcalUpdated:g.updated, needsGCalSync:false });
  });
  return g;
}


async function pushAllDirtyToGoogle({
  calendarId = 'primary',
  quiet = false,
  interactive = false
} = {}) {
  // pedir token respetando modo
  await ensureGoogleToken({ interactive });

  const dirty = [];
  await tx(['events'], 'readonly', (store) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      const e = cur.value;
      if (e.needsGCalSync) dirty.push(e);
      cur.continue();
    };
  });

  let created = 0, updated = 0, failed = 0;
  for (const e of dirty){
    try {
      const hadRemote = !!getRemoteIdForEvent(e);
      await pushEventToGCal(e, calendarId);
      hadRemote ? updated++ : created++;
    } catch(err){
      console.warn('Falló subir evento', e, err);
      failed++;
    }
  }

  if (!quiet && (created || updated || failed)) {
    showToast(`Google sync: ${created} creados · ${updated} actualizados${failed? ` · ${failed} fallidos` : ''}`);
  }
  return { created, updated, failed };
}


/* ---------- Descargar un archivo de Drive por fileId ---------- */
async function downloadDriveBlob(fileId){
  const meta = await getDriveMeta(fileId);
  if (!meta) return null;

  // Docs/Sheets/Slides → export
  if (meta.mimeType && meta.mimeType.startsWith('application/vnd.google-apps.')) {
    const exportMime = DRIVE_EXPORT_MAP[meta.mimeType] || 'application/pdf';
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
    const res = await gapiFetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    const ext = exportMime.includes('spreadsheetml') ? '.xlsx' : '.pdf';
    const name = (meta.name || 'archivo') + ext;
    try { return new File([blob], name, { type: exportMime }); }
    catch { return new Blob([blob], { type: exportMime }); }
  }

  // Ficheros “normales” → descarga directa
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await gapiFetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const name = meta.name || 'archivo';
  const type = meta.mimeType || blob.type || 'application/octet-stream';
  try { return new File([blob], name, { type }); }
  catch { return new Blob([blob], { type }); }
}

/* ---------- Guardar blob como adjunto en IndexedDB (sin duplicar por fileId+eventId) ---------- */
async function saveAttachmentBlob(eventId, name, mime, blob, fileId){
  const attId = `gdrive:${fileId}:${eventId}`;
  let existed = false;
  await tx(['attachments'], 'readwrite', (attStore) => {
    const getReq = attStore.get(attId);
    getReq.onsuccess = () => {
      if (getReq.result) { existed = true; return; }
      attStore.put({ id: attId, eventId, name, type: mime || 'application/octet-stream', blob });
    };
  });
  return !existed;
}

function ensureSWUpdatePrompt() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;

    const showIfInstalled = (sw) => {
      if (!sw) return;
      const onState = () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('Actualización disponible', {
            actionLabel: 'Actualizar',
            onUndo: async () => { reg.waiting?.postMessage({ type:'SKIP_WAITING' }); },
            duration: 15000
          });
        }
      };
      // si ya está en installed disparamos, si no, esperamos
      if (sw.state === 'installed') onState();
      sw.addEventListener('statechange', onState);
    };

    if (reg.waiting) showIfInstalled(reg.waiting);
    if (reg.installing) showIfInstalled(reg.installing);

    reg.addEventListener('updatefound', () => showIfInstalled(reg.installing));
  });
}

let _autoSyncTimer = null;

function setAutoSyncEnabled(on){
  try { localStorage.setItem('autoSync.enabled', on ? '1' : '0'); } catch {}
  ensureAutoSyncTimer();
}

function ensureAutoSyncTimer(){
  // NO toques _nowLineTimer aquí
  clearInterval(_autoSyncTimer);

  const enabled = localStorage.getItem('autoSync.enabled') === '1';
  if (!enabled) return;

  if (!_googleAccessToken) {
    reauthGoogleSilentIfRemembered().catch(()=>{});
  }

  _autoSyncTimer = setInterval(async () => {
    try { await pushAllDirtyToGoogle({ calendarId: 'primary' }); } catch {}
  }, 3 * 60 * 1000);
}

async function reauthGoogleSilentIfRemembered(){
  if (localStorage.getItem('google.remember') !== '1') return;
  try {
    await ensureGoogleToken({ interactive: false });
  } catch (e) {
    // Si no hay sesión válida en cookies de Google, no molestamos al usuario.
    console.info('Silent auth falló (no sesión):', e?.error || e);
  }
}

/* ---------- (Opcional) Importar de todos tus calendarios, no solo "primary" ----------
   Llama a listCalendars() y recorre. Lo dejamos preparado por si lo quieres usar luego.
*/
async function listCalendars(){
  const url = 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250';
  const res = await gapiFetch(url);
  if (!res.ok) throw new Error('CalendarList error');
  const data = await res.json();
  return (data.items || []).map(c => ({ id:c.id, summary:c.summary, primary: !!c.primary }));
}

// ===================== Init =====================
function updateCornerBrand(){
  const img = document.getElementById('cornerBrand');
  if (!img) return;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  img.src = theme === 'dark' ? 'icons/logo-dark@3x.png' : 'icons/logo-light@3x.png';
}

function applyTheme(theme) {
  const html = document.documentElement;
  html.classList.add('theme-anim');
  html.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? 'Cambiar a Light' : 'Cambiar a Dark';
  localStorage.setItem('theme', theme);
  try { updateCornerBrand(); } catch (_) {}
  clearTimeout(applyTheme._tmr);
  applyTheme._tmr = setTimeout(() => html.classList.remove('theme-anim'), 420);
}

(async () => {
  try {
    if (navigator.storage?.persist) {
      await navigator.storage.persist();
    }
  } catch {}
})();

(async function init(){
  injectEnhancementStyles();
  injectToastStyles();
  injectAgendaStyles();
  injectSearchFullStyles();
  setPlatformClass();                 
  ensureSearchFullUI();
  injectMonthPickerStyles();
  ensureMonthPickerUI();
  hideLegacyNavArrows();
  injectHorizontalTagPills();
  injectTagPillsBlue();
  fixDarkTagColors();
  killMobileDots();
  injectTagsHardFixV3();
  injectMobilePillAntidote();
  nukeCountBadges();
  injectBiggerMonthCells();
  injectDenseTagText();
  injectEvenBiggerMonth();
  injectTighterTagMargins();

  document.getElementById('tags-v2-hard-reset')?.remove();
  document.getElementById('month-density-css')?.remove();
  document.getElementById('month-light-css')?.remove();
  document.getElementById('tag-color-fix')?.remove();
  document.getElementById('tags-pill-override')?.remove();

  if (document.body) {
  document.body.classList.add('tags-v2');
} else {
  window.addEventListener('DOMContentLoaded', () => document.body.classList.add('tags-v2'), { once:true });
}

  // light por defecto y vista “expandida” (solo títulos, como en la foto)
state.theme = localStorage.getItem('theme') || 'light';
applyTheme(state.theme);
state.monthDensity = localStorage.getItem('month.density') || 'expanded';
  applyMonthDensity();
  ensurePreviewCleanupOnce(); 


// botón/gesto para abrirlo
on('#monthDropBtn','click', (ev)=> { ev.stopPropagation(); toggleMonthPicker(); });

  state.db = await openDB();

  const today = new Date();
  state.currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  addSwipeNavigation();

  // Placeholder de búsqueda más agradable
  $('#searchInput')?.setAttribute('placeholder', 'Buscar… ej. “reunión”, “Madrid”, “Ana”');

  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const action = params.get('action');

  if (view === 'week' || view === '3days' || view === 'day') {
    setViewMode(view);
  } else {
    setViewMode('month');
  }

  if (action === 'new') openSheetNew();
  injectGoogleImportUI();
  ensureCategoryUI();  
  injectDrawerVersion();
  ensureSWUpdatePrompt();
  ensureAutoSyncTimer();

  await reauthGoogleSilentIfRemembered(); // 👈 intenta recuperar token sin prompts
  ensureAutoSyncTimer();                  // arrancará si hay token + autosync activado
  await checkForcedUpdate();                          // al cargar
  document.addEventListener('visibilitychange', ()=>{ // al volver a la pestaña
  if (document.visibilityState === 'visible') checkForcedUpdate();
});
setInterval(checkForcedUpdate, 6 * 60 * 60 * 1000); // cada 6h
})();

async function checkForcedUpdate(){
  const localVer = window.__APP_VERSION__;
  const persistedMin = localStorage.getItem('forceUpdate.min');
  if (persistedMin && cmpSemver(localVer, persistedMin) < 0){
    showUpdateGate(persistedMin, persistedMin);
    return;
  }

  try{
    const res = await fetch(VERSION_ENDPOINT + '?t=' + Date.now(), { cache:'no-store' });
    if (!res.ok) throw new Error('version fetch failed');
    const data = await res.json();
    const minReq = data.min || data.latest || localVer;

    // Gate obligatorio si estás por debajo de min
    if (cmpSemver(localVer, minReq) < 0){
      showUpdateGate(minReq, data.latest || minReq, data.notes || '');
      return;
    } else {
      hideUpdateGate();
    }

    // --- AVISO SUAVE si existe una latest superior, sin bloquear ---
    if (data.latest && cmpSemver(localVer, data.latest) < 0) {
      showToast(`Nueva versión ${data.latest} disponible`, {
        actionLabel: 'Actualizar',
        onUndo: async () => {
          const reg = await navigator.serviceWorker?.getRegistration();
          await reg?.update();
          reg?.waiting?.postMessage({ type:'SKIP_WAITING' });
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
          location.replace(location.pathname + '?u=' + Date.now());
        },
        duration: 15000
      });
    }
  }catch{
    // si no hay red y ya estaba forzado, seguirá bloqueado por persistedMin
  }
hideLegacyNavArrows();
}