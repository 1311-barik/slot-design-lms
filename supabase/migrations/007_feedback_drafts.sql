-- Приватные черновики принадлежат автору и конкретному опубликованному отзыву.
-- Старые тексты сохраняются; редактор не подставляет их, если основание устарело.
alter table lms.review_drafts add column reason text not null default '';
alter table lms.review_drafts add column base_review_id uuid references lms.reviews;
alter table lms.review_drafts drop constraint review_drafts_pkey;
alter table lms.review_drafts add primary key(submission_id,author_id);
drop policy review_drafts_own on lms.review_drafts;
create policy review_drafts_own on lms.review_drafts for all to lms_runtime
using(lms.active() and author_id=lms.actor() and exists(
 select 1 from lms.submissions s join lms.works w on w.id=s.work_id
 where s.id=submission_id and lms.can_review(w.assignment_id)
))
with check(lms.active() and author_id=lms.actor() and exists(
 select 1 from lms.submissions s join lms.works w on w.id=s.work_id
 where s.id=submission_id and lms.can_review(w.assignment_id)
));
