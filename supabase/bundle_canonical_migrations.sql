-- =========================================
-- Bundle canónico — aplica las 10 migraciones del linaje en una sola llamada.
-- Idempotente. Generado por Claude para apply_migration via Management API.
-- =========================================

-- 01: Tablas base + RLS forzada
create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text, notes text, url text, color text,
  is_holiday boolean not null default false,
  google_event_id text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  constraint events_end_after_start check (end_at >= start_at)
);

create index if not exists idx_events_user_start on public.events(user_id, start_at);
create index if not exists idx_events_user_created on public.events(user_id, created_at desc);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  drive_file_id text,
  file_type text,
  file_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_attachments_user_event on public.attachments(user_id, event_id);
create index if not exists idx_attachments_event on public.attachments(event_id);
create unique index if not exists ux_attachments_event_drive
  on public.attachments(event_id, drive_file_id)
  where drive_file_id is not null;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_events_set_updated_at on public.events;
create trigger trg_events_set_updated_at
before update on public.events for each row execute function public.set_updated_at();

alter table public.users enable row level security;
alter table public.users force row level security;
alter table public.events enable row level security;
alter table public.events force row level security;
alter table public.attachments enable row level security;
alter table public.attachments force row level security;

-- 02-04: columnas de sync + multi-calendar + cuarentena + locked
alter table public.events
  add column if not exists last_synced_at timestamptz,
  add column if not exists source text,
  add column if not exists needs_gcal_sync boolean not null default false,
  add column if not exists gcal_updated timestamptz,
  add column if not exists gcal_etag text,
  add column if not exists locked boolean default false,
  add column if not exists remote_missing boolean not null default false,
  add column if not exists remote_missing_at timestamptz,
  add column if not exists google_calendar_id text;

update public.events
set source = case
  when is_holiday then 'holiday'
  when google_event_id is not null then 'google'
  else 'local'
end
where source is null or btrim(source) = '';

alter table public.events alter column source set default 'local';
alter table public.events alter column source set not null;

do $$ begin
  alter table public.events
    add constraint events_source_check check (source in ('local','google','holiday'));
exception when duplicate_object then null; end $$;

create unique index if not exists ux_events_user_google_event_id
  on public.events(user_id, google_event_id) where google_event_id is not null;
create index if not exists idx_events_user_source_updated
  on public.events(user_id, source, updated_at desc);
create index if not exists idx_events_user_last_synced
  on public.events(user_id, last_synced_at desc);
create index if not exists idx_events_user_needs_gcal_sync
  on public.events(user_id, needs_gcal_sync) where needs_gcal_sync = true;
create index if not exists idx_events_user_gcal_updated
  on public.events(user_id, gcal_updated desc);
create index if not exists idx_events_user_remote_missing
  on public.events(user_id, remote_missing, remote_missing_at desc) where remote_missing = true;
create index if not exists idx_events_google_calendar_id on public.events(google_calendar_id);

update public.events
set google_calendar_id = 'primary'
where google_calendar_id is null and coalesce(source, 'local') <> 'holiday';

-- 05: Festivos (dedupe + integridad)
update public.events
set source = 'holiday', is_holiday = true, locked = true,
    needs_gcal_sync = false, google_event_id = null,
    gcal_updated = null, gcal_etag = null, last_synced_at = null
where source = 'holiday' or is_holiday = true;

with ranked as (
  select id, row_number() over (
    partition by user_id, ((start_at at time zone 'Europe/Madrid')::date)
    order by updated_at desc, created_at desc, id
  ) as rn from public.events where source = 'holiday'
) delete from public.events e using ranked r where e.id = r.id and r.rn > 1;

create unique index if not exists ux_events_user_holiday_day_madrid
  on public.events (user_id, ((start_at at time zone 'Europe/Madrid')::date))
  where source = 'holiday';

do $$ begin
  alter table public.events add constraint events_holiday_integrity_check check (
    source <> 'holiday' or (
      is_holiday = true and locked = true
      and coalesce(needs_gcal_sync, false) = false
      and google_event_id is null
    ));
exception when duplicate_object then null; end $$;

-- 06: Adjuntos endurecidos
update public.attachments set drive_file_id = null where btrim(coalesce(drive_file_id, '')) = '';
delete from public.attachments where drive_file_id is null;
alter table public.attachments alter column drive_file_id set not null;

do $$ begin
  alter table public.attachments
    add constraint attachments_drive_file_id_not_blank check (btrim(drive_file_id) <> '');
exception when duplicate_object then null; end $$;

-- 07: Policies owner-email-only
do $$ declare p record; begin
  for p in select policyname from pg_policies where schemaname='public' and tablename='users' loop
    execute format('drop policy if exists %I on public.users', p.policyname); end loop;
  for p in select policyname from pg_policies where schemaname='public' and tablename='events' loop
    execute format('drop policy if exists %I on public.events', p.policyname); end loop;
  for p in select policyname from pg_policies where schemaname='public' and tablename='attachments' loop
    execute format('drop policy if exists %I on public.attachments', p.policyname); end loop;
end $$;

create policy users_select_owner_email on public.users for select to authenticated
  using (auth.uid() = id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');
create policy users_insert_owner_email on public.users for insert to authenticated
  with check (auth.uid() = id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');
create policy users_update_owner_email on public.users for update to authenticated
  using (auth.uid() = id and auth.jwt() ->> 'email' = 'andres5871@gmail.com')
  with check (auth.uid() = id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');
create policy users_delete_owner_email on public.users for delete to authenticated
  using (auth.uid() = id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');

create policy events_select_owner_email on public.events for select to authenticated
  using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');
create policy events_insert_owner_email on public.events for insert to authenticated
  with check (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');
create policy events_update_owner_email on public.events for update to authenticated
  using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com')
  with check (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');
create policy events_delete_owner_email on public.events for delete to authenticated
  using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com');

create policy attachments_select_owner_email on public.attachments for select to authenticated
  using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
    and exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()));
create policy attachments_insert_owner_email on public.attachments for insert to authenticated
  with check (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
    and exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()));
create policy attachments_update_owner_email on public.attachments for update to authenticated
  using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
    and exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()))
  with check (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
    and exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()));
create policy attachments_delete_owner_email on public.attachments for delete to authenticated
  using (auth.uid() = user_id and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
    and exists (select 1 from public.events e where e.id = event_id and e.user_id = auth.uid()));

-- 08: RPC defensiva (versión robusta a casts ::text)
create or replace function public.check_owner_policy_active(
  expected_owner_email text default 'andres5871@gmail.com',
  probe_wrong_email text default null
) returns jsonb language plpgsql security definer
set search_path = public, pg_catalog as $$
declare
  owner_email text := lower(trim(coalesce(expected_owner_email, '')));
  table_name text; tables text[] := array['users', 'events', 'attachments'];
  missing_tables text[] := '{}'; total_policies integer := 0;
  invalid_policies integer := 0; rls_invalid integer := 0; policy_ok boolean;
begin
  if owner_email = '' then return jsonb_build_object('ok', false, 'reason', 'missing_owner_email'); end if;
  foreach table_name in array tables loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=table_name and c.relkind='r'
      and c.relrowsecurity=true and c.relforcerowsecurity=true) then
      rls_invalid := rls_invalid + 1; end if;
    if not exists (select 1 from pg_policies p where p.schemaname='public' and p.tablename=table_name) then
      missing_tables := array_append(missing_tables, table_name); continue; end if;
    total_policies := total_policies + (select count(*) from pg_policies p
      where p.schemaname='public' and p.tablename=table_name);
    invalid_policies := invalid_policies + (select count(*) from pg_policies p
      where p.schemaname='public' and p.tablename=table_name
      and ((position(owner_email in lower(coalesce(p.qual,'')))=0
            and position(owner_email in lower(coalesce(p.with_check,'')))=0)
        or (position('auth.uid()' in lower(coalesce(p.qual,'')))=0
            and position('auth.uid()' in lower(coalesce(p.with_check,'')))=0)));
  end loop;
  policy_ok := (coalesce(array_length(missing_tables,1),0)=0 and rls_invalid=0
    and total_policies>0 and invalid_policies=0);
  return jsonb_build_object('ok', policy_ok, 'total_policies', total_policies,
    'invalid_policies', invalid_policies, 'missing_tables', missing_tables,
    'invalid_rls_tables', rls_invalid);
end; $$;

revoke all on function public.check_owner_policy_active(text, text) from public;
grant execute on function public.check_owner_policy_active(text, text) to authenticated;
