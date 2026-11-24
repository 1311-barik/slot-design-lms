import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mode = process.argv[2];
if (mode !== 'first' && mode !== 'weekly') {
  console.error('Expected first or weekly.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing.');
  process.exit(2);
}

// psql получает пароль только через окружение процесса, не в аргументах командной строки.
const url = new URL(process.env.DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
  console.error('DATABASE_URL must use PostgreSQL.');
  process.exit(2);
}
const env = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGSSLMODE: url.searchParams.get('sslmode') || 'require',
};
delete env.DATABASE_URL;
const path = join(dirname(fileURLToPath(import.meta.url)), `friday-homework-${mode}.sql`);
const result = spawnSync('/usr/bin/psql', ['-X', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', path], {
  env,
  stdio: 'inherit',
  timeout: 60_000,
});
if (result.error) console.error('psql failed:', result.error.name);
process.exit(result.status ?? 1);
