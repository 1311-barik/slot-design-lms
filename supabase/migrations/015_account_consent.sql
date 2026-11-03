-- Позднее согласие сохраняется с фактической датой и отдельным источником.
alter table lms.early_commencement_consents drop constraint early_commencement_consents_source_check;
alter table lms.early_commencement_consents add constraint early_commencement_consents_source_check
 check(source in ('lms_registration','lms_account'));
grant insert(source) on lms.early_commencement_consents to lms_runtime;
