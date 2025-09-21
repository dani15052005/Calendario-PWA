window.__APP_BOOT__ = 'OK';
console.log('[Calendario] JS cargado');
// ===== Versionado obligatorio =====
window.__APP_VERSION__ = '1.0.8';
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
  const pa = String(a).split('.').map(n=>parseInt(n||0,10));
  const pb = String(b).split('.').map(n=>parseInt(n||0,10));
  for (let i=0;i<3;i++){ const da=(pa[i]||0)-(pb[i]||0); if (da) return Math.sign(da); }
  return 0;
}
function qs(el){ return document.querySelector(el); }

function showUpdateGate(minReq, latest, notes){
  document.body.classList.add('update-block');
  const gate = qs('#updateGate');

  // 👉 si #updateGate NO está colgado directamente del <body>, muévelo
  if (gate && gate.parentNode !== document.body) {
    document.body.appendChild(gate);
  }

  qs('#currentVer').textContent  = `Actual: ${window.__APP_VERSION__}`;
  qs('#requiredVer').textContent = `Requerida: ${minReq}`;

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

function addMinutes(dateStr, timeStr, minutes){
  const dt = new Date(`${dateStr}T${timeStr || '00:00'}`);
  dt.setMinutes(dt.getMinutes() + (minutes||0));
  return {
    date: ymd(dt),
    time: `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`
  };
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

function injectDrawerVersion(){
  const el = document.getElementById('appVersionLabel');
  if (el) el.textContent = 'v' + (window.__APP_VERSION__ || '0.0.0');
}

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

// ===================== Estado =====================
const state = {
  db: null,
  theme: (localStorage.getItem('theme') || 'dark'),
  viewMode: 'month',
  currentMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  selectedDate: null,
  filters: new Set(['Trabajo','Tarea','Citas','Cumpleaños','Otros','Festivo']),
  holidaysCache: new Map(),
};

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
}
function closeDrawer() {
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

    on(cell, 'click', () => {
      state.selectedDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      setViewMode('day');
    });
    on(cell, 'keydown', (ev)=>{ if (ev.key==='Enter' || ev.key===' ') { ev.preventDefault(); state.selectedDate = d; setViewMode('day'); } });

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
      .sort((a, b) => a.time.localeCompare(b.time));

    for (const evt of dayEvts) {
      const tag = document.createElement('span');
      tag.className = `event-tag cat-${evt.category}`;
      tag.title = `${evt.time} · ${evt.title}`;

      // ⬇ aquí va el cambio de 3.7, PERO DENTRO del bucle
      const timeLabel = evt.allDay ? '' : (evt.time || '');
      tag.textContent = `${timeLabel ? timeLabel + ' ' : ''}${evt.title}`;

      box.append(tag);
    }
  }
});
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
  await tx(['events'], 'readonly', (store) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      const e = cur.value;
      if (map.has(e.date)) map.get(e.date).push(e);
      cur.continue();
    };
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

async function saveEvent(ev) {
  ev.preventDefault();

  const idInput = $('#eventId');
  const id = idInput?.value || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));

  const title = $('#eventTitle')?.value?.trim();
  const location = $('#eventLocation')?.value?.trim() || '';
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
    notes
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

  showToast(isEdit ? 'Evento actualizado' : 'Evento creado', {
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

  closeSheet();
  reRender();

  if (!silent) {
    showToast('Evento eliminado', {
      actionLabel: 'Deshacer',
      onUndo: async () => {
        // restaurar evento + todos los adjuntos tal cual estaban
        await restoreEventAndAttachments(snap.event, snap.atts);
        reRender();
      }
    });
  }
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
  const evt = { id, date: dateStr, time, title, location, client, category, categoryOther: '', monthKey: dateStr.slice(0,7), createdAt: Date.now() };

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
  const wrap = $('#attachmentsPreview'); if (!wrap) return;
  wrap.innerHTML = '';
  if (!eventId) return;
  const atts = await getAttachmentsByEvent(eventId);
  for (const a of atts) {
    const card = document.createElement('div'); card.className='attachment-card';
    const url = URL.createObjectURL(a.blob);
    if (a.type.startsWith('image/')) { const img = document.createElement('img'); img.src = url; img.alt = a.name; card.append(img); }
    else if (a.type.startsWith('video/')) { const vid = document.createElement('video'); vid.src = url; vid.controls = true; card.append(vid); }
    const name = document.createElement('div'); name.className='name'; name.textContent = a.name;
    card.append(name); wrap.append(card);
  }
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

function openSheetNew() {
  const baseDate = state.selectedDate || new Date();
  const base = ymd(baseDate);
  const startTime = '10:00';
  const plus = addMinutes(base, startTime, 60);

  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Añadir evento');
  $('#deleteEventBtn')?.classList.add('hidden');

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
}

async function openSheetForEdit(evt) {
  state.selectedDate = parseDateInput(evt.date);

  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Editar evento');
  $('#deleteEventBtn')?.classList.remove('hidden');

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
}

function openSheet() {
  const sheet = $('#addEventSheet'); if (!sheet) return;
  sheet.classList.remove('hidden');
  requestAnimationFrame(()=> sheet.classList.add('open'));
  attachOutsideCloseForSheet(sheet, closeSheet);
}
function closeSheet() {
  const sheet = $('#addEventSheet'); if (!sheet) return;
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
}
function closeSheetById(id){
  const sheet = document.getElementById(id); if (!sheet) return;
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
let searchTimer = null;
on('#searchInput','input', (e)=>{
  const raw = e.target.value;
  clearTimeout(searchTimer);
  if (!raw){ $('#searchResults')?.classList.remove('open'); return; }
  searchTimer = setTimeout(async ()=>{
    const items = await searchEventsAdvanced(raw);
    const parsed = parseAdvancedQuery(raw);
    showSearchResultsSafe(items, parsed.terms || []);
  }, 160);
});
on('#clearSearch','click', ()=>{
  const si = $('#searchInput'); if (!si) return;
  si.value = '';
  $('#searchResults')?.classList.remove('open');
  si.focus();
});
document.addEventListener('click', (ev)=>{
  const wrap = $('#searchWrap'), res = $('#searchResults');
  if (wrap && !wrap.contains(ev.target) && res && !res.contains(ev.target)) res.classList.remove('open');
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

// Mostrar input “Otros”
on('#eventCategory','change', (e)=>{
  if (e.target.value === 'Otros') $('#categoryOtherWrap')?.classList.remove('hidden');
  else $('#categoryOtherWrap')?.classList.add('hidden');
});

// ===== Navegación por gestos (swipe) SOLO móvil/tablet =====
function addSwipeNavigation(){
  if (addSwipeNavigation._enabled) return;

  const isCoarse   = window.matchMedia('(pointer: coarse)').matches;
  const noHover    = window.matchMedia('(hover: none)').matches;
  const smallScreen= window.matchMedia('(max-width: 1280px)').matches;

  if (!(isCoarse && noHover && smallScreen)) return;

  addSwipeNavigation._enabled = true;

  const touch = { active:false, startX:0, startY:0, startTime:0 };
  const targets = ['#monthView', '#timeView']
    .map(sel => document.querySelector(sel))
    .filter(Boolean);

  const onStart = (e) => {
    if (!e.touches || e.touches.length !== 1) return;
    const t = e.touches[0];
    touch.active = true;
    touch.startX = t.clientX;
    touch.startY = t.clientY;
    touch.startTime = Date.now();
  };

  const onMove = (e) => {
    if (!touch.active) return;
    const t = e.touches[0];
    const dx = t.clientX - touch.startX;
    const dy = t.clientY - touch.startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      e.preventDefault();
    }
  };

  const onEnd = (e) => {
    if (!touch.active) return;
    const dt = Date.now() - touch.startTime;
    const t = e.changedTouches && e.changedTouches[0];
    const endX = t ? t.clientX : touch.startX;
    const endY = t ? t.clientY : touch.startY;
    const dx = endX - touch.startX;
    const dy = endY - touch.startY;
    touch.active = false;

    const THRESHOLD = 60;
    const SLOPE = 1.2;
    if (dt < 600 && Math.abs(dx) > THRESHOLD && Math.abs(dx) > Math.abs(dy) * SLOPE) {
      if (dx < 0) swipeNext(); else swipePrev();
    }
  };

  targets.forEach(el => {
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove',  onMove,  { passive: false });
    el.addEventListener('touchend',   onEnd,   { passive: true });
    el.addEventListener('touchcancel', () => { touch.active = false; }, { passive: true });
  });
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
  'https://www.googleapis.com/auth/drive.readonly'
].join(' ');

const ALLDAY_DEFAULT_HOUR = 10; // hora por defecto para eventos de día completo (0..23)

let _googleAccessToken = null;
let _tokenClient = null;

function ensureGoogleToken() {
  return new Promise((resolve, reject) => {
    // Guardia: client id sin poner
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_ID.endsWith('.apps.googleusercontent.com')) {
      const msg = 'Falta GOOGLE_CLIENT_ID o no es de tipo Web (…apps.googleusercontent.com).';
      console.error(msg);
      alert(msg);
      return reject(new Error(msg));
    }

    if (_googleAccessToken) return resolve(_googleAccessToken);

    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      const msg = 'Google Identity Services no cargado. Revisa <script src="https://accounts.google.com/gsi/client"> y que no uses file://';
      console.error(msg);
      return reject(new Error(msg));
    }

    if (!_tokenClient) {
      _tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: GOOGLE_SCOPES,
        prompt: 'consent',
        callback: (resp) => {
          if (resp && resp.access_token) {
            _googleAccessToken = resp.access_token;
            return resolve(_googleAccessToken);
          }
          const err = resp?.error || 'Respuesta sin access_token';
          console.error('GIS callback error:', resp);
          alert('Error al obtener el token: ' + err);
          reject(new Error(err));
        },
        error_callback: (err) => {
  console.error('GIS error_callback:', err, 'origin:', location.origin);
  alert('Google OAuth error:\n' + JSON.stringify(err, null, 2) + '\nOrigen: ' + location.origin);
          reject(err);
        }
      });
    }

    // Importante: llamarlo tras un gesto del usuario (click del botón)
    _tokenClient.requestAccessToken();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gapiFetch(url, opts = {}, retry = 0) {
  const token = await ensureGoogleToken();
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
    <p class="muted" style="margin:.5rem 0 0;font-size:.85rem">
      Se importan eventos (incluye adjuntos de Drive). No se borra nada. Se evita duplicar.
    </p>
  `;
  drawer.appendChild(sec);

  const authBtn = sec.querySelector('#gcalAuthBtn');
  const importBtn = sec.querySelector('#gcalImportBtn');

  authBtn.addEventListener('click', async () => {
    try { await ensureGoogleToken(); alert('Conexión OK ✅'); }
    catch (e) { console.error(e); alert('No se pudo conectar con Google'); }
  });

  importBtn.addEventListener('click', async () => {
  try {
    importBtn.disabled = true;
    importBtn.textContent = 'Importando… 0';
    const { imported, duplicates, attsSaved } = await importAllFromGoogle({
      calendarId: 'primary',
      sinceISO: '2009-01-01T00:00:00Z',
      onProgress: ({ imported }) => {
        importBtn.textContent = `Importando… ${imported}`;
      }
    });
    alert(`Importación completada.\nEventos importados: ${imported}\nDuplicados omitidos: ${duplicates}\nAdjuntos guardados: ${attsSaved}`);
    (state.viewMode === 'month')
      ? renderCalendar(state.currentMonth)
      : renderTimeView(state.viewMode, state.selectedDate || new Date());
  } catch (e) {
    console.error(e);
    alert('Hubo un problema al importar desde Google Calendar.');
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = 'Importar (2009 → hoy)';
  }
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

async function importAllFromGoogle({ calendarId = 'primary', sinceISO = '2009-01-01T00:00:00Z', onProgress } = {}){
  await ensureGoogleToken();

  let pageToken = null;
  let imported = 0, duplicates = 0, attsSaved = 0;
  const timeMax = new Date().toISOString();

  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('timeMin', sinceISO);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true'); // expande las series
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '2500');
    url.searchParams.set('fields',
      'items(id,status,summary,location,start,end,updated,attachments(fileId,title,mimeType)),nextPageToken'
    );
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await gapiFetch(url.toString());
    if (!res.ok) throw new Error('Calendar API error: '+res.status);
    const data = await res.json();

    for (const ev of (data.items || [])) {
      if (ev.status === 'cancelled') continue;

      const { wasDuplicate, localEvent } = await upsertLocalFromGoogleEvent(ev);
      wasDuplicate ? duplicates++ : imported++;

      // Adjuntos Drive (concurrencia limitada)
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

  // ¿existe?
  const existing = await new Promise(resolve => {
    tx(['events'],'readonly',(store)=>{
      const req = store.get(localId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  });

  // Fecha/hora
  let dt;
  if (gev?.start?.dateTime) {
    dt = new Date(gev.start.dateTime);
  } else if (gev?.start?.date) {
    const [y,m,d] = gev.start.date.split('-').map(Number);
    dt = new Date(y, m-1, d, ALLDAY_DEFAULT_HOUR, 0, 0);
  } else {
    dt = new Date();
  }

  const date = `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
  const time = `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
  const title    = (gev.summary || '(Sin título)').trim();
  const location = (gev.location || '').trim();

  // Categoría heurística
  const lowerSum = title.toLowerCase();
  let category = 'Citas', categoryOther = '';
  if (/\bcumple|birthday\b/.test(lowerSum)) category = 'Cumpleaños';
  else if (/\btarea|task|todo\b/.test(lowerSum)) category = 'Tarea';
  else if (/\bwork|trabajo|proyecto\b/.test(lowerSum)) category = 'Trabajo';

  const payload = {
    id: localId,
    date, time, title, location,
    client: '',
    category, categoryOther,
    monthKey: date.slice(0,7),
    createdAt: existing?.createdAt || Date.now(),
    gcalUpdated: gev.updated || null
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
    return { wasDuplicate: true, localEvent: existing };
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
  applyTheme(state.theme);
  try { updateCornerBrand(); } catch (_) {}

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
  injectDrawerVersion();
  ensureSWUpdatePrompt();
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
}