const VERSION = 'v1.2.1';
const STATIC_CACHE = `static-${VERSION}`;
const STATIC_ASSETS = [
  './', './index.html', './styles.css', './script.js',
  './manifest.json', './offline.html',
  './icons/logo-red-192.png', './icons/logo-red-512.png',
  './icons/logo-dark@3x.png', './icons/logo-light@3x.png'
];

// Normaliza a URLs absolutas para comparación rápida
const ASSET_URLS = new Set(STATIC_ASSETS.map(u => new URL(u, self.location).href));
const IS_DEV_HOST = ['localhost', '127.0.0.1'].includes(self.location.hostname);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => {
        if (IS_DEV_HOST) self.skipWaiting(); // SOLO en localhost
        // En producción NO hacemos skipWaiting aquí, para poder avisar
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('static-') && k !== STATIC_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();

    // limpiar app-version.json obsoletos
    const cache = await caches.open(STATIC_CACHE);
    const reqs = await cache.keys();
    await Promise.all(
      reqs
        .filter(r => new URL(r.url).pathname.endsWith('/app-version.json'))
        .map(r => cache.delete(r))
    );
  })());
});


self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  if (data === 'SKIP_WAITING' || (data.type && data.type === 'SKIP_WAITING')) {
    self.skipWaiting();
  }
  if (data === 'CLEAR_CACHES' || (data.type && data.type === 'CLEAR_CACHES')) {
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    })();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // --- app-version.json: siempre red, sin cachear ---
if (url.origin === self.location.origin && url.pathname.endsWith('/app-version.json')) {
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).catch(async () => {
      // Si no hay red, no respondemos de caché para forzar bloqueo persistente.
      // Devuelve un JSON vacío como último recurso.
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    })
  );
  return;
}

  // Navegación de páginas (SPA)
  if (isHTMLNavigation(req)) {
    event.respondWith(networkFirstNav(req));
    return;
  }

  // *** MODO DEV: para JS/CSS en localhost -> network-first (evita caché vieja durante desarrollo) ***
  if (IS_DEV_HOST && url.origin === self.location.origin && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Estáticos precacheados: cache-first (con actualización en bg)
  if (ASSET_URLS.has(req.url)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Resto same-origin: SWR
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // Externos: red y cae a caché si existe
  event.respondWith((async () => {
    try {
      return await fetch(req);
    } catch {
      const cached = await caches.match(req);
      return cached || Response.error();
    }
  })());
});

// -------- Helpers --------
function isHTMLNavigation(request) {
  return request.mode === 'navigate' ||
         (request.headers.get('Accept') || '').includes('text/html');
}

async function networkFirstNav(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const fresh = await fetch(request);

// Raíz real del scope del SW (sirve para GitHub Pages / subcarpetas)
const scopeURL = new URL(self.registration.scope);
const reqURL   = new URL(request.url);

// ¿navegas a la raíz del scope o a su index.html?
const isScopeRoot  = reqURL.pathname === scopeURL.pathname;
const isScopeIndex = reqURL.pathname === scopeURL.pathname + 'index.html';

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
  const cache = await caches.open(STATIC_CACHE);
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
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request).then(res => { if (res && res.ok) cache.put(request, res.clone()); }).catch(()=>{});
    return cached;
  }
  const res = await fetch(request);
  if (res && res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request).then(res => {
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  }).catch(()=>null);
  return cached || await networkPromise || Response.error();
}