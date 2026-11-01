-- LMS-11: письма и уведомления в интерфейсе. Планирует и отправляет фоновый обработчик (scripts/mail-worker.ts)
-- под служебным подключением; браузер видит только свои уведомления, администратор — очередь и ошибки.
alter table lms.profiles add column timezone text;
alter table lms.outbox add column processed_at timestamptz;
alter table lms.outbox add column payload jsonb not null default '{}';
-- События до появления почты не рассылаются задним числом.
update lms.outbox set processed_at=clock_timestamp() where processed_at is null;

create table lms.notifications (
 id uuid primary key default gen_random_uuid(),
 dedupe_key text unique not null, kind text not null, recipient_id uuid not null references lms.profiles,
 subject text not null, body text not null, link_path text not null default '/',
 -- ref_id/ref_version: объект и его версия (например, время занятия); перед отправкой сверяются с текущими.
 ref_id uuid, ref_version text,
 due_at timestamptz not null default clock_timestamp(), not_after timestamptz,
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','unknown','cancelled','missed')),
 attempts integer not null default 0, next_attempt_at timestamptz not null default clock_timestamp(), last_error text,
 provider_id text, created_at timestamptz not null default clock_timestamp(), sent_at timestamptz, read_at timestamptz
);
create index notifications_queue on lms.notifications(status, next_attempt_at);
alter table lms.notifications enable row level security;
-- Пропущенные и отменённые письма участнику не показываются.
create policy notifications_read on lms.notifications for select to lms_runtime
 using(lms.active() and ((recipient_id=lms.actor() and status not in ('cancelled','missed')) or lms.is_admin()));
create policy notifications_mark_read on lms.notifications for update to lms_runtime
 using(lms.active() and recipient_id=lms.actor()) with check(lms.active() and recipient_id=lms.actor());
create policy notifications_admin on lms.notifications for update to lms_runtime using(lms.is_admin()) with check(lms.is_admin());
-- Из интерфейса меняются только отметка прочтения и состояние для повторной отправки, не текст письма.
grant select on lms.notifications to lms_runtime;
grant update (read_at, status, next_attempt_at, last_error) on lms.notifications to lms_runtime;
-- Участник меняет в своём профиле только зону для писем; остальной профиль правит администратор.
create function lms.set_timezone(zone text) returns text language sql volatile security definer set search_path = '' as $$
 update lms.profiles set timezone=zone where id=lms.actor() and lms.active() returning timezone $$;
revoke all on all functions in schema lms from public;
grant execute on all functions in schema lms to lms_runtime;
