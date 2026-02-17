-- ===============================================================
-- schema_full_production.sql
-- Supabase schema completo desde cero (idempotente)
-- ===============================================================

begin;

create extension if not exists pgcrypto;

-- ===============================================================
-- 1) TABLA users
-- ===============================================================

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Retro-fit idempotente si la tabla ya existia sin todas las columnas.
alter table public.users
  add column if not exists email text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.users
set
  email = coalesce(email, ''),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now())
where email is null
   or created_at is null
   or updated_at is null;

alter table public.users
  alter column email set not null,
  alter column created_at set not null,
  alter column updated_at set not null;

-- ===============================================================
-- 2) TABLA events
-- ===============================================================

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text,
  notes text,
  category text,
  color text,
  gcal_event_id text,
  google_calendar_id text,
  needs_gcal_sync boolean not null default false,
  remote_missing boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Retro-fit idempotente.
alter table public.events
  add column if not exists user_id uuid,
  add column if not exists title text,
  add column if not exists start_at timestamptz,
  add column if not exists end_at timestamptz,
  add column if not exists all_day boolean default false,
  add column if not exists location text,
  add column if not exists notes text,
  add column if not exists category text,
  add column if not exists color text,
  add column if not exists gcal_event_id text,
  add column if not exists google_calendar_id text,
  add column if not exists needs_gcal_sync boolean default false,
  add column if not exists remote_missing boolean default false,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

update public.events
set
  title = coalesce(title, ''),
  google_calendar_id = coalesce(google_calendar_id, case when coalesce(category, '') = 'Festivo' then null else 'primary' end),
  all_day = coalesce(all_day, false),
  needs_gcal_sync = coalesce(needs_gcal_sync, false),
  remote_missing = coalesce(remote_missing, false),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, now())
where title is null
   or google_calendar_id is null
   or all_day is null
   or needs_gcal_sync is null
   or remote_missing is null
   or created_at is null
   or updated_at is null;

alter table public.events
  alter column user_id set not null,
  alter column title set not null,
  alter column start_at set not null,
  alter column end_at set not null,
  alter column all_day set default false,
  alter column all_day set not null,
  alter column needs_gcal_sync set default false,
  alter column needs_gcal_sync set not null,
  alter column remote_missing set default false,
  alter column remote_missing set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

do $$
begin
  alter table public.events
    add constraint events_end_after_start_check
    check (end_at >= start_at);
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table public.events
    add constraint events_user_fk
    foreign key (user_id)
    references public.users(id)
    on delete cascade;
exception
  when duplicate_object then null;
end
$$;

-- ===============================================================
-- 3) TABLA attachments
-- ===============================================================

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  drive_file_id text not null,
  filename text,
  mime_type text,
  created_at timestamptz not null default now()
);

-- Retro-fit idempotente.
alter table public.attachments
  add column if not exists event_id uuid,
  add column if not exists user_id uuid,
  add column if not exists drive_file_id text,
  add column if not exists filename text,
  add column if not exists mime_type text,
  add column if not exists created_at timestamptz default now();

update public.attachments
set
  drive_file_id = coalesce(drive_file_id, ''),
  created_at = coalesce(created_at, now())
where drive_file_id is null
   or created_at is null;

delete from public.attachments
where btrim(coalesce(drive_file_id, '')) = '';

alter table public.attachments
  alter column event_id set not null,
  alter column user_id set not null,
  alter column drive_file_id set not null,
  alter column created_at set default now(),
  alter column created_at set not null;

do $$
begin
  alter table public.attachments
    add constraint attachments_event_fk
    foreign key (event_id)
    references public.events(id)
    on delete cascade;
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table public.attachments
    add constraint attachments_user_fk
    foreign key (user_id)
    references public.users(id)
    on delete cascade;
exception
  when duplicate_object then null;
end
$$;

-- ===============================================================
-- 4) INDICES REQUERIDOS
-- ===============================================================

create index if not exists idx_events_user_start_at
  on public.events(user_id, start_at);

create index if not exists idx_events_user_end_at
  on public.events(user_id, end_at);

create index if not exists idx_events_gcal_event_id
  on public.events(gcal_event_id);

create index if not exists idx_events_google_calendar_id
  on public.events(google_calendar_id);

create index if not exists idx_attachments_event_id
  on public.attachments(event_id);

create index if not exists idx_attachments_user_id
  on public.attachments(user_id);

-- ===============================================================
-- 5) TRIGGER updated_at automatico
-- ===============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_users_set_updated_at on public.users;
create trigger trg_users_set_updated_at
before update on public.users
for each row
execute function public.set_updated_at();

drop trigger if exists trg_events_set_updated_at on public.events;
create trigger trg_events_set_updated_at
before update on public.events
for each row
execute function public.set_updated_at();

-- ===============================================================
-- 6) RLS + POLICIES (owner email)
-- ===============================================================

alter table public.users enable row level security;
alter table public.events enable row level security;
alter table public.attachments enable row level security;

-- Limpieza de policies previas (idempotente).
do $$
declare p record;
begin
  for p in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'users'
  loop
    execute format('drop policy if exists %I on public.users', p.policyname);
  end loop;

  for p in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'events'
  loop
    execute format('drop policy if exists %I on public.events', p.policyname);
  end loop;

  for p in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'attachments'
  loop
    execute format('drop policy if exists %I on public.attachments', p.policyname);
  end loop;
end
$$;

-- users (equivalente a user_id => id)
create policy users_select_owner
on public.users
for select
to authenticated
using (
  auth.uid() = id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy users_insert_owner
on public.users
for insert
to authenticated
with check (
  auth.uid() = id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy users_update_owner
on public.users
for update
to authenticated
using (
  auth.uid() = id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
)
with check (
  auth.uid() = id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy users_delete_owner
on public.users
for delete
to authenticated
using (
  auth.uid() = id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

-- events
create policy events_select_owner
on public.events
for select
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy events_insert_owner
on public.events
for insert
to authenticated
with check (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy events_update_owner
on public.events
for update
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
)
with check (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy events_delete_owner
on public.events
for delete
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

-- attachments
create policy attachments_select_owner
on public.attachments
for select
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy attachments_insert_owner
on public.attachments
for insert
to authenticated
with check (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy attachments_update_owner
on public.attachments
for update
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
)
with check (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

create policy attachments_delete_owner
on public.attachments
for delete
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt()->>'email' = 'andres5871@gmail.com'
);

commit;
