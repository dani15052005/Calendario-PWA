-- Task: cuarentena para eventos Google con 404 transitorio
-- Ejecutar despues de schema_task2.sql + schema_task3.sql + schema_task3_refine.sql

alter table public.events
  add column if not exists remote_missing boolean not null default false,
  add column if not exists remote_missing_at timestamptz;

-- Higiene de datos: si no esta marcado como missing, no conservar timestamp residual.
update public.events
set remote_missing_at = null
where coalesce(remote_missing, false) = false
  and remote_missing_at is not null;

create index if not exists idx_events_user_remote_missing
  on public.events(user_id, remote_missing, remote_missing_at desc)
  where remote_missing = true;
