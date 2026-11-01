-- INSERT RETURNING должен читать владельца новой строки без повторного SELECT из stable-функции.
alter policy works_read on lms.works using(lms.active() and (owner_id=lms.actor() or lms.can_read_work(id)));
