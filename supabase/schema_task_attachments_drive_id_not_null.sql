-- Task: endurecer adjuntos para impedir metadata huerfana
-- Ejecutar despues de schema_task2.sql

begin;

-- 1) Normaliza valores vacios a NULL para limpieza consistente
update public.attachments
set drive_file_id = null
where btrim(coalesce(drive_file_id, '')) = '';

-- 2) Elimina metadata huerfana previa (sin enlace real a Drive)
delete from public.attachments
where drive_file_id is null;

-- 3) Endurece esquema
alter table public.attachments
  alter column drive_file_id set not null;

-- 4) Evita strings vacios
do $$
begin
  alter table public.attachments
    add constraint attachments_drive_file_id_not_blank
    check (btrim(drive_file_id) <> '');
exception
  when duplicate_object then null;
end
$$;

commit;
