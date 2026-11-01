alter table lms.works add column module integer;
update lms.works w set module=a.module from lms.assignments a where a.id=w.assignment_id;
alter table lms.works alter column module set not null;
