-- Task 3 refine - Google sync state columns
-- Ejecutar despues de schema_task2.sql y schema_task3.sql

alter table public.events
  add column if not exists needs_gcal_sync boolean not null default false,
  add column if not exists gcal_updated timestamptz,
  add column if not exists gcal_etag text;

-- Backfill desde meta (compatibilidad con versiones previas)
update public.events
set needs_gcal_sync = coalesce((meta ->> 'needsGCalSync')::boolean, false)
where meta ? 'needsGCalSync';

update public.events
set gcal_updated = nullif(meta ->> 'gcalUpdated', '')::timestamptz
where gcal_updated is null
  and meta ? 'gcalUpdated'
  and nullif(meta ->> 'gcalUpdated', '') is not null;

-- Integridad para evitar duplicados por google_event_id
create unique index if not exists ux_events_user_google_event_id
  on public.events(user_id, google_event_id)
  where google_event_id is not null;

create index if not exists idx_events_user_needs_gcal_sync
  on public.events(user_id, needs_gcal_sync)
  where needs_gcal_sync = true;

create index if not exists idx_events_user_gcal_updated
  on public.events(user_id, gcal_updated desc);
