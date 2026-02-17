-- Test manual de RLS owner-email
-- Requiere que schema_task_owner_email_rls.sql ya se haya ejecutado.
-- Ejecutar en Supabase SQL Editor.
--
-- IMPORTANTE:
-- 1) Sustituye OWNER_UUID por el id real de auth.users para andres5871@gmail.com.
-- 2) Este script crea datos "probe" y luego los elimina.

-- =============================================
-- CONFIG
-- =============================================
-- Reemplazar aqui antes de ejecutar:
-- Ejemplo: '11111111-2222-3333-4444-555555555555'
do $$
declare
  v_owner uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_exists boolean;
begin
  select exists(select 1 from auth.users where id = v_owner) into v_exists;
  if not v_exists then
    raise exception 'OWNER_UUID no existe en auth.users. Reemplaza el valor en el script.';
  end if;
end
$$;

-- =============================================
-- DATOS PROBE (admin bypass RLS)
-- =============================================
do $$
declare
  v_owner uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  v_event uuid := '10000000-0000-0000-0000-000000000000'::uuid;
  v_att uuid := '20000000-0000-0000-0000-000000000000'::uuid;
begin
  insert into public.users (id, email)
  values (v_owner, 'andres5871@gmail.com')
  on conflict (id) do update set email = excluded.email;

  insert into public.events (
    id, user_id, title, start_at, end_at, all_day, source, is_holiday, locked, needs_gcal_sync
  ) values (
    v_event, v_owner, 'RLS probe event', now(), now() + interval '1 hour', false, 'local', false, false, false
  )
  on conflict (id) do update
  set title = excluded.title,
      user_id = excluded.user_id,
      updated_at = now();

  insert into public.attachments (
    id, event_id, user_id, drive_file_id, file_type, file_name
  ) values (
    v_att, v_event, v_owner, 'drive_probe_file', 'text/plain', 'probe.txt'
  )
  on conflict (id) do update
  set event_id = excluded.event_id,
      user_id = excluded.user_id,
      drive_file_id = excluded.drive_file_id;
end
$$;

-- =============================================
-- TEST 1: TOKEN VALIDO (email owner)
-- Esperado: SELECT devuelve 1 fila por tabla y UPDATE afecta 1 fila.
-- =============================================
begin;
  select set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated","email":"andres5871@gmail.com"}',
    true
  );
  set local role authenticated;

  select auth.uid() as uid, auth.jwt() ->> 'email' as email;

  select count(*) as users_rows_visible
  from public.users
  where id = auth.uid();

  select count(*) as events_rows_visible
  from public.events
  where id = '10000000-0000-0000-0000-000000000000'::uuid;

  select count(*) as attachments_rows_visible
  from public.attachments
  where id = '20000000-0000-0000-0000-000000000000'::uuid;

  with upd as (
    update public.events
    set title = 'RLS probe event - owner ok'
    where id = '10000000-0000-0000-0000-000000000000'::uuid
    returning 1
  )
  select count(*) as events_updated_by_owner
  from upd;
rollback;

-- =============================================
-- TEST 2: TOKEN INVALIDO (mismo sub, email distinto)
-- Esperado:
-- - SELECT visibles = 0
-- - INSERT en events falla por RLS (with check)
-- =============================================
begin;
  select set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated","email":"otro.email@gmail.com"}',
    true
  );
  set local role authenticated;

  select auth.uid() as uid, auth.jwt() ->> 'email' as email;

  select count(*) as users_rows_visible
  from public.users
  where id = auth.uid();

  select count(*) as events_rows_visible
  from public.events
  where id = '10000000-0000-0000-0000-000000000000'::uuid;

  select count(*) as attachments_rows_visible
  from public.attachments
  where id = '20000000-0000-0000-0000-000000000000'::uuid;

  -- Debe fallar por RLS; se captura para documentar resultado sin abortar el script.
  do $$
  begin
    insert into public.events (
      id, user_id, title, start_at, end_at, all_day, source
    ) values (
      '30000000-0000-0000-0000-000000000000'::uuid,
      auth.uid(),
      'RLS should block this',
      now(),
      now() + interval '30 minutes',
      false,
      'local'
    );
    raise exception 'ERROR: la insercion invalida no fue bloqueada por RLS.';
  exception
    when others then
      if position('row-level security policy' in lower(sqlerrm)) > 0 then
        raise notice 'OK: insercion bloqueada por RLS: %', sqlerrm;
      else
        raise;
      end if;
  end
  $$;
rollback;

-- =============================================
-- LIMPIEZA (admin bypass RLS)
-- =============================================
delete from public.attachments
where id = '20000000-0000-0000-0000-000000000000'::uuid;

delete from public.events
where id in (
  '10000000-0000-0000-0000-000000000000'::uuid,
  '30000000-0000-0000-0000-000000000000'::uuid
);

-- Nota: no se elimina public.users para no afectar tu fila owner.
