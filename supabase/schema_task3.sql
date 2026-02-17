-- Task 3 - Google sync fields for events
-- Ejecutar despues de schema_task2.sql

alter table public.events
  add column if not exists last_synced_at timestamptz,
  add column if not exists source text;

update public.events
set source = case
  when is_holiday then 'holiday'
  when google_event_id is not null then 'google'
  else 'local'
end
where source is null or btrim(source) = '';

alter table public.events
  alter column source set default 'local';

alter table public.events
  alter column source set not null;

do $$
begin
  alter table public.events
    add constraint events_source_check
    check (source in ('local','google','holiday'));
exception
  when duplicate_object then null;
end
$$;

create unique index if not exists ux_events_user_google_event_id
  on public.events(user_id, google_event_id)
  where google_event_id is not null;

create index if not exists idx_events_user_source_updated
  on public.events(user_id, source, updated_at desc);

create index if not exists idx_events_user_last_synced
  on public.events(user_id, last_synced_at desc);
