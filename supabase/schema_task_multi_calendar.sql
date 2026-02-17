-- Task multi-calendar sync
-- Ejecutar despues de schema_task2.sql + schema_task3.sql

begin;

alter table public.events
  add column if not exists google_calendar_id text;

create index if not exists idx_events_google_calendar_id
  on public.events(google_calendar_id);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = 'source'
  ) then
    execute $q$
      update public.events
      set google_calendar_id = 'primary'
      where google_calendar_id is null
        and coalesce(source, 'local') <> 'holiday'
    $q$;
  elsif exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = 'category'
  ) then
    execute $q$
      update public.events
      set google_calendar_id = 'primary'
      where google_calendar_id is null
        and coalesce(category, '') <> 'Festivo'
    $q$;
  else
    execute $q$
      update public.events
      set google_calendar_id = 'primary'
      where google_calendar_id is null
    $q$;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = 'google_event_id'
  ) then
    execute 'create unique index if not exists ux_events_user_google_event_id on public.events(user_id, google_event_id) where google_event_id is not null';
  elsif exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'events'
      and column_name = 'gcal_event_id'
  ) then
    execute 'create unique index if not exists ux_events_user_gcal_event_id on public.events(user_id, gcal_event_id) where gcal_event_id is not null';
  end if;
end
$$;

commit;
