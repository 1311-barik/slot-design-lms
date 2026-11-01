-- Закрытая схема не включается в exposed schemas Supabase Data API.
create schema if not exists lms;
do $$ begin create role lms_runtime nologin nosuperuser nobypassrls; exception when duplicate_object then null; end $$;
grant lms_runtime to current_user;
revoke all on schema lms from public;
grant usage on schema lms to lms_runtime;

create table lms.profiles (
 id uuid primary key, email text unique not null, name text not null,
 role text not null check (role in ('participant','reviewer','admin')),
 activated_at timestamptz, revoked_at timestamptz, access_ends_at timestamptz not null,
 created_at timestamptz not null default now()
);
create table lms.assignments (
 id uuid primary key, module integer not null, revision integer not null default 1,
 spec jsonb not null, published boolean not null default false,
 due_at timestamptz, late_policy text not null check (late_policy in ('allow_mark','block_after_due'))
);
create table lms.reviewers (
 assignment_id uuid primary key references lms.assignments, reviewer_id uuid not null references lms.profiles
);
create table lms.works (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references lms.profiles,
 assignment_id uuid not null references lms.assignments, spec jsonb not null, assignment_revision integer not null,
 status text not null default 'draft' check(status in ('draft','submitted','in_review','needs_revision','accepted')),
 unique(owner_id,assignment_id)
);
create table lms.drafts (
 id uuid primary key default gen_random_uuid(), work_id uuid not null references lms.works,
 owner_id uuid not null references lms.profiles, revision integer not null default 0,
 payload jsonb not null default '{"parts":{}}', submitted_at timestamptz, updated_at timestamptz not null default now()
);
create unique index one_active_draft on lms.drafts(work_id) where submitted_at is null;
create table lms.submissions (
 id uuid primary key default gen_random_uuid(), work_id uuid not null references lms.works,
 owner_id uuid not null references lms.profiles, draft_id uuid unique not null references lms.drafts,
 draft_revision integer not null, number integer not null, payload jsonb not null, spec jsonb not null,
 submitted_at timestamptz not null default now(), late boolean not null,
 unique(work_id,number)
);
create table lms.reviews (
 id uuid primary key default gen_random_uuid(), submission_id uuid not null references lms.submissions,
 author_id uuid not null references lms.profiles, action text not null check(action in ('accepted','needs_revision')),
 body text not null, replaces_id uuid unique references lms.reviews, reason text,
 created_at timestamptz not null default now(),
 check ((replaces_id is null and reason is null) or (replaces_id is not null and length(trim(reason)) > 0))
);
create unique index first_decision on lms.reviews(submission_id) where replaces_id is null;
create table lms.review_drafts (
 submission_id uuid primary key references lms.submissions, author_id uuid not null references lms.profiles,
 revision integer not null default 0, body text not null default '', action text not null default 'needs_revision'
);
create table lms.files (
 id uuid primary key, owner_id uuid not null references lms.profiles, name text not null,
 mime text not null, size integer not null check(size > 0 and size <= 50000000), created_at timestamptz not null default now()
);
create table lms.submission_files (
 submission_id uuid not null references lms.submissions, file_id uuid not null references lms.files,
 primary key(submission_id,file_id)
);
create table lms.idempotency (
 actor_id uuid not null, key uuid not null, fingerprint text not null, result jsonb not null,
 primary key(actor_id,key)
);
create table lms.outbox (
 id uuid primary key default gen_random_uuid(), kind text not null, aggregate_id uuid not null,
 created_at timestamptz not null default now(), unique(kind,aggregate_id)
);
-- Тестовые сеансы и ссылки не доступны runtime-роли и не используются в production.
create table lms.dev_tokens (hash text primary key, profile_id uuid not null references lms.profiles, expires_at timestamptz not null, used_at timestamptz);
create table lms.dev_sessions (hash text primary key, profile_id uuid not null references lms.profiles, expires_at timestamptz not null);
create table lms.rate_limits (key text primary key, hits integer not null default 1, window_at timestamptz not null default now());

create function lms.actor() returns uuid language sql stable as $$ select nullif(current_setting('app.actor',true),'')::uuid $$;
create function lms.active() returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from lms.profiles where id=lms.actor() and activated_at is not null and revoked_at is null and access_ends_at>now()) $$;
create function lms.is_admin() returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.profiles where id=lms.actor() and role='admin') $$;
create function lms.can_review(assignment uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.reviewers where assignment_id=assignment and reviewer_id=lms.actor()) $$;
create function lms.can_read_work(work uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select lms.active() and exists(select 1 from lms.works w where w.id=work and
 (w.owner_id=lms.actor() or (exists(select 1 from lms.submissions s where s.work_id=w.id) and (lms.is_admin() or lms.can_review(w.assignment_id))))) $$;
create function lms.has_active_draft(work uuid) returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from lms.drafts d where d.work_id=work and d.submitted_at is null) and lms.can_read_work(work) $$;

alter table lms.profiles enable row level security;
create policy profiles_read on lms.profiles for select to lms_runtime using (id=lms.actor() or lms.is_admin() or (lms.active() and exists(select 1 from lms.works w where w.owner_id=id and lms.can_review(w.assignment_id) and lms.can_read_work(w.id))));
create policy profiles_insert on lms.profiles for insert to lms_runtime with check(lms.is_admin() and role='participant');
create policy profiles_update on lms.profiles for update to lms_runtime using(lms.is_admin()) with check(lms.is_admin());
alter table lms.assignments enable row level security;
create policy assignments_read on lms.assignments for select to lms_runtime using(lms.active() and (published or lms.is_admin() or lms.can_review(id)));
alter table lms.reviewers enable row level security;
create policy reviewers_read on lms.reviewers for select to lms_runtime using(lms.active());
alter table lms.works enable row level security;
create policy works_read on lms.works for select to lms_runtime using(lms.active() and (owner_id=lms.actor() or lms.can_read_work(id)));
create policy works_insert on lms.works for insert to lms_runtime with check(lms.active() and owner_id=lms.actor());
create policy works_update on lms.works for update to lms_runtime using(lms.active() and (owner_id=lms.actor() or lms.can_review(assignment_id)));
alter table lms.drafts enable row level security;
create policy drafts_owner on lms.drafts for all to lms_runtime using(lms.active() and owner_id=lms.actor()) with check(lms.active() and owner_id=lms.actor());
alter table lms.submissions enable row level security;
create policy submissions_read on lms.submissions for select to lms_runtime using(lms.can_read_work(work_id));
create policy submissions_insert on lms.submissions for insert to lms_runtime with check(lms.active() and owner_id=lms.actor());
alter table lms.reviews enable row level security;
create policy reviews_read on lms.reviews for select to lms_runtime using(exists(select 1 from lms.submissions where id=submission_id));
create policy reviews_insert on lms.reviews for insert to lms_runtime with check(author_id=lms.actor() and exists(select 1 from lms.submissions s join lms.works w on w.id=s.work_id where s.id=submission_id and lms.can_review(w.assignment_id)));
alter table lms.review_drafts enable row level security;
create policy review_drafts_own on lms.review_drafts for all to lms_runtime using(lms.active() and author_id=lms.actor()) with check(lms.active() and author_id=lms.actor());
alter table lms.files enable row level security;
create policy files_read on lms.files for select to lms_runtime using(lms.active() and (owner_id=lms.actor() or exists(select 1 from lms.submission_files where file_id=id)));
create policy files_insert on lms.files for insert to lms_runtime with check(lms.active() and owner_id=lms.actor());
alter table lms.submission_files enable row level security;
create policy submission_files_read on lms.submission_files for select to lms_runtime using(exists(select 1 from lms.submissions where id=submission_id));
create policy submission_files_insert on lms.submission_files for insert to lms_runtime with check(exists(select 1 from lms.submissions where id=submission_id and owner_id=lms.actor()) and exists(select 1 from lms.files where id=file_id and owner_id=lms.actor()));
alter table lms.idempotency enable row level security;
create policy idempotency_own on lms.idempotency for all to lms_runtime using(actor_id=lms.actor() and lms.active()) with check(actor_id=lms.actor() and lms.active());
alter table lms.outbox enable row level security;
create policy outbox_insert on lms.outbox for insert to lms_runtime with check(lms.active());
grant select, insert, update on lms.profiles, lms.works, lms.drafts, lms.review_drafts to lms_runtime;
grant select on lms.assignments, lms.reviewers to lms_runtime;
grant select, insert on lms.submissions, lms.reviews, lms.files, lms.submission_files, lms.idempotency to lms_runtime;
grant insert on lms.outbox to lms_runtime;
revoke all on all functions in schema lms from public;
grant execute on all functions in schema lms to lms_runtime;

create function lms.immutable_record() returns trigger language plpgsql as $$ begin raise exception 'Immutable record'; end $$;
create trigger immutable_submission before update or delete on lms.submissions for each row execute function lms.immutable_record();
create trigger immutable_review before update or delete on lms.reviews for each row execute function lms.immutable_record();
