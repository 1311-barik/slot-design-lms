import { isAbsolute } from 'node:path';

type Environment = Record<string, string | undefined>;
// Проверка до подключения. Ошибки называют параметр, но никогда не его секретное значение.
export function deploymentEnvironment(env: Environment, purpose: 'runtime' | 'admin', expectedProject: string) {
  const fail = (message: string): never => { throw new Error(message); };
  if (!/^[a-z0-9]{20}$/.test(expectedProject)) fail('Provide --project-ref with the 20-character Supabase project reference.');
  if (env.LMS_MODE !== 'supabase') fail('LMS_MODE must be supabase.');
  const required = ['APP_ORIGIN', 'DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET', 'LMS_RUNTIME_DIR'];
  for (const key of required) {
    if (!env[key] || /REPLACE_|YOUR[-_ ]|\bPROJECT\b/.test(env[key]!)) fail(`${key} is missing or contains a placeholder.`);
  }
  const parse = (key: string) => { try { return new URL(env[key]!); } catch { return fail(`${key} is not a valid URL.`); } };
  const origin = parse('APP_ORIGIN');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' || origin.port) fail('APP_ORIGIN must be an HTTPS origin on port 443, without a path, query or credentials.');
  if (['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) fail('APP_ORIGIN must be the public LMS address.');
  if (env.APP_ORIGIN !== origin.origin) fail('APP_ORIGIN must not have a trailing slash; use the exact HTTPS origin.');
  const supabase = parse('SUPABASE_URL');
  if (supabase.origin !== `https://${expectedProject}.supabase.co` || supabase.pathname !== '/' || supabase.search || supabase.hash || supabase.username || supabase.password) fail('SUPABASE_URL does not match --project-ref.');
  const database = parse('DATABASE_URL');
  const user = purpose === 'runtime' ? 'lms_backend' : 'postgres';
  const direct = database.hostname === `db.${expectedProject}.supabase.co` && database.username === user;
  const pooled = database.hostname.endsWith('.pooler.supabase.com') && database.username === `${user}.${expectedProject}`;
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !(direct || pooled) || database.pathname !== '/postgres' || (database.port && database.port !== '5432')) fail(`DATABASE_URL must use ${user} and this project, with a direct connection or Session pooler on port 5432.`);
  if (!database.password || !['require', 'verify-ca', 'verify-full'].includes(database.searchParams.get('sslmode') || '')) fail('DATABASE_URL needs a password and sslmode=require (or verify-full/verify-ca).');
  if (!isAbsolute(env.LMS_RUNTIME_DIR!)) fail('LMS_RUNTIME_DIR must be an absolute path outside the checkout.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(env.SUPABASE_STORAGE_BUCKET!)) fail('SUPABASE_STORAGE_BUCKET must be a simple bucket name.');
  if (env.SUPABASE_ANON_KEY!.startsWith('sb_secret_')) fail('SUPABASE_ANON_KEY must not contain a secret server key.');
  return { origin, database, projectRef: expectedProject };
}

export function projectArgument(args = process.argv.slice(2)) {
  const index = args.indexOf('--project-ref');
  return index >= 0 ? args[index + 1] || '' : '';
}
