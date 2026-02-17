-- Task: reforzar RLS para owner email unico
-- Ejecutar despues de schema_task2.sql (y posteriores)
-- Objetivo: ningun usuario autenticado distinto a andres5871@gmail.com
-- puede operar en users/events/attachments aunque tenga su propio auth.uid().

begin;

-- Seguridad base RLS
alter table public.users enable row level security;
alter table public.users force row level security;

alter table public.events enable row level security;
alter table public.events force row level security;

alter table public.attachments enable row level security;
alter table public.attachments force row level security;

-- Elimina TODAS las policies existentes en las 3 tablas para evitar
-- que quede alguna policy previa basada solo en auth.uid().
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

-- =========================
-- USERS
-- =========================
create policy users_select_owner_email
on public.users
for select
to authenticated
using (
  auth.uid() = id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

create policy users_insert_owner_email
on public.users
for insert
to authenticated
with check (
  auth.uid() = id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

create policy users_update_owner_email
on public.users
for update
to authenticated
using (
  auth.uid() = id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
)
with check (
  auth.uid() = id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

create policy users_delete_owner_email
on public.users
for delete
to authenticated
using (
  auth.uid() = id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

-- =========================
-- EVENTS
-- =========================
create policy events_select_owner_email
on public.events
for select
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

create policy events_insert_owner_email
on public.events
for insert
to authenticated
with check (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

create policy events_update_owner_email
on public.events
for update
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
)
with check (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

create policy events_delete_owner_email
on public.events
for delete
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
);

-- =========================
-- ATTACHMENTS
-- =========================
create policy attachments_select_owner_email
on public.attachments
for select
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
  and exists (
    select 1
    from public.events e
    where e.id = event_id
      and e.user_id = auth.uid()
  )
);

create policy attachments_insert_owner_email
on public.attachments
for insert
to authenticated
with check (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
  and exists (
    select 1
    from public.events e
    where e.id = event_id
      and e.user_id = auth.uid()
  )
);

create policy attachments_update_owner_email
on public.attachments
for update
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
  and exists (
    select 1
    from public.events e
    where e.id = event_id
      and e.user_id = auth.uid()
  )
)
with check (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
  and exists (
    select 1
    from public.events e
    where e.id = event_id
      and e.user_id = auth.uid()
  )
);

create policy attachments_delete_owner_email
on public.attachments
for delete
to authenticated
using (
  auth.uid() = user_id
  and auth.jwt() ->> 'email' = 'andres5871@gmail.com'
  and exists (
    select 1
    from public.events e
    where e.id = event_id
      and e.user_id = auth.uid()
  )
);

commit;

-- =========================
-- VERIFICACION RAPIDA DE POLICIES ACTIVAS
-- =========================
-- Debe devolver solo las 12 policies *_owner_email de users/events/attachments.
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('users', 'events', 'attachments')
order by tablename, policyname;

-- Debe devolver 0 filas (ninguna policy sin condicion por email).
select schemaname, tablename, policyname, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('users', 'events', 'attachments')
  and (
    coalesce(qual, '') not ilike '%auth.jwt() ->> ''email'' = ''andres5871@gmail.com''%'
    or coalesce(with_check, '') <> ''
       and coalesce(with_check, '') not ilike '%auth.jwt() ->> ''email'' = ''andres5871@gmail.com''%'
  );
