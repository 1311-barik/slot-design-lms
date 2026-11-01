-- Убирает циклическое раскрытие RLS при INSERT в submission_files.
create function lms.can_read_file(file uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists (
   select 1 from lms.submission_files sf join lms.submissions s on s.id=sf.submission_id
   join lms.works w on w.id=s.work_id where sf.file_id=file
   and (w.owner_id=lms.actor() or lms.is_admin() or lms.can_review(w.assignment_id))
 ) $$;
revoke all on function lms.can_read_file(uuid) from public;
grant execute on function lms.can_read_file(uuid) to lms_runtime;
alter policy files_read on lms.files using(lms.active() and (owner_id=lms.actor() or lms.can_read_file(id)));

create table lms.review_claims (
 id uuid primary key default gen_random_uuid(), submission_id uuid unique not null references lms.submissions,
 reviewer_id uuid not null references lms.profiles, claimed_at timestamptz not null default now()
);
alter table lms.review_claims enable row level security;
create policy claims_read on lms.review_claims for select to lms_runtime using(exists(select 1 from lms.submissions where id=submission_id));
create policy claims_insert on lms.review_claims for insert to lms_runtime with check(reviewer_id=lms.actor() and exists(select 1 from lms.submissions s join lms.works w on w.id=s.work_id where s.id=submission_id and lms.can_review(w.assignment_id)));
grant select,insert on lms.review_claims to lms_runtime;
create trigger immutable_claim before update or delete on lms.review_claims for each row execute function lms.immutable_record();
