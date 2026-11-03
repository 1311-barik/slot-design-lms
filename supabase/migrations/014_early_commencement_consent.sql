-- Явное согласие при регистрации. Снимок не меняется вместе с профилем или новой редакцией текста.
-- Отсутствие записи означает только отсутствие зафиксированного согласия.
create table lms.early_commencement_consents (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references lms.profiles,
 participant_name text not null,
 participant_email text not null,
 course_key text not null,
 course_title text not null,
 consent_version text not null,
 consent_text text not null,
 source text not null default 'lms_registration' check(source='lms_registration'),
 accepted_at timestamptz not null default clock_timestamp(),
 unique(owner_id,course_key)
);
create trigger immutable_early_commencement_consent before update or delete on lms.early_commencement_consents
 for each row execute function lms.immutable_record();
alter table lms.early_commencement_consents enable row level security;
create policy consent_read on lms.early_commencement_consents for select to lms_runtime
 using(lms.active() and (owner_id=lms.actor() or lms.is_admin()));
create policy consent_insert on lms.early_commencement_consents for insert to lms_runtime
 with check(lms.active() and owner_id=lms.actor() and exists(select 1 from lms.profiles where id=lms.actor() and role='participant'));
grant select on lms.early_commencement_consents to lms_runtime;
-- Дата, источник и id формируются базой, а не входящим запросом.
grant insert(owner_id,participant_name,participant_email,course_key,course_title,consent_version,consent_text)
 on lms.early_commencement_consents to lms_runtime;
grant select on lms.early_commencement_consents to lms_backend;
create policy backend_read on lms.early_commencement_consents for select to lms_backend using(true);
