alter policy profiles_read on lms.profiles using (
 id=lms.actor() or lms.is_admin() or
 (lms.active() and exists(select 1 from lms.works w where w.owner_id=profiles.id and lms.can_review(w.assignment_id) and lms.can_read_work(w.id)))
);
