-- Подключение приложения отдельно от владельца миграций. Пароль задаётся при развёртывании.
-- Без суперпользователя, BYPASSRLS, создания ролей/баз и владения объектами.
do $$ begin
  create role lms_backend nologin noinherit nosuperuser nobypassrls nocreatedb nocreaterole;
exception when duplicate_object then null; end $$;
grant lms_runtime to lms_backend;
grant usage on schema lms to lms_backend;

-- Почтовый обработчик и проверка входа читают только необходимые таблицы.
do $$ declare item text; begin
  foreach item in array array['profiles','assignments','reviewers','works','submissions','reviews',
    'questions','answers','feedback','materials','sessions','outbox','notifications'] loop
    execute format('grant select on lms.%I to lms_backend',item);
    execute format('create policy backend_read on lms.%I for select to lms_backend using (true)',item);
  end loop;
end $$;
grant update(activated_at,password_set_at) on lms.profiles to lms_backend;
create policy backend_activate on lms.profiles for update to lms_backend using (true) with check (true);
grant insert on lms.outbox to lms_backend;
grant update(processed_at) on lms.outbox to lms_backend;
create policy backend_outbox_insert on lms.outbox for insert to lms_backend with check (true);
create policy backend_outbox_update on lms.outbox for update to lms_backend using (true) with check (true);
grant select,insert,update on lms.rate_limits to lms_backend;
grant insert on lms.notifications to lms_backend;
grant update(status,attempts,next_attempt_at,last_error,provider_id,sent_at) on lms.notifications to lms_backend;
create policy backend_notification_insert on lms.notifications for insert to lms_backend with check (true);
create policy backend_notification_update on lms.notifications for update to lms_backend using (true) with check (true);
