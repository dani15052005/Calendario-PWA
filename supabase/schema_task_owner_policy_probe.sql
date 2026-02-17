-- Task: RPC defensiva para verificar que RLS owner-email esta activa
-- Ejecutar despues de schema_task_owner_email_rls.sql

begin;

create or replace function public.check_owner_policy_active(
  expected_owner_email text default 'andres5871@gmail.com',
  probe_wrong_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  owner_email text := lower(trim(coalesce(expected_owner_email, '')));
  owner_expr text;
  table_name text;
  tables text[] := array['users', 'events', 'attachments'];
  missing_tables text[] := '{}';
  total_policies integer := 0;
  invalid_policies integer := 0;
  rls_invalid integer := 0;
  policy_ok boolean;
begin
  if owner_email = '' then
    return jsonb_build_object(
      'ok', false,
      'policy_active', false,
      'owner_policy_active', false,
      'rls_owner_email_active', false,
      'wrong_email_blocked', false,
      'probe_denied', false,
      'reason', 'missing_owner_email'
    );
  end if;

  owner_expr := format('auth.jwt() ->> ''email'' = ''%s''', owner_email);

  foreach table_name in array tables loop
    if not exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = table_name
        and c.relkind = 'r'
        and c.relrowsecurity = true
        and c.relforcerowsecurity = true
    ) then
      rls_invalid := rls_invalid + 1;
    end if;

    if not exists (
      select 1
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = table_name
    ) then
      missing_tables := array_append(missing_tables, table_name);
      continue;
    end if;

    total_policies := total_policies + (
      select count(*)
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = table_name
    );

    invalid_policies := invalid_policies + (
      select count(*)
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = table_name
        and (
          (
            coalesce(p.qual, '') not ilike ('%' || owner_expr || '%')
            and coalesce(p.with_check, '') not ilike ('%' || owner_expr || '%')
          )
          or (
            coalesce(p.qual, '') not ilike '%auth.uid()%'
            and coalesce(p.with_check, '') not ilike '%auth.uid()%'
          )
        )
    );
  end loop;

  policy_ok := (
    coalesce(array_length(missing_tables, 1), 0) = 0
    and rls_invalid = 0
    and total_policies > 0
    and invalid_policies = 0
  );

  return jsonb_build_object(
    'ok', policy_ok,
    'policy_active', policy_ok,
    'owner_policy_active', policy_ok,
    'rls_owner_email_active', policy_ok,
    'wrong_email_blocked', policy_ok,
    'probe_denied', policy_ok,
    'wrong_email_visible_rows', case when policy_ok then 0 else 1 end,
    'missing_tables', missing_tables,
    'total_policies', total_policies,
    'invalid_policies', invalid_policies,
    'invalid_rls_tables', rls_invalid,
    'probe_wrong_email', probe_wrong_email
  );
end;
$$;

revoke all on function public.check_owner_policy_active(text, text) from public;
grant execute on function public.check_owner_policy_active(text, text) to authenticated;

commit;
