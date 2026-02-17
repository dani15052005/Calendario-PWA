const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexPath = path.join(root, 'index.html');
const manifestPath = path.join(root, 'manifest.json');
const runtimePath = path.join(root, 'core', 'app-runtime.js');

const indexHtml = fs.readFileSync(indexPath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const runtimeJs = fs.readFileSync(runtimePath, 'utf8');
const htmlFiles = fs.readdirSync(root).filter((name) => name.toLowerCase().endsWith('.html'));

function isExternalUrl(url) {
  return /^https?:\/\//i.test(url);
}

// 1) No scripts inline in index.html
const scriptTags = [...indexHtml.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
const inlineScripts = scriptTags.filter((tag) => !/\bsrc\s*=/.test(tag));
assert.strictEqual(
  inlineScripts.length,
  0,
  `index.html no debe tener <script> inline sin src. Encontrados: ${inlineScripts.join(' | ')}`
);

// 1b) No inline onXXX handlers in HTML files
for (const htmlName of htmlFiles) {
  const html = fs.readFileSync(path.join(root, htmlName), 'utf8');
  const inlineHandlers = [...html.matchAll(/\son[a-z]+\s*=/gi)];
  assert.strictEqual(
    inlineHandlers.length,
    0,
    `${htmlName} no debe tener handlers inline onXXX=. Encontrados: ${inlineHandlers.map((m) => m[0]).join(' | ')}`
  );
}

// 2) No local absolute-root src/href paths in index.html
const srcHrefMatches = [...indexHtml.matchAll(/\b(src|href)\s*=\s*["']([^"']+)["']/gi)];
const absoluteLocalPaths = srcHrefMatches
  .map((m) => m[2])
  .filter((value) => value.startsWith('/') && !value.startsWith('//') && !isExternalUrl(value));

assert.strictEqual(
  absoluteLocalPaths.length,
  0,
  `No debe haber rutas locales absolutas en index.html: ${absoluteLocalPaths.join(', ')}`
);

// 3) core/boot-production.js must be referenced with relative path
assert.ok(
  /<script[^>]*\bsrc=["']\.\/core\/boot-production\.js["'][^>]*>/i.test(indexHtml),
  'index.html debe cargar ./core/boot-production.js con ruta relativa'
);

// 4) Service Worker registration must use relative sw.js path
assert.ok(
  /navigator\.serviceWorker\.register\(\s*['"]sw\.js['"]\s*\)/.test(runtimeJs),
  "Service Worker debe registrarse con navigator.serviceWorker.register('sw.js')"
);
assert.ok(
  !/navigator\.serviceWorker\.register\(\s*['"]\/sw\.js['"]\s*\)/.test(runtimeJs),
  'Service Worker no debe registrarse con /sw.js'
);

// 5) Manifest routes and icons should stay relative for GitHub Pages subpath
assert.ok(
  typeof manifest.scope === 'string' && !manifest.scope.startsWith('/'),
  'manifest.scope debe ser relativo'
);
assert.ok(
  typeof manifest.start_url === 'string' && !manifest.start_url.startsWith('/'),
  'manifest.start_url debe ser relativo'
);
for (const icon of manifest.icons || []) {
  assert.ok(
    typeof icon.src === 'string' && !icon.src.startsWith('/'),
    `Icono con ruta absoluta detectada en manifest: ${icon.src}`
  );
}

console.log('csp-and-paths-github-pages tests passed');
