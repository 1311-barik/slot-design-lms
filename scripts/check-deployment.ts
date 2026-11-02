import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';
import { deploymentEnvironment, projectArgument } from './deployment-env';

const target = deploymentEnvironment(process.env, 'runtime', projectArgument());
const database = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, connect_timeout: 15 });
const requireCheck = (ok: unknown, description: string) => { if (!ok) throw new Error(description); console.log(`OK: ${description}`); };
try {
  const [role] = await database`select current_user as name, rolsuper, rolinherit, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname=current_user`;
  requireCheck(role.name === 'lms_backend' && !role.rolsuper && !role.rolinherit && !role.rolbypassrls && !role.rolcreatedb && !role.rolcreaterole, 'restricted runtime database role');
  // OID из каталога: lookup по имени auth.users сам требует USAGE на закрытую схему Auth.
  const [privileges] = await database`select has_table_privilege(current_user,'lms.drafts','select') as drafts,
    has_table_privilege(current_user,(select c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and c.relname='users'),'select') as auth_users`;
  requireCheck(privileges.drafts === false && privileges.auth_users === false, 'no direct access to private drafts or Auth users');
  await database.begin(async tx => {
    await tx`set transaction read only`;
    await tx`set local role lms_runtime`;
    await tx`select id from lms.profiles limit 0`;
  });
  console.log('OK: domain role and schema available');
  const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) } });
  const { data: bucket, error } = await client.storage.getBucket(process.env.SUPABASE_STORAGE_BUCKET!);
  requireCheck(!error && bucket && !bucket.public, 'private Storage bucket accessible');
  const probe = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?select=id&limit=0`, { headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'Accept-Profile': 'lms' }, signal: AbortSignal.timeout(15000) });
  const body = await probe.json().catch(() => ({}));
  requireCheck(probe.status === 406 && body.code === 'PGRST106', 'lms schema excluded from Data API');
  const queue = await database`select status,count(*)::int as count from lms.notifications where status in ('pending','sending') group by status`;
  console.log('Mail queue counts:', JSON.stringify(queue));
  console.log(`Configuration ready for ${target.origin.origin}. No mail sent and no user data changed. Complete HTTPS and real sign-in checks separately.`);
} catch (error) {
  // Внешняя ошибка может содержать DSN: выводим только код/тип. Наши проверки дают фиксированное имя.
  const message = error instanceof Error && /^(restricted|no direct|private Storage|lms schema)/.test(error.message) ? error.message : 'Database or Supabase access check failed';
  console.error(message, typeof error === 'object' && error && 'code' in error ? error.code : '');
  process.exitCode = 1;
} finally { await database.end(); }
