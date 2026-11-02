import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentEnvironment } from '../scripts/deployment-env';

const ref = 'abcdefghijklmnopqrst';
const env = {
  LMS_MODE: 'supabase', APP_ORIGIN: 'https://lms.example.org',
  DATABASE_URL: `postgresql://lms_backend.${ref}:synthetic-test-only@aws-0-eu-west-3.pooler.supabase.com:5432/postgres?sslmode=require`,
  SUPABASE_URL: `https://${ref}.supabase.co`, SUPABASE_ANON_KEY: 'synthetic-public-key',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-server-key', SUPABASE_STORAGE_BUCKET: 'lms-homework', LMS_RUNTIME_DIR: '/var/lib/slot-design-lms',
};
test('deployment accepts Session pooler and matching direct project connections', () => {
  assert.equal(deploymentEnvironment(env, 'runtime', ref).projectRef, ref);
  const direct = `postgresql://lms_backend:test-only@db.${ref}.supabase.co:5432/postgres?sslmode=verify-full`;
  assert.equal(deploymentEnvironment({ ...env, DATABASE_URL: direct }, 'runtime', ref).database.hostname, `db.${ref}.supabase.co`);
});
test('deployment rejects wrong project, admin runtime role, plaintext transport and callback path', () => {
  for (const changes of [
    { SUPABASE_URL: 'https://wrong.supabase.co' },
    { DATABASE_URL: env.DATABASE_URL.replace(ref, 'differentproject') },
    { DATABASE_URL: env.DATABASE_URL.replace('lms_backend.', 'postgres.') },
    { DATABASE_URL: env.DATABASE_URL.replace(':5432/', ':6543/') },
    { DATABASE_URL: env.DATABASE_URL.replace('sslmode=require', 'sslmode=disable') },
    { APP_ORIGIN: 'http://lms.example.org' }, { APP_ORIGIN: 'https://127.0.0.1' },
    { APP_ORIGIN: 'https://lms.example.org/path' }, { APP_ORIGIN: 'https://lms.example.org/' },
    { LMS_RUNTIME_DIR: 'relative' }, { SUPABASE_ANON_KEY: 'sb_secret_test_only' },
    { SUPABASE_SERVICE_ROLE_KEY: 'REPLACE_SERVER_SERVICE_KEY' },
  ]) assert.throws(() => deploymentEnvironment({ ...env, ...changes }, 'runtime', ref));
});
test('admin tools require a deliberately selected project and administrative connection', () => {
  assert.throws(() => deploymentEnvironment(env, 'admin', ref));
  const admin = { ...env, DATABASE_URL: env.DATABASE_URL.replace('lms_backend.', 'postgres.') };
  assert.equal(deploymentEnvironment(admin, 'admin', ref).database.username, `postgres.${ref}`);
  assert.throws(() => deploymentEnvironment(admin, 'admin', ''));
  assert.throws(() => deploymentEnvironment(admin, 'admin', 'zyxwvutsrqponmlkjihg'));
});
test('configuration errors never include connection passwords', () => {
  const secret = 'not-a-real-password-7129';
  assert.throws(() => deploymentEnvironment({ ...env, DATABASE_URL: `https://admin:${secret}@example.org` }, 'runtime', ref), error => error instanceof Error && !error.message.includes(secret));
});
