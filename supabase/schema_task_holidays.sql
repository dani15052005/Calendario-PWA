-- Task Festivos - persistencia y reglas de integridad
-- Ejecutar despues de schema_task2.sql + schema_task3.sql + schema_task3_refine.sql

-- 1) Normaliza cualquier registro de festivo preexistente
alter table public.events
  add column if not exists locked boolean not null default false;

update public.events
set
  source = 'holiday',
  is_holiday = true,
  locked = true,
  needs_gcal_sync = false,
  google_event_id = null,
  gcal_updated = null,
  gcal_etag = null,
  last_synced_at = null
where source = 'holiday'
   or is_holiday = true;

-- 2) Dedupe por usuario y dia (timezone de Espana)
with ranked as (
  select
    id,
    row_number() over (
      partition by user_id, ((start_at at time zone 'Europe/Madrid')::date)
      order by updated_at desc, created_at desc, id
    ) as rn
  from public.events
  where source = 'holiday'
)
delete from public.events e
using ranked r
where e.id = r.id
  and r.rn > 1;

-- 3) Unico festivo por usuario y dia
create unique index if not exists ux_events_user_holiday_day_madrid
  on public.events (user_id, ((start_at at time zone 'Europe/Madrid')::date))
  where source = 'holiday';

-- 4) Integridad: festivo no se sincroniza con Google

do $$
begin
  alter table public.events
    add constraint events_holiday_integrity_check
    check (
      source <> 'holiday'
      or (
        is_holiday = true
        and locked = true
        and coalesce(needs_gcal_sync, false) = false
        and google_event_id is null
      )
    );
exception
  when duplicate_object then null;
end
$$;
