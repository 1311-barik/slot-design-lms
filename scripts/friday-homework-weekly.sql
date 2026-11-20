-- Каждую пятницу с 27.11.2026 в 12:00 CET: только LMS, только без сдачи.
-- Если на эту пятницу нет опубликованного задания с указанным сроком, уведомлений нет.
with due_assignments as (
  select a.id, a.module, a.spec->>'title' as title
  from lms.assignments a
  where a.published
    and (a.opens_at is null or a.opens_at <= now())
    and a.due_at > now()
    and (a.due_at at time zone 'Europe/Berlin')::date =
        (now() at time zone 'Europe/Berlin')::date
), missing as (
  select p.id as recipient_id, a.module, a.title
  from lms.profiles p cross join due_assignments a
  where p.role = 'participant' and p.revoked_at is null and p.access_ends_at > now()
    and not exists (
      select 1 from lms.submissions s
      join lms.works w on w.id = s.work_id
      where s.owner_id = p.id and w.assignment_id = a.id
    )
), grouped as (
  select recipient_id, count(*)::int as total,
         min(module) as module, string_agg(title, '; ' order by title) as titles
  from missing group by recipient_id
)
insert into lms.notifications
  (dedupe_key, kind, recipient_id, subject, body, link_path, due_at,
   next_attempt_at, status, sent_at, provider_id)
select 'friday-homework-weekly-inapp:' ||
       to_char(now() at time zone 'Europe/Berlin', 'YYYY-MM-DD') || ':' || recipient_id,
       'course.homework.friday.in_app', recipient_id,
       case when total = 1
            then 'Homework due today by 23:59 CET: ' || titles
            else 'Homework due today by 23:59 CET'
       end,
       'You have not yet submitted: ' || titles ||
       '. Please submit in the LMS by 23:59 CET today.',
       '/?module=' || module::text,
       now(), now(), 'sent', now(), 'in-app only'
from grouped
where now() >= '2026-11-27 11:00:00+00'::timestamptz
  and now() < '2027-02-12 00:00:00+00'::timestamptz
  and extract(isodow from now() at time zone 'UTC') = 5
  and extract(hour from now() at time zone 'UTC') = 11
  and extract(minute from now() at time zone 'UTC') < 15
on conflict (dedupe_key) do nothing;
