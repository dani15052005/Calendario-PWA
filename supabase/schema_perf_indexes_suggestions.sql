-- Sugerencias de índices para producción (ejecutar manualmente en Supabase SQL Editor).
-- No cambian comportamiento funcional, solo reducen latencia de lecturas/sync.

-- 1) Solapamiento temporal por usuario (queries por rango visible)
create index if not exists idx_events_user_start_end
  on public.events (user_id, start_at, end_at);

-- 2) Incremental sync / reconciliación por Google
create index if not exists idx_events_user_last_synced_at
  on public.events (user_id, last_synced_at desc);

create index if not exists idx_events_user_gcal_updated
  on public.events (user_id, gcal_updated desc);

create index if not exists idx_events_user_needs_gcal_sync
  on public.events (user_id, needs_gcal_sync, updated_at);

create unique index if not exists idx_events_user_google_event_unique
  on public.events (user_id, google_event_id)
  where google_event_id is not null;

-- 3) Adjuntos por evento
create index if not exists idx_attachments_user_event
  on public.attachments (user_id, event_id, created_at);

-- 4) Búsqueda textual básica (title/location/notes)
create extension if not exists pg_trgm;
create index if not exists idx_events_title_trgm
  on public.events using gin (title gin_trgm_ops);
create index if not exists idx_events_location_trgm
  on public.events using gin (location gin_trgm_ops);
create index if not exists idx_events_notes_trgm
  on public.events using gin (notes gin_trgm_ops);

