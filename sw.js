const CACHE_NAME = 'app-v1.2.19';
const STATIC_ASSETS = [
  './', './index.html', './styles.css', './script.js',
  './core/app-runtime.js',
  './app-config.js', './auth-helpers.js', './app-version.json',
  './utils/helpers.js',
  './core/state.js',
  './core/auth.js',
  './data/queries.js',
  './data/supabase.js',
  './sync/reconcile.js',
  './sync/google-sync.js',
  './attachments/drive.js',
  './reminders/reminders.js',
  './ui/month.js',
  './ui/week.js',
  './ui/day.js',
  './ui/agenda.js',
  './manifest.json', './offline.html',
  './icons/logo-red-192.png', './icons/logo-red-512.png',
  './icons/logo-dark@3x.png', './icons/logo-light@3x.png'
];

const ASSET_URLS = new Set(STATIC_ASSETS.map((u) => new URL(u, self.location).href));
const IS_DEV_HOST = ['localhost', '127.0.0.1'].includes(self.location.hostname);

const REMINDER_DB = 'calendar-reminder-sw';
const REMINDER_DB_VERSION = 1;
const REMINDER_STORE = 'reminders';
const SENT_STORE = 'sent';
const PERIODIC_SYNC_TAG = 'calendar-reminder-periodic';
const ONE_OFF_SYNC_TAG = 'calendar-reminder-check';
const SENT_RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
let _reminderCheckInFlight = false;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => (k.startsWith('app-v') || k.startsWith('static-')) && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );

    const cache = await caches.open(CACHE_NAME);
    const reqs = await cache.keys();
    await Promise.all(
      reqs
        .filter((r) => new URL(r.url).pathname.endsWith('/app-version.json'))
        .map((r) => cache.delete(r))
    );
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data === 'SKIP_WAITING' || data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (data === 'CLEAR_CACHES' || data?.type === 'CLEAR_CACHES') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    })());
    return;
  }

  if (data?.type === 'REMINDER_SYNC') {
    event.waitUntil(handleReminderSyncMessage(data));
    return;
  }

  if (data?.type === 'REMINDER_CHECK_NOW') {
    event.waitUntil(runReminderCheckWithMutex({ source: 'message_check' }));
    return;
  }

  if (data?.type === 'REMINDER_CLEAR') {
    event.waitUntil(clearReminderStores());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== PERIODIC_SYNC_TAG) return;
  event.waitUntil(runReminderCheckWithMutex({ source: 'periodicsync' }));
});

self.addEventListener('sync', (event) => {
  if (event.tag !== ONE_OFF_SYNC_TAG) return;
  event.waitUntil(runReminderCheckWithMutex({ source: 'sync' }));
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = null;
    try {
      payload = event.data ? event.data.json() : null;
    } catch {
      payload = null;
    }

    if (payload?.title) {
      await self.registration.showNotification(payload.title, {
        body: payload.body || 'Recordatorio de calendario',
        icon: './icons/logo-red-192.png',
        badge: './icons/logo-red-192.png',
        tag: payload.tag || `push-${Date.now()}`,
        renotify: false,
        data: payload.data || { url: './' }
      });
      return;
    }

    await runReminderCheckWithMutex({ source: 'push_fallback' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawTargetUrl = String(event.notification?.data?.url || './');
  let target = new URL('./', self.location.origin);
  try {
    const candidate = new URL(rawTargetUrl, self.location.origin);
    if (candidate.origin === self.location.origin) {
      target = candidate;
    } else {
      swLog('notificationclick_cross_origin_blocked', { rawTargetUrl }, 'warn');
    }
  } catch {
    swLog('notificationclick_invalid_url', { rawTargetUrl }, 'warn');
  }

  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === target.origin) {
          await client.focus();
          if (typeof client.navigate === 'function') {
            await client.navigate(target.href);
          }
          return;
        }
      } catch {
        // noop
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(target.href);
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.origin === self.location.origin && url.pathname.endsWith('/app-version.json')) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' }).catch(
        () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  if (isHTMLNavigation(req)) {
    event.respondWith(networkFirstNav(req));
    return;
  }

  if (IS_DEV_HOST && url.origin === self.location.origin && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (ASSET_URLS.has(req.url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch {
      const cached = await caches.match(req);
      return cached || Response.error();
    }
  })());
});

function swLog(event, payload = {}, level = 'info') {
  const line = `[SW-REMINDER] ${JSON.stringify({ ts: new Date().toISOString(), event, ...payload })}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

function isHTMLNavigation(request) {
  return request.mode === 'navigate' ||
    (request.headers.get('Accept') || '').includes('text/html');
}

async function networkFirstNav(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);

    const scopeURL = new URL(self.registration.scope);
    const reqURL = new URL(request.url);
    const isScopeRoot = reqURL.pathname === scopeURL.pathname;
    const isScopeIndex = reqURL.pathname === `${scopeURL.pathname}index.html`;

    if (isScopeRoot || isScopeIndex) {
      await cache.put(scopeURL.href, fresh.clone());
      await cache.put(new URL('index.html', scopeURL).href, fresh.clone());
    }

    return fresh;
  } catch {
    const cached = await cache.match(request) ||
      await cache.match(new URL('./index.html', self.location)) ||
      await cache.match(new URL('./', self.location));
    return cached || await cache.match(new URL('./offline.html', self.location));
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request);
    return cached || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((res) => { if (res && res.ok) cache.put(request, res.clone()); })
      .catch(() => {});
    return cached;
  }
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || await networkPromise || Response.error();
}

function openReminderDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(REMINDER_DB, REMINDER_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains(REMINDER_STORE)) {
        const reminders = db.createObjectStore(REMINDER_STORE, { keyPath: 'id' });
        reminders.createIndex('by_reminder_at', 'reminderAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(SENT_STORE)) {
        const sent = db.createObjectStore(SENT_STORE, { keyPath: 'key' });
        sent.createIndex('by_sent_at', 'sentAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqValue(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readAll(storeName) {
  const db = await openReminderDB();
  const tx = db.transaction([storeName], 'readonly');
  const store = tx.objectStore(storeName);
  const all = await reqValue(store.getAll());
  await txDone(tx);
  return Array.isArray(all) ? all : [];
}

function normalizeReminderRecord(input) {
  if (!input || !input.id) return null;
  const reminderDate = new Date(input.reminderAt || '');
  const startDate = new Date(input.startAt || '');
  if (Number.isNaN(reminderDate.getTime()) || Number.isNaN(startDate.getTime())) return null;

  return {
    id: String(input.id),
    title: String(input.title || 'Evento'),
    reminderAt: reminderDate.toISOString(),
    startAt: startDate.toISOString(),
    eventDate: String(input.eventDate || '').trim(),
    url: String(input.url || './'),
    updatedAt: String(input.updatedAt || new Date().toISOString())
  };
}

async function handleReminderSyncMessage(data) {
  const reminders = Array.isArray(data.reminders) ? data.reminders : [];
  const normalized = reminders
    .map(normalizeReminderRecord)
    .filter(Boolean);

  const db = await openReminderDB();
  const tx = db.transaction([REMINDER_STORE], 'readwrite');
  const store = tx.objectStore(REMINDER_STORE);
  store.clear();
  for (const item of normalized) {
    store.put(item);
  }
  await txDone(tx);

  swLog('schedule_sync', {
    received: reminders.length,
    stored: normalized.length,
    triggerCheck: !!data.triggerCheck,
    reason: data.reason || 'unknown'
  });

  if (data.triggerCheck) {
    await runReminderCheckWithMutex({ source: 'sync_message' });
  }
}

async function clearReminderStores() {
  const db = await openReminderDB();
  const tx = db.transaction([REMINDER_STORE, SENT_STORE], 'readwrite');
  tx.objectStore(REMINDER_STORE).clear();
  tx.objectStore(SENT_STORE).clear();
  await txDone(tx);
  swLog('schedule_clear');
}

function buildSentKey(reminder) {
  return `${reminder.id}|${reminder.reminderAt}`;
}

async function pruneOldSentEntries(nowMs) {
  const threshold = nowMs - SENT_RETENTION_MS;
  const allSent = await readAll(SENT_STORE);
  const toDelete = allSent.filter((r) => {
    const ts = Date.parse(r.sentAt || '');
    return Number.isFinite(ts) && ts < threshold;
  });
  if (!toDelete.length) return;

  const db = await openReminderDB();
  const tx = db.transaction([SENT_STORE], 'readwrite');
  const store = tx.objectStore(SENT_STORE);
  for (const row of toDelete) {
    store.delete(row.key);
  }
  await txDone(tx);
}

async function runReminderCheckWithMutex({ source = 'manual' } = {}) {
  if (_reminderCheckInFlight) {
    swLog('check_skipped_mutex', { source }, 'warn');
    return { shown: 0, due: 0, scanned: 0, skipped: true, reason: 'in_flight' };
  }
  _reminderCheckInFlight = true;
  try {
    return await checkDueReminders({ source });
  } finally {
    _reminderCheckInFlight = false;
  }
}

async function checkDueReminders({ source = 'manual' } = {}) {
  if (Notification.permission !== 'granted') {
    swLog('check_skipped_permission', { source, permission: Notification.permission }, 'warn');
    return { shown: 0, due: 0, scanned: 0 };
  }

  const nowMs = Date.now();
  const reminders = await readAll(REMINDER_STORE);
  const sentRows = await readAll(SENT_STORE);
  const sentKeys = new Set(sentRows.map((r) => r.key));

  const due = reminders.filter((item) => {
    const reminderTs = Date.parse(item.reminderAt || '');
    const startTs = Date.parse(item.startAt || '');
    if (!Number.isFinite(reminderTs) || !Number.isFinite(startTs)) return false;
    if (startTs < nowMs - 2 * 60 * 60 * 1000) return false;
    if (reminderTs > nowMs) return false;
    return !sentKeys.has(buildSentKey(item));
  });

  let shown = 0;
  const sentToPersist = [];

  for (const item of due) {
    const sentKey = buildSentKey(item);
    await self.registration.showNotification(item.title || 'Recordatorio', {
      body: 'Recordatorio: manana a las 09:00 se activa este evento.',
      icon: './icons/logo-red-192.png',
      badge: './icons/logo-red-192.png',
      tag: sentKey,
      renotify: false,
      data: {
        eventId: item.id,
        reminderAt: item.reminderAt,
        startAt: item.startAt,
        url: item.url || './'
      }
    });

    shown += 1;
    sentToPersist.push({
      key: sentKey,
      eventId: item.id,
      sentAt: new Date().toISOString()
    });
  }

  if (sentToPersist.length) {
    const db = await openReminderDB();
    const tx = db.transaction([SENT_STORE], 'readwrite');
    const store = tx.objectStore(SENT_STORE);
    for (const sent of sentToPersist) {
      store.put(sent);
    }
    await txDone(tx);
  }

  await pruneOldSentEntries(nowMs);

  swLog('check_complete', {
    source,
    scanned: reminders.length,
    due: due.length,
    shown
  });

  return { shown, due: due.length, scanned: reminders.length };
}
