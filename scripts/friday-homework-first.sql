-- Одно объявление всем студентам 20.11.2026 в 12:00 CET.
-- Запускается единоразовым systemd timer; письмо уходит через существующий mail worker.
-- Оба канала создаются одной транзакцией (psql --single-transaction).
with recipients as (
  select id, name from lms.profiles
  where role = 'participant' and revoked_at is null and access_ends_at > now()
), message as (
  select
    'Homework is due every Friday by 23:59 CET'::text as subject,
    E'Hi ' || name || E',\n\nPlease submit each week\'s homework in the LMS by Friday at 23:59 CET (UTC+1). Assignment 1.2 in Module 1 is due today, 20 November, at 23:59 CET.\n\nIf you have already submitted it, no action is needed. Check each assignment in the LMS for its published deadline.\n\nOpen the LMS: https://lms.talentgrator.com/?module=1\n\n— Slot Design · From idea to release' as body,
    id
  from recipients
)
insert into lms.notifications
  (dedupe_key, kind, recipient_id, subject, body, link_path, due_at, next_attempt_at, not_after, status)
select 'friday-homework-first-email:2026-11-20:' || id,
       'course.homework.friday.announce', id, subject, body, '/?module=1',
       '2026-11-20 11:00:00+00'::timestamptz, now(),
       '2026-11-20 11:15:00+00'::timestamptz, 'pending'
from message
where now() >= '2026-11-20 11:00:00+00'::timestamptz
  and now() < '2026-11-20 11:15:00+00'::timestamptz
on conflict (dedupe_key) do nothing;

with recipients as (
  select id from lms.profiles
  where role = 'participant' and revoked_at is null and access_ends_at > now()
)
insert into lms.notifications
  (dedupe_key, kind, recipient_id, subject, body, link_path, due_at, next_attempt_at, status, sent_at, provider_id)
select 'friday-homework-first-inapp:2026-11-20:' || id,
       'course.homework.friday.in_app', id,
       'Homework is due every Friday by 23:59 CET',
       E'Submit each week\'s homework in the LMS by Friday at 23:59 CET. Assignment 1.2 in Module 1 is due today, 20 November. If you have already submitted it, no action is needed.',
       '/?module=1', '2026-11-20 11:00:00+00'::timestamptz,
       now(), 'sent', now(), 'in-app only'
from recipients
where now() >= '2026-11-20 11:00:00+00'::timestamptz
  and now() < '2026-11-20 11:15:00+00'::timestamptz
on conflict (dedupe_key) do nothing;
