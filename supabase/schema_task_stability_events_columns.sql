-- Phase 3: Alinear esquema de events sin borrar datos existentes.
-- No modifica indices existentes.

alter table public.events
  add column if not exists url text,
  add column if not exists locked boolean default false,
  add column if not exists is_holiday boolean default false,
  add column if not exists last_synced_at timestamptz,
  add column if not exists remote_missing boolean default false,
  add column if not exists remote_missing_at timestamptz,
  add column if not exists needs_gcal_sync boolean default false,
  add column if not exists gcal_updated timestamptz,
  add column if not exists gcal_etag text,
  add column if not exists google_event_id text,
  add column if not exists google_calendar_id text,
  add column if not exists meta jsonb default '{}'::jsonb;
