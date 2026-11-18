-- Отметки изучения доступны только явно назначенному эксперту.
-- Роль reviewer сама по себе этого права не даёт.
create table lms.reviewer_progress_access (
 reviewer_id uuid primary key references lms.profiles(id)
);
alter table lms.reviewer_progress_access enable row level security;
create policy reviewer_progress_access_read on lms.reviewer_progress_access
 for select to lms_runtime using (reviewer_id=lms.actor() or lms.is_admin());
grant select on lms.reviewer_progress_access to lms_runtime;

create function lms.can_view_reviewer_progress() returns boolean language sql stable
 security definer set search_path = '' as $$
 select lms.is_reviewer() and exists (
   select 1 from lms.reviewer_progress_access where reviewer_id=lms.actor()
 ) $$;

create policy progress_assigned_expert_read on lms.material_progress
 for select to lms_runtime using (
   lms.can_view_reviewer_progress() and exists (
     select 1 from lms.profiles p where p.id=owner_id and p.role='participant'
   )
 );
revoke all on function lms.can_view_reviewer_progress() from public;
grant execute on function lms.can_view_reviewer_progress() to lms_runtime;
