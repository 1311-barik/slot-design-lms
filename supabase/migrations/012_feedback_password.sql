-- Решение Александра 31.10.2026: после первого входа по ссылке участник может создать пароль;
-- ссылка остаётся запасным входом. Пароль в рабочей среде хранит Supabase Auth, здесь — только факт.
alter table lms.profiles add column password_set_at timestamptz;
-- Только для LMS_MODE=local: хеш scrypt для синтетических аккаунтов. runtime-роли не доступен.
create table lms.dev_passwords (profile_id uuid primary key references lms.profiles, hash text not null, updated_at timestamptz not null default now());

-- Обратная связь о курсе в любой момент: видят автор и администраторы, записи неизменяемы.
create table lms.feedback (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references lms.profiles,
 module integer check(module between 0 and 7), rating integer check(rating between 1 and 5),
 body text not null check(length(trim(body))>0), created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_feedback before update or delete on lms.feedback for each row execute function lms.immutable_record();
alter table lms.feedback enable row level security;
create policy feedback_read on lms.feedback for select to lms_runtime using(lms.active() and (owner_id=lms.actor() or lms.is_admin()));
create policy feedback_insert on lms.feedback for insert to lms_runtime with check(lms.active() and owner_id=lms.actor());
grant select, insert on lms.feedback to lms_runtime;
