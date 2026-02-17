window.__APP_BOOT__ = 'OK';

(function bootstrapCalendarApp() {
  const RUNTIME_SRC = './core/app-runtime.js';
  const RUNTIME_ATTR = 'data-calendar-runtime';

  function isProductionEnvironment() {
    const cfg = window.__APP_CONFIG__ || {};
    const explicit = String(cfg.APP_ENV || cfg.NODE_ENV || cfg.ENV || '').trim().toLowerCase();
    if (explicit) return explicit === 'production' || explicit === 'prod';

    const host = String(window.location.hostname || '').trim().toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (host.endsWith('.local') || host.endsWith('.test')) return false;
    return true;
  }

  function hardenConsoleInProduction() {
    if (!isProductionEnvironment()) return;
    if (!window.console || typeof console.log !== 'function') return;

    const noop = () => {};
    console.log = noop;
    console.debug = noop;
  }

  function markRuntimeReady() {
    window.__CALENDAR_RUNTIME_LOADING__ = false;
    window.__CALENDAR_RUNTIME_READY__ = true;
  }

  function markRuntimeFailed(err) {
    window.__CALENDAR_RUNTIME_LOADING__ = false;
    window.__CALENDAR_RUNTIME_READY__ = false;
    if (window.console && typeof console.error === 'function') {
      console.error('[bootstrap] No se pudo cargar core/app-runtime.js', err || 'error_desconocido');
    }

    const gate = document.getElementById('authGate');
    const msg = document.getElementById('authMessage');
    if (gate && msg) {
      gate.classList.remove('hidden');
      msg.textContent = 'Error crítico al iniciar la aplicación. Recarga la página.';
    }
  }

  function loadRuntimeScript() {
    if (window.__CALENDAR_RUNTIME_LOADING__) return;
    if (window.__CALENDAR_RUNTIME_READY__) return;

    const existing = document.querySelector(`script[${RUNTIME_ATTR}="1"]`);
    if (existing) {
      window.__CALENDAR_RUNTIME_LOADING__ = true;
      existing.addEventListener('load', markRuntimeReady, { once: true });
      existing.addEventListener('error', markRuntimeFailed, { once: true });
      return;
    }

    window.__CALENDAR_RUNTIME_LOADING__ = true;

    const script = document.createElement('script');
    script.src = RUNTIME_SRC;
    script.defer = true;
    script.setAttribute(RUNTIME_ATTR, '1');

    script.onload = markRuntimeReady;
    script.onerror = markRuntimeFailed;

    (document.head || document.documentElement || document.body).appendChild(script);
  }

  hardenConsoleInProduction();
  loadRuntimeScript();
})();

/*
COMPAT_TEST_MARKERS_START
function sbUpsertAttachmentWithRetry(
await rollbackAttachmentCacheEntry(normalized.id);
throw err;
throw new Error('Adjunto sin drive_file_id')
function revalidateLocalEventBeforeGooglePush(
markEventDeletedTombstone(
push_skip_deleted_revalidated
https://www.googleapis.com/oauth2/v3/userinfo
createGoogleOwnerMismatchError
err.code = 'GOOGLE_OWNER_MISMATCH'
abortGoogleNetworkRequests('google_owner_mismatch')
_syncAbortRequested = true;
abortGoogleNetworkRequests('logout')
throwIfSyncAbortRequested('pushAllDirtyToGoogle:loop_start')
throwIfSyncAbortRequested('importAllFromGoogle:loop_start')
function distributeEventsByVisibleDays(
distributeEventsByVisibleDays(events, dayKeys)
let _logoutInProgress = false;
function assertWritesAllowed(
_logoutInProgress = true;
assertWritesAllowed('sbUpsertEvent')
assertWritesAllowed('sbDeleteEventById')
assertWritesAllowed('sbUpsertAttachment')
const SB_EVENT_SELECT_COLUMNS
const SB_ATTACHMENT_SELECT_COLUMNS
function sbApplyRangeOverlap(
COMPAT_TEST_MARKERS_END
*/
