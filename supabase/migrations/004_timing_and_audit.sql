alter table lms.assignments add column opens_at timestamptz;
alter table lms.assignments add constraint opening_before_deadline check(opens_at is null or due_at is null or opens_at<=due_at);
alter table lms.submissions add column due_at_snapshot timestamptz;
alter table lms.submissions alter column submitted_at set default clock_timestamp();
alter policy assignments_read on lms.assignments using(lms.active() and ((published and (opens_at is null or opens_at<=clock_timestamp())) or lms.is_admin() or lms.can_review(id)));
drop function lms.has_active_draft(uuid);
create table lms.audit_events (
 id uuid primary key default gen_random_uuid(), actor_id uuid not null references lms.profiles,
 action text not null, target_id uuid not null, created_at timestamptz not null default clock_timestamp()
);
alter table lms.audit_events enable row level security;
create policy audit_read on lms.audit_events for select to lms_runtime using(lms.is_admin());
create policy audit_insert on lms.audit_events for insert to lms_runtime with check(actor_id=lms.actor() and lms.is_admin());
grant select,insert on lms.audit_events to lms_runtime;
create trigger immutable_audit before update or delete on lms.audit_events for each row execute function lms.immutable_record();
