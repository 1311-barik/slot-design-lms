import postgres from 'postgres';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Рабочий DATABASE_URL намеренно игнорируется: тесты сбрасывают только локальную тестовую схему.
const raw = process.env.LMS_TEST_DATABASE_URL || `postgres://${encodeURIComponent(userInfo().username)}@127.0.0.1:54431/igaming_lms_test`;
let target;
try { target = new URL(raw); } catch { throw new Error('Invalid LMS_TEST_DATABASE_URL (value hidden).'); }
if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
    || target.pathname !== '/igaming_lms_test' || target.search || target.hash || !target.username) {
  throw new Error('Tests require a loopback PostgreSQL database named igaming_lms_test, without URL parameters.');
}
process.env.DATABASE_URL = target.href;
process.env.LMS_MODE = 'local';
process.env.APP_ORIGIN = 'http://127.0.0.1:8787';
process.env.LMS_RUNTIME_DIR = process.env.LMS_TEST_RUNTIME_DIR || join(tmpdir(), 'igaming-lms-tests');
// Случайно унаследованные рабочие ключи не передаются тестам.
for (const key of Object.keys(process.env)) {
  if (/^(SUPABASE_|BREVO_|SMTP_|MAIL_)/.test(key)) delete process.env[key];
}
const options = { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 10 };
const adminUrl = new URL(target);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.href, options);
try {
  const [found] = await admin`select 1 from pg_database where datname = 'igaming_lms_test'`;
  if (!found) await admin.unsafe('create database igaming_lms_test');
} finally { await admin.end(); }
const testDatabase = postgres(target.href, options);
try { await testDatabase.unsafe('drop schema if exists lms cascade'); }
finally { await testDatabase.end(); }
await import('./setup-db.ts');
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...process.argv.slice(2)], {
  stdio: 'inherit', env: process.env,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
