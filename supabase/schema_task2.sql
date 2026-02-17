-- Task 2 - Estructura backend / Supabase
-- Ejecutar en Supabase SQL Editor

create extension if not exists pgcrypto;

-- =========================
-- Tabla users
-- =========================
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

-- =========================
-- Tabla events
-- =========================
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text,
  notes text,
  url text,
  color text,
  is_holiday boolean not null default false,
  google_event_id text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- Extra para mantener compatibilidad de UI actual
  meta jsonb not null default '{}'::jsonb,
  constraint events_end_after_start check (end_at >= start_at)
);

create index if not exists idx_events_user_start on public.events(user_id, start_at);
create index if not exists idx_events_user_created on public.events(user_id, created_at desc);

-- =========================
-- Tabla attachments
-- =========================
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

-- =========================
-- Trigger updated_at
-- =========================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_events_set_updated_at on public.events;
create trigger trg_events_set_updated_at
before update on public.events
for each row
execute function public.set_updated_at();

-- =========================
-- RLS
-- =========================
alter table public.users enable row level security;
alter table public.users force row level security;

alter table public.events enable row level security;
alter table public.events force row level security;

alter table public.attachments enable row level security;
alter table public.attachments force row level security;

-- USERS
drop policy if exists users_select_own on public.users;
create policy users_select_own
on public.users
for select
to authenticated
using (auth.uid() = id);

drop policy if exists users_insert_own on public.users;
create policy users_insert_own
on public.users
for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists users_update_own on public.users;
create policy users_update_own
on public.users
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- EVENTS
drop policy if exists events_select_own on public.events;
create policy events_select_own
on public.events
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists events_insert_own on public.events;
create policy events_insert_own
on public.events
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists events_update_own on public.events;
create policy events_update_own
on public.events
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists events_delete_own on public.events;
create policy events_delete_own
on public.events
for delete
to authenticated
using (auth.uid() = user_id);

-- ATTACHMENTS
drop policy if exists attachments_select_own on public.attachments;
create policy attachments_select_own
on public.attachments
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists attachments_insert_own on public.attachments;
create policy attachments_insert_own
on public.attachments
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists attachments_update_own on public.attachments;
create policy attachments_update_own
on public.attachments
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists attachments_delete_own on public.attachments;
create policy attachments_delete_own
on public.attachments
for delete
to authenticated
using (auth.uid() = user_id);
