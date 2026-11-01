-- LMS-10: срок проверки задания; LMS-07: необязательный уровень результата (не балл и не допуск).
alter table lms.assignments add column review_due_at timestamptz;
alter table lms.reviews add column level text check(level in ('weak','medium','strong'));
alter table lms.review_drafts add column level text check(level in ('weak','medium','strong'));

create function lms.is_reviewer() returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.reviewers where reviewer_id=lms.actor()) $$;
-- Презентацию проекта фиксирует только ответственный за итоговый пакет (§5.1); администратор — при таком назначении.
create function lms.can_present() returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.reviewers r join lms.assignments a on a.id=r.assignment_id
 where r.reviewer_id=lms.actor() and a.spec->'parts' @> '[{"kind":"versions"}]') $$;

-- Журнал команды показывает каждого участника, в том числе без сдач: проверяющему нужны имена.
alter policy profiles_read on lms.profiles using (
 id=lms.actor() or lms.is_admin() or (lms.is_reviewer() and role='participant') or
 (lms.active() and exists(select 1 from lms.works w where w.owner_id=profiles.id and lms.can_review(w.assignment_id) and lms.can_read_work(w.id))) or
 (lms.active() and exists(select 1 from lms.questions q where q.owner_id=profiles.id and lms.can_answer(q.module)))
);

-- §7.4: факт презентации проекта относится к участнику; «проведена» — с конкретным пакетом или явно без него; «не присутствовал» — без пакета.
create table lms.presentations (
 id uuid primary key default gen_random_uuid(), participant_id uuid not null references lms.profiles,
 outcome text not null check(outcome in ('held','absent')), package_id uuid references lms.submissions,
 without_package boolean not null default false, level text check(level in ('weak','medium','strong')),
 comment text not null default '', author_id uuid not null references lms.profiles,
 replaces_id uuid unique references lms.presentations, reason text, created_at timestamptz not null default clock_timestamp(),
 check((outcome='absent' and package_id is null and not without_package and level is null) or (outcome='held' and ((package_id is not null) <> without_package))),
 check((replaces_id is null and reason is null) or (replaces_id is not null and length(trim(reason))>0))
);
create unique index first_presentation on lms.presentations(participant_id) where replaces_id is null;
create trigger immutable_presentation before update or delete on lms.presentations for each row execute function lms.immutable_record();
alter table lms.presentations enable row level security;
create policy presentations_read on lms.presentations for select to lms_runtime using(lms.active() and (participant_id=lms.actor() or lms.is_admin() or lms.can_present()));
create policy presentations_insert on lms.presentations for insert to lms_runtime with check(author_id=lms.actor() and lms.can_present());
grant select, insert on lms.presentations to lms_runtime;
revoke all on all functions in schema lms from public;
grant execute on all functions in schema lms to lms_runtime;
