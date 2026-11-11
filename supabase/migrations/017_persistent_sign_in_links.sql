-- Персональные ссылки без таймера. В базе хранится только SHA-256 секрета.
create table lms.sign_in_links (
 id uuid primary key default gen_random_uuid(),
 profile_id uuid not null references lms.profiles,
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default clock_timestamp(),
 revoked_at timestamptz
);
create index sign_in_links_owner on lms.sign_in_links(profile_id);
alter table lms.sign_in_links enable row level security;
grant select on lms.sign_in_links to lms_backend;
grant insert(profile_id,token_hash) on lms.sign_in_links to lms_backend;
create policy backend_read on lms.sign_in_links for select to lms_backend using(true);
create policy backend_insert on lms.sign_in_links for insert to lms_backend with check(
 exists(select 1 from lms.profiles p where p.id=profile_id and p.role='participant' and p.revoked_at is null and p.access_ends_at>now())
);
-- Отзыв доступа отменяет все его ссылки; восстановление профиля их не оживляет.
create function lms.revoke_personal_links() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update lms.sign_in_links set revoked_at=clock_timestamp() where profile_id=new.id and revoked_at is null;
 return new;
end $$;
revoke all on function lms.revoke_personal_links() from public;
create trigger revoke_personal_links after update of revoked_at,role on lms.profiles
 for each row when(new.revoked_at is not null or new.role<>'participant') execute function lms.revoke_personal_links();
