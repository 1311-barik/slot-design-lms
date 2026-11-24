-- Короткий отзыв перед работой в модуле 2. Только внутреннее уведомление, без SMTP.
create table lms.module_feedback_prompts (
 module integer primary key check(module between 0 and 7), request_after timestamptz not null
);
alter table lms.module_feedback_prompts enable row level security;
create policy prompts_read on lms.module_feedback_prompts for select to lms_runtime using(lms.active());
grant select on lms.module_feedback_prompts to lms_runtime;

-- Понедельник 09:00 Лиссабона после занятия; дата берётся из расписания LMS.
-- Первый запуск: не раньше 15:00:35 23 ноября по прямому поручению «через 45 минут».
insert into lms.module_feedback_prompts(module,request_after)
 select 2, greatest((date_trunc('week',min(starts_at) at time zone 'Europe/Lisbon') + interval '7 days 9 hours') at time zone 'Europe/Lisbon', timestamptz '2026-11-23 15:00:35+00')
 from lms.sessions where module=2 having count(*)>0;

create function lms.feedback_required(m integer) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from lms.profiles p join lms.module_feedback_prompts r on r.module=m
 where p.id=lms.actor() and p.role='participant' and r.request_after<=now()
 and not exists(select 1 from lms.feedback f where f.owner_id=p.id and f.module=m)) $$;
revoke all on function lms.feedback_required(integer) from public;
grant execute on function lms.feedback_required(integer) to lms_runtime;

-- Ограничение действует и для прямого API/файлов, а не только для формы в браузере.
create policy feedback_gate on lms.assignments as restrictive for all to lms_runtime using(not lms.feedback_required(module)) with check(not lms.feedback_required(module));
create policy feedback_gate on lms.works as restrictive for all to lms_runtime using(not lms.feedback_required(module)) with check(not lms.feedback_required(module));
create policy feedback_gate on lms.materials as restrictive for all to lms_runtime using(not lms.feedback_required(module)) with check(not lms.feedback_required(module));
create policy feedback_gate on lms.questions as restrictive for all to lms_runtime using(not lms.feedback_required(module)) with check(not lms.feedback_required(module));
create policy feedback_gate on lms.drafts as restrictive for all to lms_runtime using(exists(select 1 from lms.works w where w.id=work_id)) with check(exists(select 1 from lms.works w where w.id=work_id));
create policy feedback_gate on lms.submissions as restrictive for all to lms_runtime using(exists(select 1 from lms.works w where w.id=work_id)) with check(exists(select 1 from lms.works w where w.id=work_id));
create policy feedback_gate on lms.reviews as restrictive for all to lms_runtime using(exists(select 1 from lms.submissions s where s.id=submission_id)) with check(exists(select 1 from lms.submissions s where s.id=submission_id));
create policy feedback_gate on lms.review_drafts as restrictive for all to lms_runtime using(exists(select 1 from lms.submissions s where s.id=submission_id)) with check(exists(select 1 from lms.submissions s where s.id=submission_id));
create policy feedback_gate on lms.material_progress as restrictive for all to lms_runtime using(exists(select 1 from lms.materials m where m.id=material_id)) with check(exists(select 1 from lms.materials m where m.id=material_id));

create or replace function lms.material_open(m uuid) returns boolean language sql stable security definer set search_path='' as $$
 select lms.material_visible(m) and exists(select 1 from lms.materials x where x.id=m and not lms.feedback_required(x.module)
 and (lms.is_admin() or x.opens_at is null or x.opens_at<=clock_timestamp())) $$;
create or replace function lms.can_read_file(file uuid) returns boolean language sql stable security definer set search_path='' as $$
 select lms.active() and (exists (
 select 1 from lms.submission_files sf join lms.submissions s on s.id=sf.submission_id join lms.works w on w.id=s.work_id
 where sf.file_id=file and not lms.feedback_required(w.module)
 and (w.owner_id=lms.actor() or lms.is_admin() or lms.can_review(w.assignment_id) or lms.can_read_packaged(s.id))
 ) or exists(select 1 from lms.material_files mf where mf.file_id=file and lms.material_open(mf.material_id))) $$;

alter table lms.notifications add column channel text not null default 'email' check(channel in ('email','in_app'));
create function lms.schedule_module_feedback() returns void language sql security definer set search_path='' as $$
 insert into lms.notifications(dedupe_key,kind,recipient_id,subject,body,link_path,status,channel)
 select 'module.feedback:'||r.module||':'||p.id,'feedback.requested',p.id,
 'A quick check-in about Module '||r.module,
 'Please share a short comment about the session before continuing in Module '||r.module||'. What helped, and what could be clearer? Your feedback is visible to you and the administrators.',
 '/?module='||r.module,'sent','in_app'
 from lms.module_feedback_prompts r cross join lms.profiles p
 where r.request_after<=now() and p.role='participant' and p.activated_at is not null and p.revoked_at is null and p.access_ends_at>now()
 and not exists(select 1 from lms.feedback f where f.owner_id=p.id and f.module=r.module)
 on conflict(dedupe_key) do nothing $$;
revoke all on function lms.schedule_module_feedback() from public;
grant execute on function lms.schedule_module_feedback() to lms_runtime,lms_backend;
