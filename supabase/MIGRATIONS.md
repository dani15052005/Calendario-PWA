# Migraciones Supabase — Orden canónico

> **Lee esto antes de ejecutar cualquier `.sql` contra producción.**

Este proyecto NO usa Supabase CLI migrations (`supabase/migrations/<timestamp>_*.sql`). Las migraciones son archivos sueltos `schema_*.sql` que se aplican manualmente en orden.

---

## Linaje canónico (aplicar en este orden, idempotente)

| # | Archivo | Qué hace |
|---|---------|----------|
| 1 | `schema_task2.sql` | Crea `users`, `events`, `attachments`. Activa RLS con `force row level security` y policies básicas por `auth.uid()`. |
| 2 | `schema_task3.sql` | Añade `last_synced_at`, `source` (`local`/`google`/`holiday`) a `events`. Crea índices de sync. |
| 3 | `schema_task3_refine.sql` | Añade `needs_gcal_sync`, `gcal_updated`, `gcal_etag` a `events`. Backfill desde `meta`. |
| 4 | `schema_task_stability_events_columns.sql` | Asegura que `url`, `locked`, `is_holiday`, `meta`, `google_event_id`, `google_calendar_id`, `remote_missing*` existen. |
| 5 | `schema_task_holidays.sql` | Añade `locked`, deduplica festivos, `unique index` por `(user_id, fecha)` y `check` de integridad. |
| 6 | `schema_task_remote_missing_quarantine.sql` | Añade `remote_missing` + `remote_missing_at` con índice parcial. |
| 7 | `schema_task_multi_calendar.sql` | Añade `google_calendar_id`, índices, unique por `google_event_id`. |
| 8 | `schema_task_attachments_drive_id_not_null.sql` | Endurece `attachments.drive_file_id NOT NULL` y `CHECK` no-blank. |
| 9 | `schema_task_owner_email_rls.sql` | **Reemplaza** todas las policies por owner-email-only. Esto es lo que hace la app realmente privada. |
| 10 | `schema_task_owner_policy_probe.sql` | RPC `check_owner_policy_active()` para verificar runtime. |

### Opcionales / one-shot
- `schema_perf_indexes_suggestions.sql` — índices adicionales de performance (`pg_trgm` para búsqueda).
- `schema_task_owner_email_rls_test.sql` — script de prueba MANUAL. Requiere editar el `OWNER_UUID` antes de ejecutar. **No ejecutar tal cual.**

---

## ⚠️ Archivos deprecados

### `_DEPRECATED_schema_full_production.sql.txt`

Contiene un schema "completo desde cero" que usa columnas **incompatibles con el código actual**:

| Schema deprecado usa | El código espera |
|---|---|
| `gcal_event_id` | `google_event_id` |
| `category` | (no existe; se usa `meta`/`is_holiday`/`source`) |

Si lo aplicas, romperás el SELECT de [data/queries.js](../data/queries.js) y todos los flujos de sync. Renombrado a `.txt` para que ningún editor SQL lo ejecute por accidente.

---

## Columnas esperadas por el código

`data/queries.js` define `SB_EVENT_SELECT_COLUMNS`. Las siguientes columnas DEBEN existir en `public.events` después de aplicar el linaje 1-9:

```
id, title, start_at, end_at, all_day,
location, notes, url, color, locked, is_holiday,
source, last_synced_at,
remote_missing, remote_missing_at,
needs_gcal_sync, gcal_updated, gcal_etag,
google_event_id, google_calendar_id,
meta, created_at, updated_at
```

Y en `public.attachments`:

```
id, event_id, drive_file_id, file_type, file_name, created_at
```

El test [tests/schema-columns-match-queries.test.js](../tests/schema-columns-match-queries.test.js) verifica esta correspondencia automáticamente.

---

## Verificar el estado real de la DB

Conéctate al SQL Editor de Supabase y ejecuta:

```sql
-- 1) Columnas reales de events
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'events'
order by ordinal_position;

-- 2) Policies activas (deben ser 12: 4 por tabla, todas con email owner)
select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('users','events','attachments')
order by tablename, policyname;

-- 3) Verificación rápida vía RPC
select public.check_owner_policy_active();
-- debe devolver { "ok": true, ... }
```
