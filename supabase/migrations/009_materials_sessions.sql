-- LMS-02: материалы модулей редактирует администратор; аудитория задаётся явно (участники / команда).
-- LMS-04: общие занятия с записью; LMS-10: отметка «изучено». Сроки заданий редактируются из кабинета.
create function lms.is_staff() returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.profiles where id=lms.actor() and role in ('reviewer','admin')) $$;

create table lms.materials (
 id uuid primary key, module integer not null check(module between 0 and 7), position integer not null default 0,
 audience text not null default 'participant' check(audience in ('participant','team')),
 title text not null check(length(trim(title))>0), body text not null default '', links jsonb not null default '[]',
 published boolean not null default false, opens_at timestamptz, revision integer not null default 1,
 updated_at timestamptz not null default clock_timestamp()
);
-- Участник видит название опубликованного будущего материала, но не его содержание (содержание отсекает сервис, файлы — can_read_file).
create function lms.material_visible(m uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.materials x where x.id=m and
 (lms.is_admin() or (x.published and (x.audience='participant' or lms.is_staff())))) $$;
create function lms.material_open(m uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.material_visible(m) and exists(select 1 from lms.materials x where x.id=m and
 (lms.is_admin() or x.opens_at is null or x.opens_at<=clock_timestamp())) $$;
alter table lms.materials enable row level security;
-- Условие по столбцам, а не через material_visible: INSERT … RETURNING должен видеть новую строку.
create policy materials_read on lms.materials for select to lms_runtime using(lms.active() and (lms.is_admin() or (published and (audience='participant' or lms.is_staff()))));
create policy materials_insert on lms.materials for insert to lms_runtime with check(lms.is_admin());
create policy materials_update on lms.materials for update to lms_runtime using(lms.is_admin()) with check(lms.is_admin());
grant select, insert, update on lms.materials to lms_runtime;

create table lms.material_files (
 material_id uuid not null references lms.materials, file_id uuid not null references lms.files, primary key(material_id,file_id)
);
alter table lms.material_files enable row level security;
create policy material_files_read on lms.material_files for select to lms_runtime using(lms.material_open(material_id));
create policy material_files_write on lms.material_files for insert to lms_runtime with check(lms.is_admin());
create policy material_files_delete on lms.material_files for delete to lms_runtime using(lms.is_admin());
grant select, insert, delete on lms.material_files to lms_runtime;

create table lms.material_progress (
 owner_id uuid not null references lms.profiles, material_id uuid not null references lms.materials,
 studied_at timestamptz not null default clock_timestamp(), primary key(owner_id,material_id)
);
alter table lms.material_progress enable row level security;
create policy progress_own on lms.material_progress for all to lms_runtime
 using(lms.active() and (owner_id=lms.actor() or lms.is_admin())) with check(lms.active() and owner_id=lms.actor() and lms.material_open(material_id));
grant select, insert, delete on lms.material_progress to lms_runtime;

create table lms.sessions (
 id uuid primary key, module integer not null check(module between 0 and 7), title text not null check(length(trim(title))>0),
 starts_at timestamptz not null, ends_at timestamptz check(ends_at is null or ends_at>starts_at),
 join_url text, recording_url text, recording_published boolean not null default false, revision integer not null default 1
);
alter table lms.sessions enable row level security;
create policy sessions_read on lms.sessions for select to lms_runtime using(lms.active());
create policy sessions_insert on lms.sessions for insert to lms_runtime with check(lms.is_admin());
create policy sessions_update on lms.sessions for update to lms_runtime using(lms.is_admin()) with check(lms.is_admin());
grant select, insert, update on lms.sessions to lms_runtime;

create policy assignments_update on lms.assignments for update to lms_runtime using(lms.is_admin()) with check(lms.is_admin());
grant update on lms.assignments to lms_runtime;

create or replace function lms.can_read_file(file uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and (exists (
   select 1 from lms.submission_files sf join lms.submissions s on s.id=sf.submission_id
   join lms.works w on w.id=s.work_id where sf.file_id=file
   and (w.owner_id=lms.actor() or lms.is_admin() or lms.can_review(w.assignment_id) or lms.can_read_packaged(s.id))
 ) or exists(select 1 from lms.material_files mf where mf.file_id=file and lms.material_open(mf.material_id))) $$;
revoke all on all functions in schema lms from public;
grant execute on all functions in schema lms to lms_runtime;
