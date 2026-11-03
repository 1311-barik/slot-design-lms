-- Исторические согласия не дополняем задним числом. Новые записи привязаны к показанному PDF.
alter table lms.early_commencement_consents
 add column terms_url text,
 add column terms_sha256 text check(terms_sha256 is null or terms_sha256 ~ '^[a-f0-9]{64}$'),
 add column terms_effective_date date;
alter table lms.early_commencement_consents add constraint consent_terms_complete
 check((terms_url is null and terms_sha256 is null and terms_effective_date is null)
    or (terms_url is not null and terms_sha256 is not null and terms_effective_date is not null));
grant insert(terms_url,terms_sha256,terms_effective_date) on lms.early_commencement_consents to lms_runtime;
