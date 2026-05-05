# Calendario PWA — Visión y Estructura General

> Este documento es la fuente de verdad sobre **qué pretendía ser esta app**, cómo se sincroniza con Google y qué reglas de negocio aplican. Léelo antes de tomar decisiones grandes.

---

## 1. Objetivo principal

App **privada** de calendario personal, accesible solo por el propietario, con interfaz propia y **sincronización con Google Calendar**.

Resumen mental: *Google Calendar propio + diseño personalizado + adjuntos + control privado + sincronización parcial.*

---

## 2. Acceso y seguridad

### Login
- Login con **Google Auth** (vía Supabase Auth con provider `google`).

### Acceso privado por email
- Bloqueo duro por email — **único propietario**:
  ```
  andres5871@gmail.com
  ```
- Cualquier otro email entra → `signOut` automático y UI bloqueada.

### Seguridad en Supabase
- RLS **activado y forzado** en `users`, `events`, `attachments`.
- Policies owner-only: `auth.uid() = user_id AND auth.jwt()->>'email' = '<owner>'`.
- Nada público, nada multiusuario, nada de service-role en cliente.

---

## 3. Stack técnico real (vs. visión inicial)

| Aspecto | Visión inicial | Implementación real |
|---|---|---|
| Frontend | React + TS + Vite | **Vanilla JS PWA** (sin bundler) |
| Calendario | FullCalendar | Vistas hand-rolled en `ui/{month,week,day,agenda}.js` |
| Backend | Supabase | ✅ Supabase |
| Auth | Google + Supabase | ✅ Google + Supabase |
| Storage adjuntos | Supabase Storage + Drive | **Solo Google Drive** |
| Sync | Edge Functions + GCal API | GCal API directa desde cliente, **sin Edge Functions** |
| Refresh token | Edge Function `save-google-token` | **No implementada** — depende de `provider_token` de Supabase |
| Sync periódica | `pg_cron` | Timer en cliente (`ensureAutoSyncTimer`) |

> La visión React/Vite/FullCalendar nunca se materializó. La app actual es vanilla JS — más liviana pero monolítica.

---

## 4. Vistas del calendario

`/` (SPA, sin router) con vistas conmutables:

- **Mes** (default)
- **Semana**
- **3 días**
- **Día**
- **Agenda / listado**

Conmutación vía radios en el drawer (`name="viewMode"`).

---

## 5. Modelo de evento

Campos de un evento:
- `id` (uuid)
- `title`, `notes`
- `start_at`, `end_at` (timestamptz)
- `all_day` (boolean)
- `location`, `url`, `color`
- `category` (Trabajo, Evento, Citas, Cumpleaños, Otros, Festivo)
- `is_holiday`, `locked`, `source` (`local` | `google` | `holiday`)
- `google_event_id`, `google_calendar_id`
- `needs_gcal_sync`, `gcal_updated`, `gcal_etag`, `last_synced_at`
- `remote_missing`, `remote_missing_at` (cuarentena)
- `meta` (jsonb)
- `created_at`, `updated_at`

---

## 6. Editor de eventos

**Sheet lateral / inferior (no modal feo).** Tres flujos:

| Flujo | Sheet | Categoría | Disparador |
|---|---|---|---|
| Quick-add cumpleaños | `#addBirthdaySheet` | `Cumpleaños` | FAB → tarta |
| Quick-add evento | `#addTaskSheet` | `Evento` | FAB → folio |
| Editor completo | `#addEventSheet` | configurable | click en día/evento, FAB principal |

El editor completo permite: título, todo-el-día, rango fecha+hora, ubicación, URL, color, calendario destino, alerta, recurrencia, notas, adjuntos (cámara/galería/archivos), duplicar y eliminar.

---

## 7. Sincronización con Google Calendar

### Reglas firmes
- **Google gana en conflicto** (excepto si el local tiene cambios pendientes recientes).
- **Borrar en la app NO borra en Google.** Solo se elimina/oculta localmente.
- Si un evento desaparece en Google y existe local, entra en **cuarentena** (`remote_missing` + `remote_missing_at`); se purga tras `GOOGLE_REMOTE_MISSING_QUARANTINE_MINUTES`.

### Flujos
1. **Importar** Google → Supabase: `importAllFromGoogle()` con `nextSyncToken` incremental, bootstrap forzado si hay 0 enlaces.
2. **Crear** local → Google: `pushEventToGCal()` cuando `needs_gcal_sync = true`.
3. **Editar** local → Google: idem, comparando `gcal_updated`/`gcal_etag`.
4. **Detectar cambios remotos**: en cada ciclo `runGoogleSyncCycle()`.

### Tokens
- Access token Google: vía `google.accounts.oauth2.initTokenClient` (GIS), TTL ~1h.
- **Refresh token**: NO se persiste cliente-side (correcto). Se intenta `provider_token` de la sesión Supabase como semilla; si no, requiere reauth interactivo.
- **Edge Function `save-google-token` está PLANIFICADA pero no implementada.** Es la deuda principal para que el sync silencioso sobreviva tras reinicio.

---

## 8. Estados de sincronización

| Estado | Significado |
|---|---|
| `local_only` | Existe en app, no se ha enviado a Google |
| `synced` | Supabase y Google alineados |
| `pending_create` | Necesita creación en Google (`needs_gcal_sync=true`, sin `google_event_id`) |
| `pending_update` | Necesita update en Google (`needs_gcal_sync=true`, con `google_event_id`) |
| `pending_delete` | Marcado para borrar (no se aplica a Google por regla de seguridad) |
| `conflict` | Versiones diferentes — Google gana |
| `remote_missing` | Estaba en Google, ya no está; en cuarentena |
| `error` | Último intento de sync falló |

---

## 9. Adjuntos

- **Solo Google Drive** (no Supabase Storage por ahora).
- Subida vía `driveUploadMultipart()` con scope `drive.file` (solo ficheros creados por la app).
- Metadatos en `public.attachments`: `drive_file_id` (NOT NULL), `file_name`, `file_type`, `event_id`, `user_id`, `created_at`.
- Pickers: cámara (mobile), galería (mobile), archivos (desktop).
- Borrado: si se elimina el evento, los adjuntos en Drive también se intentan borrar (`deleteDriveFileIfAllowed`).

---

## 10. Esquema de base de datos (canónico)

Tablas:
- `public.users` — fila por owner (id = `auth.users.id`).
- `public.events` — eventos del owner.
- `public.attachments` — metadatos de adjuntos en Drive.

Ver [supabase/MIGRATIONS.md](supabase/MIGRATIONS.md) para el orden de aplicación del linaje canónico.

> ⚠️ `supabase/_DEPRECATED_schema_full_production.sql.txt` está deprecado y **NO debe ejecutarse** — usa columnas (`gcal_event_id`, `category`) incompatibles con el código actual.

---

## 11. Lo que NO queremos

- ❌ Multiusuario / SaaS / roles.
- ❌ Compartir calendarios.
- ❌ Borrar eventos de Google al borrar desde la app.
- ❌ Service role en cliente.
- ❌ Refresh tokens en `localStorage`.
- ❌ Eventos importados con escritura masiva sin `withWriteLock`.

---

## 12. Fases de desarrollo

| Fase | Estado | Contenido |
|---|---|---|
| 1. Base privada | ✅ Done | Login, owner gate, vistas, CRUD local, Supabase |
| 2. Google Calendar | 🟡 Parcial | Import + push OK, refresh token sin Edge Function |
| 3. Sync robusta | ✅ Done | Estados, mutex, outbox, cuarentena, prioridad Google |
| 4. Adjuntos | ✅ Done | Drive multipart + metadatos |
| 5. Pulido visual | 🟡 En curso | Tema claro premium responsive (este sprint) |

---

## 13. Archivos clave

```
index.html                 ← Shell HTML, CSP estricta, carga de scripts
app-config.js              ← URL Supabase + anon key + OWNER_EMAIL
auth-helpers.js            ← normalizeEmail, isOwnerEmail
script.js                  ← Carga dinámica de core/app-runtime.js (CSP-safe)
sw.js                      ← Service worker, recordatorios via periodicSync
styles.css                 ← Estilos base (legacy, ~85KB)
styles-premium.css         ← Capa premium light (este sprint)

core/
  app-runtime.js           ← MONOLITO — todo el runtime (~9.300 líneas, deuda técnica)
  state.js                 ← Estado inicial
  auth.js                  ← Helpers de sesión Supabase
  boot-production.js       ← Bootstrap CSP-safe del search form

data/
  queries.js               ← SB_EVENT_SELECT_COLUMNS, applyRangeOverlap
  supabase.js              ← normalizeSessionContext, ensureUserRow

sync/
  google-sync.js           ← Mutex global de sync
  reconcile.js             ← Lógica "Google gana en conflicto"

attachments/drive.js       ← Normalización de metadata Drive
reminders/reminders.js     ← Helpers de recordatorios

ui/{month,week,day,agenda}.js  ← Helpers por vista (la mayoría de la lógica sigue en app-runtime.js)

supabase/
  schema_task*.sql         ← Migraciones canónicas (linaje real)
  MIGRATIONS.md            ← Orden de aplicación
  _DEPRECATED_*.txt        ← Schemas no aplicables

tests/                     ← 40 tests Node assert (sin framework)
```

---

## 14. Deuda técnica reconocida

1. **`core/app-runtime.js` es un monolito de ~9.300 líneas.** Decomposición pendiente.
2. **Edge Function `save-google-token` no existe.** El refresh token de Google no se persiste server-side.
3. **`schema_full_production.sql` legacy** — deprecado, no debe ejecutarse.
4. **Recurrencia (`eventRepeat`) no expande instancias** — el campo se guarda pero no genera recurrencias.
5. **Tests visuales acoplados a strings exactos** — frágiles ante cualquier cambio de marcado.
