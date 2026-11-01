-- LMS-09: шапка проекта, её снимок в каждой сдаче и состав итогового пакета.
-- LMS-13: приватные вопросы команде. Самооценки различаются режимом в spec, схема статусов не меняется.
create table lms.project_headers (
 owner_id uuid primary key references lms.profiles, theme text not null default '', audience text not null default '',
 revision integer not null default 0, updated_at timestamptz not null default clock_timestamp()
);
alter table lms.project_headers enable row level security;
create policy project_headers_own on lms.project_headers for all to lms_runtime
 using(lms.active() and (owner_id=lms.actor() or lms.is_admin())) with check(lms.active() and owner_id=lms.actor());
grant select, insert, update on lms.project_headers to lms_runtime;

alter table lms.submissions add column project_snapshot jsonb;

-- Пакет ссылается только на собственные отправленные версии; ссылки неизменяемы, как и сама сдача.
create table lms.package_items (
 package_id uuid not null references lms.submissions, item_id uuid not null references lms.submissions,
 primary key(package_id,item_id), check(package_id<>item_id)
);
create trigger immutable_package_item before update or delete on lms.package_items for each row execute function lms.immutable_record();
create function lms.can_read_packaged(sub uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.package_items pi join lms.submissions p on p.id=pi.package_id
 join lms.works w on w.id=p.work_id where pi.item_id=sub and (lms.is_admin() or lms.can_review(w.assignment_id))) $$;
alter table lms.package_items enable row level security;
create policy package_items_read on lms.package_items for select to lms_runtime using(exists(select 1 from lms.submissions where id=package_id));
create policy package_items_insert on lms.package_items for insert to lms_runtime with check(
 exists(select 1 from lms.submissions where id=package_id and owner_id=lms.actor()) and
 exists(select 1 from lms.submissions where id=item_id and owner_id=lms.actor()));
grant select, insert on lms.package_items to lms_runtime;
-- Проверяющий пакета читает выбранные версии и их вложения, но не остальные работы участника.
alter policy submissions_read on lms.submissions using(lms.can_read_work(work_id) or lms.can_read_packaged(id));
create or replace function lms.can_read_file(file uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists (
   select 1 from lms.submission_files sf join lms.submissions s on s.id=sf.submission_id
   join lms.works w on w.id=s.work_id where sf.file_id=file
   and (w.owner_id=lms.actor() or lms.is_admin() or lms.can_review(w.assignment_id) or lms.can_read_packaged(s.id))
 ) $$;

-- Вопрос без модуля видит только администратор; по модулю — также ответственные за задания этого модуля.
create function lms.can_answer(m integer) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and (lms.is_admin() or (m is not null and exists(select 1 from lms.reviewers r
 join lms.assignments a on a.id=r.assignment_id where a.module=m and r.reviewer_id=lms.actor()))) $$;
create table lms.questions (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references lms.profiles, module integer,
 body text not null check(length(trim(body))>0), created_at timestamptz not null default clock_timestamp()
);
create table lms.answers (
 id uuid primary key default gen_random_uuid(), question_id uuid not null references lms.questions,
 author_id uuid not null references lms.profiles, body text not null check(length(trim(body))>0), source text,
 created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_question before update or delete on lms.questions for each row execute function lms.immutable_record();
create trigger immutable_answer before update or delete on lms.answers for each row execute function lms.immutable_record();
alter table lms.questions enable row level security;
create policy questions_read on lms.questions for select to lms_runtime using(lms.active() and (owner_id=lms.actor() or lms.can_answer(module)));
create policy questions_insert on lms.questions for insert to lms_runtime with check(lms.active() and owner_id=lms.actor());
alter table lms.answers enable row level security;
create policy answers_read on lms.answers for select to lms_runtime using(exists(select 1 from lms.questions where id=question_id));
create policy answers_insert on lms.answers for insert to lms_runtime with check(author_id=lms.actor() and
 exists(select 1 from lms.questions q where q.id=question_id and lms.can_answer(q.module)));
grant select, insert on lms.questions, lms.answers to lms_runtime;
alter policy profiles_read on lms.profiles using (
 id=lms.actor() or lms.is_admin() or
 (lms.active() and exists(select 1 from lms.works w where w.owner_id=profiles.id and lms.can_review(w.assignment_id) and lms.can_read_work(w.id))) or
 (lms.active() and exists(select 1 from lms.questions q where q.owner_id=profiles.id and lms.can_answer(q.module)))
);
revoke all on all functions in schema lms from public;
grant execute on all functions in schema lms to lms_runtime;
