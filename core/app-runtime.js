window.__APP_BOOT__ = 'OK';
console.log('[Calendario] JS cargado');
// ===== Versionado obligatorio =====
window.__APP_VERSION__ = '1.2.19';
const VERSION_ENDPOINT = './app-version.json';
const EXPECTED_SUPABASE_PROJECT_URL = 'https://hqwjpjlawxrmxfcyfdbx.supabase.co';
const OWNER_EMAIL_FALLBACK = 'andres5871@gmail.com';
const GOOGLE_OAUTH_SIGNIN_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.file'
].join(' ');

let _authSupabase = null;
let _authBootDone = false;
let _authGateReady = false;
let _authBlockedByEmail = false;
let _supabaseUserRowEnsuredFor = null;
let _supabaseDebugLogged = false;
let _logoutInProgress = false;
let _googleSyncBlocked = true;
let _googleSyncInFlight = false;
let _syncAbortRequested = false;
let _lastGoogleSyncAtMs = 0;
let _autoSyncTimer = null;
let _googleApiMutexTail = Promise.resolve();
let _googleAbortController = null;
let _googleTokenOwnerVerifiedFor = null;
let _googleTokenOwnerEmail = null;
let _googleLinkColumnsUnifiedLogged = false;
let isGoogleConnected = false;
let notificationsEnabled = false;
let _writeLockTail = Promise.resolve();
let _writeLockInFlight = false;
let _writeLockOwnerToken = null;
let _writeLockDepth = 0;
let _syncWriteLockToken = null;
let _syncWriteBarrierActive = false;
let _flushOutboxInFlight = null;
const OUTBOX_STORE = 'outbox';
const OUTBOX_MAX_RETRIES = 6;
const OUTBOX_BASE_BACKOFF_MS = 1200;
const AGENDA_VIRTUALIZATION_THRESHOLD = 500;
const AGENDA_VIRTUAL_OVERSCAN_ROWS = 20;
const AGENDA_EST_EVENT_ROW_PX = 72;
const AGENDA_EST_DAY_HEAD_ROW_PX = 40;
const SYNC_STATUS_DEFAULT = Object.freeze({
  state: 'ok',
  lastSuccessAt: null,
  outboxPending: 0,
  detail: ''
});
const syncStatus = {
  ...SYNC_STATUS_DEFAULT
};
let _lastOutboxToastAt = 0;
const DEFAULT_GOOGLE_CALENDAR_ENTRY = Object.freeze({
  id: 'primary',
  summary: 'Principal',
  primary: true
});
const LOCAL_DELETE_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
const _localDeletedEventTombstones = new Map();
const CALENDAR_MODULES = window.CalendarModules || {};
const MODULE_UTILS = CALENDAR_MODULES.utils || {};
const MODULE_CORE_STATE = CALENDAR_MODULES.coreState || {};
const MODULE_CORE_AUTH = CALENDAR_MODULES.coreAuth || {};
const MODULE_DATA_SUPABASE = CALENDAR_MODULES.dataSupabase || {};
const MODULE_ATTACHMENTS_DRIVE = CALENDAR_MODULES.attachmentsDrive || {};
const MODULE_REMINDERS = CALENDAR_MODULES.reminders || {};
const MODULE_SYNC_RECONCILE = CALENDAR_MODULES.syncReconcile || {};

function formatSyncTimestamp(value) {
  if (!value) return '--';
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return '--';
  try {
    return new Intl.DateTimeFormat('es-ES', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(ts));
  } catch (err) {
    void err;
    return '--';
  }
}

function getSyncStatusPillElement() {
  return document.getElementById('syncStatusPill');
}

function renderSyncStatusPill() {
  const pill = getSyncStatusPillElement();
  if (!pill) return;
  const state = String(syncStatus.state || 'ok').trim().toLowerCase();
  pill.dataset.state = state;
  const detail = String(syncStatus.detail || '').trim();
  const last = formatSyncTimestamp(syncStatus.lastSuccessAt);
  const pending = Math.max(0, Number(syncStatus.outboxPending || 0));
  const pendingLabel = `Pendientes: ${pending}`;

  if (state === 'syncing') {
    pill.textContent = detail ? `Sincronizando · ${detail} · ${pendingLabel}` : `Sincronizando · ${pendingLabel}`;
    return;
  }
  if (state === 'offline') {
    pill.textContent = `Sin conexión · ${pendingLabel} · Último sync: ${last}`;
    return;
  }
  if (state === 'error') {
    pill.textContent = detail ? `Error sync · ${detail} · ${pendingLabel}` : `Error sync · ${pendingLabel}`;
    return;
  }
  pill.textContent = `Sync OK · ${pendingLabel} · Último: ${last}`;
}

function setSyncStatus(state, { detail = '', lastSuccessAt = undefined } = {}) {
  syncStatus.state = String(state || 'ok').trim().toLowerCase();
  syncStatus.detail = String(detail || '').trim();
  if (lastSuccessAt !== undefined) {
    syncStatus.lastSuccessAt = lastSuccessAt ? Number(lastSuccessAt) : null;
  }
  renderSyncStatusPill();
}

function setSyncStatusLastSuccess(atMs = Date.now()) {
  syncStatus.lastSuccessAt = Number(atMs) || Date.now();
  if (syncStatus.state !== 'offline' && syncStatus.state !== 'error') {
    syncStatus.state = 'ok';
    syncStatus.detail = '';
  }
  renderSyncStatusPill();
}

async function refreshSyncStatusOutboxCount() {
  try {
    const pending = await getOutboxCount();
    syncStatus.outboxPending = Math.max(0, Number(pending || 0));
  } catch (err) {
    void err;
  }
  renderSyncStatusPill();
}

async function waitForWriteLockIdle({ timeoutMs = 12000, pollMs = 25 } = {}) {
  const start = Date.now();
  while (true) {
    await _writeLockTail.catch(() => {});
    if (!_writeLockInFlight) return true;
    if ((Date.now() - start) > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function withWriteLock(fn, {
  operation = 'write',
  token = null,
  source = 'local'
} = {}) {
  if (typeof fn !== 'function') {
    throw new Error('withWriteLock requiere una funcion');
  }

  const writeSource = String(source || 'local').trim().toLowerCase();
  if (writeSource !== 'sync') {
    while (_syncWriteBarrierActive) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  if (token && _writeLockOwnerToken && token === _writeLockOwnerToken) {
    _writeLockDepth += 1;
    try {
      return await fn();
    } finally {
      _writeLockDepth = Math.max(0, _writeLockDepth - 1);
    }
  }

  const ownerToken = token || Symbol(operation);
  const run = async () => {
    _writeLockOwnerToken = ownerToken;
    _writeLockDepth = 1;
    _writeLockInFlight = true;
    try {
      return await fn();
    } finally {
      _writeLockDepth = 0;
      _writeLockOwnerToken = null;
      _writeLockInFlight = false;
    }
  };

  const chained = _writeLockTail.then(run, run);
  _writeLockTail = chained.then(
    () => undefined,
    () => undefined
  );
  return chained;
}

function getAuthHelpers(){
  const fallback = {
    normalizeEmail: (email) => String(email || '').trim().toLowerCase(),
    isOwnerEmail: (email, ownerEmail) => {
      const norm = (value) => String(value || '').trim().toLowerCase();
      return norm(email) === norm(ownerEmail);
    }
  };
  return window.AuthHelpers || fallback;
}

function getRuntimeAuthConfig(){
  const cfg = window.__APP_CONFIG__ || {};
  return {
    supabaseUrl: String(cfg.SUPABASE_URL || '').trim().replace(/\/+$/, ''),
    supabaseAnonKey: String(cfg.SUPABASE_ANON_KEY || '').trim(),
    ownerEmail: String(cfg.OWNER_EMAIL || OWNER_EMAIL_FALLBACK)
  };
}

function shouldDebugSupabaseTarget(){
  const host = String(window.location.hostname || '').trim().toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host.includes('github.io');
}

function extractSupabaseProjectRef(url){
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    return value.split('//')[1]?.split('.')[0] || '';
  } catch (err) {
    void err;
    return '';
  }
}

function debugSupabaseTarget(inputCfg = null){
  if (!shouldDebugSupabaseTarget()) return;
  if (_supabaseDebugLogged) return;
  _supabaseDebugLogged = true;
  try {
    const runtimeCfg = inputCfg || getRuntimeAuthConfig();
    const url = String(runtimeCfg.supabaseUrl || '').trim();
    const key = String(runtimeCfg.supabaseAnonKey || '').trim();
    const ref = extractSupabaseProjectRef(url);
    const urlMatchesExpected = url === EXPECTED_SUPABASE_PROJECT_URL;

    console.info('[SUPABASE DEBUG]');
    console.info('URL:', url);
    console.info('Project Ref:', ref);
    console.info('Key present:', !!key);
    console.info('URL matches expected:', urlMatchesExpected);

    const verified = urlMatchesExpected && !!key;
    console.info('[SUPABASE CONFIG VERIFIED]', verified);
    if (!verified) {
      console.warn('[SUPABASE CONFIG MISMATCH]');
    }
  } catch (err) {
    console.warn('Supabase debug failed');
  }
}

function isSupabaseConfigReady(cfg){
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) return false;
  if (!/^https:\/\/.+\.supabase\.co$/i.test(cfg.supabaseUrl)) return false;
  if (cfg.supabaseUrl.includes('YOUR_PROJECT_ID')) return false;
  if (cfg.supabaseAnonKey.includes('YOUR_SUPABASE_ANON_KEY')) return false;
  return true;
}

function getOwnerEmail(){
  const cfg = getRuntimeAuthConfig();
  return String(cfg.ownerEmail || OWNER_EMAIL_FALLBACK);
}

function setAuthGateState(message, kind = 'info', { showLogin = true, showLogout = false } = {}){
  const gate = document.getElementById('authGate');
  const msg = document.getElementById('authMessage');
  const loginBtn = document.getElementById('authLoginBtn');
  const logoutBtn = document.getElementById('authLogoutBtn');
  if (!gate || !msg) return;

  gate.classList.remove('hidden');
  msg.textContent = message;
  msg.classList.remove('error', 'ok');
  if (kind === 'error') msg.classList.add('error');
  if (kind === 'ok') msg.classList.add('ok');

  if (loginBtn) loginBtn.classList.toggle('hidden', !showLogin);
  if (logoutBtn) logoutBtn.classList.toggle('hidden', !showLogout);
}

function lockAppUI(message, kind = 'info', opts = {}){
  document.body.classList.add('auth-locked');
  document.body.classList.remove('auth-lock-pending');
  setAuthGateState(message, kind, opts);
}

function unlockAppUI(){
  const gate = document.getElementById('authGate');
  document.body.classList.remove('auth-locked', 'auth-lock-pending');
  if (gate) gate.classList.add('hidden');
}

function getSupabaseClient(){
  if (_authSupabase) return _authSupabase;
  const cfg = getRuntimeAuthConfig();
  debugSupabaseTarget(cfg);
  if (!window.supabase || typeof window.supabase.createClient !== 'function') return null;
  if (!isSupabaseConfigReady(cfg)) return null;

  console.log("==== SUPABASE RUNTIME DIAGNOSTIC ====");
  console.log("Location:", window.location.href);

  const runtimeCfg = window.__APP_CONFIG__ || {};

  console.log("Raw __APP_CONFIG__:", runtimeCfg);

  const url = runtimeCfg.supabaseUrl || runtimeCfg.SUPABASE_URL;
  const key = runtimeCfg.supabaseAnonKey || runtimeCfg.SUPABASE_ANON_KEY;

  console.log("Supabase URL used:", url);
  console.log("Supabase anon key present:", !!key);

  if (url) {
    const normalized = url.replace(/\/+$/, '');
    console.log("Normalized URL:", normalized);

    const match = normalized.match(/https:\/\/([^.]+)\.supabase\.co/);
    const projectRef = match ? match[1] : null;

    console.log("Extracted project ref:", projectRef);
  }

  console.log("==== END SUPABASE DIAGNOSTIC ====");

  _authSupabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce'
    }
  });
  return _authSupabase;
}

function authRedirectTo(){
  const clean = new URL(window.location.href);
  clean.search = '';
  clean.hash = '';
  return clean.toString();
}

function getGoogleAbortSignal() {
  if (!_googleAbortController || _googleAbortController.signal.aborted) {
    _googleAbortController = new AbortController();
  }
  return _googleAbortController.signal;
}

function abortGoogleNetworkRequests(reason = 'manual_abort') {
  const ctrl = _googleAbortController;
  if (ctrl && !ctrl.signal.aborted) {
    try { ctrl.abort(reason); } catch (err) { void err; }
  }
  _googleAbortController = null;
}

async function withGoogleApiMutex(fn, label = 'google_api') {
  if (typeof fn !== 'function') throw new Error('withGoogleApiMutex requiere una funcion');
  const prev = _googleApiMutexTail;
  let release = null;
  _googleApiMutexTail = new Promise((resolve) => { release = resolve; });
  await prev.catch(() => {});
  throwIfSyncAbortRequested(`${label}:before_lock_execute`);
  try {
    return await fn();
  } finally {
    try { release?.(); } catch (err) { void err; }
  }
}

async function signInWithGoogleOnly(){
  const supabase = getSupabaseClient();
  if (!supabase) {
    lockAppUI('Configuración de Supabase incompleta. Revisa app-config.js', 'error');
    return;
  }
  setAuthGateState('Redirigiendo a Google', 'info', { showLogin: false, showLogout: false });
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: authRedirectTo(),
      queryParams: {
        access_type: 'offline',
        prompt: 'consent',
        scope: GOOGLE_OAUTH_SIGNIN_SCOPES
      }
    }
  });
  try {
    const oauthUrl = String(data?.url || '');
    if (oauthUrl) {
      const parsed = new URL(oauthUrl);
      const grantedScope = decodeURIComponent(parsed.searchParams.get('scope') || '');
      console.info('[AUTH] oauth_signin_scope', {
        hasCalendarScope: grantedScope.includes('https://www.googleapis.com/auth/calendar'),
        hasDriveFileScope: grantedScope.includes('https://www.googleapis.com/auth/drive.file'),
        scope: grantedScope
      });
    } else {
      console.info('[AUTH] oauth_signin_scope', {
        hasCalendarScope: true,
        hasDriveFileScope: true,
        scope: GOOGLE_OAUTH_SIGNIN_SCOPES
      });
    }
  } catch (err) {
    console.warn('[AUTH] oauth_signin_scope_log_failed', err?.message || String(err));
  }
  if (error) {
    lockAppUI(`No se pudo iniciar sesión con Google: ${error.message}`, 'error', { showLogin: true, showLogout: false });
  }
}

async function signOutSupabase({ silent = false } = {}){
  _logoutInProgress = true;
  _syncAbortRequested = true;
  abortGoogleNetworkRequests('logout');

  // Bloquea de inmediato cualquier nueva operacion Google Sync.
  clearGoogleRuntimeState({ clearPreferences: true });

  try {
    let signOutError = null;
    try {
      const syncDrained = await waitForGoogleSyncDrain({ timeoutMs: 5000, pollMs: 50 });
      if (!syncDrained && !silent) {
        console.warn('Logout: Google sync seguia en vuelo tras timeout de drenaje.');
      }

      const supabase = getSupabaseClient();
      if (supabase) {
        await supabase.auth.signOut({ scope: 'global' });
      }
    } catch (err) {
      signOutError = err;
    }

    try {
      await purgeLocalCalendarDb({ silent: true });
    } catch (err) {
      if (!silent) console.warn('No se pudo purgar calendarDB en logout:', err);
    }

    try {
      clearTransientClientData();
    } catch (err) {
      if (!silent) console.warn('No se pudo limpiar estado transitorio en logout:', err);
    }

    try {
      await clearReminderScheduleFromSW({ silent: true, reason: 'logout' });
    } catch (err) {
      if (!silent) console.warn('No se pudo limpiar recordatorios SW en logout:', err);
    }

    if (signOutError && !silent) {
      lockAppUI(`No se pudo cerrar la sesion actual: ${signOutError.message || signOutError}`, 'error', { showLogin: true, showLogout: false });
    }

    _supabaseUserRowEnsuredFor = null;
  } finally {
    _logoutInProgress = false;
    _syncAbortRequested = false;
    setSyncStatus('offline', { detail: 'Sesión cerrada' });
    await refreshSyncStatusOutboxCount();
  }
}
function clearGoogleRuntimeState({ clearPreferences = true } = {}) {
  abortGoogleNetworkRequests('clear_runtime_state');
  _googleApiMutexTail = Promise.resolve();
  _googleAccessToken = null;
  _tokenClient = null;
  _googleSyncBlocked = true;
  _lastGoogleSyncAtMs = 0;
  _googleTokenOwnerVerifiedFor = null;
  _googleTokenOwnerEmail = null;
  setGoogleConnectedState(false);

  clearInterval(_autoSyncTimer);
  _autoSyncTimer = null;

  if (typeof state === 'object' && state) {
    state.googleCalendars = [{ ...DEFAULT_GOOGLE_CALENDAR_ENTRY }];
    state.calendarFilters = new Set(['primary']);
    state.selectedGoogleCalendarId = 'primary';
    setEventCalendarSelectState({ value: 'primary', disabled: false });
    renderCalendarFiltersUI();
  }

  if (clearPreferences) {
    try {
      localStorage.removeItem('google.remember');
      localStorage.removeItem('autoSync.enabled');
      localStorage.removeItem('gdrive.deleteMirror');
    } catch (err) { void err; }
  }
}

function assertWritesAllowed(operation = 'unknown_write') {
  if (!_logoutInProgress) return;
  const err = new Error(`WRITE_BLOCKED:${operation}`);
  err.code = 'WRITE_BLOCKED';
  throw err;
}

async function purgeLocalCalendarDb({ silent = true } = {}) {
  if (!('indexedDB' in window)) return { ok: false, reason: 'indexeddb_unsupported' };

  try {
    if (state.db) {
      try { state.db.close(); } catch (err) { void err; }
      state.db = null;
    }
  } catch (err) { void err; }

  const deleted = await new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase('calendarDB');
      req.onsuccess = () => resolve({ ok: true });
      req.onerror = () => resolve({ ok: false, reason: 'delete_failed', error: req.error });
      req.onblocked = () => resolve({ ok: false, reason: 'delete_blocked' });
    } catch (err) {
      resolve({ ok: false, reason: 'delete_exception', error: err });
    }
  });

  if (deleted.ok) return deleted;

  // Fallback: limpia stores si no se pudo borrar la DB completa.
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['events', 'attachments'], 'readwrite');
      tx.objectStore('events').clear();
      tx.objectStore('attachments').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    try { db.close(); } catch (err) { void err; }
    if (state) state.db = null;
    return { ok: true, fallback: 'stores_cleared' };
  } catch (err) {
    if (!silent) console.warn('No se pudo limpiar calendarDB fallback:', err);
    return { ok: false, reason: 'fallback_failed', error: err };
  }
}

function clearTransientClientData() {
  try {
    for (const urls of (_previewURLs.values?.() || [])) {
      for (const u of (urls || [])) {
        try { URL.revokeObjectURL(u); } catch (err) { void err; }
      }
    }
  } catch (err) { void err; }
  _previewURLs = new Map();
  _eventSheetPendingAttachments = [];
  _eventAttachmentUploadQueue = Promise.resolve();
  _eventAttachmentUploadsInFlight = 0;

  _lastDataToastAt = 0;
  try { state.holidaysCache.clear?.(); } catch (err) { void err; }
  try {
    _holidaySeedState.doneYears.clear?.();
    _holidaySeedState.inFlightByYear.clear?.();
  } catch (err) { void err; }
  try { _localDeletedEventTombstones.clear(); } catch (err) { void err; }
}

function hasSessionUserId(session) {
  return !!String(session?.user?.id || '').trim();
}

async function getSessionIfReadyForSync(reason = 'unknown') {
  const supabase = getSupabaseClient();
  if (!supabase?.auth?.getSession) {
    syncLog('auth_not_ready_skip', { reason, stage: 'supabase_unavailable' }, 'warn');
    return null;
  }
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      syncLog('auth_not_ready_skip', {
        reason,
        stage: 'get_session_error',
        error: error.message || String(error)
      }, 'warn');
      return null;
    }
    const session = data?.session || null;
    if (!session?.user?.id) {
      syncLog('auth_not_ready_skip', { reason, stage: 'missing_session_user_id' }, 'warn');
      return null;
    }
    return session;
  } catch (err) {
    syncLog('auth_not_ready_skip', {
      reason,
      stage: 'get_session_throw',
      error: err?.message || String(err)
    }, 'warn');
    return null;
  }
}

async function enforcePrivateOwnerSession(session){
  const helpers = getAuthHelpers();
  const ownerEmail = getOwnerEmail();
  const sessionUser = typeof MODULE_CORE_AUTH.getSessionUser === 'function'
    ? MODULE_CORE_AUTH.getSessionUser(session)
    : (session?.user || null);

  if (!session || !sessionUser) {
    clearGoogleRuntimeState({ clearPreferences: false });
    if (_authBlockedByEmail) {
      lockAppUI(
        `Acceso bloqueado. Solo se permite ${ownerEmail}.`,
        'error',
        { showLogin: true, showLogout: false }
      );
      return false;
    }
    lockAppUI(
      'Inicia sesin con Google para entrar a este calendario privado.',
      'info',
      { showLogin: true, showLogout: false }
    );
    return false;
  }

  const userEmail = typeof MODULE_CORE_AUTH.getSessionEmail === 'function'
    ? MODULE_CORE_AUTH.getSessionEmail(session)
    : String(sessionUser?.email || '');
  const provider = typeof MODULE_CORE_AUTH.getSessionProvider === 'function'
    ? MODULE_CORE_AUTH.getSessionProvider(session)
    : String(sessionUser?.app_metadata?.provider || '').trim().toLowerCase();

  if (provider !== 'google') {
    _googleSyncBlocked = true;
    _authBlockedByEmail = true;
    lockAppUI(
      `Acceso bloqueado: solo se permite autenticacin con Google (proveedor detectado: ${provider || 'desconocido'}).`,
      'error',
      { showLogin: true, showLogout: false }
    );
    await signOutSupabase({ silent: true });
    return false;
  }

  if (!helpers.isOwnerEmail(userEmail, ownerEmail)) {
    _googleSyncBlocked = true;
    _authBlockedByEmail = true;
    lockAppUI(
      `Acceso bloqueado: ${userEmail || 'usuario sin email'}. Solo ${ownerEmail} tiene acceso.`,
      'error',
      { showLogin: true, showLogout: false }
    );
    await signOutSupabase({ silent: true });
    return false;
  }

  _authBlockedByEmail = false;
  _googleSyncBlocked = false;
  unlockAppUI();
  if (!_authBootDone) {
    _authBootDone = true;
    await bootApp();
  } else {
    ensureAutoSyncTimer();
    try { reRender(); } catch (err) { void err; }
  }
  return true;
}

async function setupPrivateAuthGate(){
  if (_authGateReady) return;
  _authGateReady = true;

  const loginBtn = document.getElementById('authLoginBtn');
  const logoutBtn = document.getElementById('authLogoutBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      signInWithGoogleOnly().catch((err) => {
        lockAppUI(`Error de autenticación: ${err.message || err}`, 'error', { showLogin: true, showLogout: false });
      });
    });
  }
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      _authBlockedByEmail = false;
      await signOutSupabase();
      lockAppUI('Sesión cerrada. Inicia sesión con Google para continuar.', 'info', { showLogin: true, showLogout: false });
    });
  }

  const cfg = getRuntimeAuthConfig();
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    lockAppUI('No se cargó Supabase JS. Revisa la conexión o el script CDN.', 'error', { showLogin: false, showLogout: false });
    return;
  }
  if (!isSupabaseConfigReady(cfg)) {
    lockAppUI('Falta configurar Supabase en app-config.js (URL y ANON KEY).', 'error', { showLogin: false, showLogout: false });
    return;
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    lockAppUI('No se pudo inicializar Supabase Auth.', 'error', { showLogin: false, showLogout: false });
    return;
  }

  setAuthGateState('Comprobando sesión', 'info', { showLogin: false, showLogout: false });

  const { data, error } = await supabase.auth.getSession();
  if (error) {
    lockAppUI(`Error al recuperar sesión: ${error.message}`, 'error', { showLogin: true, showLogout: false });
    return;
  }

  await enforcePrivateOwnerSession(data.session || null);

  supabase.auth.onAuthStateChange((_event, session) => {
    const event = String(_event || '').toUpperCase();

    if (event === 'INITIAL_SESSION') {
      syncLog('auth_not_ready_skip', { event, reason: 'initial_session_event' }, 'warn');
      return;
    }

    if (event === 'SIGNED_OUT') {
      _syncAbortRequested = true;
      abortGoogleNetworkRequests('auth_state_signed_out');
      enforcePrivateOwnerSession(null).catch((err) => {
        lockAppUI(`Error en validación de acceso: ${err.message || err}`, 'error', { showLogin: true, showLogout: false });
      });
      return;
    }

    if (event !== 'SIGNED_IN' && event !== 'TOKEN_REFRESHED') {
      syncLog('auth_not_ready_skip', { event, reason: 'unsupported_auth_event' }, 'warn');
      return;
    }

    if (!session?.user?.id) {
      syncLog('auth_not_ready_skip', { event, reason: 'missing_session_user_id' }, 'warn');
      return;
    }

    if (event === 'SIGNED_IN') {
      _syncAbortRequested = true;
      abortGoogleNetworkRequests('auth_state_signed_in');
    }

    enforcePrivateOwnerSession(session).catch((err) => {
      lockAppUI(`Error en validación de acceso: ${err.message || err}`, 'error', { showLogin: true, showLogout: false });
    }).finally(() => {
      if (session?.user?.id) _syncAbortRequested = false;
    });
  });
}

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
      .replace(/[,]+/g, '.')          // comas  puntos
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

function appendCacheBuster(url, param = 'u') {
  if (typeof MODULE_UTILS.appendCacheBuster === 'function') {
    return MODULE_UTILS.appendCacheBuster(url, param);
  }
  try {
    const target = new URL(url, window.location.origin);
    target.searchParams.set(param, String(Date.now()));
    return target.toString();
  } catch {
    const hasQuery = String(url || '').includes('?');
    return `${url}${hasQuery ? '&' : '?'}${param}=${Date.now()}`;
  }
}

function showUpdateGate(minReq, latest, notes){
  let gate = qs('#updateGate');
  if (!gate) {
    // si no existe, crea un gate mínimo para no dejar el body bloqueado "a ciegas"
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
    if (notes && /^https:\/\//.test(notes)) {
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
// Pointer "coarse" = móvil/tablet
const IS_COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

const DND_STEP_MIN = 15;
const DND_MIN_DURATION_MIN = 15;
let _timeDnd = null;

function hhmmToMinutes(hhmm){
  const parts = String(hhmm || '00:00').split(':').map(Number);
  const h = Number.isFinite(parts[0]) ? parts[0] : 0;
  const m = Number.isFinite(parts[1]) ? parts[1] : 0;
  return h * 60 + m;
}

function minutesToHHMM(total){
  const mins = clamp(Math.round(total), 0, 23 * 60 + 59);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function roundMinutesStep(mins, step = DND_STEP_MIN){
  return Math.round(mins / step) * step;
}

function getEventSourceKind(evt){
  const raw = String(evt.source || '').trim().toLowerCase();
  if (raw === 'holiday' || evt.isHoliday || evt.category === 'Festivo') return 'holiday';
  if (raw === 'google' || evt.gcalId || evt.google_event_id) return 'google';
  return 'local';
}

function isReminderEvent(evt) {
  if (!evt) return false;
  const raw = String(evt.alert || evt.reminder || '').trim().toLowerCase();
  return !!raw && raw !== 'none' && raw !== 'sin aviso' && raw !== 'off';
}

function getEventVisualKind(evt) {
  const source = getEventSourceKind(evt);
  if (source === 'holiday') return 'holiday';
  if (isReminderEvent(evt)) return 'reminder';
  if (source === 'google') return 'google';
  return 'personal';
}

function getMonthEventTimeLabel(evt) {
  if (!evt) return '';
  if (evt.allDay || evt.category === 'Festivo') return 'Todo el dia';
  const from = evt.startTime || evt.time || '';
  const to = evt.endTime || '';
  if (from && to) return `${from} - ${to}`;
  return from || '';
}

function getEventDurationMinutes(evt){
  if (evt.allDay) return (DAY_END_H - DAY_START_H) * 60;
  const sDate = evt.startDate || evt.date;
  const sTime = evt.startTime || evt.time || '00:00';
  const eDate = evt.endDate || sDate;
  const eTime = evt.endTime || sTime;
  const start = toLocalDateTime(sDate, sTime).getTime();
  let end = toLocalDateTime(eDate, eTime).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 60;
  if (end <= start) end = start + 60 * 60000;
  const diff = Math.round((end - start) / 60000);
  return Math.max(DND_MIN_DURATION_MIN, diff);
}

function eventIsEditableInTimeGrid(evt){
  if (!evt) return false;
  if (evt.locked) return false;
  if (evt.allDay) return false;
  return getEventSourceKind(evt) !== 'holiday';
}

function isHolidayEvent(evt) {
  if (!evt) return false;
  return getEventSourceKind(evt) === 'holiday'
    || !!evt.isHoliday
    || !!evt.locked
    || evt.category === 'Festivo';
}

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
    try { history.pushState({ app:'cal', kind, t:Date.now() }, ''); } catch (err) { void err; }
  }
  function consumeOne() {
    // Llamar cuando cerramos manualmente (X, tap fuera)
    ignoreNextPop = true;
    try { history.back(); } catch (err) { void err; }
  }

  window.addEventListener('popstate', () => {
    if (ignoreNextPop) { ignoreNextPop = false; return; }
    const top = stack.pop();
    if (top && typeof top.onBack === 'function') {
      // Cierre "silencioso": la función NO debe volver a tocar history.back()
      top.onBack();
    }
  });

  return { push, consumeOne };
})();

// Snapshot/restore: implementacion canónica consolidada en la capa Supabase (más abajo).

// ===== Confirm no bloqueante con <dialog> (sin popups nativos) =====
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
          <div class="confirm-icon" aria-hidden="true">️</div>
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
    if (typeof showToast === 'function') {
      showToast('Este navegador no soporta dialogos de confirmacion. Accion cancelada.', 'info', 4200);
    }
    return Promise.resolve(false);
  }
  const {
    title = 'Confirmar',
    message = '¿Seguro',
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
        <button id="sfClose" class="sf-close" aria-label="Cerrar"></button>
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
      : (e.endTime ? `${e.time || ''}  ${e.endTime}` : (e.time || ''));
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
            <div class="ag-dow" id="agDow"></div>
            <div class="ag-sub" id="agSub"></div>
          </div>
        </div>
        <button class="ag-close" value="cancel" aria-label="Cerrar"></button>
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
  const sorted = (window.CalendarModules?.uiAgenda?.sortAgendaEvents)
    ? window.CalendarModules.uiAgenda.sortAgendaEvents(events)
    : events.slice().sort((a,b)=>{
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
    const range = (evt.allDay || evt.category === 'Festivo') ? '' : (evt.endTime ? `${evt.time}  ${evt.endTime}` : (evt.time || ''));
    const loc = evt.location ? ` · ${evt.location}` : '';
    metaEl.textContent = `${range}${loc}`;
    main.appendChild(titleEl); main.appendChild(metaEl);
    btn.appendChild(timeEl); btn.appendChild(main);
    btn.addEventListener('click', () => { dlg.close(); openSheetForEdit(evt); });
    list.appendChild(btn);
  });

  dlg.showModal();

  //  NUEVO: hardware back cierra este diálogo
  backMgr.push('agenda', () => { try { dlg.close(); } catch (err) { void err; } });

  // ðŸ‘‡ NUEVO: si se cierra "a mano", consumir la entrada del back
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
const state = (typeof MODULE_CORE_STATE.createInitialState === 'function')
  ? MODULE_CORE_STATE.createInitialState()
  : {
    db: null,
    theme: (localStorage.getItem('theme') || 'dark'),
    viewMode: 'month',
    currentMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    selectedDate: null,
    googleCalendars: [{ ...DEFAULT_GOOGLE_CALENDAR_ENTRY }],
    calendarFilters: new Set(['primary']),
    selectedGoogleCalendarId: 'primary',
    filters: new Set(['Trabajo','Evento','Citas','Cumpleaños','Otros','Festivo']),
    holidaysCache: new Map(),
    monthDensity: localStorage.getItem('month.density') || 'compact',
    dataLoading: false,
    lastDataError: null
  };

const ALL_CATS = Array.isArray(MODULE_CORE_STATE.DEFAULT_CATEGORIES)
  ? [...MODULE_CORE_STATE.DEFAULT_CATEGORIES]
  : ['Trabajo','Evento','Citas','Cumpleaños','Otros','Festivo'];
if (!(state.filters instanceof Set) || state.filters.size === 0) {
  state.filters = new Set(ALL_CATS);
}

function normalizeGoogleCalendarId(value, fallback = 'primary') {
  const clean = String(value || '').trim();
  return clean || fallback;
}

function isPrimaryCalendarId(calendarId) {
  return normalizeGoogleCalendarId(calendarId) === 'primary';
}

function normalizeGoogleCalendarSummary(summary, id = 'primary') {
  const clean = String(summary || '').trim();
  if (clean) return clean;
  return isPrimaryCalendarId(id) ? DEFAULT_GOOGLE_CALENDAR_ENTRY.summary : id;
}

function normalizeGoogleCalendarEntry(raw) {
  const id = normalizeGoogleCalendarId(raw?.id, 'primary');
  return {
    id,
    summary: normalizeGoogleCalendarSummary(raw?.summary, id),
    primary: !!raw?.primary || id === 'primary'
  };
}

function normalizeGoogleCalendarList(input) {
  const list = Array.isArray(input) ? input : [];
  const map = new Map();
  for (const row of list) {
    const entry = normalizeGoogleCalendarEntry(row);
    if (!map.has(entry.id) || entry.primary) {
      map.set(entry.id, entry);
    }
  }
  if (!map.has('primary')) {
    map.set('primary', { ...DEFAULT_GOOGLE_CALENDAR_ENTRY });
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.primary && !b.primary) return -1;
    if (!a.primary && b.primary) return 1;
    return String(a.summary || '').localeCompare(String(b.summary || ''), 'es', { sensitivity: 'base' });
  });
}

function getEventGoogleCalendarId(evt, fallback = 'primary') {
  return normalizeGoogleCalendarId(
    evt?.googleCalendarId || evt?.google_calendar_id || evt?.calendarId || null,
    fallback
  );
}

function ensureCalendarStateDefaults() {
  state.googleCalendars = normalizeGoogleCalendarList(state.googleCalendars);
  const available = new Set(state.googleCalendars.map((c) => c.id));

  if (!(state.calendarFilters instanceof Set)) {
    state.calendarFilters = new Set();
  }
  for (const id of Array.from(state.calendarFilters)) {
    if (!available.has(id)) state.calendarFilters.delete(id);
  }
  if (!state.calendarFilters.size) {
    for (const id of available) state.calendarFilters.add(id);
  }

  const selectedId = normalizeGoogleCalendarId(state.selectedGoogleCalendarId || null, 'primary');
  state.selectedGoogleCalendarId = available.has(selectedId) ? selectedId : (state.googleCalendars[0]?.id || 'primary');
}

function eventMatchesCalendarFilter(evt) {
  if (isHolidayEvent(evt)) return true;
  if (!(state.calendarFilters instanceof Set) || !state.calendarFilters.size) return true;
  const calendarId = getEventGoogleCalendarId(evt, 'primary');
  return state.calendarFilters.has(calendarId);
}

function eventPassesActiveFilters(evt) {
  return state.filters.has(evt.category) && eventMatchesCalendarFilter(evt);
}

ensureCalendarStateDefaults();

// ===================== IndexedDB =====================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('calendarDB', 4);
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
      let outbox;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        outbox = db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
        outbox.createIndex('by_created', 'createdAt', { unique: false });
        outbox.createIndex('by_event', 'eventId', { unique: false });
      } else {
        const tx = e.target.transaction;
        outbox = tx.objectStore(OUTBOX_STORE);
        if (!outbox.indexNames.contains('by_created')) outbox.createIndex('by_created', 'createdAt', { unique: false });
        if (!outbox.indexNames.contains('by_event')) outbox.createIndex('by_event', 'eventId', { unique: false });
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
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden','false');
  $('#drawerBackdrop').classList.add('open');
  $('#menuBtn').classList.add('active');
  $('#menuBtn').setAttribute('aria-expanded','true');
  backMgr.push('drawer', () => closeDrawer(/*silent*/true));
}
function closeDrawer(silent=false) {
  if (!silent) backMgr.consumeOne();
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden','true');
  $('#drawerBackdrop').classList.remove('open');
  $('#menuBtn').classList.remove('active');
  $('#menuBtn').setAttribute('aria-expanded','false');
}


function toggleDrawer() {
  ($('#drawer').classList.contains('open')) ? closeDrawer() : openDrawer();
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
// ===================== Render  Mes (pinta primero, hidrata después) =====================
function formatTopMonthTitle(dateValue) {
  const d = (dateValue instanceof Date && !Number.isNaN(dateValue.getTime()))
    ? dateValue
    : new Date();
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function updateAppTitleForMonth(dateValue = state.currentMonth) {
  const titleEl = $('#currentMonthLabel') || $('#appTitle');
  const formatted = formatTopMonthTitle(dateValue);
  if (titleEl) {
    titleEl.textContent = formatted;
    titleEl.classList.remove('calendar-title-enter');
    void titleEl.offsetWidth;
    titleEl.classList.add('calendar-title-enter');
    setTimeout(() => titleEl.classList.remove('calendar-title-enter'), 280);
  }
  const monthTitle = $('#monthTitle');
  if (monthTitle) {
    monthTitle.textContent = formatted;
    monthTitle.classList.remove('calendar-title-enter');
    void monthTitle.offsetWidth;
    monthTitle.classList.add('calendar-title-enter');
    setTimeout(() => monthTitle.classList.remove('calendar-title-enter'), 280);
  }
}

const HOLIDAY_REGION = {
  country: 'ES',
  region: 'AN',
  city: 'Cordoba'
};

const CORDOBA_MUNICIPAL_DATASET = {
  // Dataset estable por tradicion local.
  // Si el ayuntamiento cambia una fecha concreta, aqui se puede ajustar por anyo.
  byYear: {
    // 2026 validado en calendario oficial municipal.
    2026: [
      { m: 9, d: 8, name: 'Virgen de la Fuensanta (local)' },
      { m: 10, d: 24, name: 'San Rafael (local)' }
    ]
  },
  fallback: [
    { m: 9, d: 8, name: 'Virgen de la Fuensanta (local)' },
    { m: 10, d: 24, name: 'San Rafael (local)' }
  ]
};

function holidayMapAddEntry(map, year, month, day, name, scope) {
  const ds = `${year}-${pad2(month)}-${pad2(day)}`;
  const row = map.get(ds) || { names: [], scopes: [] };
  if (!row.names.includes(name)) row.names.push(name);
  if (!row.scopes.includes(scope)) row.scopes.push(scope);
  map.set(ds, row);
}

function holidayMapAddObservedMondayIfSunday(map, year, month, day, name, scope) {
  const dt = new Date(year, month - 1, day);
  if (dt.getDay() !== 0) {
    holidayMapAddEntry(map, year, month, day, name, scope);
    return;
  }
  const moved = new Date(year, month - 1, day + 1);
  holidayMapAddEntry(
    map,
    moved.getFullYear(),
    moved.getMonth() + 1,
    moved.getDate(),
    `${name} (traslado)`,
    scope
  );
}

function getNationalHolidaysMap(year){
  const cached = state.holidaysCache.get(year);
  if (cached) return cached;

  const scoped = new Map();
  const national = [
    { m:1,  d:1,  name:'Anyo Nuevo' },
    { m:1,  d:6,  name:'Epifania del Senyor' },
    { m:5,  d:1,  name:'Dia del Trabajador' },
    { m:8,  d:15, name:'Asuncion de la Virgen' },
    { m:10, d:12, name:'Fiesta Nacional de Espanya' },
    { m:12, d:8,  name:'Inmaculada Concepcion' },
    { m:12, d:25, name:'Navidad' }
  ];

  for (const x of national) holidayMapAddEntry(scoped, year, x.m, x.d, x.name, 'nacional');
  holidayMapAddObservedMondayIfSunday(scoped, year, 11, 1, 'Todos los Santos', 'nacional');
  holidayMapAddObservedMondayIfSunday(scoped, year, 12, 6, 'Dia de la Constitucion', 'nacional');

  const gf = goodFriday(year);
  holidayMapAddEntry(scoped, year, gf.getMonth() + 1, gf.getDate(), 'Viernes Santo', 'nacional');

  // Andalucia
  holidayMapAddEntry(scoped, year, 2, 28, 'Dia de Andalucia', 'andalucia');
  const easter = easterSunday(year);
  const maundyThursday = new Date(easter);
  maundyThursday.setDate(easter.getDate() - 3);
  holidayMapAddEntry(
    scoped,
    maundyThursday.getFullYear(),
    maundyThursday.getMonth() + 1,
    maundyThursday.getDate(),
    'Jueves Santo',
    'andalucia'
  );

  // Cordoba (municipal) - usa dataset estable si existe para el anyo.
  const cordobaList = CORDOBA_MUNICIPAL_DATASET.byYear[year] || CORDOBA_MUNICIPAL_DATASET.fallback;
  for (const x of cordobaList) {
    holidayMapAddEntry(scoped, year, x.m, x.d, x.name, 'cordoba');
  }

  const map = new Map();
  for (const [ds, row] of scoped.entries()) {
    map.set(ds, row.names.join(' / '));
  }

  state.holidaysCache.set(year, map);
  return map;
}

function renderCalendar(date = state.currentMonth) {
  const base = new Date(date.getFullYear(), date.getMonth(), 1);
  state.currentMonth = base;
  updateAppTitleForMonth();

  const year  = base.getFullYear();
  const month = base.getMonth();

  const first = new Date(year, month, 1);
  const last  = new Date(year, month + 1, 0);
  const startOffset = (first.getDay() + 6) % 7; // Lunes=0
  const totalDays   = last.getDate();
  const totalCells  = Math.ceil((startOffset + totalDays) / 7) * 7;

  const grid = $('#calendarGrid');
  if (!grid) return;

  const myToken = ++monthRenderToken;
  grid.innerHTML = '';

  const todayStr = ymd(new Date());
  const holidays = getNationalHolidaysMap(year);
  const tagRefs = new Map();   // YYYY-MM-DD -> contenedor de tags
  const badgeRefs = new Map(); // YYYY-MM-DD -> badge +X
  const dayRefs = new Map();   // YYYY-MM-DD -> Date

  // 1) Pintar celdas inmediatamente (con festivos si procede)
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startOffset + 1;
    const d = new Date(year, month, dayNum);
    const out = (dayNum < 1 || dayNum > totalDays);
    const dStr = ymd(d);

    const cell = document.createElement('div');
    cell.className = 'day calendar-day' + (out ? ' out' : '') + (dStr === todayStr ? ' today' : '');
    cell.tabIndex = 0;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', `Dia ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`);
    cell.dataset.date = dStr;

    const head = document.createElement('div');
    head.className = 'day-head';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = d.getDate();
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.hidden = true;
    head.append(num, badge);

    const tags = document.createElement('div');
    tags.className = 'events-tags calendar-events';
    forceTagsBoxLayout(tags);

    tagRefs.set(dStr, tags);
    badgeRefs.set(dStr, badge);
    dayRefs.set(dStr, d);

    // Festivo visible al instante
    const festivoName = holidays.get(dStr);
    if (festivoName && state.filters.has('Festivo')) {
      const eventEl = document.createElement('div');
      eventEl.className = 'calendar-event kind-holiday source-holiday is-all-day';
      eventEl.title = festivoName;

      const dot = document.createElement('span');
      dot.className = 'event-dot';
      dot.setAttribute('aria-hidden', 'true');

      const titleNode = document.createElement('span');
      titleNode.className = 'event-title etxt';
      titleNode.textContent = festivoName;

      eventEl.append(dot, titleNode);
      tags.append(eventEl);
    }

    cell.append(head, tags);

    on(cell, 'click', () => handleDayCellClick(d));
    on(cell, 'keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        handleDayCellClick(d);
      }
    });

    grid.append(cell);
  }

  // 2) Hidratar eventos cuando IndexedDB responda (si este render sigue vigente)
  loadMonthEvents(year, month).then((eventsByDayAll) => {
    if (myToken !== monthRenderToken) return;

    const MAX_MONTH_EVENT_CARDS = IS_COARSE_POINTER ? 2 : 3;

    for (const [dateStr, list] of eventsByDayAll) {
      const box = tagRefs.get(dateStr);
      if (!box) continue;
      const badge = badgeRefs.get(dateStr);
      const dayDate = dayRefs.get(dateStr);

      const dayEvts = list
        .filter(eventPassesActiveFilters)
        .filter((ev) => !isHolidayEvent(ev))
        .slice()
        .sort((a, b) => (a.time || '23:59').localeCompare(b.time || '23:59'));

      const visible = dayEvts.slice(0, MAX_MONTH_EVENT_CARDS);
      for (const evt of visible) {
        const eventEl = document.createElement('div');
        const sourceKind = getEventSourceKind(evt);
        const visualKind = getEventVisualKind(evt);
        const allDayEvt = !!evt.allDay || evt.category === 'Festivo';

        eventEl.className = [
          'calendar-event',
          `source-${sourceKind}`,
          `kind-${visualKind}`,
          allDayEvt ? 'is-all-day' : ''
        ].join(' ').trim();

        const wantsShort = (state.monthDensity !== 'expanded') ? IS_COARSE_POINTER : false;
        const maxCharsMobile = 18;
        const title = wantsShort
          ? shortLabelFromTitle(evt.title, { mode: 'chars', maxChars: maxCharsMobile })
          : (evt.title || '');

        const dot = document.createElement('span');
        dot.className = 'event-dot';
        dot.setAttribute('aria-hidden', 'true');

        const titleNode = document.createElement('span');
        titleNode.className = 'event-title etxt';
        titleNode.textContent = title || '(Sin titulo)';

        eventEl.append(dot, titleNode);
        eventEl.title = evt.title || '';
        eventEl.setAttribute('role', 'button');
        eventEl.tabIndex = 0;
        eventEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openSheetForEdit(evt);
        });
        eventEl.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openSheetForEdit(evt);
          }
        });

        box.append(eventEl);
      }

      const hiddenCount = Math.max(0, dayEvts.length - visible.length);
      if (badge) {
        badge.hidden = hiddenCount <= 0;
        badge.textContent = hiddenCount > 0 ? `+${hiddenCount}` : '';
      }

      if (hiddenCount > 0) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'event-overflow-indicator';
        more.textContent = `+${hiddenCount} mas`;
        more.title = `Ver ${hiddenCount} eventos mas`;
        more.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (dayDate) handleDayCellClick(dayDate);
        });
        box.append(more);
      }
    }
  });
}
async function handleDayCellClick(d){
  const ds = ymd(d);

  // 1) Eventos guardados para ese día (filtrados por categoría visible)
  let list = (await getEventsByDate(ds)).filter(eventPassesActiveFilters);

  // 2) Si es festivo y el filtro lo permite, añadimos un stub para que se vea en el modal
  const holName = getNationalHolidaysMap(d.getFullYear()).get(ds);
  const alreadyHasHoliday = list.some((ev) => isHolidayEvent(ev));
  if (holName && state.filters.has('Festivo') && !alreadyHasHoliday) {
    list.unshift({
      id: `holiday:${ds}`,
      date: ds,
      time: '00:00',
      title: `ðŸŽ‰ ${holName}`,
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
  // - Si hay varios  lista/agenda
  // - Si hay uno y es festivo  también lista (no abrimos editor de un stub)
  // - Si hay uno normal  abrir editor
  // - Si no hay nada  ir a vista de día
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

// Carga mensual consolidada en la capa de datos Supabase (loadMonthEvents más abajo).

// ===================== Vistas de tiempo =====================
function animateViewEntry(panel, variant = 'time') {
  if (!panel) return;
  const cls = variant === 'month' ? 'view-enter-month' : 'view-enter-time';
  panel.classList.remove('view-enter-month', 'view-enter-time');
  void panel.offsetWidth;
  panel.classList.add(cls);
  setTimeout(() => panel.classList.remove(cls), 180);
}

function setViewMode(mode) {
  state.viewMode = mode;
  document.body.classList.toggle('view-month', mode === 'month');
  $$('input[name="viewMode"]').forEach(r => { r.checked = (r.value === mode); });

  if (mode === 'month') {
    const timeView = $('#timeView');
    const monthView = $('#monthView');
    if (timeView) timeView.classList.add('hidden');
    if (monthView) {
      monthView.classList.remove('hidden');
      animateViewEntry(monthView, 'month');
    }
    renderCalendar(state.currentMonth);
    updateAppTitleForMonth();
    return;
  }

  const monthView = $('#monthView');
  const timeView = $('#timeView');
  if (monthView) monthView.classList.add('hidden');
  if (timeView) {
    timeView.classList.remove('hidden');
    animateViewEntry(timeView, 'time');
  }

  const anchor = state.selectedDate || new Date();
  state.selectedDate = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());

  renderTimeView(mode, state.selectedDate);
}

function startOfWeek(d) { const wd = (d.getDay() + 6) % 7; const nd = new Date(d); nd.setDate(d.getDate() - wd); return new Date(nd.getFullYear(), nd.getMonth(), nd.getDate()); }
function rangeDays(mode, anchor) {
  if (mode === 'day')   return [new Date(anchor)];
  if (mode === '3days') return [0,1,2].map(i => new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + i));
  if (mode === 'week')  { const start = startOfWeek(anchor); return [...Array(7)].map((_,i)=> new Date(start.getFullYear(), start.getMonth(), start.getDate()+i)); }
  if (mode === 'agenda') { const start = startOfWeek(anchor); return [...Array(7)].map((_,i)=> new Date(start.getFullYear(), start.getMonth(), start.getDate()+i)); }
  return [new Date(anchor)];
}
function formatRangeTitle(days) {
  if (days.length === 1) return new Intl.DateTimeFormat('es-ES', { dateStyle:'full' }).format(days[0]);
  const first = days[0], last = days[days.length-1];
  const sameMonth = (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear());
  if (sameMonth) return `${WEEKDAYS_MIN[(first.getDay()+6)%7]} ${first.getDate()}  ${WEEKDAYS_MIN[(last.getDay()+6)%7]} ${last.getDate()} · ${MONTHS[first.getMonth()]} ${first.getFullYear()}`;
  return `${first.getDate()} ${MONTHS[first.getMonth()]} ${first.getFullYear()}  ${last.getDate()} ${MONTHS[last.getMonth()]} ${last.getFullYear()}`;
}

function addHolidayStubsToMap(days, map){
  for (const d of days){
    const ds   = ymd(d);
    const name = getNationalHolidaysMap(d.getFullYear()).get(ds);
    if (!name) continue;
    const arr = map.get(ds) || [];
    if (arr.some((e) => isHolidayEvent(e))) continue;
    // evita duplicar si ya lo añadimos
    if (!arr.some(e => e.id === `holiday:${ds}`)){
      arr.push({
        id: `holiday:${ds}`,
        date: ds,
        time: '00:00',              // se colocará arriba
        title: `ðŸŽ‰ ${name}`,
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

function sortAgendaEvents(a, b) {
  const aDate = a.startDate || a.date || '';
  const bDate = b.startDate || b.date || '';
  if (aDate !== bDate) return aDate.localeCompare(bDate);

  const aAllDay = !!a.allDay || a.category === 'Festivo';
  const bAllDay = !!b.allDay || b.category === 'Festivo';
  if (aAllDay !== bAllDay) return aAllDay ? -1 : 1;

  const aStart = aAllDay ? '00:00' : (a.startTime || a.time || '00:00');
  const bStart = bAllDay ? '00:00' : (b.startTime || b.time || '00:00');
  if (aStart !== bStart) return aStart.localeCompare(bStart);

  return String(a.title || '').localeCompare(String(b.title || ''), 'es', { sensitivity: 'base' });
}

function cleanupAgendaVirtualization(list) {
  if (!list || typeof list._agendaVirtualCleanup !== 'function') return;
  try {
    list._agendaVirtualCleanup();
  } catch (err) {
    void err;
  }
  list._agendaVirtualCleanup = null;
}

function createAgendaDayHeadNode(label) {
  const dayHead = document.createElement('div');
  dayHead.className = 'agenda-day-head';
  dayHead.textContent = label;
  return dayHead;
}

function createAgendaEventItemNode(evt) {
  const item = document.createElement('button');
  item.type = 'button';
  const agendaSource = getEventSourceKind(evt);
  const agendaKind = getEventVisualKind(evt);
  item.className = `agenda-item calendar-event event-card cat-${evt.category || ''} source-${agendaSource} kind-${agendaKind}`;

  const timeEl = document.createElement('div');
  timeEl.className = 'agenda-item-time';
  if (evt.allDay || evt.category === 'Festivo') {
    timeEl.textContent = 'Todo el día';
  } else {
    const from = evt.startTime || evt.time || '--:--';
    const to = evt.endTime ? ` - ${evt.endTime}` : '';
    timeEl.textContent = `${from}${to}`;
  }

  const main = document.createElement('div');
  main.className = 'agenda-item-main';

  const titleEl = document.createElement('div');
  titleEl.className = 'agenda-item-title';
  titleEl.textContent = (evt.category === 'Otros' && evt.categoryOther)
    ? `${evt.title} - ${evt.categoryOther}`
    : (evt.title || '(Sin título)');
  main.append(titleEl);

  const metaParts = [];
  if (evt.location) metaParts.push(evt.location);
  const catLabel = (evt.category === 'Otros' && evt.categoryOther) ? evt.categoryOther : evt.category;
  if (catLabel) metaParts.push(catLabel);
  if (metaParts.length) {
    const metaEl = document.createElement('div');
    metaEl.className = 'agenda-item-meta';
    metaEl.textContent = metaParts.join(' · ');
    main.append(metaEl);
  }

  item.append(timeEl, main);
  item.addEventListener('click', () => openSheetForEdit(evt));
  return item;
}

function buildAgendaRenderRows(events, dayFmt) {
  const rows = [];
  let currentDate = '';

  for (let idx = 0; idx < events.length; idx++) {
    const evt = events[idx];
    const dateStr = evt.startDate || evt.date || '';
    if (dateStr && dateStr !== currentDate) {
      currentDate = dateStr;
      let dayLabel = dateStr;
      try {
        dayLabel = dayFmt.format(parseDateInput(dateStr));
      } catch (err) {
        void err;
      }
      rows.push({
        kind: 'dayHead',
        key: `d:${dateStr}:${idx}`,
        label: dayLabel,
        estHeight: AGENDA_EST_DAY_HEAD_ROW_PX
      });
    }
    rows.push({
      kind: 'event',
      key: `e:${evt.id || idx}:${idx}`,
      event: evt,
      estHeight: AGENDA_EST_EVENT_ROW_PX
    });
  }
  return rows;
}

function createAgendaRowNode(row) {
  if (row.kind === 'dayHead') return createAgendaDayHeadNode(row.label || '');
  return createAgendaEventItemNode(row.event || {});
}

function renderAgendaRowsSlice(container, rows, start = 0, end = rows.length) {
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    frag.appendChild(createAgendaRowNode(rows[i]));
  }
  container.replaceChildren(frag);
}

function agendaFindRowIndexByOffset(prefixHeights, offsetPx) {
  let lo = 0;
  let hi = prefixHeights.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (prefixHeights[mid] <= offsetPx) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(0, Math.min(lo, prefixHeights.length - 2));
}

function mountAgendaVirtualization(list, rows) {
  cleanupAgendaVirtualization(list);
  list.classList.add('agenda-virtualized');

  const totalRows = rows.length;
  const prefixHeights = new Array(totalRows + 1);
  prefixHeights[0] = 0;
  for (let i = 0; i < totalRows; i++) {
    prefixHeights[i + 1] = prefixHeights[i] + Math.max(24, Number(rows[i].estHeight || AGENDA_EST_EVENT_ROW_PX));
  }
  const totalHeight = prefixHeights[totalRows];

  const topSpacer = document.createElement('div');
  topSpacer.className = 'agenda-virtual-spacer top';
  const viewport = document.createElement('div');
  viewport.className = 'agenda-virtual-window';
  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'agenda-virtual-spacer bottom';
  list.replaceChildren(topSpacer, viewport, bottomSpacer);

  let rafId = 0;
  const renderSlice = () => {
    const scrollTop = Math.max(0, list.scrollTop || 0);
    const viewportHeight = Math.max(1, list.clientHeight || 1);
    const startRaw = agendaFindRowIndexByOffset(prefixHeights, scrollTop);
    const endRaw = agendaFindRowIndexByOffset(prefixHeights, scrollTop + viewportHeight) + 1;
    const start = Math.max(0, startRaw - AGENDA_VIRTUAL_OVERSCAN_ROWS);
    const end = Math.min(totalRows, endRaw + AGENDA_VIRTUAL_OVERSCAN_ROWS);

    const topHeight = prefixHeights[start];
    const bottomHeight = Math.max(0, totalHeight - prefixHeights[end]);

    topSpacer.style.height = `${topHeight}px`;
    bottomSpacer.style.height = `${bottomHeight}px`;
    renderAgendaRowsSlice(viewport, rows, start, end);
  };

  const scheduleRender = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      renderSlice();
    });
  };

  const onScroll = () => scheduleRender();
  const onResize = () => scheduleRender();
  list.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  list._agendaVirtualCleanup = () => {
    list.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onResize);
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  };

  renderSlice();
}

function renderAgendaView(days, allByDate) {
  const list = $('#agendaListView');
  const empty = $('#dayEmptyMsg');
  if (!list) return;

  cleanupAgendaVirtualization(list);
  list.classList.remove('agenda-virtualized', 'agenda-heavy');
  list.innerHTML = '';
  list.scrollTop = 0;

  const events = [];
  for (const d of days) {
    const ds = ymd(d);
    const rows = (allByDate.get(ds) || [])
      .filter(eventPassesActiveFilters)
      .sort(sortAgendaEvents);
    events.push(...rows);
  }
  events.sort(sortAgendaEvents);

  if (!events.length) {
    if (empty) {
      empty.textContent = 'Aún no hay eventos en este rango';
      empty.classList.remove('hidden');
    }
    return;
  }

  if (empty) empty.classList.add('hidden');

  const dayFmt = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });

  const rows = buildAgendaRenderRows(events, dayFmt);
  list.classList.toggle('agenda-heavy', events.length > 1000);

  if (events.length > AGENDA_VIRTUALIZATION_THRESHOLD) {
    mountAgendaVirtualization(list, rows);
    return;
  }

  renderAgendaRowsSlice(list, rows, 0, rows.length);
}

function getDayIndexFromPointer(dayCols, clientX){
  if (!Array.isArray(dayCols) || !dayCols.length) return -1;
  for (let i = 0; i < dayCols.length; i++) {
    const r = dayCols[i].getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right) return i;
  }
  return -1;
}

function buildUpdatedEventFromTimeDnd(evt, dayDate, startMinutes, durationMinutes){
  const startTime = minutesToHHMM(startMinutes);
  const plus = addMinutes(dayDate, startTime, durationMinutes);
  const sourceKind = getEventSourceKind(evt);
  const shouldSync = (sourceKind === 'google' || sourceKind === 'local');

  return {
    ...evt,
    allDay: false,
    date: dayDate,
    time: startTime,
    startDate: dayDate,
    startTime,
    endDate: plus.date,
    endTime: plus.time,
    monthKey: dayDate.slice(0, 7),
    needsGCalSync: shouldSync ? true : !!evt.needsGCalSync
  };
}

function attachTimeGridDnD({
  pill,
  evt,
  days,
  dayCols,
  dayIndex,
  minHeight
}) {
  if (!eventIsEditableInTimeGrid(evt)) {
    pill.classList.add('locked');
    return;
  }

  pill.classList.add('draggable');
  const handle = document.createElement('div');
  handle.className = 'pill-resize-handle';
  handle.setAttribute('aria-hidden', 'true');
  pill.append(handle);

  const startBase = hhmmToMinutes(evt.startTime || evt.time || '00:00');
  const durationBase = getEventDurationMinutes(evt);

  const setVisual = (startMin, durationMin) => {
    const topPx = clamp((startMin - DAY_START_H * 60) * PX_PER_MIN, 0, minHeight - 36);
    const hPx = clamp(durationMin * PX_PER_MIN, 36, minHeight - topPx);
    pill.style.top = `${topPx}px`;
    pill.style.height = `${hPx}px`;
    const timeEl = pill.querySelector('.pill-time');
    if (timeEl) {
      const from = minutesToHHMM(startMin);
      const to = minutesToHHMM(startMin + durationMin);
      timeEl.textContent = `${from} - ${to}`;
    }
  };

  const cleanup = () => {
    pill.classList.remove('dragging', 'resizing');
    document.body.classList.remove('event-dnd-active');
    if (_timeDnd.pill === pill) _timeDnd = null;
  };

  const startInteraction = (ev, kind) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();

    _timeDnd = {
      kind,
      pill,
      evt,
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      initialDayIndex: dayIndex,
      initialStart: startBase,
      initialDuration: durationBase,
      dayIndex,
      startMin: startBase,
      durationMin: durationBase,
      moved: false
    };

    pill.classList.add(kind === 'resize' ? 'resizing' : 'dragging');
    document.body.classList.add('event-dnd-active');
    pill.setPointerCapture?.(ev.pointerId);
  };

  const onPointerDown = (ev) => {
    const kind = ev.target.closest('.pill-resize-handle') ? 'resize' : 'move';
    startInteraction(ev, kind);
  };

  const onPointerMove = (ev) => {
    const st = _timeDnd;
    if (!st || st.pill !== pill || ev.pointerId !== st.pointerId) return;
    ev.preventDefault();
    ev.stopPropagation();

    const dyMin = roundMinutesStep((ev.clientY - st.startY) / PX_PER_MIN);

    if (st.kind === 'move') {
      const pointerDay = getDayIndexFromPointer(dayCols, ev.clientX);
      if (pointerDay >= 0) st.dayIndex = pointerDay;

      const maxStart = DAY_END_H * 60 - st.durationMin;
      let nextStart = st.initialStart + dyMin;
      nextStart = roundMinutesStep(nextStart);
      nextStart = clamp(nextStart, DAY_START_H * 60, Math.max(DAY_START_H * 60, maxStart));
      st.startMin = nextStart;

      if (pill.parentElement !== dayCols[st.dayIndex]) {
        dayCols[st.dayIndex].appendChild(pill);
      }
      setVisual(st.startMin, st.durationMin);
      st.moved = st.moved || Math.abs(ev.clientY - st.startY) > 4 || st.dayIndex !== st.initialDayIndex;
    } else {
      let nextDuration = st.initialDuration + dyMin;
      nextDuration = roundMinutesStep(nextDuration);
      const maxByDay = DAY_END_H * 60 - st.startMin;
      nextDuration = clamp(nextDuration, DND_MIN_DURATION_MIN, Math.max(DND_MIN_DURATION_MIN, maxByDay));
      st.durationMin = nextDuration;
      setVisual(st.startMin, st.durationMin);
      st.moved = st.moved || Math.abs(ev.clientY - st.startY) > 4;
    }
  };

  const finishInteraction = async (ev, cancelled = false) => {
    const st = _timeDnd;
    if (!st || st.pill !== pill || (ev && ev.pointerId !== st.pointerId)) return;
    ev.preventDefault();
    ev.stopPropagation();
    pill.releasePointerCapture?.(st.pointerId);

    const didMove = !!st.moved && !cancelled;
    cleanup();

    if (!didMove) return;
    pill.dataset.blockClick = '1';
    setTimeout(() => { delete pill.dataset.blockClick; }, 220);

    const targetDate = ymd(days[st.dayIndex] || days[0]);
    const updatedEvt = buildUpdatedEventFromTimeDnd(st.evt, targetDate, st.startMin, st.durationMin);

    try {
      await sbUpsertEvent(updatedEvt);
      clearDataError();
      await syncReminderScheduleToSW({
        requestPermission: false,
        triggerCheck: true,
        reason: 'dnd_update',
        force: true
      });
    } catch (err) {
      reportDataError('mover o redimensionar evento', err);
    } finally {
      reRender();
    }
  };

  pill.addEventListener('pointerdown', onPointerDown);
  pill.addEventListener('pointermove', onPointerMove);
  pill.addEventListener('pointerup', (ev) => finishInteraction(ev, false));
  pill.addEventListener('pointercancel', (ev) => finishInteraction(ev, true));
}

async function renderTimeView(mode, anchor) {
  const days = rangeDays(mode, anchor);
  $('#timeRangeTitle') && ($('#timeRangeTitle').textContent = formatRangeTitle(days));
  updateAppTitleForMonth(anchor);

  const head = $('#timeDaysHeader');
  const grid = $('#timeGrid');
  const weekViewShell = $('#weekViewShell');
  const agenda = $('#agendaListView');
  const empty = $('#dayEmptyMsg');
  if (!head || !grid) return;

  const allByDate = await getEventsByDates(days.map(ymd));
  addHolidayStubsToMap(days, allByDate);

  if (mode === 'agenda') {
    weekViewShell?.classList.add('hidden');
    head.classList.add('hidden');
    grid.classList.add('hidden');
    grid.classList.remove('compact-time-list');
    grid.removeAttribute('data-layout');
    head.style.gridTemplateColumns = '';
    grid.style.gridTemplateColumns = '';
    grid.innerHTML = '';
    agenda.classList.remove('hidden');
    renderAgendaView(days, allByDate);
    return;
  }

  agenda.classList.add('hidden');
  weekViewShell?.classList.remove('hidden');
  head.classList.remove('hidden');
  grid.classList.remove('hidden');
  const columnTemplate = `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))`;
  head.style.gridTemplateColumns = columnTemplate;
  grid.style.gridTemplateColumns = columnTemplate;

  head.innerHTML = '';
  days.forEach((d) => {
    const el = document.createElement('div');
    el.className = 'day-head-cell';
    const wd = WEEKDAYS_MIN[(d.getDay() + 6) % 7];
    el.textContent = `${wd} ${d.getDate()}`;
    head.append(el);
  });

  const hasAny = days.some((d) => (allByDate.get(ymd(d)) || []).some((e) => eventPassesActiveFilters(e)));

  if (mode === 'day') {
    if (empty) empty.textContent = 'Aún no hay eventos para este día';
    empty.classList.toggle('hidden', hasAny);
  } else {
    empty.classList.add('hidden');
  }

  grid.innerHTML = '';
  grid.classList.toggle('has-events', hasAny);
  grid.classList.add('compact-time-list');
  grid.dataset.layout = 'list';

  const dayCols = days.map(() => {
    const col = document.createElement('div');
    col.className = 'day-col calendar-day day-column';
    grid.append(col);
    return col;
  });

  days.forEach((d, dayIndex) => {
    const col = dayCols[dayIndex];
    const parseStartAt = (evt) => {
      const fromISO = Date.parse(String(evt?.start_at || '').trim());
      if (Number.isFinite(fromISO)) return fromISO;
      const ds = String(evt?.startDate || evt?.date || ymd(d) || '').trim();
      const ts = String(evt?.startTime || evt?.time || '00:00').trim() || '00:00';
      if (!ds) return 0;
      const fallback = Date.parse(localPartsToISO(ds, ts));
      return Number.isFinite(fallback) ? fallback : 0;
    };

    const evts = (allByDate.get(ymd(d)) || [])
      .filter(eventPassesActiveFilters)
      .slice()
      .sort((a, b) => parseStartAt(a) - parseStartAt(b));

    evts.forEach((evt) => {
      const tpl = $('#pillTpl');
      if (!tpl) return;
      const pill = tpl.content.firstElementChild.cloneNode(true);
      const sourceKind = getEventSourceKind(evt);
      const visualKind = getEventVisualKind(evt);
      const isAllDay = !!evt.allDay || evt.category === 'Festivo';
      pill.classList.add(`cat-${evt.category || 'Otros'}`, `source-${sourceKind}`, `kind-${visualKind}`, 'calendar-event', 'event-card');
      if (isAllDay) pill.classList.add('is-all-day');

      const title = (evt.category === 'Otros' && evt.categoryOther)
        ? `${evt.title} - ${evt.categoryOther}`
        : evt.title;
      const titleEl = pill.querySelector('.pill-title');
      titleEl.textContent = title || '';
      if (isAllDay) {
        titleEl.textContent = '';
        const iconEl = document.createElement('span');
        iconEl.className = 'event-icon all-day-icon';
        iconEl.setAttribute('aria-hidden', 'true');
        iconEl.textContent = '⏺';
        titleEl.append(iconEl, document.createTextNode(title || ''));
      }

      let timeText = '';
      if (evt.allDay || evt.category === 'Festivo') {
        pill.classList.add('all-day');
        timeText = 'Todo el dia';
      } else {
        const fallbackDate = ymd(d);
        const fromIso = isoToLocalParts(evt?.start_at || '', fallbackDate, '00:00');
        const toIso = isoToLocalParts(evt?.end_at || '', fromIso?.date || fallbackDate, fromIso?.time || '00:00');
        const startLabel = String(evt?.startTime || evt?.time || fromIso?.time || '00:00').trim();
        const endLabel = String(evt?.endTime || toIso?.time || startLabel).trim();
        timeText = endLabel && endLabel !== startLabel ? `${startLabel} - ${endLabel}` : startLabel;
      }
      pill.querySelector('.pill-time').textContent = timeText;

      pill.title = [
        evt.title,
        evt.location ? `- ${evt.location}` : '',
        evt.client ? `- ${evt.client}` : '',
        `- ${evt.category === 'Otros' && evt.categoryOther ? evt.categoryOther : evt.category}`
      ].join(' ').trim();

      on(pill, 'click', (ev) => {
        if (pill.dataset.blockClick === '1') {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        openSheetForEdit(evt);
      });

      col.append(pill);
    });
  });

  const staleNowLine = grid.querySelector('.now-line');
  staleNowLine?.remove?.();
}

// CRUD principal consolidado en la capa Supabase (implementaciones más abajo).

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
  delete copy.gcalId;          //  que no herede el evento remoto
  copy.needsGCalSync = true;   //  que se suba como nuevo

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

// Alta rápida consolidada en saveEventFromForm (implementación más abajo).

// ===================== Adjuntos =====================
let _previewURLs = new Map(); // eventId -> [blobUrls]

function ensurePreviewCleanupOnce() {
  if (ensurePreviewCleanupOnce._done) return; // evita registrarlo varias veces
  window.addEventListener('beforeunload', () => {
    try {
      for (const urls of _previewURLs.values()) {
        for (const u of urls) { try { URL.revokeObjectURL(u); } catch (err) { void err; } }
      }
    } finally {
      _previewURLs.clear();
    }
  });
  ensurePreviewCleanupOnce._done = true;
}

// Adjuntos: lectura/preview consolidado más abajo junto a Supabase.

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
        <button class="attv-close" value="cancel" aria-label="Cerrar"></button>
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
  backMgr.push('attViewer', () => { try{ dlg.close(); }catch (err) { void err; } });
  dlg.addEventListener('close', function onCloseOnce(){
    dlg.removeEventListener('close', onCloseOnce);
    backMgr.consumeOne();
  }, { once:true });
}

function closeAttachmentViewer(){
  const dlg = document.getElementById('attViewer');
  if (!dlg) return;
  try { dlg.close(); } catch (err) { void err; }
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

function injectHorizontalTagPills() {
  if (document.getElementById('tags-pill-css')) return;
  const css = `
  body.tags-v2 .events-tags{
    display:flex; flex-direction:row; flex-wrap:wrap;
    gap:4px; align-content:flex-start; min-width:0;
  }
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
  body.tags-v2 .events-tags .event-tag .etxt{
    display:inline-block; min-width:0; max-width:100%;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#e8f0fe; --tag-border:#c7d2fe; --tag-fg:#174ea6; }
  body.tags-v2 .event-tag.cat-Evento      { --tag-bg:#e6f4ea; --tag-border:#c7e3cf; --tag-fg:#0d652d; }
  body.tags-v2 .event-tag.cat-Citas      { --tag-bg:#fef7e0; --tag-border:#fde68a; --tag-fg:#8a4b00; }
  body.tags-v2 .event-tag.cat-Cumpleaños { --tag-bg:#f3e8ff; --tag-border:#e9d5ff; --tag-fg:#6b21a8; }
  body.tags-v2 .event-tag.cat-Otros      { --tag-bg:#eef2f7; --tag-border:#e5e7eb; --tag-fg:#334155; }
  body.tags-v2 .event-tag.cat-Festivo    { --tag-bg:#e0f2fe; --tag-border:#bae6fd; --tag-fg:#075985; }
  body.tags-v2 .events-tags::before,
  body.tags-v2 .events-tags::after{
    content:none !important;
    display:none !important;
    width:0 !important;
    height:0 !important;
    background:transparent !important;
    border:0 !important;
  }
  body.tags-v2 .events-tags{
    list-style:none !important;
    background-image:none !important;
    padding-left:0 !important;
  }
  body.tags-v2 .events-tags > * { min-width:0; }
  html[data-platform="ios"] body.tags-v2 .events-tags .event-tag .etxt{
    line-height:16px; padding-bottom:.5px;
  }
  `;
  const st = document.createElement('style');
  st.id = 'tags-pill-css';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectTagPillsBlue() {
  if (document.getElementById('tags-pill-blue')) return;
  const css = `
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
  body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#1a73e8; --tag-border:#1669c1; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Evento      { --tag-bg:#16a34a; --tag-border:#12833c; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Citas      { --tag-bg:#f59e0b; --tag-border:#d97706; --tag-fg:#0b0f02; }
  body.tags-v2 .event-tag.cat-Cumpleaños { --tag-bg:#9333ea; --tag-border:#7e22ce; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Otros      { --tag-bg:#64748b; --tag-border:#475569; --tag-fg:#ffffff; }
  body.tags-v2 .event-tag.cat-Festivo    { --tag-bg:#0ea5e9; --tag-border:#0284c7; --tag-fg:#04141c; }
  html[data-platform="ios"] body.tags-v2 .events-tags .event-tag .etxt{
    line-height:16px; padding-bottom:.5px;
  }
  `;
  const st = document.createElement('style');
  st.id = 'tags-pill-blue';
  st.textContent = css;
  document.head.appendChild(st);
}

function injectMobilePillAntidote() {
  if (document.getElementById('mobile-pill-antidote')) return;
  const css = `
@media (max-width: 1024px), (pointer: coarse) {
  #calendarGrid .events-tags{
    display:flex !important; flex-wrap:wrap !important; gap:4px !important;
    list-style:none !important; background:none !important; padding-left:0 !important;
    position:static !important; overflow:visible !important;
  }
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

function injectBiggerMonthCells() {
  if (document.getElementById('bigger-month-cells-css')) return;
  const st = document.createElement('style');
  st.id = 'bigger-month-cells-css';
  st.textContent = `
  @media (max-width: 1024px), (pointer: coarse){
    #monthView { padding-inline: 6px !important; }
    #calendarGrid{
      grid-template-columns: repeat(7, minmax(0,1fr)) !important;
      gap: 6px !important;
      padding: 0 !important;
    }
    #calendarGrid .day{
      min-height: clamp(82px, 14vw, 140px) !important;
      padding: 8px !important;
      border-radius: 12px !important;
    }
    #calendarGrid .day .day-head{ margin-bottom: 4px !important; }
  }`;
  document.head.appendChild(st);
}

function injectDenseTagText() {
  if (document.getElementById('dense-tag-text-css')) return;
  const st = document.createElement('style');
  st.id = 'dense-tag-text-css';
  st.textContent = `
  @media (max-width:1024px), (pointer:coarse){
    #calendarGrid .events-tags .event-tag{
      padding: 1px 6px !important;
      width: 100% !important;
      box-sizing: border-box !important;
      white-space: normal !important;
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

function injectEvenBiggerMonth() {
  if (document.getElementById('even-bigger-month-css')) return;
  const st = document.createElement('style');
  st.id = 'even-bigger-month-css';
  st.textContent = `
  @media (max-width:1024px), (pointer:coarse){
    #monthView{ padding-inline: 4px !important; }
    #calendarGrid{ gap: 4px !important; padding: 0 !important; }
    #calendarGrid .day{
      min-height: clamp(96px, 16vw, 180px) !important;
      padding: 8px !important;
      border-radius: 12px !important;
    }
    #calendarGrid .day .day-head{ margin-bottom: 4px !important; }
  }`;
  document.head.appendChild(st);
}

function nukeCountBadges() {
  if (document.getElementById('nuke-count-badges')) return;
  const css = `
@media (max-width: 1024px), (pointer: coarse) {
  #calendarGrid .events-tags,
  #calendarGrid .events-tags *{
    list-style: none !important;
    counter-reset: none !important;
    counter-increment: none !important;
  }
  #calendarGrid .day li::marker,
  #calendarGrid .events-tags li::marker,
  #calendarGrid .events-tags .event-tag::marker{
    content: "" !important;
  }
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

function injectTighterTagMargins() {
  if (document.getElementById('tight-tag-margins')) return;
  const st = document.createElement('style');
  st.id = 'tight-tag-margins';
  st.textContent = `
  @media (max-width:1024px), (pointer:coarse){
    #calendarGrid .day{ padding: 6px !important; }
    #calendarGrid .day .day-head{ margin-bottom: 2px !important; }
    #calendarGrid .events-tags .event-tag{
      width: 100% !important;
      padding: 2px 8px !important;
    }
    #calendarGrid .events-tags{ margin-inline: -1px !important; }
    #calendarGrid .events-tags .event-tag{ max-width: calc(100% + 2px) !important; }
  }`;
  document.head.appendChild(st);
}

function fixDarkTagColors() {
  if (document.getElementById('tag-dark-fix')) return;
  const st = document.createElement('style');
  st.id = 'tag-dark-fix';
  st.textContent = `
  [data-theme="dark"] body.tags-v2 .events-tags .event-tag{
    --tag-bg: initial; --tag-border: initial; --tag-fg: initial;
  }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#1a73e8; --tag-border:#1669c1; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Evento      { --tag-bg:#16a34a; --tag-border:#12833c; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Citas      { --tag-bg:#f59e0b; --tag-border:#d97706; --tag-fg:#0b0f02; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Cumpleaños { --tag-bg:#9333ea; --tag-border:#7e22ce; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Otros      { --tag-bg:#64748b; --tag-border:#475569; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Festivo    { --tag-bg:#0ea5e9; --tag-border:#0284c7; --tag-fg:#04141c; }
  `;
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

  /* 2) Píldoras: visibles, con texto y sin pseudo-elementos "barra" */
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

  /* 3) Colores (si algo los "aplana", los volvemos a fijar) */
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Trabajo    { --tag-bg:#1a73e8; --tag-border:#1669c1; --tag-fg:#fff; }
  [data-theme="dark"] body.tags-v2 .event-tag.cat-Evento      { --tag-bg:#16a34a; --tag-border:#12833c; --tag-fg:#fff; }
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

  /* Asegura "píldora" con texto recortable, no círculo */
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
  // neutraliza trucos típicos de "solo inicial"
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

// Borrado de adjuntos consolidado en handleAttachmentDelete (más abajo).

//  Garantiza que existe la UI de categoría en el sheet de evento 
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
      <option value="Evento">Evento</option>
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
  form.querySelector('#eventNotes').closest('.row') ||
  form.querySelector('#eventLocation').closest('.row');

  if (afterEl) afterEl.insertAdjacentHTML('afterend', html);
  else form.insertAdjacentHTML('beforeend', html);

  // listener local para mostrar el campo "Otros"
  const sel = form.querySelector('#eventCategory');
  const otherWrap = form.querySelector('#categoryOtherWrap');
  sel.addEventListener('change', (e) => {
    const show = e.target.value === 'Otros';
    otherWrap.classList.toggle('hidden', !show);
  });
}

// ===================== Sheets (Añadir/Editar) =====================
//  cierre al pulsar fuera 
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

const EVENT_COLOR_DEFAULT = '#3b82f6';

function normalizeEventColor(color, fallback = EVENT_COLOR_DEFAULT) {
  const raw = String(color || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toLowerCase() : fallback;
}

function setEventUrlColorFormState({ url = '', color = null, disabled = false } = {}) {
  const urlInput = $('#eventUrl');
  const colorInput = $('#eventColor');

  if (urlInput) {
    urlInput.value = String(url || '').trim();
    urlInput.disabled = !!disabled;
  }
  if (colorInput) {
    colorInput.value = normalizeEventColor(color, EVENT_COLOR_DEFAULT);
    colorInput.disabled = !!disabled;
  }
}

function getCalendarFilterHost() {
  return $('#calendarFilterList');
}

function formatCalendarLabel(entry) {
  if (!entry) return 'Calendario';
  return entry.primary ? `${entry.summary} (principal)` : entry.summary;
}

function setEventCalendarSelectState({ value = null, disabled = false } = {}) {
  const select = $('#eventGoogleCalendar');
  if (!select) return;
  const calendars = normalizeGoogleCalendarList(state.googleCalendars);
  const signature = calendars.map((c) => `${c.id}:${c.summary}:${c.primary ? 1 : 0}`).join('|');

  if (select.dataset.signature !== signature) {
    select.innerHTML = '';
    for (const cal of calendars) {
      const opt = document.createElement('option');
      opt.value = cal.id;
      opt.textContent = formatCalendarLabel(cal);
      select.append(opt);
    }
    select.dataset.signature = signature;
  }

  const allowed = new Set(calendars.map((c) => c.id));
  const target = normalizeGoogleCalendarId(value || state.selectedGoogleCalendarId || 'primary', 'primary');
  const resolved = allowed.has(target) ? target : (calendars[0]?.id || 'primary');
  select.value = resolved;
  select.disabled = !!disabled;
  state.selectedGoogleCalendarId = resolved;
}

function renderCalendarFiltersUI() {
  const host = getCalendarFilterHost();
  if (!host) return;
  const calendars = normalizeGoogleCalendarList(state.googleCalendars);
  const active = state.calendarFilters instanceof Set ? state.calendarFilters : new Set();

  host.innerHTML = '';
  for (const cal of calendars) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'calendar-filter';
    input.value = cal.id;
    input.checked = active.has(cal.id);
    input.addEventListener('change', (ev) => {
      const nextId = normalizeGoogleCalendarId(ev.target.value, 'primary');
      if (!(state.calendarFilters instanceof Set)) state.calendarFilters = new Set();
      if (ev.target.checked) state.calendarFilters.add(nextId);
      else state.calendarFilters.delete(nextId);
      if (!state.calendarFilters.size) {
        const first = state.googleCalendars[0]?.id || 'primary';
        state.calendarFilters.add(first);
        ev.target.checked = nextId === first;
      }
      if (state.viewMode === 'month') renderCalendar(state.currentMonth);
      else renderTimeView(state.viewMode, state.selectedDate || new Date());
    });
    label.append(input, document.createTextNode(` ${formatCalendarLabel(cal)}`));
    host.append(label);
  }
}

function setGoogleCalendars(calendars, { reason = 'runtime', preserveFilters = true } = {}) {
  const normalized = normalizeGoogleCalendarList(calendars);
  const available = new Set(normalized.map((c) => c.id));
  const prevFilters = state.calendarFilters instanceof Set ? new Set(state.calendarFilters) : new Set();
  const prevSelected = normalizeGoogleCalendarId(state.selectedGoogleCalendarId || null, 'primary');

  state.googleCalendars = normalized;
  state.calendarFilters = new Set();
  if (preserveFilters) {
    for (const id of prevFilters) {
      if (available.has(id)) state.calendarFilters.add(id);
    }
  }
  if (!state.calendarFilters.size) {
    for (const id of available) state.calendarFilters.add(id);
  }

  state.selectedGoogleCalendarId = available.has(prevSelected)
    ? prevSelected
    : (normalized[0]?.id || 'primary');

  setEventCalendarSelectState({ value: state.selectedGoogleCalendarId });
  renderCalendarFiltersUI();
  syncLog('calendar_filters_updated', {
    reason,
    calendars: normalized.map((c) => ({ id: c.id, primary: c.primary })),
    activeCount: state.calendarFilters.size
  });
}

const EVENT_ATTACHMENT_DRAFT_KEY = '__event_sheet_draft__';
const EVENT_ATTACHMENT_PICKERS = Object.freeze([
  { key: 'camera', buttonSel: '#pickCameraBtn', inputSel: '#eventFilesCamera', baseLabel: 'Camara' },
  { key: 'gallery', buttonSel: '#pickGalleryBtn', inputSel: '#eventFilesGallery', baseLabel: 'Galeria' },
  { key: 'files', buttonSel: '#pickFilesBtn', inputSel: '#eventFilesFiles', baseLabel: 'Archivos' }
]);

let _eventSheetPendingAttachments = [];
let _eventAttachmentUploadQueue = Promise.resolve();
let _eventAttachmentUploadsInFlight = 0;

function getEventAttachmentPickerConfig(key) {
  return EVENT_ATTACHMENT_PICKERS.find((cfg) => cfg.key === key) || null;
}

function setAttachmentPickerButtonLabel(cfg, count = 0) {
  const btn = $(cfg.buttonSel || '');
  if (!btn) return;
  if (!btn.dataset.baseLabel) {
    btn.dataset.baseLabel = (btn.textContent || cfg.baseLabel || 'Adjunto').trim();
  }
  const base = btn.dataset.baseLabel || cfg.baseLabel || 'Adjunto';
  btn.textContent = count > 0 ? `${base} (${count})` : base;
}

function resetEventAttachmentPickers() {
  for (const cfg of EVENT_ATTACHMENT_PICKERS) {
    const input = $(cfg.inputSel);
    if (input) input.value = '';
    setAttachmentPickerButtonLabel(cfg, 0);
  }
}

function setEventAttachmentPickersDisabled(disabled) {
  for (const cfg of EVENT_ATTACHMENT_PICKERS) {
    const btn = $(cfg.buttonSel);
    if (btn) btn.disabled = !!disabled;
  }
}

function getEditingEventIdFromForm() {
  const id = String($('#eventId').value || '').trim();
  return id || null;
}

function clearPreviewUrlsForKey(key) {
  (_previewURLs.get(key) || []).forEach((u) => {
    try { URL.revokeObjectURL(u); } catch (err) { void err; }
  });
  _previewURLs.set(key, []);
}

function clearEventAttachmentDraft({ clearPreview = false } = {}) {
  _eventSheetPendingAttachments = [];
  clearPreviewUrlsForKey(EVENT_ATTACHMENT_DRAFT_KEY);
  if (clearPreview) {
    const wrap = $('#attachmentsPreview');
    if (wrap) wrap.innerHTML = '';
  }
}

function renderEventAttachmentDraftPreview() {
  injectAttachmentViewerStyles();
  const wrap = $('#attachmentsPreview');
  if (!wrap) return;

  clearPreviewUrlsForKey(EVENT_ATTACHMENT_DRAFT_KEY);
  wrap.innerHTML = '';
  if (!_eventSheetPendingAttachments.length) return;

  for (const a of _eventSheetPendingAttachments) {
    const card = document.createElement('div');
    card.className = 'attachment-card';

    let blobURL = null;
    if (a.blob) {
      blobURL = URL.createObjectURL(a.blob);
      _previewURLs.get(EVENT_ATTACHMENT_DRAFT_KEY).push(blobURL);
    }

    if (blobURL && a.type && a.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = blobURL;
      img.alt = a.name || 'adjunto';
      card.append(img);
    } else if (blobURL && a.type && a.type.startsWith('video/')) {
      const vid = document.createElement('video');
      vid.src = blobURL;
      vid.controls = true;
      card.append(vid);
    } else {
      const box = document.createElement('div');
      box.style.padding = '.6rem';
      box.style.textAlign = 'center';
      box.textContent = a.name || 'archivo';
      card.append(box);
    }

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = a.name || 'archivo';
    card.append(name);

    if (blobURL) {
      card.tabIndex = 0;
      card.addEventListener('click', () => openAttachmentViewer(a, blobURL));
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openAttachmentViewer(a, blobURL);
        }
      });
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'att-del';
    delBtn.title = 'Eliminar adjunto';
    delBtn.textContent = 'Eliminar';
    delBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await confirmNative({
        title: 'Eliminar adjunto',
        message: `Quieres eliminar ${a.name || 'este archivo'}`,
        confirmText: 'Eliminar',
        cancelText: 'Cancelar',
        destructive: true
      });
      if (!ok) return;
      try {
        await deleteDriveFileIfAllowed(a);
      } catch (err) {
        reportDataError('eliminar adjunto en Drive', err, { silent: true });
      }
      _eventSheetPendingAttachments = _eventSheetPendingAttachments.filter((item) => item.id !== a.id);
      renderEventAttachmentDraftPreview();
      showToast('Adjunto eliminado', { actionLabel: null, onUndo: null, duration: 3000 });
    });
    card.append(delBtn);
    wrap.append(card);
  }
}

async function ensureAttachmentDriveId(att) {
  const existing = (typeof MODULE_ATTACHMENTS_DRIVE.resolveDriveFileId === 'function')
    ? MODULE_ATTACHMENTS_DRIVE.resolveDriveFileId(att)
    : String(att.gdriveId || att.drive_file_id || '').trim();
  if (existing) return existing;
  if (!att.blob) throw new Error('Adjunto sin drive_file_id ni blob');
  const up = await driveUploadMultipart(att.blob, {
    name: att.name || att.file_name || 'archivo',
    mimeType: att.type || att.file_type || 'application/octet-stream'
  });
  const driveId = String(up.id || '').trim();
  if (!driveId) throw new Error('Drive no devolvio drive_file_id');
  return driveId;
}

async function rollbackAttachmentCacheEntry(attId) {
  if (!attId) return;
  try {
    await cacheDeleteAttachmentById(attId);
  } catch (err) { void err; }
}

async function rollbackDriveUploadById(driveId) {
  const id = String(driveId || '').trim();
  if (!id) return;
  try {
    await gapiFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  } catch (err) {
    syncLog('drive_upload_rollback_failed', {
      driveFileId: id,
      error: err.message || String(err)
    }, 'warn');
  }
}

async function sbUpsertAttachmentWithRetry(att, eventId, {
  attempts = 2,
  context = 'guardar metadato de adjunto',
  source = 'local',
  writeLockToken = null
} = {}) {
  let lastErr = null;
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const saved = await sbUpsertAttachment(att, eventId, { source, writeLockToken });
      clearDataError();
      return saved;
    } catch (err) {
      lastErr = err;
      reportDataError(context, err, { silent: attempt < maxAttempts });
      if (attempt < maxAttempts) {
        await sleep(250 * attempt);
      }
    }
  }
  throw lastErr || new Error('No se pudo guardar metadato de adjunto');
}

async function persistAttachmentMetaWithDriveId(att, eventId, errorContext = 'guardar metadato de adjunto') {
  const hadDriveIdBefore = String(att.gdriveId || att.drive_file_id || '').trim();
  const driveId = await ensureAttachmentDriveId(att);
  if (!driveId) throw new Error('Adjunto sin drive_file_id');

  const normalized = (typeof MODULE_ATTACHMENTS_DRIVE.normalizeAttachmentForPersistence === 'function')
    ? MODULE_ATTACHMENTS_DRIVE.normalizeAttachmentForPersistence({
      ...att,
      gdriveId: driveId,
      drive_file_id: driveId
    }, eventId, ensureUuidId)
    : {
      ...att,
      id: ensureUuidId(att.id),
      eventId,
      name: att.name || att.file_name || 'archivo',
      type: att.type || att.file_type || 'application/octet-stream',
      gdriveId: driveId,
      drive_file_id: driveId
    };

  await cachePutAttachments([normalized]);
  try {
    return await sbUpsertAttachmentWithRetry(normalized, eventId, {
      attempts: 2,
      context: errorContext
    });
  } catch (err) {
    await rollbackAttachmentCacheEntry(normalized.id);
    if (!hadDriveIdBefore) {
      await rollbackDriveUploadById(driveId);
    }
    throw err;
  }
}

function enqueueEventAttachmentUpload(task) {
  const run = () => Promise.resolve().then(task);
  _eventAttachmentUploadQueue = _eventAttachmentUploadQueue.then(run, run);
  return _eventAttachmentUploadQueue;
}

async function waitForEventAttachmentUploads() {
  try {
    await _eventAttachmentUploadQueue;
  } catch (err) { void err; }
}

async function uploadEventPickerFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;

  _eventAttachmentUploadsInFlight += 1;
  setEventAttachmentPickersDisabled(true);

  try {
    const eventId = getEditingEventIdFromForm();
    for (const file of list) {
      try {
        const upload = await driveUploadMultipart(file, {
          name: file.name || 'archivo',
          mimeType: file.type || 'application/octet-stream'
        });
        const driveId = String(upload.id || '').trim();
        if (!driveId) throw new Error('Drive no devolvio drive_file_id');

        const localAttachment = {
          id: ensureUuidId(),
          eventId: eventId || null,
          name: file.name || 'archivo',
          type: file.type || 'application/octet-stream',
          blob: file,
          gdriveId: driveId,
          drive_file_id: driveId
        };

        if (eventId) {
          await persistAttachmentMetaWithDriveId(localAttachment, eventId, 'guardar adjunto en Supabase');
        } else {
          _eventSheetPendingAttachments.push(localAttachment);
        }
      } catch (err) {
        reportDataError('subir adjunto a Drive', err, { silent: true });
        showToast(`No se pudo subir ${file.name || 'un adjunto'} a Drive.`, {
          actionLabel: null,
          onUndo: null,
          duration: 3500
        });
      }
    }

    if (eventId) {
      await renderAttachmentPreview(eventId);
    } else {
      renderEventAttachmentDraftPreview();
    }
  } finally {
    _eventAttachmentUploadsInFlight = Math.max(0, _eventAttachmentUploadsInFlight - 1);
    setEventAttachmentPickersDisabled(_eventAttachmentUploadsInFlight > 0);
  }
}

async function handleEventAttachmentPickerChange(key) {
  const cfg = getEventAttachmentPickerConfig(key);
  if (!cfg) return;
  const input = $(cfg.inputSel);
  if (!input) return;

  const files = Array.from(input.files || []);
  setAttachmentPickerButtonLabel(cfg, files.length);
  if (!files.length) return;

  try {
    await enqueueEventAttachmentUpload(() => uploadEventPickerFiles(files));
  } finally {
    input.value = '';
    setAttachmentPickerButtonLabel(cfg, 0);
  }
}

function openSheetNew() {
  const baseDate = state.selectedDate || new Date();
  const base = ymd(baseDate);
  const startTime = '10:00';
  const plus = addMinutes(base, startTime, 60);

  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Añadir evento');
  $('#deleteEventBtn').classList.add('hidden');

  $('#duplicateFromId') && ($('#duplicateFromId').value = ''); // limpiar
  $('#duplicateEventBtn').classList.add('hidden');

  const idEl = $('#eventId');      if (idEl) idEl.value = '';
  const ttlEl = $('#eventTitle');  if (ttlEl) ttlEl.value = '';

  // Todo el día OFF por defecto
  const allDayEl = $('#eventAllDay'); if (allDayEl) allDayEl.checked = false;
  setAllDayUI(false);

  $('#eventStartDate').setAttribute('value', base);
  $('#eventStartDate').value = base;
  $('#eventStartTime').setAttribute('value', startTime);
  $('#eventStartTime').value = startTime;

  $('#eventEndDate').setAttribute('value', plus.date);
  $('#eventEndDate').value = plus.date;
  $('#eventEndTime').setAttribute('value', plus.time);
  $('#eventEndTime').value = plus.time;

  $('#eventLocation').setAttribute('value', '');
  $('#eventLocation').value = '';
  setEventUrlColorFormState({ url: '', color: null, disabled: false });
  setEventCalendarSelectState({ value: state.selectedGoogleCalendarId || 'primary', disabled: false });

  $('#eventAlert') && ($('#eventAlert').value = 'none');
  $('#eventRepeat') && ($('#eventRepeat').value = 'none');
  $('#eventNotes') && ($('#eventNotes').value = '');

  $('#eventCategory') && ($('#eventCategory').value = 'Trabajo');
  $('#categoryOtherWrap').classList.add('hidden');
  $('#eventCategoryOther') && ($('#eventCategoryOther').value = '');

  resetEventAttachmentPickers();
  clearEventAttachmentDraft({ clearPreview: true });
  openSheet();

  $('#eventNotes') && ($('#eventNotes').value = '');
  autosizeNotes();
}

async function openSheetForEdit(evt) {
  state.selectedDate = parseDateInput(evt.date);

  const isLockedEvent = isHolidayEvent(evt) || evt.locked;
  setEventUrlColorFormState({
    url: evt.url || '',
    color: evt.color || null,
    disabled: isLockedEvent
  });
  setEventCalendarSelectState({
    value: getEventGoogleCalendarId(evt, 'primary'),
    disabled: isLockedEvent
  });

  if (isLockedEvent) {
    showToast('Evento bloqueado: no editable');
    return;
  }

  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Editar evento');
  $('#deleteEventBtn').classList.remove('hidden');

  $('#duplicateFromId') && ($('#duplicateFromId').value = ''); // limpiar
  $('#duplicateEventBtn').classList.remove('hidden');

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
  setEventUrlColorFormState({
    url: evt.url || '',
    color: evt.color || null,
    disabled: false
  });
  setEventCalendarSelectState({
    value: getEventGoogleCalendarId(evt, 'primary'),
    disabled: false
  });

  $('#eventAlert') && ($('#eventAlert').value = evt.alert || 'none');
  $('#eventRepeat') && ($('#eventRepeat').value = evt.repeat || 'none');
  $('#eventNotes') && ($('#eventNotes').value = evt.notes || '');

  $('#eventCategory') && ($('#eventCategory').value = evt.category || 'Trabajo');
  if (evt.category === 'Otros') {
    $('#categoryOtherWrap').classList.remove('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = evt.categoryOther || '');
  } else {
    $('#categoryOtherWrap').classList.add('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = '');
  }

  resetEventAttachmentPickers();
  clearEventAttachmentDraft({ clearPreview: false });
  await renderAttachmentPreview(evt.id);
  openSheet();

  $('#eventNotes') && ($('#eventNotes').value = evt.notes || '');
autosizeNotes();
}

async function startDuplicateFlow(originalId){
  const evt = await getEventById(originalId);
  if (!evt) {
    showToast('No se encontro el evento a duplicar', 'error');
    return;
  }

  // Título y botones
  $('#sheetTitle') && ($('#sheetTitle').textContent = 'Duplicar evento');
  $('#deleteEventBtn').classList.add('hidden');     // no borrar en modo nuevo
  $('#duplicateEventBtn').classList.add('hidden');  // no mostrar duplicar dentro de un nuevo

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
  setEventUrlColorFormState({
    url: evt.url || '',
    color: evt.color || null,
    disabled: false
  });
  setEventCalendarSelectState({
    value: getEventGoogleCalendarId(evt, 'primary'),
    disabled: false
  });
  $('#eventAlert')     && ($('#eventAlert').value     = evt.alert || 'none');
  $('#eventRepeat')    && ($('#eventRepeat').value    = evt.repeat || 'none');
  $('#eventNotes')     && ($('#eventNotes').value     = evt.notes || '');

  $('#eventCategory')  && ($('#eventCategory').value  = evt.category || 'Trabajo');
  if (evt.category === 'Otros') {
    $('#categoryOtherWrap').classList.remove('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = evt.categoryOther || '');
  } else {
    $('#categoryOtherWrap').classList.add('hidden');
    $('#eventCategoryOther') && ($('#eventCategoryOther').value = '');
  }

  // No cargamos vista previa de adjuntos aquí: se copiarán al Guardar
  resetEventAttachmentPickers();
  clearEventAttachmentDraft({ clearPreview: true });

  openSheet();
  showToast('Edita la fecha/hora y pulsa Guardar para crear la copia');
}

function openSheet() {
  const sheet = $('#addEventSheet'); if (!sheet) return;

  ensureCategoryUI();
  
  sheet.classList.remove('closing');
  sheet.classList.remove('hidden');
  requestAnimationFrame(()=> sheet.classList.add('open'));
  attachOutsideCloseForSheet(sheet, () => closeSheet()); // tap fuera = cerrar
  // <- tecla atrás cierra esta hoja
  backMgr.push('sheet', () => {
    sheet.classList.add('closing');
    sheet.classList.remove('open');
    setTimeout(() => {
      sheet.classList.add('hidden');
      sheet.classList.remove('closing');
    }, 180);
    detachOutsideCloseForSheet(sheet);
  });
}

function closeSheet() {
  const sheet = $('#addEventSheet'); if (!sheet) return;
  // consume la entrada del historial porque estamos cerrando "a mano"
  backMgr.consumeOne();
  clearEventAttachmentDraft({ clearPreview: true });
  resetEventAttachmentPickers();
  sheet.classList.add('closing');
  sheet.classList.remove('open');
  setTimeout(() => {
    sheet.classList.add('hidden');
    sheet.classList.remove('closing');
  }, 180);
  detachOutsideCloseForSheet(sheet);
}


// Helpers para otros sheets
function openSheetById(id){
  const sheet = document.getElementById(id); if (!sheet) return;
  sheet.classList.remove('closing');
  sheet.classList.remove('hidden');
  requestAnimationFrame(()=> sheet.classList.add('open'));
  attachOutsideCloseForSheet(sheet, ()=> closeSheetById(id));
  backMgr.push('sheet:'+id, () => {
    sheet.classList.add('closing');
    sheet.classList.remove('open');
    setTimeout(() => {
      sheet.classList.add('hidden');
      sheet.classList.remove('closing');
    }, 180);
    detachOutsideCloseForSheet(sheet);
  });
}
function closeSheetById(id){
  const sheet = document.getElementById(id); if (!sheet) return;
  backMgr.consumeOne();
  sheet.classList.add('closing');
  sheet.classList.remove('open');
  setTimeout(() => {
    sheet.classList.add('hidden');
    sheet.classList.remove('closing');
  }, 180);
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

// Buscador avanzado consolidado más abajo (Supabase + caché).

//  Resaltado seguro del primer término 
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
  return (t.length > maxChars) ? (t.slice(0, maxChars - 1) + '...') : t;
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
//  Listeners de búsqueda a pantalla completa  //
let searchTimer = null;

on('#searchInput','focus', () => {
  // abre overlay si ya hay texto
  const v = $('#searchInput').value.trim();
  if (v) openSearchFull();
});

on('#searchInput','input', (e)=>{
  const raw = e.target.value;
  clearTimeout(searchTimer);

  if (!raw){
    closeSearchFull();
    $('#searchResults').classList.remove('open'); // ocultar lista antigua
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
  $('#searchResults').classList.remove('open'); // por si acaso
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
  .month-out-left{ animation: calMonthOutLeft 160ms cubic-bezier(.4,0,.2,1) both }
  .month-in-right{ animation: calMonthInRight 160ms cubic-bezier(.4,0,.2,1) both }
  .month-out-right{ animation: calMonthOutRight 160ms cubic-bezier(.4,0,.2,1) both }
  .month-in-left{ animation: calMonthInLeft 160ms cubic-bezier(.4,0,.2,1) both }
  .month-transition-enter{ opacity:0; transform:translateY(6px) }
  .month-transition-active{
    opacity:1; transform:translateY(0);
    transition: opacity 160ms cubic-bezier(.4,0,.2,1), transform 160ms cubic-bezier(.4,0,.2,1)
  }
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
  /* En la vista de mes, no dejamos que el navegador "se lleve" el gesto vertical.
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
  .toast.toast-success{
    background:var(--color-primary,var(--primary,#0ea5e9));
    border-color:transparent;
    color:#fff;
  }
  .toast.toast-error{
    background:#e53935;
    border-color:transparent;
    color:#fff;
  }
  .toast.toast-info{
    background:#5c6bc0;
    border-color:transparent;
    color:#fff;
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

function showToast(text, config = {}, maybeDuration = 3500){
  const opts = (typeof config === 'string')
    ? { type: config, duration: maybeDuration, actionLabel: null, onUndo: null }
    : (config && typeof config === 'object' ? config : {});

  const {
    type = 'info',
    actionLabel = 'Deshacer',
    onUndo = null,
    duration = 6000,
    toastKey = null
  } = opts;

  injectToastStyles();
  const host = ensureToastHost();
  positionToastHost();
  const normalizedToastKey = String(toastKey || '').trim();
  if (normalizedToastKey) {
    const existing = [...host.querySelectorAll('.toast')]
      .find((node) => node.dataset?.toastKey === normalizedToastKey);
    if (existing) return existing;
  }

  const el = document.createElement('div');
  const normalizedType = String(type || 'info').trim().toLowerCase();
  const typeClass = (normalizedType === 'success' || normalizedType === 'error')
    ? `toast-${normalizedType}`
    : 'toast-info';
  el.className = `toast app-toast ${typeClass}`;
  if (normalizedToastKey) el.dataset.toastKey = normalizedToastKey;
  el.setAttribute('role','status');
  el.setAttribute('aria-live','polite');

  el.innerHTML = `
    <span class="msg"></span>
    ${onUndo ? `<button class="btn-undo" type="button">${actionLabel}</button>` : ''}
    <button class="btn-close" type="button" aria-label="Cerrar"></button>
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
  const title = $('#currentMonthLabel');
  if (!grid) {
    rerender();
    return;
  }
  const targets = [grid, title].filter(Boolean);
  targets.forEach((el) => {
    el.classList.remove('month-transition-enter', 'month-transition-active');
    el.classList.add('month-transition-enter');
  });
  requestAnimationFrame(() => {
    rerender();
    targets.forEach((el) => {
      el.classList.add('month-transition-active');
    });
    setTimeout(() => {
      targets.forEach((el) => {
        el.classList.remove('month-transition-enter', 'month-transition-active');
      });
    }, 180);
  });
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
    .replace(/<br\s*\/>/gi, '\n')
    .replace(/<\/p>/gi, '\n');
  const tmp = document.createElement('div');
  tmp.innerHTML = withNewlines;
  return (tmp.textContent || tmp.innerText || '').trim();
}

//  util: ocultar flechas de navegación clásicas  //
function hideLegacyNavArrows(){
  ['#prevMonth','#nextMonth','#prevYear','#nextYear'].forEach(sel=>{
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.display = 'none';
    el.setAttribute('aria-hidden','true');
    el.setAttribute('tabindex','-1');
    if ('disabled' in el) el.disabled = true;
    try { el.inert = true; } catch (err) { void err; }
  });
}

function setPlatformClass() {
  const ua = navigator.userAgent || '';
  const isIOS = /iP(hone|ad|od)/.test(ua) || ((/Macintosh/.test(ua)) && 'ontouchend' in document);
  const isAndroid = /Android/i.test(ua);
  document.documentElement.setAttribute('data-platform', isIOS ? 'ios' : (isAndroid ? 'android' : 'other'));
}

function updateLandscapeClass() {
  if (!document?.body) return;
  document.body.classList.toggle(
    'is-landscape',
    window.matchMedia('(orientation: landscape)').matches
  );
}

function bindLandscapeResizeClassOnce() {
  if (bindLandscapeResizeClassOnce._bound) return;
  bindLandscapeResizeClassOnce._bound = true;
  window.addEventListener('resize', () => {
    document.body.classList.toggle(
      'is-landscape',
      window.matchMedia('(orientation: landscape)').matches
    );
  });
  window.addEventListener('orientationchange', updateLandscapeClass);
  updateLandscapeClass();
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
on('#eventGoogleCalendar', 'change', (e) => {
  state.selectedGoogleCalendarId = normalizeGoogleCalendarId(e?.target?.value || 'primary', 'primary');
});

on('#updateNowBtn','click', async ()=>{
  const btn = qs('#updateNowBtn');
  btn.classList.add('loading');

  try{
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg){
      if (reg.waiting){
        reg.waiting.postMessage({ type:'SKIP_WAITING' });
      } else if (reg.installing){
        await new Promise(r => reg.installing.addEventListener('statechange', e=>{
          if (e.target.state === 'installed') r();
        }));
        if (reg.waiting) {
          reg.waiting.postMessage({ type:'SKIP_WAITING' });
        }
      }
    }
    if ('caches' in window){
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  }catch(e){ console.warn(e); }

  localStorage.removeItem('forceUpdate.min'); // <- evita bucle del cartel

  const base = location.href.split('#')[0];
  location.replace(appendCacheBuster(base, 'u'));
});


// Botón marcar/desmarcar todos
on('#toggleAllCats','click', ()=>{
  const all = ALL_CATS.slice();
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

// Navegación mensual (flechas superiores + controles legacy)
function getSafeCurrentMonth() {
  const cur = (state.currentMonth instanceof Date && !Number.isNaN(state.currentMonth.getTime()))
    ? state.currentMonth
    : new Date();
  return new Date(cur.getFullYear(), cur.getMonth(), 1);
}

function navigateMonthByOffset(offset) {
  const base = getSafeCurrentMonth();
  const target = new Date(base.getFullYear(), base.getMonth() + offset, 1);

  if (state.viewMode !== 'month') {
    state.currentMonth = target;
    state.selectedDate = new Date(target.getFullYear(), target.getMonth(), 1);
    setViewMode('month');
    return;
  }

  const dir = offset < 0 ? 'prev' : 'next';
  animateMonth(dir, ()=>{ state.currentMonth = target; renderCalendar(state.currentMonth); });
}

function goToPrevMonth() {
  navigateMonthByOffset(-1);
}

function goToNextMonth() {
  navigateMonthByOffset(1);
}

on('#prevMonthBtn','click', goToPrevMonth);
on('#nextMonthBtn','click', goToNextMonth);
on('#prevMonth','click', goToPrevMonth);
on('#nextMonth','click', goToNextMonth);
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
  const v=$('#jumpDate').value; if(!v) return;
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
    try { localStorage.removeItem('forceUpdate.min'); } catch (err) { void err; }
    location.replace(appendCacheBuster(location.pathname, 'u'));
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
  const id = $('#eventId').value;
  if (!id) return;
  try {
    await startDuplicateFlow(id);
  } catch (err) {
    console.error(err);
    showToast('No se pudo iniciar la duplicacion.', 'error');
  }
});


on('#deleteEventBtn','click', async ()=>{
  const id = $('#eventId').value; if (!id) return;

  const ok = await confirmNative({
    title: 'Eliminar evento',
    message: 'Se eliminará el evento y todos sus archivos adjuntos. ¿Seguro que quieres continuar',
    confirmText: 'Eliminar',
    cancelText: 'Cancelar',
    destructive: true
  });

  if (ok) {
    await deleteEvent(id);
  }
});

// Listeners del formulario (globales, no dentro de "Eliminar")
on('#eventAllDay','change', (e)=> setAllDayUI(!!e.target.checked));

on('#pickCameraBtn','click', ()=> $('#eventFilesCamera').click());
on('#pickGalleryBtn','click', ()=> $('#eventFilesGallery').click());
on('#pickFilesBtn','click', ()=> $('#eventFilesFiles').click());

on('#eventFilesCamera','change', ()=> { handleEventAttachmentPickerChange('camera'); });
on('#eventFilesGallery','change', ()=> { handleEventAttachmentPickerChange('gallery'); });
on('#eventFilesFiles','change', ()=> { handleEventAttachmentPickerChange('files'); });

// Sheets nuevos: Cumpleaños
on('#closeBirthdaySheet','click', ()=> closeSheetById('addBirthdaySheet'));
on('#cancelBirthdayBtn','click', ()=> closeSheetById('addBirthdaySheet'));
on('#birthdayForm','submit', (ev)=> saveEventFromForm(ev, 'Cumpleaños'));

// Sheets nuevos: Tarea
on('#closeTaskSheet','click', ()=> closeSheetById('addTaskSheet'));
on('#cancelTaskBtn','click', ()=> closeSheetById('addTaskSheet'));
on('#taskForm','submit', (ev)=> saveEventFromForm(ev, 'Evento'));

// ===== Navegación por gestos (swipe)  versión Pointer Events =====
function addSwipeNavigation(){
  if (addSwipeNavigation._enabled) return;

  const isCoarse = window.matchMedia('(pointer: coarse)').matches;
  const smallScreen = window.matchMedia('(max-width: 1280px)').matches;
  if (!(isCoarse && smallScreen)) return;

  addSwipeNavigation._enabled = true;

  const targets = ['#calendarGrid','#timeGrid','#timeDaysHeader','#agendaListView','#monthView','#timeView']
    .map(sel => document.querySelector(sel))
    .filter(Boolean);

  const touch = { active:false, startX:0, startY:0, startTime:0, id:null };
  const shouldIgnoreSwipeStart = (target) => {
    if (document.body.classList.contains('event-dnd-active')) return true;
    return !!target?.closest?.('.event-pill.draggable, .pill-resize-handle');
  };

  // --- Pointer Events (Android/modern iOS) ---
  const onPointerDown = (e)=>{
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
    if (shouldIgnoreSwipeStart(e.target)) return;
    touch.active = true;
    touch.startX = e.clientX;
    touch.startY = e.clientY;
    touch.startTime = performance.now();
    touch.id = e.pointerId;
    // Asegura que seguimos recibiendo los move/up aunque haya scroll
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e)=>{
  if (document.body.classList.contains('event-dnd-active')) {
    touch.active = false;
    touch.id = null;
    return;
  }
  if (!touch.active || (e.pointerId !== touch.id)) return;
  const dx = e.clientX - touch.startX;
  const dy = e.clientY - touch.startY;

  // Gesto horizontal claro  bloqueo scroll
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10){
    e.preventDefault();
  } 
};

  const onPointerUp = (e)=>{
    if (document.body.classList.contains('event-dnd-active')) {
      touch.active = false;
      touch.id = null;
      return;
    }
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
      if (shouldIgnoreSwipeStart(e.target)) return;
      const t = e.touches[0];
      touch.active = true; touch.startX = t.clientX; touch.startY = t.clientY; touch.startTime = Date.now();
    };
    const onMove = (e)=>{
  if (document.body.classList.contains('event-dnd-active')) {
    touch.active = false;
    return;
  }
  if (!touch.active) return;
  const t = e.touches[0];
  const dx = t.clientX - touch.startX;
  const dy = t.clientY - touch.startY;

  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
    e.preventDefault();                            // horizontal
  }
};

const onEnd = (e)=>{
  if (document.body.classList.contains('event-dnd-active')) {
    touch.active = false;
    return;
  }
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
    case 'agenda':
      state.selectedDate = shiftDate(state.selectedDate || new Date(), -7);
      renderTimeView('agenda', state.selectedDate);
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
    case 'agenda':
      state.selectedDate = shiftDate(state.selectedDate || new Date(), +7);
      renderTimeView('agenda', state.selectedDate);
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

// ===================== Línea "ahora" (vista de tiempo) =====================
let _nowLineTimer = null;
function paintNowLine(){
  const grid = $('#timeGrid'); if (!grid) return;
  if (state.viewMode === 'week' || state.viewMode === '3days' || state.viewMode === 'day'
    || grid.classList.contains('compact-time-list')
    || grid.dataset.layout === 'list'){
    const staleCompact = grid.querySelector('.now-line');
    staleCompact?.remove?.();
    return;
  }
  const now = new Date(), anchor = state.selectedDate || new Date();
  // Solo si estamos viendo HOY
  if (now.toDateString() !== anchor.toDateString()){
    const stale = grid.querySelector('.now-line');
    stale?.remove?.();
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
if (!inRange) {
  const stale = grid.querySelector('.now-line');
  stale?.remove?.();
  return;
}

const top = (minutes - (DAY_START_H*60)) * PX_PER_MIN;
line.style.top = Math.max(0, top) + 'px';
}
function ensureNowLineTimer(){
  if (_nowLineTimer) return;
  _nowLineTimer = setInterval(paintNowLine, 60000);
}
window.addEventListener('resize', paintNowLine);
document.addEventListener('visibilitychange', ()=>{ if (document.visibilityState === 'visible') paintNowLine(); });

/* ===================== Supabase Data Layer (source of truth) ===================== */
const SB_TABLES = {
  users: 'users',
  events: 'events',
  attachments: 'attachments'
};
const DATA_QUERY_MODULE = window.CalendarModules?.dataQueries || {};
const SB_EVENT_SELECT_COLUMNS = DATA_QUERY_MODULE.SB_EVENT_SELECT_COLUMNS
  || 'id,title,start_at,end_at,all_day,location,notes,url,color,locked,is_holiday,source,last_synced_at,remote_missing,remote_missing_at,needs_gcal_sync,gcal_updated,gcal_etag,google_event_id,google_calendar_id,meta,created_at,updated_at';
const SB_ATTACHMENT_SELECT_COLUMNS = DATA_QUERY_MODULE.SB_ATTACHMENT_SELECT_COLUMNS
  || 'id,event_id,drive_file_id,file_type,file_name,created_at';

function sbSelectEventColumns(query) {
  return query.select(SB_EVENT_SELECT_COLUMNS);
}

function sbSelectAttachmentColumns(query) {
  return query.select(SB_ATTACHMENT_SELECT_COLUMNS);
}

function getSupabaseRestTableUrl(tableName) {
  const cfg = getRuntimeAuthConfig();
  const base = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return `./rest/v1/${tableName}`;
  return `${base}/rest/v1/${tableName}`;
}

function serializeSupabaseError(err) {
  if (!err) return null;
  return {
    message: err.message || String(err),
    code: err.code || null,
    details: err.details || null,
    hint: err.hint || null,
    status: Number.isFinite(Number(err.status)) ? Number(err.status) : null,
    name: err.name || null
  };
}

function isSupabaseSchemaMismatchError(err) {
  const text = String(err?.message || '').toLowerCase();
  const details = String(err?.details || '').toLowerCase();
  const code = String(err?.code || '').toUpperCase();
  if (code === '42703' || code === 'PGRST204') return true;
  if (text.includes('schema cache')) return true;
  if (text.includes('column') && text.includes('does not exist')) return true;
  if (details.includes('schema cache')) return true;
  return false;
}

function isSupabaseMissingTableError(err) {
  const text = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '').toUpperCase();
  return code === '42P01'
    || (text.includes('could not find the table') && text.includes('schema cache'))
    || text.includes('relation')
    && text.includes('does not exist');
}

function dataLog(event, payload = {}, level = 'info') {
  if (typeof MODULE_UTILS.structuredLog === 'function') {
    MODULE_UTILS.structuredLog('data', event, payload, level);
    return;
  }
  const line = `[DATA] ${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

function buildSupabaseCallContext(ctx, tableName, operation, meta = {}) {
  return {
    ts: new Date().toISOString(),
    operation,
    table: tableName,
    url: getSupabaseRestTableUrl(tableName),
    user_id: ctx?.userId || null,
    email: String(ctx?.email || '').trim().toLowerCase() || null,
    filters: meta.filters || null,
    params: meta.params || null
  };
}

async function runSupabaseCallWithLogging({ ctx, tableName, operation, meta = {}, execute }) {
  const callCtx = buildSupabaseCallContext(ctx, tableName, operation, meta);
  dataLog('supabase_call_start', callCtx);
  try {
    const result = await execute();
    if (result?.error) {
      dataLog('supabase_call_error', {
        ...callCtx,
        error: serializeSupabaseError(result.error)
      }, 'error');
    } else {
      const rowCount = Array.isArray(result?.data) ? result.data.length : (result?.data ? 1 : 0);
      dataLog('supabase_call_ok', {
        ...callCtx,
        row_count: rowCount
      });
    }
    return result;
  } catch (err) {
    dataLog('supabase_call_throw', {
      ...callCtx,
      error: serializeSupabaseError(err)
    }, 'error');
    throw err;
  }
}

function applyEventWriteProfile(row) {
  return row;
}

function applyAttachmentWriteProfile(row) {
  return row;
}

function throwSchemaMismatchErrorIfNeeded(error, { tableName, operation }) {
  if (!error || !isSupabaseSchemaMismatchError(error)) return;
  const original = String(error?.message || '').trim() || 'schema_mismatch';
  throw new Error(`SUPABASE_SCHEMA_MISMATCH:${tableName}:${operation}:${original}`);
}

async function runEventSelectWithProfileFallback(ctx, operation, meta = {}, buildQuery) {
  const result = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.events,
    operation,
    meta,
    execute: () => buildQuery()
  });
  throwSchemaMismatchErrorIfNeeded(result?.error, { tableName: SB_TABLES.events, operation });
  return result;
}

async function runAttachmentSelectWithProfileFallback(ctx, operation, meta = {}, buildQuery) {
  const result = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.attachments,
    operation,
    meta,
    execute: () => buildQuery()
  });
  throwSchemaMismatchErrorIfNeeded(result?.error, { tableName: SB_TABLES.attachments, operation });
  return result;
}

async function runEventMutationWithProfileFallback(ctx, operation, meta = {}, buildMutation) {
  const result = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.events,
    operation,
    meta,
    execute: () => buildMutation()
  });
  throwSchemaMismatchErrorIfNeeded(result?.error, { tableName: SB_TABLES.events, operation });
  return result;
}

async function runAttachmentMutationWithProfileFallback(ctx, operation, meta = {}, buildMutation) {
  const result = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.attachments,
    operation,
    meta,
    execute: () => buildMutation()
  });
  throwSchemaMismatchErrorIfNeeded(result?.error, { tableName: SB_TABLES.attachments, operation });
  return result;
}

function isMinimalEventProfile() {
  return false;
}

function getGoogleEventIdColumnName() {
  return 'google_event_id';
}

function getEventWatermarkColumnName() {
  return 'last_synced_at';
}

function sbApplyRangeOverlap(query, { startISO = null, endISO = null, startCol = 'start_at', endCol = 'end_at' } = {}) {
  if (typeof DATA_QUERY_MODULE.applyRangeOverlap === 'function') {
    return DATA_QUERY_MODULE.applyRangeOverlap(query, { startISO, endISO, startCol, endCol });
  }
  let next = query;
  if (endISO) next = next.lt(startCol, endISO);
  if (startISO) next = next.gt(endCol, startISO);
  return next;
}

let _lastDataToastAt = 0;

function setDataLoading(flag) {
  state.dataLoading = !!flag;
  document.body.classList.toggle('data-loading', !!flag);
}

function bindSyncStatusNetworkHandlersOnce() {
  if (bindSyncStatusNetworkHandlersOnce._bound) return;
  bindSyncStatusNetworkHandlersOnce._bound = true;

  window.addEventListener('offline', () => {
    setSyncStatus('offline', { detail: 'Sin conexión' });
  });

  window.addEventListener('online', async () => {
    setSyncStatus('syncing', { detail: 'Reconectando' });
    try {
      await flushOutbox({ reason: 'network_online', silent: true });
      await refreshSyncStatusOutboxCount();
      if (syncStatus.state !== 'error') {
        setSyncStatus('ok', { detail: '' });
      }
    } catch (err) {
      setSyncStatus('error', { detail: 'Error al reconectar' });
      void err;
    }
  });
}

async function initSyncStatusPillState() {
  syncStatus.state = navigator.onLine ? 'ok' : 'offline';
  syncStatus.detail = navigator.onLine ? '' : 'Sin conexión';
  await refreshSyncStatusOutboxCount();
}

function clearDataError() {
  state.lastDataError = null;
}

function classifyDataErrorKind(err) {
  if (!err) return 'unknown';
  if (isSupabaseMissingTableError(err)) return 'backend_missing_table';
  if (isSupabaseSchemaMismatchError(err)) return 'backend_schema_mismatch';
  const status = Number(err?.status || 0);
  if (status === 401 || status === 403) return 'backend_auth_or_rls';
  if (status === 404) return 'backend_not_found';
  if (status >= 500) return 'backend_server';
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('failed to fetch') || msg.includes('networkerror')) return 'network';
  return 'unknown';
}

function buildDataErrorToastMessage(context, err) {
  const kind = classifyDataErrorKind(err);
  if (kind === 'backend_missing_table') {
    return `Error backend al ${context}: tabla faltante en Supabase.`;
  }
  if (kind === 'backend_schema_mismatch') {
    return `Error backend al ${context}: desalineación de esquema en Supabase.`;
  }
  if (kind === 'backend_auth_or_rls') {
    return `Error backend al ${context}: sesión inválida o política RLS bloqueando acceso.`;
  }
  if (kind === 'backend_server') {
    return `Error backend al ${context}: fallo interno de Supabase.`;
  }
  if (kind === 'network') {
    return `Error de red al ${context}. Se usa caché local cuando existe.`;
  }
  return `Error al ${context}. Revisa consola para detalle técnico.`;
}

function shouldUseCacheFallbackForError(err) {
  return classifyDataErrorKind(err) === 'network';
}

function reportDataError(context, err, { silent = false } = {}) {
  const msg = err.message || String(err || 'error desconocido');
  state.lastDataError = `${context}: ${msg}`;
  const errMeta = serializeSupabaseError(err);
  const kind = classifyDataErrorKind(err);
  dataLog('context_error', {
    context,
    kind,
    status: errMeta?.status || null,
    code: errMeta?.code || null,
    details: errMeta?.details || null,
    hint: errMeta?.hint || null,
    message: errMeta?.message || msg
  }, 'warn');
  if (kind === 'network') {
    setSyncStatus('offline', { detail: 'Sin red' });
  } else if (kind !== 'unknown') {
    setSyncStatus('error', { detail: `Error ${kind}` });
  }
  if (silent) return;
  const now = Date.now();
  if (typeof showToast === 'function' && (now - _lastDataToastAt) > 4000) {
    _lastDataToastAt = now;
    showToast(buildDataErrorToastMessage(context, err));
  }
}

function isUuidLike(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || '').trim());
}

function ensureUuidId(v) {
  if (isUuidLike(v)) return v;
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function localPartsToISO(dateStr, timeStr = '00:00') {
  if (!dateStr) return null;
  const [Y, M, D] = dateStr.split('-').map(Number);
  const [h, m] = String(timeStr || '00:00').split(':').map(Number);
  const d = new Date(Y, (M || 1) - 1, D || 1, h || 0, m || 0, 0, 0);
  return d.toISOString();
}

function isoToLocalParts(iso, fallbackDate = null, fallbackTime = '00:00') {
  if (!iso) return { date: fallbackDate, time: fallbackTime };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: fallbackDate, time: fallbackTime };
  return { date: ymd(d), time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
}

function normalizeEventSource(inputSource, evt = null) {
  const raw = String(inputSource || '').trim().toLowerCase();
  if (raw === 'local' || raw === 'google' || raw === 'holiday') return raw;
  if (evt.isHoliday || evt.category === 'Festivo') return 'holiday';
  if (evt.gcalId || evt.google_event_id || evt.gcal_event_id) return 'google';
  return 'local';
}

function safeISODateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function eventToSupabaseRow(evt, userId) {
  const startDate = evt.startDate || evt.date;
  const startTime = evt.startTime || evt.time || '00:00';
  const endDate = evt.endDate || startDate;
  const endTime = evt.endTime || startTime;
  const safeColor = normalizeEventColor(evt.color || '', EVENT_COLOR_DEFAULT);
  const sourceGuess = normalizeEventSource(evt.source, evt);
  const isHoliday = !!evt.isHoliday || evt.category === 'Festivo' || sourceGuess === 'holiday';
  const source = isHoliday ? 'holiday' : sourceGuess;
  const locked = isHoliday ? true : !!evt.locked;
  const meta = {
    category: evt.category || 'Trabajo',
    categoryOther: evt.categoryOther || '',
    client: evt.client || '',
    alert: evt.alert || 'none',
    repeat: evt.repeat || 'none'
  };

  return {
    id: ensureUuidId(evt.id),
    user_id: userId,
    title: evt.title || '',
    start_at: localPartsToISO(startDate, startTime),
    end_at: localPartsToISO(endDate, endTime),
    all_day: !!evt.allDay,
    location: evt.location || '',
    notes: evt.notes || '',
    url: evt.url || '',
    color: safeColor,
    locked,
    is_holiday: isHoliday,
    source,
    last_synced_at: isHoliday ? null : safeISODateTime(evt.lastSyncedAt || evt.last_synced_at || null),
    remote_missing: isHoliday ? false : !!(evt.remoteMissing || evt.remote_missing),
    remote_missing_at: isHoliday ? null : safeISODateTime(evt.remoteMissingAt || evt.remote_missing_at || null),
    needs_gcal_sync: isHoliday ? false : !!evt.needsGCalSync,
    gcal_updated: isHoliday ? null : safeISODateTime(evt.gcalUpdated || evt.gcal_updated || null),
    gcal_etag: isHoliday ? null : (evt.gcalEtag || evt.gcal_etag || null),
    google_event_id: isHoliday ? null : (evt.gcalId || evt.google_event_id || null),
    google_calendar_id: isHoliday
      ? null
      : normalizeGoogleCalendarId(
        evt.googleCalendarId || evt.google_calendar_id || state.selectedGoogleCalendarId || 'primary',
        'primary'
      ),
    meta
  };
}

function supabaseRowToEvent(row) {
  const meta = row.meta || {};
  const s = isoToLocalParts(row.start_at, ymd(new Date()), '00:00');
  const e = isoToLocalParts(row.end_at, s.date, s.time);
  const createdTs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
  const source = normalizeEventSource(row.source, {
    isHoliday: !!row.is_holiday,
    category: row.category || meta.category || '',
    google_event_id: row.google_event_id,
    gcal_event_id: row.gcal_event_id
  });
  const holiday = !!row.is_holiday || source === 'holiday';
  const locked = holiday ? true : !!row.locked;

  return {
    id: row.id,
    title: row.title || '',
    location: row.location || '',
    notes: row.notes || '',
    url: row.url || '',
    color: normalizeEventColor(row.color || '', EVENT_COLOR_DEFAULT),
    locked,
    allDay: !!row.all_day,
    startDate: s.date,
    startTime: s.time,
    endDate: e.date,
    endTime: e.time,
    date: s.date,
    time: s.time,
    monthKey: s.date.slice(0, 7),
    category: row.category || meta.category || (holiday ? 'Festivo' : 'Trabajo'),
    categoryOther: meta.categoryOther || '',
    client: meta.client || '',
    alert: meta.alert || 'none',
    repeat: meta.repeat || 'none',
    remoteMissing: holiday ? false : !!row.remote_missing,
    remote_missing: holiday ? false : !!row.remote_missing,
    remoteMissingAt: holiday ? null : (row.remote_missing_at || null),
    remote_missing_at: holiday ? null : (row.remote_missing_at || null),
    needsGCalSync: holiday ? false : ((typeof row.needs_gcal_sync === 'boolean') ? row.needs_gcal_sync : !!meta.needsGCalSync),
    gcalUpdated: holiday ? null : (row.gcal_updated || meta.gcalUpdated || null),
    gcal_updated: holiday ? null : (row.gcal_updated || meta.gcalUpdated || null),
    gcalEtag: holiday ? null : (row.gcal_etag || null),
    gcal_etag: holiday ? null : (row.gcal_etag || null),
    google_event_id: holiday ? null : (row.google_event_id || null),
    gcal_event_id: holiday ? null : (row.gcal_event_id || null),
    gcalId: holiday ? null : (row.google_event_id || row.gcal_event_id || null),
    googleCalendarId: holiday ? null : normalizeGoogleCalendarId(row.google_calendar_id || null, 'primary'),
    google_calendar_id: holiday ? null : normalizeGoogleCalendarId(row.google_calendar_id || null, 'primary'),
    source: holiday ? 'holiday' : source,
    lastSyncedAt: holiday ? null : (row.last_synced_at || null),
    last_synced_at: holiday ? null : (row.last_synced_at || null),
    isHoliday: holiday,
    createdAt: createdTs,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : createdTs
  };
}

async function getSupabaseSessionContext() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase no está configurado');
  const payload = await supabase.auth.getSession();
  const { data, error } = payload;
  if (error) throw error;
  const normalized = (typeof MODULE_DATA_SUPABASE.normalizeSessionContext === 'function')
    ? MODULE_DATA_SUPABASE.normalizeSessionContext(payload)
    : {
      session: data?.session || null,
      user: data?.session?.user || null,
      userId: data?.session?.user?.id || null,
      email: String(data?.session?.user?.email || '')
    };
  if (!normalized.userId) throw new Error('Sesión inválida o expirada');
  return { supabase, userId: normalized.userId, email: normalized.email || '' };
}

async function ensureSupabaseUserRow(ctx) {
  if (_supabaseUserRowEnsuredFor === ctx.userId) return;
  const payload = { id: ctx.userId, email: (ctx.email || '').trim().toLowerCase() };
  const { error } = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.users,
    operation: 'ensureSupabaseUserRow.upsert',
    meta: { params: { onConflict: 'id' }, filters: { id: ctx.userId } },
    execute: () => ctx.supabase
      .from(SB_TABLES.users)
      .upsert(payload, { onConflict: 'id' })
  });
  if (error) throw error;
  _supabaseUserRowEnsuredFor = ctx.userId;
}

async function getReadDataContext() {
  // Evita side-effects de escritura en lectura (p.ej. users.upsert) que enmascaran errores de carga de eventos.
  return getSupabaseSessionContext();
}

async function getWriteDataContext() {
  const ctx = await getSupabaseSessionContext();
  await ensureSupabaseUserRow(ctx);
  return ctx;
}

async function cachePutEvents(events) {
  if (!state.db || !Array.isArray(events) || !events.length) return;
  await tx(['events'], 'readwrite', (store) => {
    for (const e of events) store.put(e);
  });
}

async function cacheDeleteEvent(eventId) {
  if (!state.db || !eventId) return;
  await tx(['events'], 'readwrite', (store) => store.delete(eventId));
}

async function cacheGetEventById(eventId) {
  if (!state.db || !eventId) return null;
  let out = null;
  await tx(['events'], 'readonly', (store) => {
    const req = store.get(eventId);
    req.onsuccess = () => { out = req.result || null; };
  });
  return out;
}

function buildInclusiveDateKeys(fromDateStr, toDateStr) {
  const from = String(fromDateStr || '').trim();
  const to = String(toDateStr || '').trim();
  if (!from || !to) return [];

  const start = parseDateInput(from);
  const end = parseDateInput(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur.getTime() <= last.getTime()) {
    out.push(ymd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function getEventBoundsMsForDayDistribution(evt) {
  const startDate = String(evt.startDate || evt.date || '').trim();
  const endDate = String(evt.endDate || startDate || '').trim();
  if (!startDate || !endDate) return null;

  const allDay = !!evt.allDay || !!evt.all_day;
  const startTime = allDay ? '00:00' : String(evt.startTime || evt.time || '00:00');
  const endTime = allDay
    ? '23:59'
    : String(evt.endTime || evt.time || evt.startTime || '00:00');

  const startMs = toLocalDateTime(startDate, startTime).getTime();
  let endMs = toLocalDateTime(endDate, endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (endMs <= startMs) endMs = startMs + 60 * 1000;

  return { startMs, endMs };
}

function getDayBoundsMs(dayKey) {
  const day = parseDateInput(dayKey);
  if (Number.isNaN(day.getTime())) return null;
  const startMs = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0).getTime();
  const endMs = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0).getTime();
  return { startMs, endMs };
}

function distributeEventsByVisibleDays(events, dayKeys) {
  const keys = [...new Set((dayKeys || []).filter(Boolean))];
  const out = new Map(keys.map((k) => [k, []]));
  if (!keys.length || !Array.isArray(events) || !events.length) return out;

  const dayBounds = keys
    .map((dayKey) => {
      const bounds = getDayBoundsMs(dayKey);
      return bounds ? { dayKey, ...bounds } : null;
    })
    .filter(Boolean);

  for (const evt of events) {
    const evtBounds = getEventBoundsMsForDayDistribution(evt);
    if (!evtBounds) continue;
    for (const day of dayBounds) {
      if (evtBounds.startMs < day.endMs && evtBounds.endMs > day.startMs) {
        out.get(day.dayKey).push(evt);
      }
    }
  }
  return out;
}

async function cacheGetEventsByDate(dateStr) {
  if (!state.db || !dateStr) return [];
  const byDate = await cacheGetEventsByDates([dateStr]);
  return byDate.get(dateStr) || [];
}

async function cacheGetEventsByDates(dateStrs) {
  const dayKeys = [...new Set((dateStrs || []).filter(Boolean))];
  const emptyMap = new Map(dayKeys.map((s) => [s, []]));
  if (!state.db || !dayKeys.length) return emptyMap;

  const months = [...new Set(dayKeys.map((s) => s.slice(0, 7)))];
  const scanned = [];
  await tx(['events'], 'readonly', (store) => {
    const idx = store.index('by_month');
    months.forEach((m) => {
      const req = idx.openCursor(IDBKeyRange.only(m));
      req.onsuccess = () => {
        const cur = req.result; if (!cur) return;
        scanned.push(cur.value);
        cur.continue();
      };
    });
  });
  return distributeEventsByVisibleDays(scanned, dayKeys);
}

async function cacheGetMonthEvents(year, month) {
  const fromDate = `${year}-${pad2(month + 1)}-01`;
  const toDate = ymd(new Date(year, month + 1, 0));
  const dayKeys = buildInclusiveDateKeys(fromDate, toDate);
  const emptyMap = new Map(dayKeys.map((s) => [s, []]));
  if (!state.db) return emptyMap;

  const allEvents = await cacheGetAllEvents();
  return distributeEventsByVisibleDays(allEvents, dayKeys);
}

async function cacheGetAllEvents() {
  const out = [];
  if (!state.db) return out;
  await tx(['events'], 'readonly', (store) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      out.push(cur.value);
      cur.continue();
    };
  });
  return out;
}

async function cachePutAttachments(atts) {
  if (!state.db || !Array.isArray(atts) || !atts.length) return;
  await tx(['attachments'], 'readwrite', (store) => {
    for (const a of atts) store.put(a);
  });
}

async function cacheGetAttachmentsByEvent(eventId) {
  if (!state.db || !eventId) return [];
  const out = [];
  await tx(['attachments'], 'readonly', (store) => {
    const idx = store.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(eventId));
    req.onsuccess = () => { const cur = req.result; if (cur) { out.push(cur.value); cur.continue(); } };
  });
  return out;
}

async function cacheDeleteAttachmentById(attId) {
  if (!state.db || !attId) return;
  await tx(['attachments'], 'readwrite', (store) => store.delete(attId));
}

async function cacheDeleteAttachmentsForEvent(eventId) {
  if (!state.db || !eventId) return;
  await tx(['attachments'], 'readwrite', (store) => {
    const idx = store.index('by_event');
    const req = idx.openCursor(IDBKeyRange.only(eventId));
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      store.delete(cur.primaryKey);
      cur.continue();
    };
  });
}

async function cacheLoadEventIdsWithFiles() {
  const out = new Set();
  if (!state.db) return out;
  await tx(['attachments'], 'readonly', (store) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result; if (!cur) return;
      if (cur.value.eventId) out.add(cur.value.eventId);
      cur.continue();
    };
  });
  return out;
}

function normalizeOutboxEntry(raw) {
  if (!raw || !raw.id || !raw.op) return null;
  return {
    id: String(raw.id),
    op: String(raw.op),
    eventId: raw.eventId ? String(raw.eventId) : null,
    payload: raw.payload || null,
    createdAt: Number(raw.createdAt) || Date.now(),
    retries: Math.max(0, Number(raw.retries || 0)),
    nextAttemptAt: Number(raw.nextAttemptAt || 0) || 0,
    lastError: raw.lastError ? String(raw.lastError) : ''
  };
}

async function getOutboxEntries() {
  const rows = [];
  if (!state.db) return rows;
  await tx([OUTBOX_STORE], 'readonly', (store) => {
    const req = store.index('by_created').openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      const row = normalizeOutboxEntry(cur.value);
      if (row) rows.push(row);
      cur.continue();
    };
  });
  rows.sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
  return rows;
}

async function getOutboxCount() {
  if (!state.db) return 0;
  return new Promise((resolve) => {
    try {
      const t = state.db.transaction([OUTBOX_STORE], 'readonly');
      const store = t.objectStore(OUTBOX_STORE);
      const req = store.count();
      req.onsuccess = () => resolve(Number(req.result) || 0);
      req.onerror = () => resolve(0);
      t.onabort = () => resolve(0);
      t.onerror = () => resolve(0);
    } catch (err) {
      void err;
      resolve(0);
    }
  });
}

async function putOutboxEntry(entry) {
  const normalized = normalizeOutboxEntry(entry);
  if (!normalized || !state.db) return null;
  await tx([OUTBOX_STORE], 'readwrite', (store) => {
    store.put(normalized);
  });
  await refreshSyncStatusOutboxCount();
  return normalized;
}

async function deleteOutboxEntry(entryId) {
  if (!entryId || !state.db) return;
  await tx([OUTBOX_STORE], 'readwrite', (store) => {
    store.delete(String(entryId));
  });
  await refreshSyncStatusOutboxCount();
}

async function showOutboxQueuedToastOnce() {
  const now = Date.now();
  if ((now - _lastOutboxToastAt) < 4000) return;
  _lastOutboxToastAt = now;
  showToast('Sin conexión: cambios guardados en cola local.', {
    type: 'info',
    actionLabel: null,
    onUndo: null,
    duration: 3600,
    toastKey: 'offline-outbox'
  });
}

async function enqueueOutboxOperation(op, payload, { eventId = null } = {}) {
  const normalizedEventId = eventId ? String(eventId) : null;
  const all = await getOutboxEntries();
  const toDelete = [];

  if (normalizedEventId) {
    for (const row of all) {
      if (row.eventId !== normalizedEventId) continue;
      if (op === 'event_upsert' && row.op === 'event_upsert') toDelete.push(row.id);
      if (op === 'event_delete' && (row.op === 'event_delete' || row.op === 'event_upsert')) toDelete.push(row.id);
    }
  }

  if (toDelete.length) {
    await tx([OUTBOX_STORE], 'readwrite', (store) => {
      for (const id of toDelete) store.delete(id);
    });
  }

  const entry = {
    id: ensureUuidId(),
    op,
    eventId: normalizedEventId,
    payload,
    createdAt: Date.now(),
    retries: 0,
    nextAttemptAt: 0
  };
  await putOutboxEntry(entry);
  setSyncStatus('offline', { detail: 'En cola local' });
  await showOutboxQueuedToastOnce();
}

function isNetworkWriteError(err) {
  return classifyDataErrorKind(err) === 'network';
}

function dateToRangeStartISO(dateStr) {
  return localPartsToISO(dateStr, '00:00');
}

function dateToRangeEndISO(dateStr) {
  const d = parseDateInput(dateStr);
  d.setDate(d.getDate() + 1);
  return localPartsToISO(ymd(d), '00:00');
}

const HOLIDAY_EVENT_COLOR = '#e11d48';
const _holidaySeedState = {
  inFlightByYear: new Map(),
  doneYears: new Set()
};

function stableHash32(input, seed = 2166136261) {
  let h = seed >>> 0;
  const txt = String(input || '');
  for (let i = 0; i < txt.length; i++) {
    h ^= txt.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function stableUuidFromString(input) {
  const h1 = stableHash32(`${input}|a`).toString(16).padStart(8, '0');
  const h2 = stableHash32(`${input}|b`).toString(16).padStart(8, '0');
  const h3 = stableHash32(`${input}|c`).toString(16).padStart(8, '0');
  const h4 = stableHash32(`${input}|d`).toString(16).padStart(8, '0');
  let hex = `${h1}${h2}${h3}${h4}`.slice(0, 32);
  hex = `${hex.slice(0, 12)}5${hex.slice(13)}`;
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  hex = `${hex.slice(0, 16)}${variant}${hex.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function buildHolidaySeedEvent(dateStr, name, existingEvt = null) {
  const eventKey = `holiday:${HOLIDAY_REGION.country}:${HOLIDAY_REGION.region}:${HOLIDAY_REGION.city}:${dateStr}`;
  const existingId = String(existingEvt?.id || '').trim();
  const id = existingId || stableUuidFromString(eventKey);
  const existingCreatedAt = Number(existingEvt?.createdAt);
  return {
    id,
    title: `Festivo - ${name}`,
    location: `${HOLIDAY_REGION.country}-${HOLIDAY_REGION.region}-${HOLIDAY_REGION.city}`,
    client: '',
    notes: `Festivo oficial: ${name}`,
    url: '',
    color: HOLIDAY_EVENT_COLOR,
    category: 'Festivo',
    categoryOther: '',
    date: dateStr,
    time: '00:00',
    monthKey: dateStr.slice(0, 7),
    createdAt: Number.isFinite(existingCreatedAt) && existingCreatedAt > 0 ? existingCreatedAt : Date.now(),
    allDay: true,
    startDate: dateStr,
    startTime: '00:00',
    endDate: dateStr,
    endTime: '23:59',
    alert: 'none',
    repeat: 'none',
    source: 'holiday',
    isHoliday: true,
    locked: true,
    needsGCalSync: false,
    gcalId: null,
    gcalUpdated: null,
    gcalEtag: null,
    lastSyncedAt: null
  };
}

async function sbFetchHolidayEventsByYear(year) {
  const ctx = await getReadDataContext();
  const fromISO = localPartsToISO(`${year}-01-01`, '00:00');
  const toISO = localPartsToISO(`${year + 1}-01-01`, '00:00');
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_holiday_events_by_year',
    {
      filters: {
        user_id: ctx.userId,
        holiday_field: isMinimalEventProfile() ? 'category' : 'source',
        range_start: fromISO,
        range_end: toISO
      }
    },
    () => {
      let query = sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
      )
        .eq('user_id', ctx.userId);
      query = isMinimalEventProfile()
        ? query.eq('category', 'Festivo')
        : query.eq('source', 'holiday');
      query = sbApplyRangeOverlap(query, { startISO: fromISO, endISO: toISO });
      return query.order('start_at', { ascending: true });
    }
  );
  if (error) throw error;
  const events = (data || []).map(supabaseRowToEvent);
  await cachePutEvents(events);
  return events;
}

async function ensureHolidayEventsForYear(year, { force = false, silent = true, skipAuthCheck = false } = {}) {
  const y = Number(year);
  if (!Number.isFinite(y)) return { year, upserted: 0, deleted: 0, skipped: true };
  if (!skipAuthCheck) {
    const session = await getSessionIfReadyForSync(`holiday_seed_year_${y}`);
    if (!session?.user?.id) {
      syncLog('auth_not_ready_skip', { scope: 'holiday_seed_year', year: y }, 'warn');
      return { year: y, upserted: 0, deleted: 0, skipped: true, reason: 'auth_not_ready' };
    }
  }
  if (!force && _holidaySeedState.doneYears.has(y)) return { year: y, upserted: 0, deleted: 0, skipped: true };

  if (_holidaySeedState.inFlightByYear.has(y)) {
    return _holidaySeedState.inFlightByYear.get(y);
  }

  const task = (async () => {
    const expected = getNationalHolidaysMap(y);
    const existing = await sbFetchHolidayEventsByYear(y);
    const existingByDate = new Map();

    for (const evt of existing) {
      const ds = evt.startDate || evt.date || '';
      if (!ds) continue;
      if (!existingByDate.has(ds)) existingByDate.set(ds, []);
      existingByDate.get(ds).push(evt);
    }

    let upserted = 0;
    let deleted = 0;

    for (const [dateStr, holidayName] of expected.entries()) {
      const sameDate = existingByDate.get(dateStr) || [];
      const primary = sameDate[0] || null;
      const payload = buildHolidaySeedEvent(dateStr, holidayName, primary);
      await sbUpsertEvent(payload);
      upserted++;

      for (let i = 1; i < sameDate.length; i++) {
        const duplicateId = String(sameDate[i]?.id || '').trim();
        if (!duplicateId) {
          syncLog('holiday_duplicate_without_id_skip', { year: y, date: dateStr, index: i }, 'warn');
          continue;
        }
        await sbDeleteEventById(duplicateId);
        deleted++;
      }
      existingByDate.delete(dateStr);
    }

    // Limpia festivos de ese anyo que ya no esten en el dataset.
    for (const leftovers of existingByDate.values()) {
      for (const evt of leftovers) {
        const leftoverId = String(evt?.id || '').trim();
        if (!leftoverId) {
          syncLog('holiday_leftover_without_id_skip', { year: y, date: evt?.startDate || evt?.date || null }, 'warn');
          continue;
        }
        await sbDeleteEventById(leftoverId);
        deleted++;
      }
    }

    _holidaySeedState.doneYears.add(y);
    return { year: y, upserted, deleted, skipped: false };
  })().catch((err) => {
    reportDataError('sincronizar festivos', err, { silent });
    return { year: y, upserted: 0, deleted: 0, skipped: false, error: err.message || String(err) };
  }).finally(() => {
    _holidaySeedState.inFlightByYear.delete(y);
  });

  _holidaySeedState.inFlightByYear.set(y, task);
  return task;
}

async function ensureHolidayEventsForYears(years, { force = false, silent = true } = {}) {
  const uniqYears = [...new Set((years || []).map((y) => Number(y)).filter((y) => Number.isFinite(y)))];
  if (!uniqYears.length) return [];
  const session = await getSessionIfReadyForSync('holiday_seed_years');
  if (!session?.user?.id) {
    syncLog('auth_not_ready_skip', { scope: 'holiday_seed_years', years: uniqYears }, 'warn');
    return uniqYears.map((y) => ({ year: y, upserted: 0, deleted: 0, skipped: true, reason: 'auth_not_ready' }));
  }
  const results = [];
  for (const y of uniqYears) {
    results.push(await ensureHolidayEventsForYear(y, { force, silent, skipAuthCheck: true }));
  }
  return results;
}

async function sbFetchEventsRange(dateStart, dateEnd) {
  const ctx = await getReadDataContext();
  const startISO = dateToRangeStartISO(dateStart);
  const endISO = dateToRangeEndISO(dateEnd);
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_events_range',
    {
      filters: {
        user_id: ctx.userId,
        start_at_lt: endISO,
        end_at_gt: startISO
      }
    },
    () => {
      let query = sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
      )
        .eq('user_id', ctx.userId);
      query = sbApplyRangeOverlap(query, { startISO, endISO });
      return query.order('start_at', { ascending: true });
    }
  );
  if (error) throw error;
  const events = (data || []).map(supabaseRowToEvent);
  await cachePutEvents(events);
  return events;
}

async function sbFetchAllEvents() {
  const ctx = await getReadDataContext();
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_all_events',
    { filters: { user_id: ctx.userId } },
    () => sbSelectEventColumns(ctx.supabase
      .from(SB_TABLES.events)
    )
      .eq('user_id', ctx.userId)
      .order('start_at', { ascending: true })
  );
  if (error) throw error;
  const events = (data || []).map(supabaseRowToEvent);
  await cachePutEvents(events);
  return events;
}

async function sbFetchUnlinkedEventsForRebind() {
  const ctx = await getReadDataContext();
  const googleIdCol = getGoogleEventIdColumnName();
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_unlinked_events_for_rebind',
    {
      filters: {
        user_id: ctx.userId,
        google_id_column: googleIdCol,
        google_id_is_null: true,
        non_holiday_field: isMinimalEventProfile() ? 'category' : 'source'
      }
    },
    () => {
      let query = sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
      )
        .eq('user_id', ctx.userId)
        .is(googleIdCol, null);
      query = isMinimalEventProfile()
        ? query.neq('category', 'Festivo')
        : query.neq('source', 'holiday');
      return query.order('start_at', { ascending: true });
    }
  );
  if (error) throw error;
  const events = (data || []).map(supabaseRowToEvent);
  await cachePutEvents(events);
  return events;
}

async function sbFetchEventById(eventId) {
  if (!eventId) return null;
  const ctx = await getReadDataContext();
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_event_by_id',
    { filters: { user_id: ctx.userId, id: eventId } },
    () => sbSelectEventColumns(ctx.supabase
      .from(SB_TABLES.events)
    )
      .eq('user_id', ctx.userId)
      .eq('id', eventId)
      .maybeSingle()
  );
  if (error) throw error;
  if (!data) return null;
  const evt = supabaseRowToEvent(data);
  await cachePutEvents([evt]);
  return evt;
}

const LOCAL_RECENT_CONFLICT_WINDOW_MS = 2 * 60 * 1000;

function normalizeConcurrencyActor(actor) {
  const raw = String(actor || 'local').trim().toLowerCase();
  return raw === 'google' ? 'google' : 'local';
}

function firstMutationRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function isRecentLocalEditRow(row, nowMs = Date.now()) {
  if (!row) return false;
  if (!row.needs_gcal_sync) return false;
  if (normalizeEventSource(row.source, row) === 'holiday') return false;
  const updatedIso = safeISODateTime(row.updated_at || null);
  if (!updatedIso) return false;
  const updatedMs = Date.parse(updatedIso);
  if (!Number.isFinite(updatedMs)) return false;
  return (nowMs - updatedMs) <= LOCAL_RECENT_CONFLICT_WINDOW_MS;
}

async function sbFetchEventRowById(ctx, eventId) {
  if (!eventId) return null;
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_event_row_by_id',
    { filters: { user_id: ctx.userId, id: eventId } },
    () => sbSelectEventColumns(ctx.supabase
      .from(SB_TABLES.events)
    )
      .eq('user_id', ctx.userId)
      .eq('id', eventId)
      .maybeSingle()
  );
  if (error) throw error;
  return data || null;
}

async function sbFetchEventRowByGoogleId(ctx, googleEventId, { calendarId = null } = {}) {
  if (!googleEventId) return null;
  const targetCalendarId = calendarId ? normalizeGoogleCalendarId(calendarId, 'primary') : null;
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_event_row_by_google_id',
    {
      filters: {
        user_id: ctx.userId,
        google_event_id: googleEventId,
        google_calendar_id: targetCalendarId
      }
    },
    () => {
      let query = sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
      )
        .eq('user_id', ctx.userId)
        .eq(getGoogleEventIdColumnName(), googleEventId);

      if (targetCalendarId && !isMinimalEventProfile()) {
        if (isPrimaryCalendarId(targetCalendarId)) {
          query = query.or('google_calendar_id.eq.primary,google_calendar_id.is.null');
        } else {
          query = query.eq('google_calendar_id', targetCalendarId);
        }
      }

      return query.maybeSingle();
    }
  );
  if (error) throw error;
  return data || null;
}

async function sbUpdateEventRowWithExpectedTs(ctx, row, expectedUpdatedAt) {
  const { data, error } = await runEventMutationWithProfileFallback(
    ctx,
    'update_event_expected_updated_at',
    {
      filters: {
        user_id: ctx.userId,
        id: row.id,
        expected_updated_at: expectedUpdatedAt || null
      }
    },
    () => {
      const payload = applyEventWriteProfile(row);
      let query = ctx.supabase
        .from(SB_TABLES.events)
        .update(payload)
        .eq('user_id', ctx.userId)
        .eq('id', row.id);
      query = expectedUpdatedAt ? query.eq('updated_at', expectedUpdatedAt) : query.is('updated_at', null);
      return sbSelectEventColumns(query);
    }
  );
  if (error) throw error;
  return firstMutationRow(data);
}

async function sbUpdateEventRowById(ctx, row) {
  const { data, error } = await runEventMutationWithProfileFallback(
    ctx,
    'update_event_by_id',
    { filters: { user_id: ctx.userId, id: row.id } },
    () => {
      const payload = applyEventWriteProfile(row);
      return sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
        .update(payload)
        .eq('user_id', ctx.userId)
        .eq('id', row.id));
    }
  );
  if (error) throw error;
  return firstMutationRow(data);
}

async function resolveSbUpsertConflict({
  ctx,
  row,
  actor,
  expectedUpdatedAt
}) {
  const latest = await sbFetchEventRowById(ctx, row.id);
  syncLog('optimistic_conflict_detected', {
    actor,
    eventId: row.id,
    googleEventId: row.google_event_id || null,
    expectedUpdatedAt: expectedUpdatedAt || null,
    latestUpdatedAt: latest?.updated_at || null,
    latestNeedsGCalSync: !!latest?.needs_gcal_sync,
    latestSource: latest?.source || null
  }, 'warn');

  if (!latest) {
    const inserted = await runEventMutationWithProfileFallback(
      ctx,
      'resolve_conflict_insert_missing_latest',
      {
        filters: { user_id: ctx.userId, id: row.id },
        params: { single: true }
      },
      () => sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
        .insert(applyEventWriteProfile(row))
      ).single()
    );
    if (inserted.error) throw inserted.error;
    syncLog('optimistic_conflict_resolved_insert_missing_latest', {
      actor,
      eventId: row.id,
      googleEventId: row.google_event_id || null
    }, 'warn');
    return inserted.data;
  }

  if (actor === 'google') {
    const forced = await sbUpdateEventRowById(ctx, row);
    if (forced) {
      syncLog('optimistic_conflict_resolved_google_wins', {
        eventId: row.id,
        googleEventId: row.google_event_id || null
      }, 'warn');
      return forced;
    }

    const inserted = await runEventMutationWithProfileFallback(
      ctx,
      'resolve_conflict_google_insert',
      {
        filters: { user_id: ctx.userId, id: row.id },
        params: { single: true }
      },
      () => sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
        .insert(applyEventWriteProfile(row))
      ).single()
    );
    if (inserted.error) throw inserted.error;
    syncLog('optimistic_conflict_resolved_google_insert', {
      eventId: row.id,
      googleEventId: row.google_event_id || null
    }, 'warn');
    return inserted.data;
  }

  if (isRecentLocalEditRow(latest)) {
    syncLog('optimistic_conflict_resolved_local_recent_kept', {
      eventId: row.id,
      keepUpdatedAt: latest.updated_at || null,
      recentWindowMs: LOCAL_RECENT_CONFLICT_WINDOW_MS
    }, 'warn');
    return latest;
  }

  syncLog('optimistic_conflict_resolved_latest_kept', {
    eventId: row.id,
    latestUpdatedAt: latest.updated_at || null
  }, 'warn');
  return latest;
}

async function sbUpsertEventCore(evt, options = {}) {
  assertWritesAllowed('sbUpsertEvent');
  const ctx = await getWriteDataContext();
  const actor = normalizeConcurrencyActor(options.actor);
  let row = eventToSupabaseRow(evt, ctx.userId);
  let current = null;
  let savedRow = null;
  const rowCalendarId = normalizeGoogleCalendarId(row.google_calendar_id || null, 'primary');

  if (row.google_event_id) {
    const linkedScoped = await sbFetchEventRowByGoogleId(ctx, row.google_event_id, { calendarId: rowCalendarId });
    const linked = linkedScoped || await sbFetchEventRowByGoogleId(ctx, row.google_event_id);
    if (linked && !isMinimalEventProfile()) {
      const linkedCalendarId = normalizeGoogleCalendarId(linked.google_calendar_id || null, 'primary');
      if (linkedCalendarId !== rowCalendarId) {
        syncLog('upsert_rebind_google_calendar_id', {
          actor,
          googleEventId: row.google_event_id,
          fromCalendarId: linkedCalendarId,
          toCalendarId: rowCalendarId,
          eventId: linked.id || row.id
        }, 'warn');
      }
    }
    if (linked?.id && linked.id !== row.id) {
      syncLog('upsert_rebound_google_event_id', {
        actor,
        googleEventId: row.google_event_id,
        requestedId: row.id,
        resolvedId: linked.id
      }, 'warn');
      row = { ...row, id: linked.id, google_calendar_id: rowCalendarId };
      current = linked;
    }
  }

  if (!current) {
    current = await sbFetchEventRowById(ctx, row.id);
  }

  if (!current) {
    const insert = await runEventMutationWithProfileFallback(
      ctx,
      'upsert_event_insert_initial',
      {
        filters: { user_id: ctx.userId, id: row.id },
        params: { single: true }
      },
      () => sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
        .insert(applyEventWriteProfile(row))
      ).single()
    );
    if (!insert.error) {
      savedRow = insert.data;
    } else if (row.google_event_id && insert.error.code === '23505') {
      const rebound = await sbFetchEventRowByGoogleId(ctx, row.google_event_id, { calendarId: rowCalendarId })
        || await sbFetchEventRowByGoogleId(ctx, row.google_event_id);
      if (!rebound?.id) throw insert.error;
      syncLog('upsert_rebound_google_event_id_race', {
        actor,
        googleEventId: row.google_event_id,
        requestedId: row.id,
        resolvedId: rebound.id
      }, 'warn');
      row = { ...row, id: rebound.id, google_calendar_id: rowCalendarId };
      current = rebound;
    } else {
      throw insert.error;
    }
  }

  if (!savedRow) {
    if (!current) current = await sbFetchEventRowById(ctx, row.id);
    if (!current) {
      const retryInsert = await runEventMutationWithProfileFallback(
        ctx,
        'upsert_event_insert_retry',
        {
          filters: { user_id: ctx.userId, id: row.id },
          params: { single: true }
        },
        () => sbSelectEventColumns(ctx.supabase
          .from(SB_TABLES.events)
          .insert(applyEventWriteProfile(row))
        ).single()
      );
      if (retryInsert.error) throw retryInsert.error;
      savedRow = retryInsert.data;
    } else {
      const expectedUpdatedAt = current.updated_at || null;
      const optimisticSaved = await sbUpdateEventRowWithExpectedTs(ctx, row, expectedUpdatedAt);
      if (optimisticSaved) {
        savedRow = optimisticSaved;
      } else {
        savedRow = await resolveSbUpsertConflict({
          ctx,
          row,
          actor,
          expectedUpdatedAt
        });
      }
    }
  }

  if (!savedRow) {
    throw new Error(`No se pudo persistir evento ${row.id}`);
  }

  const saved = supabaseRowToEvent(savedRow);
  clearEventDeletedTombstone(saved.id);
  await cachePutEvents([saved]);
  return saved;
}

async function sbUpsertEvent(evt, options = {}) {
  assertWritesAllowed('sbUpsertEvent');
  const actor = normalizeConcurrencyActor(options.actor);
  const source = actor === 'google' ? 'sync' : 'local';
  const writeToken = options.writeLockToken || (source === 'sync' ? _syncWriteLockToken : null);

  try {
    const saved = await withWriteLock(
      () => sbUpsertEventCore(evt, options),
      {
        operation: `sbUpsertEvent:${source}`,
        token: writeToken,
        source
      }
    );
    if (source === 'local') {
      await refreshSyncStatusOutboxCount();
    }
    return saved;
  } catch (err) {
    if (source !== 'local' || options.skipOutbox || !isNetworkWriteError(err)) {
      throw err;
    }
    if (!state.db) throw err;

    const optimistic = {
      ...evt,
      id: ensureUuidId(evt?.id),
      needsGCalSync: evt?.needsGCalSync !== false,
      source: normalizeEventSource(evt?.source, evt || {}),
      _queuedOffline: true
    };
    if (!optimistic.startDate) optimistic.startDate = optimistic.date || ymd(new Date());
    if (!optimistic.startTime) optimistic.startTime = optimistic.time || '00:00';
    if (!optimistic.endDate) optimistic.endDate = optimistic.startDate;
    if (!optimistic.endTime) optimistic.endTime = optimistic.startTime;
    optimistic.date = optimistic.startDate;
    optimistic.time = optimistic.startTime;
    optimistic.monthKey = (optimistic.startDate || '').slice(0, 7);

    await cachePutEvents([optimistic]);
    await enqueueOutboxOperation('event_upsert', { event: optimistic }, { eventId: optimistic.id });
    await refreshSyncStatusOutboxCount();
    return optimistic;
  }
}

async function sbDeleteEventByIdCore(eventId, options = {}) {
  if (!eventId) return;
  const ctx = await getWriteDataContext();
  const { error: attErr } = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.attachments,
    operation: 'delete_attachments_by_event_for_event_delete',
    meta: { filters: { user_id: ctx.userId, event_id: eventId } },
    execute: () => ctx.supabase
      .from(SB_TABLES.attachments)
      .delete()
      .eq('user_id', ctx.userId)
      .eq('event_id', eventId)
  });
  if (attErr) throw attErr;

  const { error } = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.events,
    operation: 'delete_event_by_id',
    meta: { filters: { user_id: ctx.userId, id: eventId } },
    execute: () => ctx.supabase
      .from(SB_TABLES.events)
      .delete()
      .eq('user_id', ctx.userId)
      .eq('id', eventId)
  });
  if (error) throw error;

  markEventDeletedTombstone(eventId);

  await cacheDeleteEvent(eventId);
  await cacheDeleteAttachmentsForEvent(eventId);
}

async function sbDeleteEventById(eventId, options = {}) {
  if (!eventId) return;
  assertWritesAllowed('sbDeleteEventById');
  const source = String(options.source || 'local').trim().toLowerCase() === 'sync' ? 'sync' : 'local';
  const writeToken = options.writeLockToken || (source === 'sync' ? _syncWriteLockToken : null);

  try {
    await withWriteLock(
      () => sbDeleteEventByIdCore(eventId, options),
      {
        operation: `sbDeleteEventById:${source}`,
        token: writeToken,
        source
      }
    );
    if (source === 'local') {
      await refreshSyncStatusOutboxCount();
    }
  } catch (err) {
    if (source !== 'local' || options.skipOutbox || !isNetworkWriteError(err)) {
      throw err;
    }
    if (!state.db) throw err;
    markEventDeletedTombstone(eventId);
    await cacheDeleteEvent(eventId);
    await cacheDeleteAttachmentsForEvent(eventId);
    await enqueueOutboxOperation('event_delete', { eventId: String(eventId) }, { eventId: String(eventId) });
    await refreshSyncStatusOutboxCount();
  }
}

function computeOutboxBackoffMs(retries) {
  const n = Math.max(0, Number(retries || 0));
  const raw = OUTBOX_BASE_BACKOFF_MS * (2 ** Math.min(n, 6));
  return Math.min(raw, 60 * 1000);
}

async function applyOutboxEntry(entry) {
  if (!entry || !entry.op) return;
  if (entry.op === 'event_upsert') {
    const evt = entry.payload?.event || null;
    if (!evt?.id) throw new Error('OUTBOX_INVALID_EVENT_UPSERT');
    await sbUpsertEventCore(evt, { actor: 'local', skipOutbox: true });
    return;
  }
  if (entry.op === 'event_delete') {
    const eventId = String(entry.payload?.eventId || entry.eventId || '').trim();
    if (!eventId) throw new Error('OUTBOX_INVALID_EVENT_DELETE');
    await sbDeleteEventByIdCore(eventId, { skipOutbox: true });
    return;
  }
  throw new Error(`OUTBOX_UNKNOWN_OP:${entry.op}`);
}

async function flushOutbox({
  reason = 'manual',
  silent = true,
  force = false
} = {}) {
  if (_flushOutboxInFlight) return _flushOutboxInFlight;
  if (_googleSyncInFlight && !force) {
    return { ok: false, skipped: true, reason: 'sync_in_flight' };
  }

  _flushOutboxInFlight = (async () => {
    if (!state.db) return { ok: false, skipped: true, reason: 'no_indexeddb' };
    const outboxRows = await getOutboxEntries();
    if (!outboxRows.length) {
      await refreshSyncStatusOutboxCount();
      return { ok: true, processed: 0, failed: 0 };
    }

    setSyncStatus('syncing', { detail: `Aplicando cola (${outboxRows.length})` });
    let processed = 0;
    let failed = 0;
    const nowMs = Date.now();

    await withWriteLock(async () => {
      for (const row of outboxRows) {
        const nextAttemptAt = Number(row.nextAttemptAt || 0);
        if (nextAttemptAt > Date.now()) continue;
        try {
          await applyOutboxEntry(row);
          await deleteOutboxEntry(row.id);
          processed++;
        } catch (err) {
          failed++;
          const retries = Math.max(0, Number(row.retries || 0)) + 1;
          const nextTs = Date.now() + computeOutboxBackoffMs(retries);
          await putOutboxEntry({
            ...row,
            retries: Math.min(retries, OUTBOX_MAX_RETRIES),
            nextAttemptAt: nextTs,
            lastError: err?.message || String(err || 'error')
          });

          if (isNetworkWriteError(err)) {
            setSyncStatus('offline', { detail: 'Reintentando cola local' });
            break;
          }
          setSyncStatus('error', { detail: 'Fallo al vaciar cola local' });
        }
      }
    }, { operation: 'flush_outbox', source: 'local' });

    await refreshSyncStatusOutboxCount();

    if (!failed) {
      setSyncStatus('ok', { detail: '' });
      setSyncStatusLastSuccess(nowMs);
    } else if (!silent) {
      showToast('Algunas operaciones pendientes no pudieron sincronizarse.', {
        type: 'error',
        actionLabel: null,
        onUndo: null,
        duration: 4200
      });
    }

    return { ok: failed === 0, processed, failed };
  })().finally(() => {
    _flushOutboxInFlight = null;
  });

  return _flushOutboxInFlight;
}

async function sbRebindEventGoogleLinkById(eventId, googleEventId, googleCalendarId) {
  if (!eventId || !googleEventId) return null;
  assertWritesAllowed('sbRebindEventGoogleLinkById');
  const ctx = await getWriteDataContext();
  const googleIdCol = getGoogleEventIdColumnName();
  const normalizedCalendarId = normalizeGoogleCalendarId(googleCalendarId, 'primary');
  const payload = {
    updated_at: new Date().toISOString()
  };

  payload[googleIdCol] = googleEventId;
  if (!isMinimalEventProfile()) {
    payload.google_calendar_id = normalizedCalendarId;
  }

  const { data, error } = await runEventMutationWithProfileFallback(
    ctx,
    'rebind_event_google_link_by_id',
    {
      filters: {
        user_id: ctx.userId,
        id: eventId,
        google_event_id: googleEventId,
        google_calendar_id: normalizedCalendarId
      }
    },
    () => sbSelectEventColumns(ctx.supabase
      .from(SB_TABLES.events)
      .update(payload)
      .eq('user_id', ctx.userId)
      .eq('id', eventId)
      .is(googleIdCol, null)
    ).maybeSingle()
  );
  if (error) throw error;
  if (!data) return null;
  const saved = supabaseRowToEvent(data);
  await cachePutEvents([saved]);
  return saved;
}

function attachmentToSupabaseRow(att, eventId, userId) {
  const driveId = (typeof MODULE_ATTACHMENTS_DRIVE.ensureDriveFileId === 'function')
    ? MODULE_ATTACHMENTS_DRIVE.ensureDriveFileId(att)
    : String(att.gdriveId || att.drive_file_id || '').trim();
  if (!driveId) throw new Error('Adjunto sin drive_file_id');
  return {
    id: ensureUuidId(att.id),
    event_id: eventId,
    user_id: userId,
    drive_file_id: driveId,
    file_type: att.type || att.file_type || null,
    file_name: att.name || att.file_name || 'archivo'
  };
}

function supabaseRowToAttachmentMeta(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    gdriveId: row.drive_file_id,
    drive_file_id: row.drive_file_id,
    type: row.file_type || 'application/octet-stream',
    file_type: row.file_type || 'application/octet-stream',
    name: row.file_name || 'archivo',
    file_name: row.file_name || 'archivo',
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now()
  };
}

async function sbFetchAttachmentsByEvent(eventId) {
  if (!eventId) return [];
  const ctx = await getReadDataContext();
  const { data, error } = await runAttachmentSelectWithProfileFallback(
    ctx,
    'fetch_attachments_by_event',
    { filters: { user_id: ctx.userId, event_id: eventId } },
    () => sbSelectAttachmentColumns(ctx.supabase
      .from(SB_TABLES.attachments)
    )
      .eq('user_id', ctx.userId)
      .eq('event_id', eventId)
      .order('created_at', { ascending: true })
  );
  if (error) throw error;
  return (data || []).map(supabaseRowToAttachmentMeta);
}

async function sbUpsertAttachmentCore(att, eventId) {
  const ctx = await getWriteDataContext();
  const row = attachmentToSupabaseRow(att, eventId, ctx.userId);
  const { data, error } = await runAttachmentMutationWithProfileFallback(
    ctx,
    'upsert_attachment',
    {
      filters: { user_id: ctx.userId, id: row.id, event_id: row.event_id },
      params: { onConflict: 'id', single: true }
    },
    () => sbSelectAttachmentColumns(ctx.supabase
      .from(SB_TABLES.attachments)
      .upsert(applyAttachmentWriteProfile(row), { onConflict: 'id' })
    ).single()
  );
  if (error) throw error;
  const savedMeta = supabaseRowToAttachmentMeta(data);
  const local = { ...att, ...savedMeta, eventId };
  await cachePutAttachments([local]);
  return local;
}

async function sbUpsertAttachment(att, eventId, options = {}) {
  assertWritesAllowed('sbUpsertAttachment');
  const source = String(options.source || 'local').trim().toLowerCase() === 'sync' ? 'sync' : 'local';
  const writeToken = options.writeLockToken || (source === 'sync' ? _syncWriteLockToken : null);
  return withWriteLock(
    () => sbUpsertAttachmentCore(att, eventId),
    {
      operation: `sbUpsertAttachment:${source}`,
      token: writeToken,
      source
    }
  );
}

async function sbDeleteAttachmentById(attId) {
  if (!attId) return;
  assertWritesAllowed('sbDeleteAttachmentById');
  const ctx = await getWriteDataContext();
  const { error } = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.attachments,
    operation: 'delete_attachment_by_id',
    meta: { filters: { user_id: ctx.userId, id: attId } },
    execute: () => ctx.supabase
      .from(SB_TABLES.attachments)
      .delete()
      .eq('user_id', ctx.userId)
      .eq('id', attId)
  });
  if (error) throw error;
  await cacheDeleteAttachmentById(attId);
}

async function sbDeleteAttachmentsByEvent(eventId) {
  if (!eventId) return;
  assertWritesAllowed('sbDeleteAttachmentsByEvent');
  const ctx = await getWriteDataContext();
  const { error } = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.attachments,
    operation: 'delete_attachments_by_event',
    meta: { filters: { user_id: ctx.userId, event_id: eventId } },
    execute: () => ctx.supabase
      .from(SB_TABLES.attachments)
      .delete()
      .eq('user_id', ctx.userId)
      .eq('event_id', eventId)
  });
  if (error) throw error;
  await cacheDeleteAttachmentsForEvent(eventId);
}

async function sbLoadEventIdsWithFiles() {
  const ctx = await getReadDataContext();
  const { data, error } = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.attachments,
    operation: 'load_event_ids_with_files',
    meta: { filters: { user_id: ctx.userId }, params: { select: 'event_id' } },
    execute: () => ctx.supabase
      .from(SB_TABLES.attachments)
      .select('event_id')
      .eq('user_id', ctx.userId)
  });
  if (error) throw error;
  const out = new Set();
  for (const row of (data || [])) {
    if (row.event_id) out.add(row.event_id);
  }
  return out;
}

function mergeAttachments(remoteMetaList, localList) {
  const map = new Map();
  for (const a of (localList || [])) {
    map.set(a.id, { ...a });
  }
  for (const m of (remoteMetaList || [])) {
    const cur = map.get(m.id) || {};
    map.set(m.id, {
      ...cur,
      ...m,
      eventId: m.eventId || cur.eventId,
      name: m.name || cur.name || 'archivo',
      type: m.type || cur.type || 'application/octet-stream',
      gdriveId: m.gdriveId || m.drive_file_id || cur.gdriveId || cur.drive_file_id || ''
    });
  }
  return [...map.values()];
}

// Snapshot único (evento + adjuntos) usado por undo/restore en la capa Supabase.
async function snapshotEventAndAttachments(eventId) {
  const ev = await getEventById(eventId);
  const atts = await getAttachmentsByEvent(eventId);
  return { event: ev ? { ...ev } : null, atts: atts.map((a) => ({ ...a })) };
}

// Borrado único de adjuntos de un evento (remoto + caché local).
async function deleteAllAttachmentsForEvent(eventId) {
  try {
    await sbDeleteAttachmentsByEvent(eventId);
    clearDataError();
  } catch (err) {
    reportDataError('borrar adjuntos', err);
    await cacheDeleteAttachmentsForEvent(eventId);
  }
}

// Restore único para deshacer: repone evento y adjuntos en Supabase/caché.
async function restoreEventAndAttachments(ev, atts) {
  if (!ev) return;
  const restored = await sbUpsertEvent(ev);
  await deleteAllAttachmentsForEvent(restored.id);
  const list = Array.isArray(atts) ? atts : [];
  for (const a of list) {
    try {
      await sbUpsertAttachment({ ...a, eventId: restored.id }, restored.id);
    } catch (err) {
      reportDataError('restaurar adjunto', err, { silent: true });
      await cachePutAttachments([{ ...a, eventId: restored.id }]);
    }
  }
}

// Fuente única para cargar mes: Supabase primero, caché local como fallback.
async function loadMonthEvents(year, month) {
  const fromDate = `${year}-${pad2(month + 1)}-01`;
  const toDateObj = new Date(year, month + 1, 0);
  const toDate = ymd(toDateObj);
  const dayKeys = buildInclusiveDateKeys(fromDate, toDate);
  try {
    setDataLoading(true);
    await ensureHolidayEventsForYears([year], { silent: true });
    const events = await sbFetchEventsRange(fromDate, toDate);
    const map = distributeEventsByVisibleDays(events, dayKeys);
    clearDataError();
    return map;
  } catch (err) {
    reportDataError('cargar eventos del mes', err);
    if (shouldUseCacheFallbackForError(err)) {
      return cacheGetMonthEvents(year, month);
    }
    return new Map(dayKeys.map((k) => [k, []]));
  } finally {
    setDataLoading(false);
  }
}

// Lectura única por rango visible: asegura festivos y usa capa remota con fallback local.
async function getEventsByDates(dateStrs) {
  const keys = (dateStrs || []).filter(Boolean);
  const map = new Map(keys.map((s) => [s, []]));
  if (!keys.length) return map;
  const ordered = [...keys].sort();
  const fromDate = ordered[0];
  const toDate = ordered[ordered.length - 1];
  const years = [...new Set(ordered.map((s) => Number(String(s).slice(0, 4))).filter((y) => Number.isFinite(y)))];
  try {
    setDataLoading(true);
    await ensureHolidayEventsForYears(years, { silent: true });
    const events = await sbFetchEventsRange(fromDate, toDate);
    const distributed = distributeEventsByVisibleDays(events, keys);
    clearDataError();
    return distributed;
  } catch (err) {
    reportDataError('cargar eventos por fecha', err, { silent: true });
    if (shouldUseCacheFallbackForError(err)) {
      return cacheGetEventsByDates(keys);
    }
    return map;
  } finally {
    setDataLoading(false);
  }
}

async function getEventsByDate(dateStr) {
  const map = await getEventsByDates([dateStr]);
  return map.get(dateStr) || [];
}

async function getEventById(id) {
  if (!id) return null;
  try {
    const out = await sbFetchEventById(id);
    if (out) clearDataError();
    return out;
  } catch (err) {
    reportDataError('leer evento', err, { silent: true });
    if (shouldUseCacheFallbackForError(err)) {
      return cacheGetEventById(id);
    }
    return null;
  }
}

// Guardado único de eventos (crear/editar) con persistencia en Supabase.
async function saveEvent(ev) {
  ev.preventDefault();
  const idInput = $('#eventId');
  const inputId = idInput.value || '';
  const id = ensureUuidId(inputId);

  const title = $('#eventTitle').value.trim();
  const location = $('#eventLocation').value.trim() || '';
  const url = $('#eventUrl').value.trim() || '';
  const color = normalizeEventColor($('#eventColor').value || '', EVENT_COLOR_DEFAULT);
  const selectedCalendarId = normalizeGoogleCalendarId($('#eventGoogleCalendar')?.value || state.selectedGoogleCalendarId || 'primary', 'primary');
  const client = $('#eventClient').value.trim() || '';
  const category = $('#eventCategory').value || 'Trabajo';
  const categoryOther = (category === 'Otros') ? ($('#eventCategoryOther').value.trim() || '') : '';

  const allDay = !!$('#eventAllDay').checked;
  const sDate = $('#eventStartDate').value;
  let sTime = $('#eventStartTime').value;
  let eDate = $('#eventEndDate').value;
  let eTime = $('#eventEndTime').value;

  const alertSel = $('#eventAlert').value || 'none';
  const repeatSel = $('#eventRepeat').value || 'none';
  const notes = $('#eventNotes').value.trim() || '';
  const duplicateFromId = $('#duplicateFromId').value || '';

  if (!title || !sDate || (!allDay && !sTime)) return;
  await waitForEventAttachmentUploads();

  if (allDay) {
    sTime = '00:00';
    eDate = eDate || sDate;
    eTime = '23:59';
  } else {
    eDate = eDate || sDate;
    if (!eTime) {
      const plus = addMinutes(sDate, sTime, 60);
      eDate = plus.date; eTime = plus.time;
    }
  }

  const isEdit = !!idInput.value;
  let snapshot = null;

  try {
    setDataLoading(true);
    if (isEdit) snapshot = await snapshotEventAndAttachments(inputId || id);
    state.selectedGoogleCalendarId = selectedCalendarId;

    const evt = {
      id,
      title,
      location,
      url,
      color,
      client,
      category,
      categoryOther,
      date: sDate,
      time: sTime,
      monthKey: sDate.slice(0, 7),
      createdAt: snapshot?.event?.createdAt || Date.now(),
      allDay,
      startDate: sDate,
      startTime: sTime,
      endDate: eDate,
      endTime: eTime,
      alert: alertSel,
      repeat: repeatSel,
      notes,
      googleCalendarId: normalizeGoogleCalendarId(
        selectedCalendarId || snapshot?.event?.googleCalendarId || snapshot?.event?.google_calendar_id || 'primary',
        'primary'
      ),
      needsGCalSync: true,
      gcalId: snapshot?.event?.gcalId || null,
      gcalUpdated: snapshot?.event?.gcalUpdated || null,
      source: snapshot?.event?.source || 'local',
      lastSyncedAt: snapshot?.event?.lastSyncedAt || null
    };

    const savedEvent = await sbUpsertEvent(evt);

    try {
      if (_eventSheetPendingAttachments.length) {
        const pendingForSave = _eventSheetPendingAttachments.map((a) => ({
          ...a,
          id: ensureUuidId(a.id),
          eventId: savedEvent.id
        }));
        for (const a of pendingForSave) {
          await persistAttachmentMetaWithDriveId(a, savedEvent.id, 'guardar metadato de adjunto');
        }
        _eventSheetPendingAttachments = [];
      }

      if (duplicateFromId) {
        const sourceAtts = await getAttachmentsByEvent(duplicateFromId);
        const cloned = sourceAtts.map((a) => ({
          ...a,
          id: ensureUuidId(),
          eventId: savedEvent.id
        }));
        const clonedWithDrive = [];
        for (const a of cloned) {
          const driveId = await ensureAttachmentDriveId(a);
          if (!driveId) continue;
          clonedWithDrive.push({
            ...a,
            gdriveId: driveId,
            drive_file_id: driveId
          });
        }
        if (clonedWithDrive.length) {
          await cachePutAttachments(clonedWithDrive);
          for (const a of clonedWithDrive) {
            await sbUpsertAttachmentWithRetry(a, savedEvent.id, {
              attempts: 2,
              context: 'clonar metadato de adjunto'
            });
          }
        }
      }
    } catch (attachmentErr) {
      reportDataError('guardar adjuntos del evento', attachmentErr);
      if (!savedEvent?._queuedOffline) {
        try {
          if (isEdit && snapshot.event) {
            await restoreEventAndAttachments(snapshot.event, snapshot.atts);
          } else {
            await sbDeleteEventById(savedEvent.id);
          }
        } catch (rollbackErr) {
          reportDataError('rollback de evento por fallo de adjuntos', rollbackErr, { silent: true });
        }
      }
      throw attachmentErr;
    }

    clearEventAttachmentDraft({ clearPreview: true });
    resetEventAttachmentPickers();
    closeSheet();
    reRender();
    clearDataError();
    try {
      await syncReminderScheduleToSW({ requestPermission: false, triggerCheck: true, reason: 'save_event', force: true });
    } catch (syncErr) {
      console.warn('No se pudo sincronizar recordatorios al guardar evento:', syncErr);
    }

    const createdMsg = duplicateFromId ? 'Evento duplicado' : 'Evento creado';
    showToast(isEdit ? 'Evento actualizado' : createdMsg, {
      actionLabel: 'Deshacer',
      onUndo: async () => {
        if (isEdit && snapshot.event) {
          await restoreEventAndAttachments(snapshot.event, snapshot.atts);
        } else {
          await deleteEvent(savedEvent.id, { silent: true });
        }
        reRender();
      }
    });
  } catch (err) {
    reportDataError('guardar evento', err);
  } finally {
    setDataLoading(false);
  }
}

// Borrado único de eventos con limpieza de adjuntos y soporte undo.
async function deleteEvent(id, { silent = false } = {}) {
  if (!id) return;
  let snap = null;
  try {
    setDataLoading(true);
    snap = await snapshotEventAndAttachments(id);
    await sbDeleteEventById(id);


    closeSheet();
    reRender();
    clearDataError();
    try {
      await syncReminderScheduleToSW({ requestPermission: false, triggerCheck: true, reason: 'delete_event', force: true });
    } catch (syncErr) {
      console.warn('No se pudo sincronizar recordatorios al borrar evento:', syncErr);
    }

    if (!silent) {
      showToast('Evento eliminado', {
        actionLabel: 'Deshacer',
        onUndo: async () => {
          await restoreEventAndAttachments(snap.event, snap.atts);
          try {
            const restored = { ...snap.event, needsGCalSync: true };
            await sbUpsertEvent(restored);
          } catch (err) {
            reportDataError('marcar evento restaurado para sync Google', err, { silent: true });
          }
          reRender();
        }
      });
    }
  } catch (err) {
    reportDataError('eliminar evento', err);
  } finally {
    setDataLoading(false);
  }
}

// Alta rápida única (cumple/tarea) integrada con Supabase.
async function saveEventFromForm(ev, category) {
  ev.preventDefault();
  const form = ev.target;
  const idInput = form.querySelector('[name="id"]');
  const dateStr = form.querySelector('[name="date"]').value;
  const time = form.querySelector('[name="time"]').value;
  const title = form.querySelector('[name="title"]').value.trim();
  const location = form.querySelector('[name="location"]').value.trim() || '';
  const client = form.querySelector('[name="client"]').value.trim() || '';
  const filesEl = form.querySelector('[name="files"]');

  if (!dateStr || !time || !title) return;

  const id = ensureUuidId(idInput.value);
  const plus = addMinutes(dateStr, time, 60);
  const evt = {
    id,
    date: dateStr,
    time,
    title,
    location,
    client,
    category,
    categoryOther: '',
    monthKey: dateStr.slice(0, 7),
    createdAt: Date.now(),
    allDay: false,
    startDate: dateStr,
    startTime: time,
    endDate: plus.date,
    endTime: plus.time,
    googleCalendarId: normalizeGoogleCalendarId(state.selectedGoogleCalendarId || 'primary', 'primary'),
    needsGCalSync: true,
    source: 'local'
  };

  try {
    setDataLoading(true);
    const saved = await sbUpsertEvent(evt);
    try {
      if (filesEl && filesEl.files && filesEl.files.length) {
        for (const f of filesEl.files) {
          const att = {
            id: ensureUuidId(),
            eventId: saved.id,
            name: f.name,
            type: f.type || 'application/octet-stream',
            blob: f
          };
          await persistAttachmentMetaWithDriveId(att, saved.id, 'guardar metadato de adjunto');
        }
      }
    } catch (attachmentErr) {
      reportDataError('guardar adjuntos de alta rapida', attachmentErr);
      if (!saved?._queuedOffline) {
        try {
          await sbDeleteEventById(saved.id);
        } catch (rollbackErr) {
          reportDataError('rollback de alta rapida por fallo de adjuntos', rollbackErr, { silent: true });
        }
      }
      throw attachmentErr;
    }
    clearDataError();
    try {
      await syncReminderScheduleToSW({ requestPermission: false, triggerCheck: true, reason: `quick_save_${category || 'evento'}`, force: true });
    } catch (syncErr) {
      console.warn('No se pudo sincronizar recordatorios tras alta rapida:', syncErr);
    }
  } catch (err) {
    reportDataError(`guardar ${String(category || 'evento').toLowerCase()}`, err);
    return;
  } finally {
    setDataLoading(false);
  }

  if (category === 'Cumpleaños') closeSheetById('addBirthdaySheet');
  else if (category === 'Evento') closeSheetById('addTaskSheet');

  reRender();
  showToast(`${category} creado`, {
    actionLabel: 'Deshacer',
    onUndo: async () => {
      await deleteEvent(id, { silent: true });
      reRender();
    }
  });
}

// Lectura única de adjuntos por evento (remote + fallback local).
async function getAttachmentsByEvent(eventId) {
  const local = await cacheGetAttachmentsByEvent(eventId);
  try {
    const remoteMeta = await sbFetchAttachmentsByEvent(eventId);
    const merged = mergeAttachments(remoteMeta, local);
    await cachePutAttachments(merged);
    clearDataError();
    return merged;
  } catch (err) {
    reportDataError('leer adjuntos', err, { silent: true });
    return local;
  }
}

// Render único de preview de adjuntos (incluye blobs locales cuando existen).
async function renderAttachmentPreview(eventId) {
  injectAttachmentViewerStyles();
  const wrap = $('#attachmentsPreview'); if (!wrap) return;

  (_previewURLs.get(eventId) || []).forEach(u => { try { URL.revokeObjectURL(u); } catch (err) { void err; } });
  _previewURLs.set(eventId, []);

  wrap.innerHTML = '';
  if (!eventId) return;

  const atts = await getAttachmentsByEvent(eventId);
  for (const a of atts) {
    const card = document.createElement('div'); card.className = 'attachment-card';
    let blobURL = null;
    const hasBlob = !!a.blob;
    if (hasBlob) {
      blobURL = URL.createObjectURL(a.blob);
      _previewURLs.get(eventId).push(blobURL);
    }

    if (hasBlob && a.type && a.type.startsWith('image/')) {
      const img = document.createElement('img'); img.src = blobURL; img.alt = a.name || 'adjunto';
      card.append(img);
    } else if (hasBlob && a.type && a.type.startsWith('video/')) {
      const vid = document.createElement('video'); vid.src = blobURL; vid.controls = true;
      card.append(vid);
    } else {
      const box = document.createElement('div');
      box.style.padding = '.6rem';
      box.style.textAlign = 'center';
      box.textContent = hasBlob ? (`Adjunto: ${a.name || 'archivo'}`) : (`Drive: ${a.name || 'Adjunto en Drive'}`);
      card.append(box);
    }

    const name = document.createElement('div'); name.className = 'name'; name.textContent = a.name || 'archivo';
    card.append(name);

    if (hasBlob) {
      card.tabIndex = 0;
      card.addEventListener('click', () => openAttachmentViewer(a, blobURL));
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openAttachmentViewer(a, blobURL); }
      });
    }

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'att-del';
    delBtn.title = 'Eliminar adjunto';
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handleAttachmentDelete(eventId, a);
    });
    card.append(delBtn);

    wrap.append(card);
  }
}

// Borrado único de adjuntos (Drive opcional + Supabase + cache).
async function handleAttachmentDelete(eventId, att) {
  const ok = await confirmNative({
    title: 'Eliminar adjunto',
    message: `¿Eliminar "${att.name}" Esta acción es permanente.`,
    confirmText: 'Eliminar',
    cancelText: 'Cancelar',
    destructive: true
  });
  if (!ok) return;

  try {
    await deleteDriveFileIfAllowed(att);
  } catch (err) {
    reportDataError('eliminar adjunto en Drive', err, { silent: true });
  }

  try {
    setDataLoading(true);
    await sbDeleteAttachmentById(att.id);
    clearDataError();
  } catch (err) {
    reportDataError('eliminar adjunto', err, { silent: true });
    await cacheDeleteAttachmentById(att.id);
  } finally {
    setDataLoading(false);
  }

  try { closeAttachmentViewer(); } catch (err) { void err; }
  await renderAttachmentPreview(eventId);
  showToast('Adjunto eliminado', { actionLabel: null, onUndo: null, duration: 3000 });
}

// Índice único de eventos con archivos para búsqueda avanzada.
async function loadEventIdsWithFiles() {
  try {
    const remote = await sbLoadEventIdsWithFiles();
    const local = await cacheLoadEventIdsWithFiles();
    for (const id of local) remote.add(id);
    clearDataError();
    return remote;
  } catch (err) {
    reportDataError('cargar adjuntos para búsqueda', err, { silent: true });
    return cacheLoadEventIdsWithFiles();
  }
}

// Búsqueda avanzada única sobre la fuente canónica de eventos.
async function searchEventsAdvanced(queryRaw) {
  const q = parseAdvancedQuery(queryRaw);
  const needFiles = q.hasFiles;
  const fileSet = needFiles ? await loadEventIdsWithFiles() : null;

  let events = [];
  try {
    events = await sbFetchAllEvents();
    clearDataError();
  } catch (err) {
    reportDataError('buscar eventos', err, { silent: true });
    events = await cacheGetAllEvents();
  }

  const results = [];
  for (const e of events) {
    const catText = (e.category === 'Otros' && e.categoryOther) ? e.categoryOther : e.category;

    if (q.title && !String(e.title || '').toLowerCase().includes(q.title)) continue;
    if (q.client && !String(e.client || '').toLowerCase().includes(q.client)) continue;
    if (q.location && !String(e.location || '').toLowerCase().includes(q.location)) continue;
    if (q.category && String(e.category || '').toLowerCase() !== q.category) continue;
    if (q.on && e.date !== q.on) continue;
    if (q.before && !dateLTE(e.date, q.before)) continue;
    if (q.after && !dateGTE(e.date, q.after)) continue;
    if (q.from && q.to && !(dateGTE(e.date, q.from) && dateLTE(e.date, q.to))) continue;
    if (needFiles && !fileSet.has(e.id)) continue;

    if (q.terms.length) {
      const hay = `${e.title || ''} ${e.client || ''} ${e.location || ''} ${catText || ''}`.toLowerCase();
      const all = q.terms.every((t) => hay.includes(t));
      if (!all) continue;
    }
    results.push(e);
  }

  results.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return results.slice(0, 200);
}

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
 * - interactive=false  intenta recuperar token en silencio (sin prompts)
 * - interactive=true   puede mostrar consentimiento (úsalo en clicks del usuario)
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
        setGoogleConnectedState(true);
        try { ensureAutoSyncTimer(); } catch (err) { void err; }
        return resolve(_googleAccessToken);
      }
      const err = resp.error || 'Respuesta sin access_token';
      reject(new Error(err));
    };

    try {
      client.requestAccessToken({
        prompt: interactive ? 'consent' : '' // silencioso si no es interactivo
      });
    } catch (e) {
      reject(e);
    }
  });
}

function normalizeOwnedEmail(email) {
  const helpers = getAuthHelpers();
  if (helpers.normalizeEmail) return helpers.normalizeEmail(email);
  return String(email || '').trim().toLowerCase();
}

function createGoogleOwnerMismatchError(ownerEmail, tokenEmail) {
  const err = new Error(`GOOGLE_OWNER_MISMATCH:${tokenEmail || 'unknown'}`);
  err.code = 'GOOGLE_OWNER_MISMATCH';
  err.ownerEmail = ownerEmail;
  err.tokenEmail = tokenEmail || null;
  return err;
}

async function googleFetchRaw(url, opts = {}, stage = 'google_fetch_raw') {
  return withGoogleApiMutex(async () => {
    throwIfSyncAbortRequested(`${stage}:before_fetch`);
    const signal = getGoogleAbortSignal();
    try {
      const res = await fetch(url, {
        ...opts,
        signal
      });
      throwIfSyncAbortRequested(`${stage}:after_fetch`);
      return res;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw createSyncAbortError(`${stage}:aborted`);
      }
      throw err;
    }
  }, stage);
}

async function verifyGoogleTokenOwnerEmail(token, { force = false } = {}) {
  if (!token) throw new Error('Token Google ausente');
  if (!force && _googleTokenOwnerVerifiedFor === token && _googleTokenOwnerEmail) {
    return _googleTokenOwnerEmail;
  }

  const ownerEmail = normalizeOwnedEmail(getOwnerEmail());
  if (!ownerEmail) throw new Error('OWNER_EMAIL no configurado');

  const res = await googleFetchRaw('https://www.googleapis.com/oauth2/v3/userinfo', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  }, 'google_userinfo');

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = new Error(`GOOGLE_USERINFO_FAILED:${res.status}:${txt}`);
    err.code = 'GOOGLE_USERINFO_FAILED';
    err.status = res.status;
    throw err;
  }

  const payload = await res.json().catch(() => ({}));
  const tokenEmail = normalizeOwnedEmail(payload.email || '');
  if (!tokenEmail || tokenEmail !== ownerEmail) {
    _googleAccessToken = null;
    _googleTokenOwnerVerifiedFor = null;
    _googleTokenOwnerEmail = null;
    _googleSyncBlocked = true;
    setGoogleConnectedState(false);
    abortGoogleNetworkRequests('google_owner_mismatch');
    throw createGoogleOwnerMismatchError(ownerEmail, tokenEmail);
  }

  _googleTokenOwnerVerifiedFor = token;
  _googleTokenOwnerEmail = tokenEmail;
  return tokenEmail;
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

// ensureDriveIdsForEventAttachments consolidado en Google Sync v2 (más abajo).

async function gapiFetch(url, opts = {}, retry = 0) {
  throwIfSyncAbortRequested('gapiFetch:before_token');
  if (_googleSyncBlocked) {
    const err = new Error('GOOGLE_SYNC_BLOCKED');
    err.code = 'GOOGLE_SYNC_BLOCKED';
    throw err;
  }
  let token = await ensureGoogleToken({ interactive: false });
  await verifyGoogleTokenOwnerEmail(token);
  throwIfSyncAbortRequested('gapiFetch:before_fetch');
  const doFetch = () => googleFetchRaw(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
  }, 'gapiFetch');

  let res = await doFetch();
  throwIfSyncAbortRequested('gapiFetch:after_fetch');

  // token caducado -> reintenta una vez con token nuevo
  if (res.status === 401) {
    throwIfSyncAbortRequested('gapiFetch:before_token_refresh');
    _googleAccessToken = null;
    _googleTokenOwnerVerifiedFor = null;
    _googleTokenOwnerEmail = null;
    token = await ensureGoogleToken();
    await verifyGoogleTokenOwnerEmail(token, { force: true });
    throwIfSyncAbortRequested('gapiFetch:before_fetch_refresh');
    res = await googleFetchRaw(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
    }, 'gapiFetch_refresh');
    throwIfSyncAbortRequested('gapiFetch:after_fetch_refresh');
  }

  // cuotas/rate limit -> backoff exponencial hasta 5 intentos
  if ((res.status === 429 || res.status === 403) && retry < 5) {
    throwIfSyncAbortRequested('gapiFetch:before_backoff');
    const wait = (2 ** retry) * 500 + Math.random() * 300;
    await sleep(wait);
    throwIfSyncAbortRequested('gapiFetch:after_backoff');
    return gapiFetch(url, opts, retry + 1);
  }
  return res;
}

// UI Google/Auth consolidada en injectGoogleImportUI (Google Sync v2, más abajo).

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

// importAllFromGoogle consolidado en Google Sync v2 (más abajo).

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
    // Google usa end.date EXCLUSIVO  +1 día
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
  if (e.gcalId) return e.gcalId;
  if (e.id && String(e.id).startsWith('gcal:')) return String(e.id).slice(5);
  return null;
}

// pushEventToGCal/pushAllDirtyToGoogle consolidados en Google Sync v2 (más abajo).


/* ---------- Descargar un archivo de Drive por fileId ---------- */
async function downloadDriveBlob(fileId){
  const meta = await getDriveMeta(fileId);
  if (!meta) return null;

  // Docs/Sheets/Slides  export
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

  // Ficheros "normales"  descarga directa
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const res = await gapiFetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const name = meta.name || 'archivo';
  const type = meta.mimeType || blob.type || 'application/octet-stream';
  try { return new File([blob], name, { type }); }
  catch { return new Blob([blob], { type }); }
}

/* ---------- Guardar blob como adjunto en caché + metadatos en Supabase ---------- */
async function saveAttachmentBlob(eventId, name, mime, blob, fileId, options = {}) {
  if (!fileId) {
    throw new Error('Adjunto remoto sin drive_file_id');
  }
  if (fileId) {
    try {
      const existing = await getAttachmentsByEvent(eventId);
      if (existing.some((a) => (a.gdriveId || a.drive_file_id) === fileId)) {
        return false;
      }
    } catch (err) {
      reportDataError('consultar adjuntos existentes antes de importar', err, { silent: true });
    }
  }

  const localAtt = {
    id: ensureUuidId(),
    eventId,
    name: name || 'archivo',
    type: mime || 'application/octet-stream',
    blob,
    gdriveId: fileId,
    drive_file_id: fileId
  };

  await cachePutAttachments([localAtt]);
  try {
    await sbUpsertAttachmentWithRetry(localAtt, eventId, {
      attempts: 2,
      context: 'guardar metadato de adjunto importado',
      source: options.source || 'local',
      writeLockToken: options.writeLockToken || null
    });
  } catch (err) {
    await rollbackAttachmentCacheEntry(localAtt.id);
    throw err;
  }
  return true;
}

function ensureSWUpdatePrompt() {
  if (!('serviceWorker' in navigator)) return;
  if (ensureSWUpdatePrompt._bound) return;
  ensureSWUpdatePrompt._bound = true;
  ensureSWUpdatePrompt._toastVisible = false;
  ensureSWUpdatePrompt._notifiedWorkers = ensureSWUpdatePrompt._notifiedWorkers || new Set();

  navigator.serviceWorker.getRegistration().then((reg) => {
    if (!reg) return;

    const showIfInstalled = (newWorker) => {
      if (!newWorker) return;
      const workerKey = String(newWorker.scriptURL || '').trim() || `worker-${Date.now()}`;
      const onState = () => {
        if (newWorker.state !== 'installed') return;
        if (!navigator.serviceWorker.controller) return;
        if (ensureSWUpdatePrompt._notifiedWorkers.has(workerKey)) return;
        if (ensureSWUpdatePrompt._toastVisible) return;

        ensureSWUpdatePrompt._toastVisible = true;
        ensureSWUpdatePrompt._notifiedWorkers.add(workerKey);
        showToast('Actualización disponible', {
          actionLabel: 'Actualizar',
          onUndo: async () => {
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          },
          duration: 15000,
          toastKey: 'sw-update'
        });
        setTimeout(() => {
          ensureSWUpdatePrompt._toastVisible = false;
        }, 15100);
      };
      if (newWorker.state === 'installed') onState();
      newWorker.addEventListener('statechange', onState);
    };

    reg.addEventListener('updatefound', () => showIfInstalled(reg.installing));
  });
}

function registerServiceWorkerIfSupported() {
  if (!('serviceWorker' in navigator)) return;
  if (registerServiceWorkerIfSupported._started) return;
  registerServiceWorkerIfSupported._started = true;
  const isSecureContext = location.protocol === 'https:'
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1';
  if (!isSecureContext) return;
  window.addEventListener('load', async () => {
    try {
      const appScopeHref = new URL('./', location.href).href;
      const regs = await navigator.serviceWorker.getRegistrations();
      const sameScopeRegs = regs.filter((reg) => reg.scope === appScopeHref);
      if (sameScopeRegs.length > 1) {
        await Promise.all(
          sameScopeRegs.slice(1).map((reg) => reg.unregister().catch(() => false))
        );
      }
      if (sameScopeRegs[0]) return;
      await navigator.serviceWorker.register('sw.js');
    } catch (err) {
      console.error('SW register failed:', err);
    }
  }, { once: true });
}

registerServiceWorkerIfSupported();

// Auto-sync/reauth consolidados en Google Sync v2 (setAutoSyncEnabled, ensureAutoSyncTimer y reauth...).

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
    if (navigator.storage.persist) {
      await navigator.storage.persist();
    }
  } catch (err) { void err; }
})();

async function bootApp(){
  if (bootApp._started) return;
  bootApp._started = true;
  console.log("Month navigation mode: arrows");
  injectEnhancementStyles();
  injectToastStyles();
  injectAgendaStyles();
  injectSearchFullStyles();
  setPlatformClass();                 
  bindLandscapeResizeClassOnce();
  ensureSearchFullUI();
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

  if (typeof MODULE_UTILS.safeRemoveById === 'function') {
    MODULE_UTILS.safeRemoveById('tags-v2-hard-reset');
    MODULE_UTILS.safeRemoveById('month-density-css');
    MODULE_UTILS.safeRemoveById('month-light-css');
    MODULE_UTILS.safeRemoveById('tag-color-fix');
    MODULE_UTILS.safeRemoveById('tags-pill-override');
  } else {
    document.getElementById('tags-v2-hard-reset')?.remove?.();
    document.getElementById('month-density-css')?.remove?.();
    document.getElementById('month-light-css')?.remove?.();
    document.getElementById('tag-color-fix')?.remove?.();
    document.getElementById('tags-pill-override')?.remove?.();
  }

  if (document.body) {
  document.body.classList.add('tags-v2');
} else {
  window.addEventListener('DOMContentLoaded', () => document.body.classList.add('tags-v2'), { once:true });
}

  // light por defecto y vista "expandida" (solo títulos, como en la foto)
state.theme = localStorage.getItem('theme') || 'light';
applyTheme(state.theme);
state.monthDensity = localStorage.getItem('month.density') || 'expanded';
  applyMonthDensity();
  ensurePreviewCleanupOnce(); 


  try {
    state.db = await openDB();
  } catch (err) {
    console.warn('IndexedDB no disponible; se continúa sin caché offline.', err);
    state.db = null;
  }
  bindSyncStatusNetworkHandlersOnce();
  await initSyncStatusPillState();
  try {
    await flushOutbox({ reason: 'boot', silent: true });
  } catch (err) {
    void err;
  }

  const today = new Date();
  state.currentMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  addSwipeNavigation();

  // Placeholder de búsqueda más agradable
  $('#searchInput').setAttribute('placeholder', 'Buscar ej. "reunión", "Madrid", "Ana"');

  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const action = params.get('action');

  if (view === 'week' || view === '3days' || view === 'day' || view === 'agenda') {
    setViewMode(view);
  } else {
    setViewMode('month');
  }

  try {
    const y = new Date().getFullYear();
    await ensureHolidayEventsForYears([y, y + 1, y + 2], { silent: true });
  } catch (err) {
    reportDataError('precargar festivos futuros', err, { silent: true });
  }

  if (action === 'new') openSheetNew();
  injectGoogleImportUI();
  injectReminderNotificationUI();
  ensureCategoryUI();  
  setGoogleCalendars(state.googleCalendars, { reason: 'boot', preserveFilters: true });
  injectDrawerVersion();
  ensureSWUpdatePrompt();
  ensureAutoSyncTimer();

  await reauthGoogleSilentIfRemembered(); // intenta recuperar token sin prompts
  ensureAutoSyncTimer();                  // arrancara si hay token + autosync activado
  try {
    await syncReminderScheduleToSW({ requestPermission: false, triggerCheck: true, reason: 'boot' });
  } catch (err) {
    console.warn('No se pudo sincronizar recordatorios en arranque:', err);
  }
  await checkForcedUpdate();                          // al cargar
  document.addEventListener('visibilitychange', ()=>{ // al volver a la pestana
  if (document.visibilityState === 'visible') {
    checkForcedUpdate();
    syncReminderScheduleToSW({ requestPermission: false, triggerCheck: true, reason: 'visibility' }).catch(() => {});
  }
});
setInterval(checkForcedUpdate, 6 * 60 * 60 * 1000); // cada 6h
}

async function checkForcedUpdate(){
  const localVer = window.__APP_VERSION__;
  const persistedMin = localStorage.getItem('forceUpdate.min');
  if (persistedMin && cmpSemver(localVer, persistedMin) < 0){
    showUpdateGate(persistedMin, persistedMin);
    return;
  }

  try{
    const res = await fetch(appendCacheBuster(VERSION_ENDPOINT, 't'), { cache:'no-store' });
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
          const reg = await navigator.serviceWorker.getRegistration();
          await reg.update();
          reg.waiting.postMessage({ type:'SKIP_WAITING' });
          if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map(k => caches.delete(k)));
          }
          location.replace(appendCacheBuster(location.pathname, 'u'));
        },
        duration: 15000
      });
    }
  }catch{
    // si no hay red y ya estaba forzado, seguirá bloqueado por persistedMin
  }
hideLegacyNavArrows();
}

setupPrivateAuthGate().catch((err) => {
  lockAppUI(`Error inicializando autenticación privada: ${err.message || err}`, 'error', { showLogin: true, showLogout: false });
});

/* ===================== Google Sync v2 (Google -> normalizacion -> Supabase) ===================== */
const GOOGLE_SYNC_DEFAULTS = Object.freeze({
  calendarId: 'primary',
  sinceISO: '2009-01-01T00:00:00Z',
  horizonYears: 10,
  intervalMinutes: 5
});
const MANUAL_FULL_BOOTSTRAP_TIME_MIN = '2009-01-01T00:00:00Z';
const GOOGLE_REMOTE_MISSING_QUARANTINE_MINUTES = 10;
const GOOGLE_REMOTE_MISSING_QUARANTINE_MS = GOOGLE_REMOTE_MISSING_QUARANTINE_MINUTES * 60 * 1000;
const GOOGLE_SYNC_TOKEN_STORAGE_PREFIX = 'google.sync.nextSyncToken.';
const GOOGLE_SYNC_TOKEN_STORAGE_LEGACY_KEY = 'google.sync.nextSyncToken';

function getGoogleSyncTokenStorageKey(calendarId = 'primary') {
  const normalized = normalizeGoogleCalendarId(calendarId, 'primary');
  return `${GOOGLE_SYNC_TOKEN_STORAGE_PREFIX}${encodeURIComponent(normalized)}`;
}

function readStoredGoogleSyncToken(calendarId = 'primary') {
  const normalized = normalizeGoogleCalendarId(calendarId, 'primary');
  const key = getGoogleSyncTokenStorageKey(normalized);
  try {
    const current = String(localStorage.getItem(key) || '').trim();
    if (current) return current;
    if (!isPrimaryCalendarId(normalized)) return null;
    const legacy = String(localStorage.getItem(GOOGLE_SYNC_TOKEN_STORAGE_LEGACY_KEY) || '').trim();
    return legacy || null;
  } catch (err) {
    void err;
    return null;
  }
}

function saveStoredGoogleSyncToken(calendarId = 'primary', nextSyncToken = null) {
  const normalized = normalizeGoogleCalendarId(calendarId, 'primary');
  const key = getGoogleSyncTokenStorageKey(normalized);
  const clean = String(nextSyncToken || '').trim();
  try {
    if (!clean) {
      localStorage.removeItem(key);
      if (isPrimaryCalendarId(normalized)) {
        localStorage.removeItem(GOOGLE_SYNC_TOKEN_STORAGE_LEGACY_KEY);
      }
      return null;
    }
    localStorage.setItem(key, clean);
    if (isPrimaryCalendarId(normalized)) {
      localStorage.setItem(GOOGLE_SYNC_TOKEN_STORAGE_LEGACY_KEY, clean);
    }
    return clean;
  } catch (err) {
    void err;
    return clean || null;
  }
}

function clearStoredGoogleSyncToken(calendarId = 'primary') {
  const normalized = normalizeGoogleCalendarId(calendarId, 'primary');
  const key = getGoogleSyncTokenStorageKey(normalized);
  try {
    localStorage.removeItem(key);
    if (isPrimaryCalendarId(normalized)) {
      localStorage.removeItem(GOOGLE_SYNC_TOKEN_STORAGE_LEGACY_KEY);
    }
  } catch (err) {
    void err;
  }
}

function createGoogleSyncTokenExpiredError(calendarId = 'primary', detail = '') {
  const err = new Error('GOOGLE_SYNC_TOKEN_EXPIRED_410');
  err.code = 'GOOGLE_SYNC_TOKEN_EXPIRED_410';
  err.status = 410;
  err.calendarId = normalizeGoogleCalendarId(calendarId, 'primary');
  err.detail = String(detail || '').trim();
  return err;
}

function isGoogleSyncTokenExpiredError(err) {
  if (!err) return false;
  return err.code === 'GOOGLE_SYNC_TOKEN_EXPIRED_410'
    || Number(err.status || 0) === 410;
}

function resolveAutoSyncEnabled() {
  const raw = localStorage.getItem('autoSync.enabled');
  if (raw === null) return true;
  return raw === '1';
}

function syncLog(event, payload = {}, level = 'info') {
  if (typeof MODULE_UTILS.structuredLog === 'function') {
    MODULE_UTILS.structuredLog('sync', event, payload, level);
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...payload
  };
  const line = `[SYNC] ${JSON.stringify(entry)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

function logGoogleLinkColumnsUnified() {
  if (_googleLinkColumnsUnifiedLogged) return;
  _googleLinkColumnsUnifiedLogged = true;
  syncLog('google_link_columns_unified', {
    using: ['gcal_event_id', 'google_event_id']
  });
}

function createSyncAbortError(stage = 'unknown') {
  const err = new Error('SYNC_ABORTED');
  err.code = 'SYNC_ABORTED';
  err.stage = stage;
  return err;
}

function isSyncAbortError(err) {
  return err.code === 'SYNC_ABORTED' || err.message === 'SYNC_ABORTED';
}

function throwIfSyncAbortRequested(stage = 'unknown') {
  if (!_syncAbortRequested) return;
  syncLog('sync_aborted_checkpoint', { stage }, 'warn');
  throw createSyncAbortError(stage);
}

async function waitForGoogleSyncDrain({ timeoutMs = 5000, pollMs = 50 } = {}) {
  const started = Date.now();
  while (_googleSyncInFlight && (Date.now() - started) < timeoutMs) {
    await sleep(pollMs);
  }
  return !_googleSyncInFlight;
}

function pruneDeletedEventTombstones(nowMs = Date.now()) {
  for (const [eventId, ts] of _localDeletedEventTombstones.entries()) {
    if (!Number.isFinite(ts) || (nowMs - ts) > LOCAL_DELETE_TOMBSTONE_TTL_MS) {
      _localDeletedEventTombstones.delete(eventId);
    }
  }
}

function markEventDeletedTombstone(eventId, atMs = Date.now()) {
  if (!eventId) return;
  pruneDeletedEventTombstones(atMs);
  _localDeletedEventTombstones.set(String(eventId), atMs);
}

function clearEventDeletedTombstone(eventId) {
  if (!eventId) return;
  _localDeletedEventTombstones.delete(String(eventId));
}

function hasEventDeletedTombstone(eventId, nowMs = Date.now()) {
  if (!eventId) return false;
  pruneDeletedEventTombstones(nowMs);
  const ts = _localDeletedEventTombstones.get(String(eventId));
  return Number.isFinite(ts) && (nowMs - ts) <= LOCAL_DELETE_TOMBSTONE_TTL_MS;
}

async function withGoogleSyncLock(fn) {
  if (typeof fn !== 'function') {
    throw new Error('withGoogleSyncLock requiere una funcion');
  }
  if (_syncAbortRequested) {
    syncLog('lock_skipped', { reason: 'sync_abort_requested' }, 'warn');
    return { skipped: true, reason: 'sync_abort_requested' };
  }
  if (_googleSyncBlocked) {
    syncLog('lock_skipped', { reason: 'google_sync_blocked' }, 'warn');
    return { skipped: true, reason: 'google_sync_blocked' };
  }
  if (_googleSyncInFlight) {
    syncLog('lock_skipped', { reason: 'sync_in_flight' }, 'warn');
    return { skipped: true, reason: 'sync_in_flight' };
  }

  _googleSyncInFlight = true;
  const syncToken = Symbol('google_sync_write');
  try {
    setSyncStatus('syncing', { detail: 'Preparando sync' });
    await waitForWriteLockIdle({ timeoutMs: 12000, pollMs: 25 });
    await flushOutbox({ reason: 'before_google_sync', silent: true, force: true });
    _syncWriteBarrierActive = true;
    await waitForWriteLockIdle({ timeoutMs: 12000, pollMs: 25 });

    const prevSyncToken = _syncWriteLockToken;
    _syncWriteLockToken = syncToken;
    throwIfSyncAbortRequested('withGoogleSyncLock:before_fn');
    try {
      return await withWriteLock(
        () => fn(),
        {
          operation: 'google_sync_cycle',
          token: syncToken,
          source: 'sync'
        }
      );
    } finally {
      _syncWriteLockToken = prevSyncToken;
    }
  } finally {
    _syncWriteBarrierActive = false;
    _googleSyncInFlight = false;
    if (syncStatus.state === 'syncing') {
      setSyncStatusLastSuccess(Date.now());
    }
    await refreshSyncStatusOutboxCount();
  }
}
function assertGoogleSyncLockHeld(opName = 'google_sync_op') {
  if (_googleSyncInFlight) return;
  throw new Error(`Operacion Google Sync fuera de lock: ${opName}`);
}

async function seedGoogleTokenFromSupabaseSession() {
  if (_googleAccessToken) return _googleAccessToken;
  const supabase = getSupabaseClient?.();
  if (!supabase?.auth?.getSession) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    const providerToken = data?.session?.provider_token || null;
    if (providerToken) {
      _googleAccessToken = providerToken;
      setGoogleConnectedState(true);
    }
    return providerToken;
  } catch {
    return null;
  }
}

function isRemoteGoogleVersionNewer(remoteUpdated, localKnownUpdated) {
  if (typeof MODULE_SYNC_RECONCILE.isRemoteGoogleVersionNewer === 'function') {
    return MODULE_SYNC_RECONCILE.isRemoteGoogleVersionNewer(remoteUpdated, localKnownUpdated);
  }
  const remoteIso = safeISODateTime(remoteUpdated);
  const localIso = safeISODateTime(localKnownUpdated);
  if (!remoteIso) return false;
  if (!localIso) return true;
  return new Date(remoteIso).getTime() > new Date(localIso).getTime();
}

function hasRemoteVersionChanged(remoteUpdated, localKnownUpdated, remoteEtag, localKnownEtag) {
  if (typeof MODULE_SYNC_RECONCILE.hasRemoteVersionChanged === 'function') {
    return MODULE_SYNC_RECONCILE.hasRemoteVersionChanged(remoteUpdated, localKnownUpdated, remoteEtag, localKnownEtag);
  }
  if (isRemoteGoogleVersionNewer(remoteUpdated, localKnownUpdated)) return true;
  if (remoteEtag && localKnownEtag && String(remoteEtag) !== String(localKnownEtag)) return true;
  return false;
}

function shouldApplyGoogleOverLocal(localEvent, remoteUpdated, remoteEtag = null) {
  if (typeof MODULE_SYNC_RECONCILE.shouldApplyGoogleOverLocal === 'function') {
    return MODULE_SYNC_RECONCILE.shouldApplyGoogleOverLocal(localEvent, remoteUpdated, remoteEtag);
  }
  if (!localEvent) return true;
  if (!localEvent.needsGCalSync) return true;
  if (!localEvent.gcalUpdated && !localEvent.gcalEtag) return true;
  return hasRemoteVersionChanged(remoteUpdated, localEvent.gcalUpdated, remoteEtag, localEvent.gcalEtag);
}

function parseRemoteMissingAt(evt) {
  const iso = safeISODateTime(evt.remoteMissingAt || evt.remote_missing_at || null);
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : null;
}

function getUnifiedGoogleEventId(evt) {
  const fromGcalId = String(evt?.gcalId || '').trim();
  if (fromGcalId) return fromGcalId;
  const fromGoogleEventId = String(evt?.google_event_id || '').trim();
  if (fromGoogleEventId) return fromGoogleEventId;
  const fromLegacyGcalEventId = String(evt?.gcal_event_id || '').trim();
  if (fromLegacyGcalEventId) return fromLegacyGcalEventId;
  return null;
}

function hasGoogleLinkColumns(evt) {
  return !!String(evt?.gcal_event_id || '').trim()
    || !!String(evt?.google_event_id || '').trim();
}

function hasRemoteMissingQuarantineExpired(evt, nowMs = Date.now()) {
  if (!evt.remoteMissing && !evt.remote_missing) return false;
  const markedAt = parseRemoteMissingAt(evt);
  if (!markedAt) return false;
  return (nowMs - markedAt) >= GOOGLE_REMOTE_MISSING_QUARANTINE_MS;
}

function normalizeGoogleEventForSupabase(gev, existingEvent = null, calendarId = 'primary') {
  const existing = existingEvent || {};
  const notes = gcalDescToPlain(gev.description || '');
  const normalizedCalendarId = normalizeGoogleCalendarId(
    calendarId || existing.googleCalendarId || existing.google_calendar_id || 'primary',
    'primary'
  );

  let allDay = false;
  let startDate;
  let startTime;
  let endDate;
  let endTime;

  if (gev.start.date) {
    allDay = true;
    startDate = gev.start.date;
    endDate = gev.end.date ? addDaysISO(gev.end.date, -1) : startDate;
    startTime = '00:00';
    endTime = '23:59';
  } else if (gev.start.dateTime) {
    const sdt = new Date(gev.start.dateTime);
    const edt = gev.end.dateTime ? new Date(gev.end.dateTime) : new Date(sdt.getTime() + 60 * 60000);
    startDate = ymd(sdt);
    startTime = `${pad2(sdt.getHours())}:${pad2(sdt.getMinutes())}`;
    endDate = ymd(edt);
    endTime = `${pad2(edt.getHours())}:${pad2(edt.getMinutes())}`;
  } else {
    const sdt = new Date();
    const edt = new Date(sdt.getTime() + 60 * 60000);
    startDate = ymd(sdt);
    startTime = `${pad2(sdt.getHours())}:${pad2(sdt.getMinutes())}`;
    endDate = ymd(edt);
    endTime = `${pad2(edt.getHours())}:${pad2(edt.getMinutes())}`;
  }

  const baseSource = normalizeEventSource(existing.source, existing);
  const source = baseSource === 'local' ? 'local' : 'google';

  return {
    ...existing,
    id: existing.id || ensureUuidId(),
    title: String(gev.summary || '').trim(),
    location: String(gev.location || '').trim(),
    notes,
    allDay,
    startDate,
    startTime,
    endDate,
    endTime,
    date: startDate,
    time: allDay ? '00:00' : startTime,
    monthKey: startDate.slice(0, 7),
    category: existing.category || 'Citas',
    categoryOther: existing.categoryOther || '',
    client: existing.client || '',
    alert: existing.alert || 'none',
    repeat: existing.repeat || 'none',
    color: existing.color || '',
    url: existing.url || '',
    isHoliday: false,
    gcalId: gev.id,
    googleCalendarId: normalizedCalendarId,
    google_calendar_id: normalizedCalendarId,
    gcalUpdated: safeISODateTime(gev.updated) || null,
    gcalEtag: gev.etag || null,
    remoteMissing: false,
    remote_missing: false,
    remoteMissingAt: null,
    remote_missing_at: null,
    needsGCalSync: false,
    source,
    lastSyncedAt: safeISODateTime(gev.updated) || new Date().toISOString(),
    createdAt: existing.createdAt || Date.now()
  };
}

async function sbFetchLinkedGoogleEventsInRange({ fromISO = null, toISO = null, calendarId = null } = {}) {
  const ctx = await getReadDataContext();
  const targetCalendarId = calendarId ? normalizeGoogleCalendarId(calendarId, 'primary') : null;
  logGoogleLinkColumnsUnified();
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_linked_google_events_in_range',
    {
      filters: {
        user_id: ctx.userId,
        google_id_columns: ['gcal_event_id', 'google_event_id'],
        google_id_not_null_or: true,
        range_start: fromISO,
        range_end: toISO,
        google_calendar_id: targetCalendarId
      }
    },
    () => {
      let query = sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
      )
        .eq('user_id', ctx.userId);
      query = isMinimalEventProfile()
        ? query.not('gcal_event_id', 'is', null)
        : query.or('gcal_event_id.not.is.null,google_event_id.not.is.null');
      query = sbApplyRangeOverlap(query, { startISO: fromISO, endISO: toISO });
      return query.order('start_at', { ascending: true });
    }
  );
  if (error) throw error;
  const events = (data || []).map(supabaseRowToEvent);
  const filtered = targetCalendarId
    ? events.filter((evt) => getEventGoogleCalendarId(evt, 'primary') === targetCalendarId)
    : events;
  await cachePutEvents(filtered);
  return filtered;
}

async function sbGetSyncWatermark({ fallbackSinceISO = GOOGLE_SYNC_DEFAULTS.sinceISO, calendarId = null } = {}) {
  const ctx = await getReadDataContext();
  const watermarkColumn = getEventWatermarkColumnName();
  const targetCalendarId = calendarId ? normalizeGoogleCalendarId(calendarId, 'primary') : null;
  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'get_sync_watermark',
    {
      filters: {
        user_id: ctx.userId,
        watermark_column: watermarkColumn,
        google_calendar_id: targetCalendarId
      },
      params: { limit: 1 }
    },
    () => {
      const col = getEventWatermarkColumnName();
      let query = ctx.supabase
        .from(SB_TABLES.events)
        .select(col)
        .eq('user_id', ctx.userId)
        .not(col, 'is', null);

      if (targetCalendarId && !isMinimalEventProfile()) {
        if (isPrimaryCalendarId(targetCalendarId)) {
          query = query.or('google_calendar_id.eq.primary,google_calendar_id.is.null');
        } else {
          query = query.eq('google_calendar_id', targetCalendarId);
        }
      }

      return query.order(col, { ascending: false })
        .limit(1)
        .maybeSingle();
    }
  );
  if (error) throw error;

  const col = getEventWatermarkColumnName();
  const maxLastSyncedAt = data?.[col] || null;
  if (!maxLastSyncedAt) {
    return {
      bootstrap: true,
      maxLastSyncedAt: null,
      updatedMinISO: safeISODateTime(fallbackSinceISO) || GOOGLE_SYNC_DEFAULTS.sinceISO
    };
  }

  // Restamos 1s para evitar huecos por igualdad exacta de timestamp entre sesiones.
  const dt = new Date(maxLastSyncedAt);
  dt.setSeconds(dt.getSeconds() - 1);

  return {
    bootstrap: false,
    maxLastSyncedAt: safeISODateTime(maxLastSyncedAt),
    updatedMinISO: dt.toISOString()
  };
}

async function sbCountEventsWithGoogleLink() {
  const ctx = await getReadDataContext();
  logGoogleLinkColumnsUnified();
  const { count, error } = await runSupabaseCallWithLogging({
    ctx,
    tableName: SB_TABLES.events,
    operation: 'count_events_with_google_link',
    meta: {
      filters: {
        user_id: ctx.userId,
        google_id_columns: ['gcal_event_id', 'google_event_id'],
        google_id_not_null_or: true
      },
      params: {
        head: true,
        count: 'exact'
      }
    },
    execute: () => ctx.supabase
      .from(SB_TABLES.events)
      .select('id', { count: 'exact', head: true })
      .eq('user_id', ctx.userId)
      .or('gcal_event_id.not.is.null,google_event_id.not.is.null')
  });
  if (error && isSupabaseSchemaMismatchError(error)) {
    const fallbackCol = getGoogleEventIdColumnName();
    const fallback = await runSupabaseCallWithLogging({
      ctx,
      tableName: SB_TABLES.events,
      operation: 'count_events_with_google_link_fallback',
      meta: {
        filters: {
          user_id: ctx.userId,
          google_id_column: fallbackCol,
          reason: 'schema_mismatch_dual_google_columns'
        },
        params: {
          head: true,
          count: 'exact'
        }
      },
      execute: () => ctx.supabase
        .from(SB_TABLES.events)
        .select('id', { count: 'exact', head: true })
        .eq('user_id', ctx.userId)
        .not(fallbackCol, 'is', null)
    });
    if (fallback.error) throw fallback.error;
    return Number.isFinite(Number(fallback.count)) ? Number(fallback.count) : 0;
  }
  if (error) throw error;
  return Number.isFinite(Number(count)) ? Number(count) : 0;
}

async function sbFetchEventsPendingGooglePush({ calendarId = null } = {}) {
  const ctx = await getReadDataContext();
  const targetCalendarId = calendarId ? normalizeGoogleCalendarId(calendarId, 'primary') : null;

  const { data, error } = await runEventSelectWithProfileFallback(
    ctx,
    'fetch_events_pending_google_push',
    {
      filters: {
        user_id: ctx.userId,
        needs_gcal_sync: true,
        non_holiday_field: isMinimalEventProfile() ? 'category' : 'source',
        google_calendar_id: targetCalendarId
      }
    },
    () => {
      let query = sbSelectEventColumns(ctx.supabase
        .from(SB_TABLES.events)
      )
        .eq('user_id', ctx.userId)
        .eq('needs_gcal_sync', true);
      query = isMinimalEventProfile()
        ? query.neq('category', 'Festivo')
        : query.neq('source', 'holiday');
      return query.order('updated_at', { ascending: true });
    }
  );
  if (error) throw error;
  const events = (data || []).map(supabaseRowToEvent);
  const filtered = targetCalendarId
    ? events.filter((evt) => getEventGoogleCalendarId(evt, 'primary') === targetCalendarId)
    : events;
  await cachePutEvents(filtered);
  return filtered;
}

async function revalidateLocalEventBeforeGooglePush(localEvent) {
  const localEventId = localEvent.id || null;
  if (!localEventId) return null;

  if (hasEventDeletedTombstone(localEventId)) {
    syncLog('push_skip_deleted_tombstone', { localEventId });
    return null;
  }

  const latest = await sbFetchEventById(localEventId);
  if (!latest) {
    markEventDeletedTombstone(localEventId);
    syncLog('push_skip_deleted_revalidated', { localEventId }, 'warn');
    return null;
  }

  if (hasEventDeletedTombstone(localEventId)) {
    syncLog('push_skip_deleted_tombstone_after_fetch', { localEventId });
    return null;
  }

  return latest;
}

async function fetchGoogleEventsWindow({
  calendarId = 'primary',
  sinceISO = GOOGLE_SYNC_DEFAULTS.sinceISO,
  horizonYears = GOOGLE_SYNC_DEFAULTS.horizonYears,
  interactive = false,
  forceBootstrap = false,
  ignoreWatermark = false,
  modeOverride = null
} = {}) {
  assertGoogleSyncLockHeld('fetchGoogleEventsWindow');
  throwIfSyncAbortRequested('fetchGoogleEventsWindow:start');
  await ensureGoogleToken({ interactive });
  throwIfSyncAbortRequested('fetchGoogleEventsWindow:after_token');

  const normalizedCalendarId = normalizeGoogleCalendarId(calendarId, 'primary');
  const shouldIgnoreWatermark = forceBootstrap || ignoreWatermark;
  const watermark = shouldIgnoreWatermark
    ? {
      bootstrap: true,
      maxLastSyncedAt: null,
      updatedMinISO: safeISODateTime(sinceISO) || GOOGLE_SYNC_DEFAULTS.sinceISO
    }
    : await sbGetSyncWatermark({
      fallbackSinceISO: sinceISO,
      calendarId: normalizedCalendarId
    });
  const storedSyncToken = shouldIgnoreWatermark
    ? null
    : readStoredGoogleSyncToken(normalizedCalendarId);
  const useStoredSyncToken = Boolean(storedSyncToken) && !watermark.bootstrap;
  throwIfSyncAbortRequested('fetchGoogleEventsWindow:after_watermark');
  const tm = new Date();
  tm.setFullYear(tm.getFullYear() + horizonYears);
  const bootstrapTimeMaxISO = shouldIgnoreWatermark ? null : tm.toISOString();
  const mode = String(modeOverride || '').trim() || (forceBootstrap
    ? 'bootstrap_full_import'
    : (useStoredSyncToken
      ? 'incremental_syncToken'
      : (watermark.bootstrap ? 'bootstrap_full' : 'incremental_updatedMin')));

  syncLog('pull_request', {
    mode,
    calendarId: normalizedCalendarId,
    syncTokenUsed: useStoredSyncToken,
    updatedMin: watermark.updatedMinISO,
    maxLastSyncedAt: watermark.maxLastSyncedAt,
    timeMin: sinceISO,
    timeMax: watermark.bootstrap ? bootstrapTimeMaxISO : null
  });

  let pageToken = null;
  const items = [];
  let nextSyncToken = null;

  do {
    throwIfSyncAbortRequested('fetchGoogleEventsWindow:before_page_build');
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(normalizedCalendarId)}/events`);
    if (useStoredSyncToken) {
      url.searchParams.set('syncToken', storedSyncToken);
    } else if (watermark.bootstrap) {
      url.searchParams.set('timeMin', sinceISO);
      if (bootstrapTimeMaxISO) {
        url.searchParams.set('timeMax', bootstrapTimeMaxISO);
      }
      url.searchParams.set('orderBy', 'startTime');
    } else {
      url.searchParams.set('updatedMin', watermark.updatedMinISO);
    }
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('showDeleted', 'true');
    url.searchParams.set('maxResults', '2500');
    url.searchParams.set(
      'fields',
      'items(id,etag,status,summary,location,description,start,end,updated,attachments(fileId,title,mimeType)),nextPageToken,nextSyncToken'
    );
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    throwIfSyncAbortRequested('fetchGoogleEventsWindow:before_page_fetch');
    const res = await gapiFetch(url.toString());
    throwIfSyncAbortRequested('fetchGoogleEventsWindow:after_page_fetch');
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (res.status === 410 && useStoredSyncToken) {
        throw createGoogleSyncTokenExpiredError(normalizedCalendarId, errText);
      }
      const shortErr = String(errText || '').trim().slice(0, 300);
      throw new Error(shortErr ? `Calendar API error ${res.status}: ${shortErr}` : `Calendar API error ${res.status}`);
    }
    const data = await res.json();
    throwIfSyncAbortRequested('fetchGoogleEventsWindow:after_page_json');
    items.push(...(data.items || []));
    const candidateSyncToken = String(data.nextSyncToken || '').trim();
    if (candidateSyncToken) nextSyncToken = candidateSyncToken;
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  if (nextSyncToken) {
    saveStoredGoogleSyncToken(normalizedCalendarId, nextSyncToken);
  }

  syncLog('pull_response', {
    mode,
    calendarId: normalizedCalendarId,
    totalItems: items.length,
    syncTokenUsed: useStoredSyncToken,
    nextSyncTokenStored: !!nextSyncToken
  });

  return {
    items,
    timeMaxISO: bootstrapTimeMaxISO,
    sinceISO,
    calendarId: normalizedCalendarId,
    mode,
    updatedMinISO: watermark.updatedMinISO,
    maxLastSyncedAt: watermark.maxLastSyncedAt,
    bootstrap: watermark.bootstrap,
    usedSyncToken: useStoredSyncToken,
    nextSyncToken
  };
}

async function fetchGoogleEventById(eventId, { calendarId = 'primary', allowNotFound = false } = {}) {
  assertGoogleSyncLockHeld('fetchGoogleEventById');
  throwIfSyncAbortRequested('fetchGoogleEventById:start');
  const normalizedCalendarId = normalizeGoogleCalendarId(calendarId, 'primary');
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(normalizedCalendarId)}/events/${encodeURIComponent(eventId)}?supportsAttachments=true&fields=id,etag,status,summary,location,description,start,end,updated,attachments(fileId,title,mimeType)`;
  const res = await gapiFetch(url);
  throwIfSyncAbortRequested('fetchGoogleEventById:after_fetch');
  if (allowNotFound && res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Calendar API error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  throwIfSyncAbortRequested('fetchGoogleEventById:after_json');
  return json;
}

async function syncGoogleAttachmentsToSupabase(eventId, remoteAttachments = []) {
  assertGoogleSyncLockHeld('syncGoogleAttachmentsToSupabase');
  throwIfSyncAbortRequested('syncGoogleAttachmentsToSupabase:start');
  if (!Array.isArray(remoteAttachments) || !remoteAttachments.length) return 0;
  const toDownload = remoteAttachments.filter((a) => a.fileId);
  if (!toDownload.length) return 0;

  let attsSaved = 0;
  await mapLimit(toDownload, 3, async (a) => {
    throwIfSyncAbortRequested('syncGoogleAttachmentsToSupabase:before_download');
    const blobFile = await downloadDriveBlob(a.fileId);
    throwIfSyncAbortRequested('syncGoogleAttachmentsToSupabase:after_download');
    if (!blobFile) return;
    const name = blobFile.name || a.title || 'archivo';
    const mime = blobFile.type || a.mimeType || 'application/octet-stream';
    throwIfSyncAbortRequested('syncGoogleAttachmentsToSupabase:before_save_blob');
    const ok = await saveAttachmentBlob(eventId, name, mime, blobFile, a.fileId, {
      source: 'sync',
      writeLockToken: _syncWriteLockToken
    });
    throwIfSyncAbortRequested('syncGoogleAttachmentsToSupabase:after_save_blob');
    if (ok) attsSaved++;
  });
  return attsSaved;
}

// Pull interno Google -> normalizacion -> Supabase (con reconciliacion).
async function importAllFromGoogleUnlocked({
  calendarId = 'primary',
  sinceISO = GOOGLE_SYNC_DEFAULTS.sinceISO,
  horizonYears = GOOGLE_SYNC_DEFAULTS.horizonYears,
  onProgress,
  interactive = false,
  forceBootstrap = false,
  allowDeletes = true,
  ignoreWatermark = false,
  modeOverride = null
} = {}) {
  assertGoogleSyncLockHeld('importAllFromGoogle');
  throwIfSyncAbortRequested('importAllFromGoogle:start');
  const normalizedCalendarId = normalizeGoogleCalendarId(calendarId, 'primary');
  let pull;
  let recoveredFromSyncToken410 = false;
  try {
    pull = await fetchGoogleEventsWindow({
      calendarId: normalizedCalendarId,
      sinceISO,
      horizonYears,
      interactive,
      forceBootstrap,
      ignoreWatermark,
      modeOverride
    });
  } catch (err) {
    if (!isGoogleSyncTokenExpiredError(err)) throw err;
    syncLog('pull_410_sync_token_recovery_start', {
      calendarId: normalizedCalendarId,
      mode: modeOverride || null,
      detail: String(err.detail || err.message || '').slice(0, 300)
    }, 'warn');
    clearStoredGoogleSyncToken(normalizedCalendarId);
    try {
      pull = await fetchGoogleEventsWindow({
        calendarId: normalizedCalendarId,
        sinceISO,
        horizonYears,
        interactive,
        forceBootstrap: true,
        ignoreWatermark: true,
        modeOverride: 'recovery_full_after_410'
      });
      recoveredFromSyncToken410 = true;
      syncLog('pull_410_sync_token_recovery_success', {
        calendarId: normalizedCalendarId,
        mode: pull.mode,
        nextSyncTokenStored: !!pull.nextSyncToken,
        incomingItems: Array.isArray(pull.items) ? pull.items.length : 0
      }, 'warn');
    } catch (recoveryErr) {
      syncLog('pull_410_sync_token_recovery_failed', {
        calendarId: normalizedCalendarId,
        error: recoveryErr.message || String(recoveryErr)
      }, 'error');
      throw recoveryErr;
    }
  }
  throwIfSyncAbortRequested('importAllFromGoogle:after_pull_fetch');
  const {
    items,
    mode,
    updatedMinISO,
    maxLastSyncedAt,
    bootstrap,
    usedSyncToken,
    nextSyncToken
  } = pull;

  const linkedLocal = await sbFetchLinkedGoogleEventsInRange({ calendarId: normalizedCalendarId });
  throwIfSyncAbortRequested('importAllFromGoogle:after_local_linked_fetch');
  const localByGoogleId = new Map();
  for (const evt of linkedLocal) {
    const unifiedGoogleId = getUnifiedGoogleEventId(evt);
    if (unifiedGoogleId) localByGoogleId.set(unifiedGoogleId, evt);
  }
  const knownLinkedLocal = linkedLocal.filter((evt) => hasGoogleLinkColumns(evt)).length;
  let imported = 0;
  let updated = 0;
  let deleted = 0;
  let skippedDirty = 0;
  let conflictsResolvedByGoogle = 0;
  let attsSaved = 0;

  syncLog('pull_apply_start', {
    calendarId: normalizedCalendarId,
    mode,
    updatedMin: updatedMinISO,
    maxLastSyncedAt,
    bootstrap,
    syncTokenUsed: !!usedSyncToken,
    recoveredFromSyncToken410,
    nextSyncTokenStored: !!nextSyncToken,
    incomingItems: items.length,
    knownLinkedLocal
  });

  for (const remoteEvent of items) {
    throwIfSyncAbortRequested('importAllFromGoogle:loop_start');
    const remoteId = remoteEvent.id;
    if (!remoteId) continue;

    if (remoteEvent.status === 'cancelled') {
      if (!allowDeletes) {
        onProgress?.({ imported, updated, deleted, skippedDirty, conflictsResolvedByGoogle, attsSaved });
        continue;
      }
      const localCancelled = localByGoogleId.get(remoteId);
      if (localCancelled) {
        throwIfSyncAbortRequested('importAllFromGoogle:before_delete_cancelled');
        await sbDeleteEventById(localCancelled.id, { source: 'sync', writeLockToken: _syncWriteLockToken });
        throwIfSyncAbortRequested('importAllFromGoogle:after_delete_cancelled');
        localByGoogleId.delete(remoteId);
        deleted++;
        syncLog('pull_delete_remote_cancelled', {
          googleEventId: remoteId,
          localEventId: localCancelled.id
        });
      }
      onProgress?.({ imported, updated, deleted, skippedDirty, conflictsResolvedByGoogle, attsSaved });
      continue;
    }

    const existing = localByGoogleId.get(remoteId) || null;
    if (!shouldApplyGoogleOverLocal(existing, remoteEvent.updated || null, remoteEvent.etag || null)) {
      skippedDirty++;
      syncLog('pull_skip_local_dirty', {
        googleEventId: remoteId,
        localEventId: existing?.id || null,
        remoteUpdated: remoteEvent.updated || null
      });
      onProgress?.({ imported, updated, deleted, skippedDirty, conflictsResolvedByGoogle, attsSaved });
      continue;
    }

    if (existing?.needsGCalSync && hasRemoteVersionChanged(
      remoteEvent.updated || null,
      existing.gcalUpdated || null,
      remoteEvent.etag || null,
      existing.gcalEtag || null
    )) {
      conflictsResolvedByGoogle++;
      syncLog('pull_conflict_google_wins', {
        googleEventId: remoteId,
        localEventId: existing.id
      });
    }

    const normalized = normalizeGoogleEventForSupabase(remoteEvent, existing, normalizedCalendarId);
    throwIfSyncAbortRequested('importAllFromGoogle:before_upsert');
    const savedEvent = await sbUpsertEvent(normalized, { actor: 'google' });
    throwIfSyncAbortRequested('importAllFromGoogle:after_upsert');
    localByGoogleId.set(remoteId, savedEvent);

    if (existing) updated++;
    else imported++;

    if (Array.isArray(remoteEvent.attachments) && remoteEvent.attachments.length) {
      throwIfSyncAbortRequested('importAllFromGoogle:before_attachment_sync');
      attsSaved += await syncGoogleAttachmentsToSupabase(savedEvent.id, remoteEvent.attachments);
      throwIfSyncAbortRequested('importAllFromGoogle:after_attachment_sync');
    }

    onProgress?.({ imported, updated, deleted, skippedDirty, conflictsResolvedByGoogle, attsSaved });
  }
  syncLog('pull_apply_complete', {
    calendarId: normalizedCalendarId,
    mode,
    imported,
    updated,
    deleted,
    skippedDirty,
    conflictsResolvedByGoogle,
    attsSaved
  });
  return { imported, updated, deleted, skippedDirty, conflictsResolvedByGoogle, attsSaved };
}

async function importAllFromGoogle(options = {}) {
  try {
    return await withGoogleSyncLock(async () => {
      const requestedCalendarId = options?.calendarId ? normalizeGoogleCalendarId(options.calendarId, 'primary') : null;
      if (requestedCalendarId) {
        return importAllFromGoogleUnlocked({
          ...options,
          calendarId: requestedCalendarId
        });
      }

      const calendars = await listWritableGoogleCalendars({ interactive: !!options?.interactive });
      const merged = createEmptyPullStats();
      for (const calendar of calendars) {
        throwIfSyncAbortRequested(`importAllFromGoogle:before_calendar_${calendar.id}`);
        const stats = await importAllFromGoogleUnlocked({
          ...options,
          calendarId: calendar.id
        });
        mergePullStats(merged, stats);
      }
      return merged;
    });
  } catch (err) {
    if (isSyncAbortError(err)) {
      syncLog('pull_aborted', { reason: 'logout_or_abort', stage: err.stage || null }, 'warn');
      return { aborted: true, reason: 'sync_aborted' };
    }
    throw err;
  }
}

// Resolucion unica de drive_file_id para adjuntos antes de push a Google.
async function ensureDriveIdsForEventAttachments(localEventId) {
  assertGoogleSyncLockHeld('ensureDriveIdsForEventAttachments');
  throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:start');
  const atts = await getAttachmentsByEvent(localEventId);
  throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:after_fetch_attachments');
  const out = [];

  for (const a of atts) {
    throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:loop_start');
    let driveId = String(a.gdriveId || a.drive_file_id || '').trim();
    if (!driveId && a.blob) {
      throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:before_drive_upload');
      const up = await driveUploadMultipart(a.blob, {
        name: a.name || a.file_name || 'archivo',
        mimeType: a.type || a.file_type || 'application/octet-stream'
      });
      driveId = String(up.id || '').trim();
      throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:after_drive_upload');
    }

    if (!driveId) continue;

    const updatedAtt = {
      ...a,
      gdriveId: driveId,
      drive_file_id: driveId
    };

    throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:before_attachment_cache');
    await cachePutAttachments([updatedAtt]);
    throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:before_attachment_upsert');
    await sbUpsertAttachmentWithRetry(updatedAtt, localEventId, {
      attempts: 2,
      context: 'guardar id de Drive en Supabase',
      source: 'sync',
      writeLockToken: _syncWriteLockToken
    });
    throwIfSyncAbortRequested('ensureDriveIdsForEventAttachments:after_attachment_upsert');

    out.push({
      fileId: driveId,
      title: updatedAtt.name || updatedAtt.file_name || 'archivo',
      mimeType: updatedAtt.type || updatedAtt.file_type || 'application/octet-stream'
    });
  }

  return out;
}

async function handleRemoteMissingEventQuarantine(localEvent, googleEventId, contextTag) {
  assertGoogleSyncLockHeld('handleRemoteMissingEventQuarantine');
  throwIfSyncAbortRequested('handleRemoteMissingEventQuarantine:start');
  const nowMs = Date.now();
  const markedAtMs = parseRemoteMissingAt(localEvent);
  const ageMinutes = markedAtMs ? Math.floor((nowMs - markedAtMs) / 60000) : 0;

  if (hasRemoteMissingQuarantineExpired(localEvent, nowMs)) {
    throwIfSyncAbortRequested('handleRemoteMissingEventQuarantine:before_delete');
    await sbDeleteEventById(localEvent.id, { source: 'sync', writeLockToken: _syncWriteLockToken });
    throwIfSyncAbortRequested('handleRemoteMissingEventQuarantine:after_delete');
    syncLog('remote_missing_deleted_after_quarantine', {
      context: contextTag,
      localEventId: localEvent.id,
      googleEventId,
      quarantineMinutes: ageMinutes
    }, 'warn');
    return {
      deletedLocally: true,
      reason: 'remote_missing_quarantine_expired',
      quarantineMinutes: ageMinutes
    };
  }

  const markedAtISO = markedAtMs
    ? new Date(markedAtMs).toISOString()
    : new Date(nowMs).toISOString();

  throwIfSyncAbortRequested('handleRemoteMissingEventQuarantine:before_upsert');
  const saved = await sbUpsertEvent({
    ...localEvent,
    remoteMissing: true,
    remote_missing: true,
    remoteMissingAt: markedAtISO,
    remote_missing_at: markedAtISO,
    needsGCalSync: true
  }, { actor: 'google' });
  throwIfSyncAbortRequested('handleRemoteMissingEventQuarantine:after_upsert');

  syncLog(markedAtMs ? 'remote_missing_quarantine_pending' : 'remote_missing_quarantine_started', {
    context: contextTag,
    localEventId: localEvent.id,
    googleEventId,
    quarantineMinutes: ageMinutes,
    deleteAfterMinutes: GOOGLE_REMOTE_MISSING_QUARANTINE_MINUTES
  }, 'warn');

  return {
    deletedLocally: false,
    quarantined: true,
    reason: 'remote_missing_quarantine',
    quarantineMinutes: ageMinutes,
    deleteAfterMinutes: GOOGLE_REMOTE_MISSING_QUARANTINE_MINUTES,
    saved
  };
}

// Push unico de un evento local a Google respetando reglas de conflicto.
async function pushEventToGCal(localEvent, calendarId = 'primary') {
  assertGoogleSyncLockHeld('pushEventToGCal');
  throwIfSyncAbortRequested('pushEventToGCal:start');
  const localEventId = localEvent.id || null;
  if (localEventId && hasEventDeletedTombstone(localEventId)) {
    return { deletedLocally: true, reason: 'local_tombstone_before_push' };
  }
  if (localEventId) {
    const latest = await sbFetchEventById(localEventId);
    if (!latest) {
      markEventDeletedTombstone(localEventId);
      return { deletedLocally: true, reason: 'local_deleted_before_push' };
    }
    localEvent = latest;
  }
  await ensureGoogleToken({ interactive: false });
  throwIfSyncAbortRequested('pushEventToGCal:after_token');

  const targetCalendarId = normalizeGoogleCalendarId(
    calendarId || getEventGoogleCalendarId(localEvent, 'primary'),
    'primary'
  );
  const existingId = getRemoteIdForEvent(localEvent);

  if (existingId) {
    throwIfSyncAbortRequested('pushEventToGCal:before_remote_fetch');
    const remote = await fetchGoogleEventById(existingId, { calendarId: targetCalendarId, allowNotFound: true });
    throwIfSyncAbortRequested('pushEventToGCal:after_remote_fetch');
    if (!remote) {
      return handleRemoteMissingEventQuarantine(localEvent, existingId, 'fetch_by_id_404');
    }

    if (hasRemoteVersionChanged(
      remote.updated || null,
      localEvent.gcalUpdated || null,
      remote.etag || null,
      localEvent.gcalEtag || null
    )) {
      const winner = normalizeGoogleEventForSupabase(remote, localEvent, targetCalendarId);
      throwIfSyncAbortRequested('pushEventToGCal:before_conflict_upsert');
      const saved = await sbUpsertEvent(winner, { actor: 'google' });
      throwIfSyncAbortRequested('pushEventToGCal:after_conflict_upsert');
      syncLog('push_conflict_google_wins', {
        localEventId: localEvent.id,
        googleEventId: existingId
      }, 'warn');
      return { conflictResolvedByGoogle: true, saved };
    }
  }

  const urlBase = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`;
  throwIfSyncAbortRequested('pushEventToGCal:before_ensure_drive_ids');
  const attachments = await ensureDriveIdsForEventAttachments(localEvent.id);
  throwIfSyncAbortRequested('pushEventToGCal:after_ensure_drive_ids');
  const payload = {
    ...toGCalPayload(localEvent),
    ...(attachments.length ? { attachments } : {})
  };

  let res;
  if (existingId) {
    throwIfSyncAbortRequested('pushEventToGCal:before_patch');
    res = await gapiFetch(`${urlBase}/${encodeURIComponent(existingId)}?supportsAttachments=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    throwIfSyncAbortRequested('pushEventToGCal:after_patch');
    if (res.status === 404) {
      return handleRemoteMissingEventQuarantine(localEvent, existingId, 'patch_404');
    }
  } else {
    throwIfSyncAbortRequested('pushEventToGCal:before_post');
    res = await gapiFetch(`${urlBase}?supportsAttachments=true&sendUpdates=none`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    throwIfSyncAbortRequested('pushEventToGCal:after_post');
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Error Google ${res.status}: ${txt}`);
  }

  const remoteSaved = await res.json();
  throwIfSyncAbortRequested('pushEventToGCal:after_response_json');
  const source = normalizeEventSource(localEvent.source, localEvent);
  throwIfSyncAbortRequested('pushEventToGCal:before_final_upsert');
  const saved = await sbUpsertEvent({
    ...localEvent,
    gcalId: remoteSaved.id,
    googleCalendarId: targetCalendarId,
    gcalUpdated: safeISODateTime(remoteSaved.updated) || localEvent.gcalUpdated || null,
    gcalEtag: remoteSaved.etag || localEvent.gcalEtag || null,
    remoteMissing: false,
    remote_missing: false,
    remoteMissingAt: null,
    remote_missing_at: null,
    needsGCalSync: false,
    source: source === 'holiday' ? 'holiday' : source,
    lastSyncedAt: safeISODateTime(remoteSaved.updated) || new Date().toISOString()
  }, { actor: 'google' });
  throwIfSyncAbortRequested('pushEventToGCal:after_final_upsert');

  return {
    created: !existingId,
    updated: !!existingId,
    conflictResolvedByGoogle: false,
    deletedLocally: false,
    saved
  };
}

// Push interno en lote de eventos locales pendientes hacia Google.
async function pushAllDirtyToGoogleUnlocked({
  calendarId = 'primary',
  quiet = false,
  interactive = false
} = {}) {
  assertGoogleSyncLockHeld('pushAllDirtyToGoogle');
  throwIfSyncAbortRequested('pushAllDirtyToGoogle:start');
  await ensureGoogleToken({ interactive });
  throwIfSyncAbortRequested('pushAllDirtyToGoogle:after_token');
  const targetCalendarId = normalizeGoogleCalendarId(calendarId, 'primary');
  const dirty = await sbFetchEventsPendingGooglePush({ calendarId: targetCalendarId });
  throwIfSyncAbortRequested('pushAllDirtyToGoogle:after_dirty_fetch');
  syncLog('push_start', { calendarId: targetCalendarId, pending: dirty.length });

  let created = 0;
  let updated = 0;
  let failed = 0;
  let deletedLocally = 0;
  let conflictsResolvedByGoogle = 0;

  for (const e of dirty) {
    throwIfSyncAbortRequested('pushAllDirtyToGoogle:loop_start');
    try {
      const candidate = await revalidateLocalEventBeforeGooglePush(e);
      if (!candidate) {
        deletedLocally++;
        continue;
      }
      const result = await pushEventToGCal(candidate, targetCalendarId);
      if (result.deletedLocally) {
        deletedLocally++;
        continue;
      }
      if (result.conflictResolvedByGoogle) {
        conflictsResolvedByGoogle++;
        continue;
      }
      if (result.created) created++;
      else updated++;
    } catch (err) {
      if (isSyncAbortError(err)) {
        syncLog('push_aborted', {
          stage: err.stage || null,
          localEventId: e.id || null
        }, 'warn');
        return { created, updated, failed, deletedLocally, conflictsResolvedByGoogle, aborted: true, reason: 'sync_aborted' };
      }
      failed++;
      syncLog('push_event_failed', {
        localEventId: e.id || null,
        error: err.message || String(err)
      }, 'error');
      console.warn('Fallo al subir evento a Google:', e.id, err);
    }
  }

  if (!quiet && (created || updated || failed || deletedLocally || conflictsResolvedByGoogle)) {
    showToast(
      `Google sync: ${created} creados - ${updated} actualizados` +
      `${deletedLocally ? ` - ${deletedLocally} borrados por Google` : ''}` +
      `${conflictsResolvedByGoogle ? ` - ${conflictsResolvedByGoogle} conflictos (Google gana)` : ''}` +
      `${failed ? ` - ${failed} fallidos` : ''}`
    );
  }

  syncLog('push_complete', {
    calendarId: targetCalendarId,
    created,
    updated,
    failed,
    deletedLocally,
    conflictsResolvedByGoogle
  });

  return { created, updated, failed, deletedLocally, conflictsResolvedByGoogle };
}

async function pushAllDirtyToGoogle(options = {}) {
  try {
    return await withGoogleSyncLock(async () => {
      const requestedCalendarId = options?.calendarId ? normalizeGoogleCalendarId(options.calendarId, 'primary') : null;
      if (requestedCalendarId) {
        return pushAllDirtyToGoogleUnlocked({
          ...options,
          calendarId: requestedCalendarId
        });
      }

      const calendars = await listWritableGoogleCalendars({ interactive: !!options?.interactive });
      const merged = createEmptyPushStats();
      for (const calendar of calendars) {
        throwIfSyncAbortRequested(`pushAllDirtyToGoogle:before_calendar_${calendar.id}`);
        const stats = await pushAllDirtyToGoogleUnlocked({
          ...options,
          calendarId: calendar.id,
          quiet: true
        });
        mergePushStats(merged, stats);
      }
      return merged;
    });
  } catch (err) {
    if (isSyncAbortError(err)) {
      syncLog('push_aborted', { reason: 'logout_or_abort', stage: err.stage || null }, 'warn');
      return { aborted: true, reason: 'sync_aborted' };
    }
    throw err;
  }
}

async function listWritableGoogleCalendars({ interactive = false } = {}) {
  assertGoogleSyncLockHeld('listWritableGoogleCalendars');
  throwIfSyncAbortRequested('listWritableGoogleCalendars:start');
  await ensureGoogleToken({ interactive });
  throwIfSyncAbortRequested('listWritableGoogleCalendars:after_token');

  let pageToken = null;
  const collected = [];
  do {
    throwIfSyncAbortRequested('listWritableGoogleCalendars:before_fetch');
    const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
    url.searchParams.set('maxResults', '250');
    url.searchParams.set('showHidden', 'false');
    url.searchParams.set('fields', 'items(id,summary,primary,accessRole),nextPageToken');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await gapiFetch(url.toString());
    throwIfSyncAbortRequested('listWritableGoogleCalendars:after_fetch');
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`CalendarList API error ${res.status}: ${txt}`);
    }
    const data = await res.json();
    throwIfSyncAbortRequested('listWritableGoogleCalendars:after_json');
    collected.push(...(Array.isArray(data?.items) ? data.items : []));
    pageToken = data?.nextPageToken || null;
  } while (pageToken);

  const writable = normalizeGoogleCalendarList(
    collected
      .filter((c) => c && (c.accessRole === 'owner' || c.accessRole === 'writer'))
      .map((c) => ({
        id: c.id,
        summary: c.summary,
        primary: !!c.primary
      }))
  );

  setGoogleCalendars(writable, { reason: 'calendars_detected', preserveFilters: true });
  syncLog('calendars_detected', {
    count: writable.length,
    calendars: writable.map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary }))
  });
  return writable;
}

function createEmptyPullStats() {
  return {
    imported: 0,
    updated: 0,
    deleted: 0,
    skippedDirty: 0,
    conflictsResolvedByGoogle: 0,
    attsSaved: 0
  };
}

function createEmptyPushStats() {
  return {
    created: 0,
    updated: 0,
    failed: 0,
    deletedLocally: 0,
    conflictsResolvedByGoogle: 0
  };
}

function mergePullStats(base, next) {
  const current = base || createEmptyPullStats();
  const incoming = next || {};
  current.imported += Number(incoming.imported || 0);
  current.updated += Number(incoming.updated || 0);
  current.deleted += Number(incoming.deleted || 0);
  current.skippedDirty += Number(incoming.skippedDirty || 0);
  current.conflictsResolvedByGoogle += Number(incoming.conflictsResolvedByGoogle || 0);
  current.attsSaved += Number(incoming.attsSaved || 0);
  return current;
}

function mergePushStats(base, next) {
  const current = base || createEmptyPushStats();
  const incoming = next || {};
  current.created += Number(incoming.created || 0);
  current.updated += Number(incoming.updated || 0);
  current.failed += Number(incoming.failed || 0);
  current.deletedLocally += Number(incoming.deletedLocally || 0);
  current.conflictsResolvedByGoogle += Number(incoming.conflictsResolvedByGoogle || 0);
  return current;
}

function normalizeRebindTitle(title) {
  return String(title || '').trim().toLowerCase();
}

function makeRebindMatchKey({ title = '', startISO = null, endISO = null } = {}) {
  const safeStart = safeISODateTime(startISO);
  const safeEnd = safeISODateTime(endISO);
  if (!safeStart || !safeEnd) return null;
  return `${normalizeRebindTitle(title)}|${safeStart}|${safeEnd}`;
}

function eventToRebindMatchKey(evt) {
  if (!evt) return null;
  return makeRebindMatchKey({
    title: evt.title || '',
    startISO: localPartsToISO(evt.startDate || evt.date, evt.startTime || evt.time || '00:00'),
    endISO: localPartsToISO(evt.endDate || evt.startDate || evt.date, evt.endTime || evt.startTime || evt.time || '00:00')
  });
}

async function fetchAllGoogleEventsForRebindCalendar(calendarId, { interactive = false } = {}) {
  assertGoogleSyncLockHeld('fetchAllGoogleEventsForRebindCalendar');
  const normalizedCalendarId = normalizeGoogleCalendarId(calendarId, 'primary');
  throwIfSyncAbortRequested('fetchAllGoogleEventsForRebindCalendar:start');
  await ensureGoogleToken({ interactive });
  throwIfSyncAbortRequested('fetchAllGoogleEventsForRebindCalendar:after_token');

  let pageToken = null;
  const items = [];

  do {
    throwIfSyncAbortRequested('fetchAllGoogleEventsForRebindCalendar:before_fetch');
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(normalizedCalendarId)}/events`);
    url.searchParams.set('timeMin', GOOGLE_SYNC_DEFAULTS.sinceISO);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('showDeleted', 'false');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '2500');
    url.searchParams.set('fields', 'items(id,summary,start,end,status),nextPageToken');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await gapiFetch(url.toString());
    throwIfSyncAbortRequested('fetchAllGoogleEventsForRebindCalendar:after_fetch');
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Calendar API error ${res.status}: ${txt}`);
    }
    const data = await res.json();
    throwIfSyncAbortRequested('fetchAllGoogleEventsForRebindCalendar:after_json');
    items.push(...(Array.isArray(data?.items) ? data.items : []));
    pageToken = data?.nextPageToken || null;
  } while (pageToken);

  return items.filter((item) => item && item.id && item.status !== 'cancelled');
}

async function rebindLocalEventsWithGoogle({ interactive = false } = {}) {
  return withGoogleSyncLock(async () => {
    assertGoogleSyncLockHeld('rebindLocalEventsWithGoogle');
    throwIfSyncAbortRequested('rebindLocalEventsWithGoogle:start');

    await ensureGoogleToken({ interactive });
    throwIfSyncAbortRequested('rebindLocalEventsWithGoogle:after_token');

    const calendars = await listWritableGoogleCalendars({ interactive });
    throwIfSyncAbortRequested('rebindLocalEventsWithGoogle:after_calendars');

    const ctx = await getReadDataContext();
    const remoteByKey = new Map();
    for (const calendar of calendars) {
      throwIfSyncAbortRequested(`rebindLocalEventsWithGoogle:before_calendar_${calendar.id}`);
      const remoteItems = await fetchAllGoogleEventsForRebindCalendar(calendar.id, { interactive });
      for (const remoteEvent of remoteItems) {
        const normalized = normalizeGoogleEventForSupabase(remoteEvent, null, calendar.id);
        const normalizedRow = eventToSupabaseRow(normalized, ctx.userId);
        const key = makeRebindMatchKey({
          title: normalizedRow.title,
          startISO: normalizedRow.start_at,
          endISO: normalizedRow.end_at
        });
        if (!key) continue;
        const bucket = remoteByKey.get(key) || [];
        bucket.push({
          googleEventId: remoteEvent.id,
          googleCalendarId: normalizeGoogleCalendarId(calendar.id, 'primary')
        });
        remoteByKey.set(key, bucket);
      }
    }

    const allLocalEvents = await sbFetchAllEvents();
    const existingLinkedGoogleIds = new Set(
      allLocalEvents
        .filter((evt) => !!getRemoteIdForEvent(evt))
        .map((evt) => getRemoteIdForEvent(evt))
    );

    const localUnlinkedEvents = await sbFetchUnlinkedEventsForRebind();
    let matched = 0;
    let unmatched = 0;

    for (const localEvent of localUnlinkedEvents) {
      throwIfSyncAbortRequested('rebindLocalEventsWithGoogle:loop_start');
      const key = eventToRebindMatchKey(localEvent);
      if (!key) {
        unmatched++;
        continue;
      }

      const candidates = remoteByKey.get(key) || [];
      if (candidates.length !== 1) {
        unmatched++;
        continue;
      }

      const remoteEntry = candidates[0];
      if (existingLinkedGoogleIds.has(remoteEntry.googleEventId)) {
        unmatched++;
        continue;
      }

      try {
        const saved = await sbRebindEventGoogleLinkById(
          localEvent.id,
          remoteEntry.googleEventId,
          remoteEntry.googleCalendarId
        );
        if (!saved) {
          unmatched++;
          continue;
        }
        existingLinkedGoogleIds.add(remoteEntry.googleEventId);
        matched++;
      } catch (err) {
        if (String(err?.code || '').trim() === '23505') {
          unmatched++;
          continue;
        }
        throw err;
      }
    }

    syncLog('rebind_complete', { matched, unmatched });
    reRender();
    return { matched, unmatched };
  });
}

async function syncSingleCalendar(calendarId, {
  interactive = false,
  quiet = true,
  sinceISO = GOOGLE_SYNC_DEFAULTS.sinceISO,
  horizonYears = GOOGLE_SYNC_DEFAULTS.horizonYears
} = {}) {
  assertGoogleSyncLockHeld('syncSingleCalendar');
  const normalizedCalendarId = normalizeGoogleCalendarId(calendarId, 'primary');
  syncLog('calendar_sync_start', { calendarId: normalizedCalendarId });
  throwIfSyncAbortRequested('syncSingleCalendar:before_pull');

  const pull = await importAllFromGoogleUnlocked({
    calendarId: normalizedCalendarId,
    sinceISO,
    horizonYears,
    interactive
  });

  throwIfSyncAbortRequested('syncSingleCalendar:before_push');
  const push = await pushAllDirtyToGoogleUnlocked({
    calendarId: normalizedCalendarId,
    quiet,
    interactive
  });

  syncLog('calendar_sync_complete', {
    calendarId: normalizedCalendarId,
    pull,
    push
  });
  return { calendarId: normalizedCalendarId, pull, push };
}

async function runGoogleSyncCycle({
  calendarId = null,
  interactive = false,
  quiet = true,
  reason = 'manual'
} = {}) {
  return withGoogleSyncLock(async () => {
    const session = await getSessionIfReadyForSync(`google_sync_cycle_${reason}`);
    if (!session?.user?.id) {
      syncLog('auth_not_ready_skip', { reason, scope: 'google_sync_cycle' }, 'warn');
      setSyncStatus('error', { detail: 'Sesión no lista para sync' });
      return { skipped: true, reason: 'auth_not_ready' };
    }
    setSyncStatus('syncing', { detail: `Ciclo ${reason}` });
    throwIfSyncAbortRequested('runGoogleSyncCycle:start');
    syncLog('cycle_start', {
      reason,
      interactive: !!interactive,
      calendarScope: calendarId ? normalizeGoogleCalendarId(calendarId, 'primary') : 'all_writable'
    });

    await seedGoogleTokenFromSupabaseSession();
    throwIfSyncAbortRequested('runGoogleSyncCycle:after_seed_token');
    try {
      await ensureGoogleToken({ interactive });
      throwIfSyncAbortRequested('runGoogleSyncCycle:after_ensure_token');
    } catch (err) {
      if (isSyncAbortError(err)) {
        syncLog('cycle_aborted', { reason, stage: err.stage || null }, 'warn');
        setSyncStatus('offline', { detail: 'Sync cancelado' });
        return { aborted: true, reason: 'sync_aborted' };
      }
      syncLog('cycle_no_token', {
        reason,
        error: err.message || String(err)
      }, interactive ? 'error' : 'warn');
      setSyncStatus('error', { detail: 'Token Google no disponible' });
      if (interactive) throw err;
      return { skipped: true, reason: 'no_google_token', error: err.message || String(err) };
    }

    const pull = createEmptyPullStats();
    const push = createEmptyPushStats();
    try {
      const forcedCalendarId = calendarId ? normalizeGoogleCalendarId(calendarId, 'primary') : null;
      const calendars = forcedCalendarId
        ? normalizeGoogleCalendarList([{ id: forcedCalendarId, summary: normalizeGoogleCalendarSummary('', forcedCalendarId), primary: isPrimaryCalendarId(forcedCalendarId) }])
        : await listWritableGoogleCalendars({ interactive: false });
      const isManualFullBootstrap = reason === 'manual';
      if (isManualFullBootstrap) {
        syncLog('manual_full_bootstrap_forced', { reason: 'user_manual_sync' });
        for (const calendar of calendars) {
          throwIfSyncAbortRequested(`runGoogleSyncCycle:before_manual_full_bootstrap_calendar_${calendar.id}`);
          const manualBootstrapPull = await importAllFromGoogleUnlocked({
            calendarId: calendar.id,
            sinceISO: MANUAL_FULL_BOOTSTRAP_TIME_MIN,
            horizonYears: GOOGLE_SYNC_DEFAULTS.horizonYears,
            interactive: false,
            forceBootstrap: true,
            ignoreWatermark: true,
            modeOverride: 'manual_full_bootstrap',
            allowDeletes: false
          });
          mergePullStats(pull, manualBootstrapPull);
        }
      } else {
        const linkedGoogleEventsCount = await sbCountEventsWithGoogleLink();
        const mustBootstrapFullImport = linkedGoogleEventsCount === 0;

        if (mustBootstrapFullImport) {
          const linkedLocalForBootstrap = await sbFetchLinkedGoogleEventsInRange();
          const knownLinkedLocal = linkedLocalForBootstrap.filter((evt) => hasGoogleLinkColumns(evt)).length;
          syncLog('bootstrap_forced_due_to_zero_links', {
            linkedCount: linkedGoogleEventsCount,
            knownLinkedLocal
          });
          syncLog('bootstrap_full_import_start', {
            calendars: calendars.map((cal) => cal.id)
          });
        }

        for (const calendar of calendars) {
          throwIfSyncAbortRequested(`runGoogleSyncCycle:before_calendar_${calendar.id}`);
          if (mustBootstrapFullImport) {
            const bootstrapPull = await importAllFromGoogleUnlocked({
              calendarId: calendar.id,
              sinceISO: GOOGLE_SYNC_DEFAULTS.sinceISO,
              horizonYears: GOOGLE_SYNC_DEFAULTS.horizonYears,
              interactive: false,
              forceBootstrap: true,
              allowDeletes: false
            });
            mergePullStats(pull, bootstrapPull);
            continue;
          }
          const single = await syncSingleCalendar(calendar.id, {
            interactive: false,
            quiet: true,
            sinceISO: GOOGLE_SYNC_DEFAULTS.sinceISO,
            horizonYears: GOOGLE_SYNC_DEFAULTS.horizonYears
          });
          mergePullStats(pull, single.pull);
          mergePushStats(push, single.push);
        }

        if (mustBootstrapFullImport) {
          syncLog('bootstrap_full_import_complete', {
            totalImported: pull.imported
          });
        }
      }
    } catch (err) {
      if (isSyncAbortError(err)) {
        syncLog('cycle_aborted', { reason, stage: err.stage || null }, 'warn');
        setSyncStatus('offline', { detail: 'Sync cancelado' });
        return { aborted: true, reason: 'sync_aborted' };
      }
      syncLog('cycle_failed', {
        reason,
        error: err.message || String(err)
      }, 'error');
      setSyncStatus('error', { detail: 'Error en ciclo de sync' });
      throw err;
    }

    _lastGoogleSyncAtMs = Date.now();
    setSyncStatusLastSuccess(_lastGoogleSyncAtMs);
    await refreshSyncStatusOutboxCount();

    if (!quiet) {
      showToast(
        `Sync Google (${reason}): +${pull.imported}/${pull.updated} -${pull.deleted} - push ${push.created + push.updated}`
      );
    }

    syncLog('cycle_complete', {
      reason,
      pull,
      push
    });

    try {
      throwIfSyncAbortRequested('runGoogleSyncCycle:before_reminder_sync');
      await syncReminderScheduleToSW({ requestPermission: false, triggerCheck: true, reason: `google_cycle_${reason}`, force: true });
    } catch (syncErr) {
      syncLog('cycle_reminder_sync_failed', { reason, error: syncErr.message || String(syncErr) }, 'warn');
    }

    reRender();
    return { pull, push };
  });
}
// Toggle único de auto-sync; persiste preferencia y rearma timer.
function setAutoSyncEnabled(on) {
  try { localStorage.setItem('autoSync.enabled', on ? '1' : '0'); } catch (err) { void err; }
  ensureAutoSyncTimer();
}

// Timer único de auto-sync (interval + trigger en arranque).
function ensureAutoSyncTimer() {
  clearInterval(_autoSyncTimer);
  _autoSyncTimer = null;

  if (_googleSyncBlocked) return;
  if (!resolveAutoSyncEnabled()) return;

  _autoSyncTimer = setInterval(() => {
    runGoogleSyncCycle({ interactive: false, quiet: true, reason: 'interval' }).catch(() => {});
  }, GOOGLE_SYNC_DEFAULTS.intervalMinutes * 60 * 1000);

  const stale = Date.now() - _lastGoogleSyncAtMs > (GOOGLE_SYNC_DEFAULTS.intervalMinutes * 60 * 1000);
  if (stale) {
    runGoogleSyncCycle({ interactive: false, quiet: true, reason: 'startup' }).catch(() => {});
  }
}

// Reauth silenciosa única para recuperar token sin interacción.
async function reauthGoogleSilentIfRemembered() {
  await seedGoogleTokenFromSupabaseSession();
  if (localStorage.getItem('google.remember') !== '1' && !_googleAccessToken) return false;
  try {
    const cycle = await runGoogleSyncCycle({ interactive: false, quiet: true, reason: 'login' });
    if (cycle.skipped && cycle.reason === 'no_google_token') {
      setGoogleConnectedState(false);
      return false;
    }
    if (cycle.aborted) {
      setGoogleConnectedState(false);
      return false;
    }
    setGoogleConnectedState(true);
    return true;
  } catch (e) {
    console.info('Silent auth de Google fallo:', e.error || e.message || e);
    setGoogleConnectedState(false);
    return false;
  }
}

function getGoogleConnectButton() {
  return document.getElementById('btnGoogleConnect')
    || document.getElementById('gcalAuthBtn')
    || null;
}

function setGoogleConnectedState(connected) {
  isGoogleConnected = !!connected;
  const btn = getGoogleConnectButton();
  if (!btn) return;
  if (isGoogleConnected) {
    btn.textContent = 'Desconectar Google';
    btn.classList.add('danger');
  } else {
    btn.textContent = 'Conectar Google';
    btn.classList.remove('danger');
  }
}

async function disconnectFromGoogle() {
  const tokenToRevoke = _googleAccessToken;
  clearGoogleRuntimeState({ clearPreferences: false });
  try {
    if (tokenToRevoke && window.google?.accounts?.oauth2?.revoke) {
      window.google.accounts.oauth2.revoke(tokenToRevoke, () => {});
    }
  } catch (err) {
    void err;
  }
  setGoogleConnectedState(false);
  showToast('Google desconectado', 'info');
}

async function handleGoogleButtonClick() {
  if (isGoogleConnected) {
    await disconnectFromGoogle();
    return { disconnected: true };
  }

  _googleSyncBlocked = false;
  const cycle = await runGoogleSyncCycle({ interactive: true, quiet: false, reason: 'auth' });
  if (cycle?.skipped) {
    showToast('Ya hay una sincronizacion Google en curso', 'info');
    return { skipped: true };
  }
  if (cycle?.aborted) {
    setGoogleConnectedState(false);
    showToast('Sync Google cancelado por cierre de sesion', 'info');
    return { aborted: true };
  }

  setGoogleConnectedState(true);
  showToast('Google conectado correctamente', 'success');
  return { connected: true };
}

// UI única del bloque Google en drawer (auth/pull/push/sync completo).
function injectGoogleImportUI() {
  const drawer = document.getElementById('drawer');
  if (!drawer || document.getElementById('gcalImportBtn')) return;

  const sec = document.createElement('div');
  sec.className = 'drawer-section';
  sec.innerHTML = `
    <h3>Google Calendar</h3>
    <div style="display:flex; gap:.5rem; flex-wrap:wrap">
      <button id="btnGoogleConnect" class="small">Conectar Google</button>
      <button id="gcalImportBtn" class="small">Importar desde Google</button>
    </div>
    <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem">
      <button id="gcalPushBtn" class="small">Exportar cambios locales</button>
      <button id="gcalSyncNowBtn" class="small">Sincronizacion completo</button>
    </div>
    <div style="display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.5rem">
      <button id="gcalRebindBtn" class="small">Rebind eventos existentes</button>
    </div>
    <p class="muted" style="margin:.5rem 0 0;font-size:.85rem">
      Flujo activo: Google API -> normalizacion -> Supabase. La UI solo lee desde Supabase.
    </p>
  `;
  drawer.appendChild(sec);

  const authBtn = sec.querySelector('#btnGoogleConnect');
  const importBtn = sec.querySelector('#gcalImportBtn');
  const pushBtn = sec.querySelector('#gcalPushBtn');
  const syncNowBtn = sec.querySelector('#gcalSyncNowBtn');
  const rebindBtn = sec.querySelector('#gcalRebindBtn');

  const rememberWrap = document.createElement('label');
  rememberWrap.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.25rem;cursor:pointer;font-size:.9rem';
  rememberWrap.innerHTML = '<input id="gcalRemember" type="checkbox"> Mantener sesion iniciada';
  sec.appendChild(rememberWrap);

  const rememberChk = rememberWrap.querySelector('#gcalRemember');
  rememberChk.checked = (localStorage.getItem('google.remember') === '1');
  rememberChk.addEventListener('change', () => {
    localStorage.setItem('google.remember', rememberChk.checked ? '1' : '0');
  });

  const autoWrap = document.createElement('label');
  autoWrap.style.cssText = 'display:flex;align-items:center;gap:.5rem;margin-top:.5rem;cursor:pointer;font-size:.9rem';
  autoWrap.innerHTML = `<input id="gcalAutoSync" type="checkbox"> Auto-sync cada ${GOOGLE_SYNC_DEFAULTS.intervalMinutes} min`;
  sec.appendChild(autoWrap);

  const autoChk = autoWrap.querySelector('#gcalAutoSync');
  autoChk.checked = resolveAutoSyncEnabled();
  autoChk.addEventListener('change', () => {
    setAutoSyncEnabled(!!autoChk.checked);
    showToast(autoChk.checked ? 'Auto-sync activado' : 'Auto-sync desactivado');
  });

  authBtn.addEventListener('click', async () => {
    const wasConnected = isGoogleConnected;
    try {
      authBtn.disabled = true;
      authBtn.textContent = wasConnected ? 'Desconectando...' : 'Conectando...';
      await handleGoogleButtonClick();
    } catch (e) {
      console.error(e);
      if (wasConnected) {
        showToast('Error al desconectar Google', 'error');
      } else {
        setGoogleConnectedState(false);
        showToast('Error al conectar con Google', 'error');
      }
    } finally {
      authBtn.disabled = false;
      setGoogleConnectedState(isGoogleConnected);
    }
  });

  importBtn.addEventListener('click', async () => {
    try {
      importBtn.disabled = true;
      importBtn.textContent = 'Sincronizando...';
      const stats = await importAllFromGoogle({
        sinceISO: GOOGLE_SYNC_DEFAULTS.sinceISO,
        horizonYears: GOOGLE_SYNC_DEFAULTS.horizonYears,
        interactive: true
      });
      if (stats.skipped) {
        showToast('Ya hay una sincronizacion Google en curso', 'info');
        return;
      }
      if (stats.aborted) {
        showToast('Pull cancelado por cierre de sesion', 'info');
        return;
      }
      reRender();
      showToast(
        `Pull completado.\nImportados: ${stats.imported}\nActualizados: ${stats.updated}\n` +
        `Borrados: ${stats.deleted}\nConflictos (Google gana): ${stats.conflictsResolvedByGoogle}`,
        'success',
        5200
      );
    } catch (e) {
      console.error(e);
      showToast('No se pudo ejecutar importación desde Google\n' + (e.message || ''), 'error', 5200);
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = 'Importar desde Google';
    }
  });

  pushBtn.addEventListener('click', async () => {
    try {
      pushBtn.disabled = true;
      pushBtn.textContent = 'Subiendo...';
      const stats = await pushAllDirtyToGoogle({
        interactive: true,
        quiet: false
      });
      if (stats.skipped) {
        showToast('Ya hay una sincronizacion Google en curso', 'info');
        return;
      }
      if (stats.aborted) {
        showToast('Push cancelado por cierre de sesion', 'info');
        return;
      }
      reRender();
      showToast(
        `Push completado.\nCreados: ${stats.created}\nActualizados: ${stats.updated}\n` +
        `Borrados local por Google: ${stats.deletedLocally}\nConflictos (Google gana): ${stats.conflictsResolvedByGoogle}\n` +
        `Fallidos: ${stats.failed}`,
        'success',
        5200
      );
    } catch (e) {
      console.error(e);
      showToast('No se pudo hacer push de cambios locales\n' + (e.message || ''), 'error', 5200);
    } finally {
      pushBtn.disabled = false;
      pushBtn.textContent = 'Exportar cambios locales';
    }
  });

  syncNowBtn.addEventListener('click', async () => {
    try {
      syncNowBtn.disabled = true;
      syncNowBtn.textContent = 'Sincronizando...';
      const cycle = await runGoogleSyncCycle({ interactive: true, quiet: false, reason: 'manual' });
      if (cycle.skipped) {
        showToast('Ya hay una sincronizacion Google en curso', 'info');
      } else if (cycle.aborted) {
        showToast('Sync completo cancelado por cierre de sesion', 'info');
      } else {
        showToast('Sync completo finalizado', 'success');
      }
    } catch (e) {
      console.error(e);
      showToast('No se pudo ejecutar sync completo\n' + (e.message || ''), 'error', 5200);
    } finally {
      syncNowBtn.disabled = false;
      syncNowBtn.textContent = 'Sync completo';
    }
  });

  rebindBtn.addEventListener('click', async () => {
    try {
      rebindBtn.disabled = true;
      rebindBtn.textContent = 'Rebind en curso...';
      const stats = await rebindLocalEventsWithGoogle({ interactive: true });
      if (stats?.skipped) {
        showToast('Ya hay una sincronizacion Google en curso', 'info');
        return;
      }
      if (stats?.aborted) {
        showToast('Rebind cancelado por cierre de sesion', 'info');
        return;
      }
      showToast(`Rebind completado: ${stats?.matched || 0} vinculados, ${stats?.unmatched || 0} sin match`, 'success');
    } catch (err) {
      console.error(err);
      showToast(`No se pudo ejecutar rebind\n${err.message || err}`, 'error', 5200);
    } finally {
      rebindBtn.disabled = false;
      rebindBtn.textContent = 'Rebind eventos existentes';
    }
  });

  setGoogleConnectedState(Boolean(_googleAccessToken && !_googleSyncBlocked));
}


/* ===================== Reminder Notifications (PWA real notifications) ===================== */
const REMINDER_SW_SYNC_MESSAGE = 'REMINDER_SYNC';
const REMINDER_SW_CHECK_MESSAGE = 'REMINDER_CHECK_NOW';
const REMINDER_SW_CLEAR_MESSAGE = 'REMINDER_CLEAR';
const REMINDER_SW_ONE_OFF_TAG = 'calendar-reminder-check';
const REMINDER_SW_PERIODIC_TAG = 'calendar-reminder-periodic';
const REMINDER_SW_PERIODIC_MIN_MS = 15 * 60 * 1000;
const REMINDER_UI_ENABLED_KEY = 'reminder.ui.enabled';

let _reminderSyncInFlight = null;
let _lastReminderSyncAt = 0;
let _notificationToggleBtn = null;
let _notificationStatusLabel = null;

function resolveReminderNotificationsEnabled() {
  let pref = '';
  try {
    pref = String(localStorage.getItem(REMINDER_UI_ENABLED_KEY) || '').trim();
  } catch (err) {
    void err;
  }
  if (pref === '0') return false;
  if (pref === '1') return true;
  return getReminderPermissionState() === 'granted';
}

function setNotificationsEnabledState(enabled, { persist = true } = {}) {
  notificationsEnabled = !!enabled;
  if (persist) {
    try {
      localStorage.setItem(REMINDER_UI_ENABLED_KEY, notificationsEnabled ? '1' : '0');
    } catch (err) {
      void err;
    }
  }
  updateNotificationButton();
}

function reminderLog(event, payload = {}, level = 'info') {
  if (typeof MODULE_UTILS.structuredLog === 'function') {
    MODULE_UTILS.structuredLog('reminder', event, payload, level);
    return;
  }
  const entry = {
    ts: new Date().toISOString(),
    event,
    ...payload
  };
  const line = `[REMINDER] ${JSON.stringify(entry)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

function isReminderSupported() {
  return ('Notification' in window) && ('serviceWorker' in navigator);
}

function getReminderPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

async function requestReminderPermissionIfNeeded({ interactive = false } = {}) {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  if (!interactive) return Notification.permission;
  const result = await Notification.requestPermission();
  return result;
}

function getReminderStartAtISO(evt) {
  if (typeof MODULE_REMINDERS.getReminderStartAtISO === 'function') {
    return MODULE_REMINDERS.getReminderStartAtISO(evt, localPartsToISO);
  }
  const dateStr = evt.startDate || evt.date;
  if (!dateStr) return null;
  const timeStr = evt.allDay ? '00:00' : (evt.startTime || evt.time || '00:00');
  return localPartsToISO(dateStr, timeStr);
}

function getReminderAtISO(evt) {
  if (typeof MODULE_REMINDERS.getReminderAtISO === 'function') {
    return MODULE_REMINDERS.getReminderAtISO(evt, parseDateInput);
  }
  const dateStr = evt.startDate || evt.date;
  if (!dateStr) return null;
  const d = parseDateInput(dateStr);
  if (!d || Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

function buildReminderRecordFromEvent(evt) {
  if (!evt.id) return null;
  const skipReminder = typeof MODULE_REMINDERS.shouldSkipReminder === 'function'
    ? MODULE_REMINDERS.shouldSkipReminder(evt)
    : (evt.isHoliday || evt.category === 'Festivo');
  if (skipReminder) return null;

  const startAt = getReminderStartAtISO(evt);
  const reminderAt = getReminderAtISO(evt);
  if (!startAt || !reminderAt) return null;

  const startTs = Date.parse(startAt);
  if (!Number.isFinite(startTs)) return null;
  if (startTs < Date.now() - 2 * 60 * 60 * 1000) return null;

  return {
    id: String(evt.id),
    title: String(evt.title || 'Evento'),
    startAt,
    reminderAt,
    eventDate: String(evt.startDate || evt.date || ''),
    updatedAt: safeISODateTime(evt.lastSyncedAt || evt.updatedAt || Date.now()) || new Date().toISOString(),
    url: './view=day'
  };
}

function buildReminderSchedule(events) {
  const map = new Map();
  for (const evt of (events || [])) {
    const reminder = buildReminderRecordFromEvent(evt);
    if (!reminder) continue;
    map.set(reminder.id, reminder);
  }
  return [...map.values()];
}

async function fetchEventsForReminderSchedule() {
  try {
    const events = await sbFetchAllEvents();
    return Array.isArray(events) ? events : [];
  } catch (err) {
    reminderLog('fetch_events_remote_failed', { error: err.message || String(err) }, 'warn');
  }

  try {
    const fallback = await cacheGetAllEvents();
    return Array.isArray(fallback) ? fallback : [];
  } catch (err) {
    reminderLog('fetch_events_cache_failed', { error: err.message || String(err) }, 'warn');
    return [];
  }
}

async function getReminderServiceWorkerRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  return navigator.serviceWorker.ready;
}

async function postReminderMessageToSW(registration, message) {
  const target = registration.active || navigator.serviceWorker.controller || registration.waiting;
  if (!target || typeof target.postMessage !== 'function') {
    throw new Error('Service Worker no activo para recordatorios');
  }
  target.postMessage(message);
}

async function clearReminderScheduleFromSW({ silent = true, reason = 'logout' } = {}) {
  if (!('serviceWorker' in navigator)) return { ok: false, reason: 'unsupported' };
  try {
    const registration = await getReminderServiceWorkerRegistration();
    if (!registration) return { ok: false, reason: 'no_registration' };
    await postReminderMessageToSW(registration, {
      type: REMINDER_SW_CLEAR_MESSAGE,
      reason,
      generatedAt: new Date().toISOString()
    });
    _reminderSyncInFlight = null;
    _lastReminderSyncAt = 0;
    reminderLog('clear_sent', { reason });
    return { ok: true };
  } catch (err) {
    if (!silent) reminderLog('clear_failed', { reason, error: err.message || String(err) }, 'warn');
    return { ok: false, reason: 'clear_failed', error: err.message || String(err) };
  }
}

async function ensureReminderBackgroundRegistration(registration) {
  if (!registration) return;

  if (registration.sync.register) {
    try {
      await registration.sync.register(REMINDER_SW_ONE_OFF_TAG);
    } catch (err) {
      reminderLog('register_sync_failed', { error: err.message || String(err) }, 'warn');
    }
  }

  if (registration.periodicSync.register) {
    try {
      let allowed = true;
      if (navigator.permissions.query) {
        try {
          const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
          if (status.state === 'denied') allowed = false;
        } catch {
          // browsers sin este permiso nominal
        }
      }

      if (allowed) {
        await registration.periodicSync.register(REMINDER_SW_PERIODIC_TAG, {
          minInterval: REMINDER_SW_PERIODIC_MIN_MS
        });
      }
    } catch (err) {
      reminderLog('register_periodic_sync_failed', { error: err.message || String(err) }, 'warn');
    }
  }
}

async function syncReminderScheduleToSW({
  requestPermission = false,
  triggerCheck = true,
  reason = 'manual',
  force = false
} = {}) {
  if (!isReminderSupported()) {
    return { ok: false, reason: 'unsupported' };
  }

  if (!requestPermission && !notificationsEnabled) {
    reminderLog('sync_skipped_disabled', { reason }, 'info');
    return { ok: false, reason: 'disabled_by_user' };
  }

  if (_reminderSyncInFlight) return _reminderSyncInFlight;

  const now = Date.now();
  if (!force && now - _lastReminderSyncAt < 5000) {
    return { ok: true, skipped: true, reason: 'throttled' };
  }

  _reminderSyncInFlight = (async () => {
    const permission = await requestReminderPermissionIfNeeded({ interactive: requestPermission });
    if (permission !== 'granted') {
      reminderLog('sync_skipped_permission', { permission, reason }, 'warn');
      return { ok: false, reason: 'permission_not_granted', permission };
    }

    const registration = await getReminderServiceWorkerRegistration();
    if (!registration) {
      return { ok: false, reason: 'no_registration' };
    }

    await ensureReminderBackgroundRegistration(registration);

    const events = await fetchEventsForReminderSchedule();
    const reminders = buildReminderSchedule(events);

    await postReminderMessageToSW(registration, {
      type: REMINDER_SW_SYNC_MESSAGE,
      reason,
      triggerCheck,
      generatedAt: new Date().toISOString(),
      reminders
    });

    _lastReminderSyncAt = Date.now();
    reminderLog('sync_sent', {
      reason,
      reminders: reminders.length,
      triggerCheck
    });

    return { ok: true, reminders: reminders.length };
  })().finally(() => {
    _reminderSyncInFlight = null;
  });

  return _reminderSyncInFlight;
}

function renderReminderPermissionLabel(labelEl) {
  if (!labelEl) return;
  const state = getReminderPermissionState();
  if (state === 'granted') labelEl.textContent = 'Estado: activadas';
  else if (state === 'denied') labelEl.textContent = 'Estado: bloqueadas por el navegador';
  else if (state === 'default') labelEl.textContent = 'Estado: pendiente de permiso';
  else labelEl.textContent = 'Estado: no soportado en este navegador';
}

function updateNotificationButton() {
  const btn = _notificationToggleBtn || document.getElementById('btnNotifications') || document.getElementById('reminderNotifEnableBtn');
  if (!btn) return;
  if (notificationsEnabled) {
    btn.textContent = 'Desactivar notificaciones';
    btn.classList.add('danger');
  } else {
    btn.textContent = 'Activar notificaciones';
    btn.classList.remove('danger');
  }
}

async function toggleNotifications() {
  if (!notificationsEnabled) {
    const permission = await requestReminderPermissionIfNeeded({ interactive: true });
    if (permission !== 'granted') {
      renderReminderPermissionLabel(_notificationStatusLabel);
      showToast('Permiso de notificaciones denegado', 'error');
      return { ok: false, reason: 'permission_denied', permission };
    }

    setNotificationsEnabledState(true);
    const result = await syncReminderScheduleToSW({
      requestPermission: false,
      triggerCheck: true,
      reason: 'ui_enable',
      force: true
    });
    renderReminderPermissionLabel(_notificationStatusLabel);
    if (result.ok) {
      showToast('Notificaciones activadas', 'success');
      return result;
    }
    showToast('No se pudo activar notificaciones', 'error');
    return result;
  }

  setNotificationsEnabledState(false);
  const cleared = await clearReminderScheduleFromSW({ silent: true, reason: 'ui_disable' });
  renderReminderPermissionLabel(_notificationStatusLabel);
  if (!cleared.ok) {
    reminderLog('ui_disable_clear_failed', { reason: cleared.reason || 'unknown' }, 'warn');
  }
  showToast('Notificaciones desactivadas', 'info');
  return { ok: true, disabled: true };
}

function injectReminderNotificationUI() {
  const drawer = document.getElementById('drawer');
  if (!drawer || document.getElementById('btnNotifications')) return;

  const sec = document.createElement('div');
  sec.className = 'drawer-section';
  sec.innerHTML = `
    <h3>Recordatorios Web</h3>
    <div style="display:flex; gap:.5rem; flex-wrap:wrap">
      <button id="btnNotifications" class="small">Activar notificaciones</button>
      <button id="reminderNotifSyncBtn" class="small">Recalcular recordatorios</button>
    </div>
    <p id="reminderNotifStatus" class="muted" style="margin:.5rem 0 0;font-size:.85rem">Estado: pendiente</p>
    <p class="muted" style="margin:.25rem 0 0;font-size:.8rem">Regla fija: aviso 1 dia antes a las 09:00.</p>
  `;
  drawer.appendChild(sec);

  const enableBtn = sec.querySelector('#btnNotifications');
  const syncBtn = sec.querySelector('#reminderNotifSyncBtn');
  const status = sec.querySelector('#reminderNotifStatus');

  _notificationToggleBtn = enableBtn;
  _notificationStatusLabel = status;
  setNotificationsEnabledState(resolveReminderNotificationsEnabled(), { persist: false });
  renderReminderPermissionLabel(status);

  enableBtn.addEventListener('click', async () => {
    try {
      enableBtn.disabled = true;
      enableBtn.textContent = notificationsEnabled ? 'Desactivando...' : 'Activando...';
      await toggleNotifications();
    } catch (err) {
      console.error(err);
      showToast('Error al cambiar notificaciones', 'error');
    } finally {
      enableBtn.disabled = false;
      updateNotificationButton();
      renderReminderPermissionLabel(status);
    }
  });

  syncBtn.addEventListener('click', async () => {
    try {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Sincronizando...';
      const result = await syncReminderScheduleToSW({
        requestPermission: false,
        triggerCheck: true,
        reason: 'ui_resync',
        force: true
      });
      renderReminderPermissionLabel(status);
      if (result.ok) showToast('Recordatorios recalculados', 'success');
      else if (result.reason === 'disabled_by_user') showToast('Activa notificaciones para recalcular recordatorios', 'info');
      else showToast('No se pudo recalcular recordatorios', 'error');
    } catch (err) {
      console.error(err);
      showToast('Error recalculando recordatorios', 'error');
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Recalcular recordatorios';
      renderReminderPermissionLabel(status);
    }
  });
}
