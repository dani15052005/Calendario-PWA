# Pendiente de aplicar — esperando OK del usuario

> Esta lista se aplica TODA DEL TIRÓN cuando el usuario diga "tira" / "aplica".
> Hasta entonces NO se toca nada.

---

## 1. Hamburguesa invisible (BUG visual)

**Síntoma:** las tres líneas del botón menú (#menuBtn) son blancas sobre fondo blanco — no se ven.

**Causa:** el CSS premium asigna `background: var(--text-2)` a `.hamburger span`. La cascada con la regla original de `styles.css` está dejando blanco. Probablemente es porque algún `.topbar` impone color blanco a los hijos en cascada.

**Fix planeado:**
- En [styles-premium.css](styles-premium.css), reforzar la regla con mayor especificidad o `!important`:
  ```css
  html[data-theme="light"] .topbar .hamburger span,
  html[data-theme="light"] #menuBtn span {
    background: #1f2937 !important;
  }
  ```
- Comprobar también que el `aria-expanded` no añade un color heredado.
- Si el botón completo está descolorido, mirar también `.hamburger { color: ... }`.

**Archivos a tocar:** `styles-premium.css`.

---

## 2. Sin emojis en la app — todos los símbolos deben ser nativos

**Regla:** en toda la app (UI + textos + toasts) **no se usan emojis**. Los símbolos se sustituyen por:
- SVG inline (preferido — el HTML ya tiene un patrón establecido para iconos como ✏ → SVG, 📍 → SVG, etc.)
- Caracteres Unicode tipográficos pero **sin presentación emoji** (ej: `←`, `→`, `▸`, `·`, `×`)
- O texto simple

**Sitios donde hay emojis ahora mismo (verificar y cambiar):**

### En el HTML
- [index.html:101](index.html#L101): `🔍` en el botón de búsqueda → cambiar por SVG lupa o icono Unicode `⌕` (U+2315) o quitar y dejar solo el aria-label.

### En el runtime
Buscar grep `[\x{1F300}-\x{1FAFF}]|[\u{2600}-\u{27BF}]` (rangos de emojis) en `core/app-runtime.js`. Identifico de memoria al menos:
- `injectGoogleImportUI`: el bloque tiene textos en plano sin emojis (OK).
- `showToast`: revisar si en alguna llamada de `showToast(...)` hay emojis pegados al texto.
- Sheet títulos / labels: revisar.

### En los SVG existentes
Mantenerlos — son SVG, no emojis. Solo se cambian si quedan caracteres pictográficos crudos.

**Archivos a tocar:** `index.html`, `core/app-runtime.js`, posiblemente `styles-premium.css` (si algún `::before content:"..."` usa emoji).

**Acción:** grep exhaustivo de caracteres Unicode emoji en repo y sustituir uno a uno.

---

## 3. Flechas de mes pegadas al título del mes (top-right)

**Estado actual:** la topbar tiene tres regiones — `toolbar-left` (hamburguesa, logo, "Hoy", flecha mes anterior), `toolbar-center` (título del mes con `id="currentMonthLabel"`), `toolbar-right` (sync pill, flecha siguiente, búsqueda).

**Lo que el usuario quiere:**
- El bloque "← mes año →" debe quedar agrupado y vivir **arriba a la derecha** (en la zona `toolbar-right`).
- Las flechas pegadas al texto del mes/año, como un widget compacto.
- La hamburguesa, logo, "Hoy" pueden quedarse a la izquierda como están.

**Fix planeado:**

### Reestructurar HTML ([index.html:69-106](index.html#L69-L106))
Mover `#currentMonthLabel` (que está en `toolbar-center`) y unirlo con `#prevMonthBtn` y `#nextMonthBtn` (que están en lados opuestos hoy) en un único contenedor dentro de `toolbar-right`:

```html
<div class="toolbar-right">
  <div id="syncStatusPill" ...>...</div>
  <div class="month-pager">
    <button id="prevMonthBtn" class="month-nav-btn ghost" aria-label="Mes anterior">‹</button>
    <h1 class="app-title month-title" id="currentMonthLabel" aria-live="polite">mayo 2026</h1>
    <button id="nextMonthBtn" class="month-nav-btn ghost" aria-label="Mes siguiente">›</button>
  </div>
  <form class="search-wrap ..." id="searchWrap">...</form>
</div>
```

Y quitarlo del `toolbar-center` (que queda vacío o se elimina).

### Símbolos de flecha
Los actuales son `&#9664;` (◀) y `&#9654;` (▶) — caracteres triangulares pesados. Cambiar por algo más fino, p.ej. `‹` (`&lsaquo;`) y `›` (`&rsaquo;`), que son los nativos de Mac/iOS.

### CSS premium en `styles-premium.css`
```css
html[data-theme="light"] .month-pager{
  display:flex; align-items:center;
  gap:4px;
  background:var(--surface-soft);
  border:1px solid var(--border-soft);
  border-radius:var(--radius-pill);
  padding:2px 4px;
}
html[data-theme="light"] .month-pager .month-title{
  font-size:.95rem;
  font-weight:600;
  padding:0 8px;
  margin:0;
  white-space:nowrap;
}
html[data-theme="light"] .month-pager .month-nav-btn{
  width:28px; height:28px;
  font-size:1rem;
}
```

### Responsive móvil
En pantallas estrechas (`max-width:480px`), reducir gap, font-size del título, y eliminar la sync pill para ganar espacio.

**Archivos a tocar:** `index.html`, `styles-premium.css`. Revisar que `updateAppTitleForMonth` siga pintando en `#currentMonthLabel` (debería seguir funcionando porque mantenemos el id).

---

## 4. "Conectar Google" se queda en loop

**Síntoma:** al pulsar el botón "Conectar Google" (drawer → sección Google Calendar), la sincronización entra en bucle infinito.

**Hipótesis ordenadas por probabilidad:**

### A) GIS popup bloqueado o falla silenciosa
`ensureGoogleToken({interactive:true})` usa `google.accounts.oauth2.initTokenClient` para abrir el flow popup. Si el popup queda atrapado (bloqueado por navegador, abre y se cierra sin token, o el callback nunca se llama), la promesa nunca resuelve y `runGoogleSyncCycle` se queda colgado.

### B) `Authorized JavaScript origins` mal en Google Cloud
El cliente OAuth `226957829260-shmlvb1an7lrkdhbj8prd5dd2eb0u17k` necesita tener en **Authorized JavaScript origins**:
- `https://dani15052005.github.io`

Si falta, GIS se cierra con error o no devuelve token.

### C) OAuth consent screen en Testing + email no es Test User
Si el OAuth consent está en "Testing", `andres5871@gmail.com` debe estar en la lista de "Test users" de la consent screen. Si no, GIS rechaza silenciosamente.

### D) Bucle entre `setSyncStatus('syncing')` y errores
En `runGoogleSyncCycle`, si después de un error transitorio se reintenta sin condición de salida, podría reentrar. El código tiene `withGoogleSyncLock` que debería prevenirlo, pero si el lock no se libera, sí entraría en estado "Sync en curso" perpetuo.

### E) Falta `provider_token` y la app entra en otro bucle
Como el login es por magic link, no hay `provider_token` de Google en la sesión. La función `seedGoogleTokenFromSupabaseSession()` devuelve null. Después `ensureGoogleToken` debe abrir el popup. Si en el medio hay algún reauth o redirect, podría recargar la app y reentrar.

### Plan de diagnóstico cuando aplique
1. Pedir al usuario que abra DevTools → Console y reproduzca el "Conectar Google".
2. Buscar errores rojos y warnings amarillos. Identificar:
   - `popup_blocked_by_browser`
   - `redirect_uri_mismatch`
   - `idpiframe_initialization_failed`
   - `403: app blocked` (consent screen no aprobada)
3. Si nada en consola pero la UI dice "Conectando..." indefinidamente, mirar Network tab — debería verse llamada a `googleapis.com/oauth2/...`.

### Acciones probables (a confirmar tras diagnóstico)
- **Verificar/añadir Authorized JS origins** en Google Cloud:
  ```
  https://dani15052005.github.io
  ```
- **Verificar Test users** en OAuth consent screen incluya `andres5871@gmail.com`.
- **Añadir timeout** a `runGoogleSyncCycle` para que no se quede colgado >30s.
- **Resetear `_googleSyncInFlight` y soltar el mutex** si la operación falla por timeout.
- **Mostrar toast de error** explícito si GIS no devuelve token en X segundos, en vez de silencio.
- **Limpiar status pill** y volver a estado normal en caso de fallo.

**Archivos a tocar:** `core/app-runtime.js` (handlers de Google sync) — solo después de diagnosticar la causa exacta. Posiblemente solo es config en Google Cloud sin tocar código.

---

## 5. Vistas Día / 3 días / Semana no se ven bien

**Síntoma:** las vistas de tiempo (#timeView con #timeGrid + #timeDaysHeader + #weekViewShell) no se renderizan correctamente. El usuario no ha precisado el problema concreto — puede ser:
- Cabecera de días desalineada con el grid de horas
- Eventos colocados fuera de su columna
- Anchos de columna inconsistentes
- Scroll roto
- Hueco grande / espacios en blanco extraños
- Today highlight mal pintado

**Origen probable:** colisión entre los estilos originales de `styles.css` (que usan grid template específicos para `.week-view`, `.week-header`, `.week-body`, `.time-grid`) y el CSS premium nuevo que solo restyleó superficialmente `.time-header` y `#timeView`.

### Plan de diagnóstico (al aplicar)
1. Pedir al usuario screenshot de cada vista (Día, 3 días, Semana).
2. Identificar qué exactamente está mal: alineación, colores, espacios, scroll.
3. Inspeccionar selectores en uso:
   - `#timeDaysHeader.time-days-header.week-header`
   - `#timeGrid.time-grid.week-body`
   - `.time-col`, `.time-day`, `.time-event`
   - `.now-line` (línea de hora actual)

### Plan de fix (provisional, refinar tras screenshots)
1. En `styles-premium.css` añadir bloque de overrides específico para `.week-view`:
   ```css
   html[data-theme="light"] .week-view{
     display:grid;
     grid-template-rows: auto 1fr;
     overflow:auto;
   }
   html[data-theme="light"] .time-days-header{
     display:grid;
     grid-template-columns: 60px repeat(var(--day-count, 7), 1fr);
     position:sticky; top:0;
     background:#fff;
     z-index:2;
   }
   html[data-theme="light"] .time-grid{
     display:grid;
     grid-template-columns: 60px repeat(var(--day-count, 7), 1fr);
     position:relative;
   }
   /* Eventos alineados a su columna día */
   html[data-theme="light"] .time-event{
     border-radius:8px;
     padding:4px 8px;
     font-size:.75rem;
     line-height:1.2;
     box-shadow:var(--shadow-xs);
   }
   /* Línea de hora actual */
   html[data-theme="light"] .now-line{
     background:var(--primary);
     height:2px;
   }
   html[data-theme="light"] .now-line::before{
     content:"";
     width:8px; height:8px; border-radius:50%;
     background:var(--primary);
     position:absolute; left:-4px; top:-3px;
   }
   ```
2. Si el grid del runtime usa unidades absolutas (px) y no `1fr`, refactor mínimo para responsive.
3. Verificar que `#dayEmptyMsg` se posiciona dentro de la vista Día correctamente.

**Archivos a tocar:** `styles-premium.css` (principalmente), posiblemente `core/app-runtime.js` si los listeners de scroll o cálculos de posición de eventos son los que fallan.

---

## 6. Quitar opción de dark mode

**Tema único: claro.** No hay toggle, no hay dark mode disponible.

**Cambios a hacer:**

### En index.html
- **Quitar la sección "Tema" del drawer** ([index.html:144-147](index.html#L144-L147)):
  ```html
  <div class="drawer-section">
    <h3>Tema</h3>
    <button id="themeToggle" class="theme-toggle">Cambiar a Light</button>
  </div>
  ```
  Borrar entera.
- **Mantener `data-theme="light"`** en `<html>` (ya está así).
- Quitar `<meta name="color-scheme" content="light dark">` y dejar solo `<meta name="color-scheme" content="light">` para que el navegador no proponga dark.
- Quitar el `theme-color` de dark.

### En core/app-runtime.js
- **Quitar `toggleTheme` y `applyTheme`** o dejarlas no-op forzando light.
- En `bootApp()`, hardcodear `state.theme = 'light'` (quitar lectura de localStorage).
- Quitar el listener del `#themeToggle` (ya no existirá).
- Limpieza opcional: borrar la clave `localStorage.theme` para no dejar residuos.

### En styles-premium.css
- **Borrar todo el bloque** `html[data-theme="dark"]{...}` (~25 líneas al principio del archivo).
- El selector `html[data-theme="light"]` puede quedarse o simplificarse a `:root`/global. Si se queda con `[data-theme="light"]`, el HTML siempre tiene esa clase, así que sigue funcionando — pero es código muerto innecesario.
- Decisión: dejar `html[data-theme="light"]` por simplicidad, solo eliminar el bloque dark.

### En styles.css (legacy)
- Quitar el bloque `html[data-theme="light"]{...}` y aplicar directamente a `:root` si simplifica.
- Quitar overrides `html[data-theme="light"] .topbar{...}` etc — pueden quedarse, no rompen.
- Decisión: **no tocar styles.css salvo eliminación de regla muerta de toggle theme**. Es 2700 líneas de CSS legacy, riesgoso.

**Archivos a tocar:** `index.html`, `core/app-runtime.js`, `styles-premium.css`.

---

## 7. Pulido visual completo, prioridad MÓVIL

**Mandato:** revisión visual exhaustiva de toda la app. **El móvil es lo más importante** — debe verse impecable en pantallas de 360px-480px de ancho. Desktop después.

### Auditoría móvil — checklist

#### Topbar
- [ ] Altura cómoda (44-56px), sin saturar pantalla
- [ ] Hamburguesa visible y con touch target ≥44x44px
- [ ] Título mes/año + flechas pegadas formando un widget cohesivo (ya capturado en fix 3)
- [ ] Sync pill oculto en móvil (ya está en CSS premium, validar)
- [ ] Búsqueda como icono solo, expande a fullscreen overlay al pulsar
- [ ] Logo y "Hoy" sin amontonarse

#### Drawer
- [ ] Animación slide suave (200-280ms cubic-bezier)
- [ ] Backdrop con blur sutil
- [ ] Ancho 88vw máx 320px
- [ ] Cierre por tap fuera + por gesto swipe-left
- [ ] Texto mínimo 14px, padding generoso
- [ ] Secciones bien separadas con divider sutil
- [ ] Segmented control de vista cómodo de tap (cada opción ≥44px alto)

#### Calendario mes
- [ ] Cells con altura suficiente para mostrar 2-3 eventos sin que se solapen
- [ ] Pills/tags con gap visible, color claramente distinguible por categoría
- [ ] Día actual con anillo de color marcado (ya está) sin invadir el número
- [ ] Día seleccionado claramente diferenciado
- [ ] Indicador "+N más" cuando hay más eventos de los que caben
- [ ] Swipe horizontal para cambiar mes (ya existe, validar fluidez)
- [ ] Weekend cells sutilmente diferenciadas
- [ ] Holidays visualmente distintos (color rojo o icono)

#### Vista Día / 3 días / Semana
- [ ] (Ver fix 5 — necesita screenshot)
- [ ] Hora actual con línea horizontal viva
- [ ] Eventos con su color de categoría como background sutil + borde lateral
- [ ] Pinch-zoom o scroll vertical fluido
- [ ] Sticky header con días
- [ ] Tap en hueco vacío → quick-add evento en esa franja

#### Vista Agenda
- [ ] Lista clara, agrupada por día
- [ ] Sticky day headers que se elevan al scroll
- [ ] Cards de evento con sombra sutil, hora prominente, título legible
- [ ] Tap → abrir editor

#### Sheet (editor de evento)
- [ ] Bottom sheet en móvil, NO modal centrado
- [ ] Drag handle arriba para arrastrar y cerrar
- [ ] Animación slide-up suave
- [ ] Inputs con altura ≥44px, labels claros
- [ ] Pickers nativos (date/time) que respeten viewport
- [ ] Botones de acción (Guardar/Cancelar) sticky abajo, no scrolleables
- [ ] Adjuntos con preview en grid de cards (no lista lineal apretada)
- [ ] Sin overflow horizontal en ninguna fila

#### FAB
- [ ] Posición fija bottom-right respeta safe-area (iOS notch/island)
- [ ] Tamaño 56-64px, sombra cromática vivida
- [ ] Animación al abrir speed-dial fluida
- [ ] Mini-buttons con label legible

#### Auth gate
- [ ] Card centrada con padding generoso
- [ ] Input email grande, padding cómodo (≥48px alto)
- [ ] Botón primary ancho completo, ≥48px
- [ ] Acordeón Google secundario sin distraer
- [ ] Mensajes de estado bien legibles

#### Toasts
- [ ] Posición fija que no tape el FAB
- [ ] Animación entry/exit limpia
- [ ] Texto legible, no demasiado pequeño
- [ ] Dismissable por swipe en móvil

### Auditoría desktop

- [ ] Layout aprovecha el ancho sin ser estirado
- [ ] Cells del mes con altura suficiente (~120-160px)
- [ ] Hover states claros pero sutiles
- [ ] Drawer overlay vs sidebar fijo (decidir según breakpoint ≥1280px)
- [ ] Sheet del evento como modal centrado, no bottom-sheet
- [ ] Atajos de teclado funcionando (← → para mes, T para hoy, etc.)

### Sistema de diseño a apretar

- [ ] **Tipografía:** un solo tamaño por nivel, escala 12/14/16/18/22/28
- [ ] **Espaciado:** múltiplos de 4px (4, 8, 12, 16, 24, 32, 48)
- [ ] **Colores:** paleta limitada — primario, surface, text-{1,2,3}, border-{soft,strong}, success, danger, warning
- [ ] **Sombras:** sistema XS→XL coherente (ya está)
- [ ] **Radios:** 6/8/12/16/22/pill (ya está)
- [ ] **Estados:** hover, active, focus, disabled — todos definidos uniformemente

### Implementación planificada

#### Bloque A — `styles-premium.css` ampliación
Añadir secciones que faltan o están débiles:
- Mobile media queries más agresivas (breakpoint principal: 480px, 768px, 1024px)
- Touch target mínimos universales con `:where(button, [role="button"], a, input, label) { min-height: 44px }` en mobile
- Bottom sheet con `border-radius: 20px 20px 0 0`, drag handle visible
- Time grid premium (sticky, alineación grid, eventos con color)
- Agenda con sticky day headers
- Auth gate refinado para móvil (90vw card max-width 380px)
- Toast positioning con safe-area

#### Bloque B — `index.html` ajustes
- Confirmar `<meta name="viewport">` ya tiene `viewport-fit=cover` (sí lo tiene)
- Añadir drag handle visual al sheet (`<div class="sheet-handle"></div>`)
- Touch action manipulation en elementos scroll
- Confirmar todos los inputs `<input>` tienen el `inputmode` correcto

#### Bloque C — `core/app-runtime.js` micro-ajustes UX
- Tap fuera del sheet → cierre solo si está vacío (sino confirm)
- Swipe-down en sheet → cierra si supera 100px
- Pull-to-refresh en agenda → trigger sync
- Long-press en evento del mes → quick-edit menu

### Riesgo
- **Alto** si tocamos demasiado de golpe — el monolito tiene 9000+ líneas y el CSS legacy 2700.
- Mitigación: empezar por `styles-premium.css` (capa overlay, fácil de revertir). Probar cada cambio en local con DevTools mobile preview antes de commit. Tests visuales actualizados.

---

## Cuando el usuario diga "tira"

### Fase 1 — Commit grande visual (fixes 1, 2, 3, 6, 7-bloque-A-y-B)
Prioridades en este orden:
1. **Eliminar dark mode** (fix 6) — limpia código antes de tocar más cosas
2. **Hamburguesa visible** (fix 1) — bug obvio
3. **Sin emojis** (fix 2) — auditoría + reemplazo
4. **Flechas mes pegadas al título** (fix 3) — reorganizar topbar
5. **Pulido visual móvil + desktop** (fix 7 bloques A y B):
   - Tipografía y espaciado coherentes
   - Topbar refinada
   - Drawer pulido
   - Calendario mes mejorado
   - Sheet bottom-sheet con drag handle
   - FAB premium con safe-area
   - Auth gate refinado
   - Touch targets ≥44px en móvil

Bump v1.2.25, tests, commit.

### Fase 2 — Pidiendo screenshots: vistas tiempo (fix 5) + UX micro-ajustes (fix 7 bloque C)
Después de Fase 1, pedir al usuario screenshot de:
- Vista Día
- Vista 3 días
- Vista Semana
- Vista Agenda
- Sheet de evento abierto en móvil
- Cualquier otra cosa que se vea rara

Aplicar fix 5 (vistas tiempo) y bloque C (micro-ajustes UX) en commit 2. Bump v1.2.26.

### Fase 3 — Loop Google (fix 4)
Cuando todo lo visual esté ya bien, pedir consola DevTools al pulsar Conectar Google. Diagnosticar en orden:
1. Authorized JavaScript origins en Google Cloud
2. Test users en OAuth consent screen
3. Si hay popup_blocked → tip al usuario
4. Si bug en código → añadir timeout + liberar mutex

### En cada fase
- Tests verdes (41/41 mínimo)
- node --check de todos los .js
- Reporte resumen al usuario
- El push lo hace el usuario (entorno me lo bloquea)
