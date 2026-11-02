import { spawn } from 'node:child_process';
import { deploymentEnvironment, projectArgument } from './deployment-env';

// Пароль передаётся libpq через окружение, а не через argv/историю shell.
const { database } = deploymentEnvironment(process.env, 'admin', projectArgument());
const args = process.argv.slice(2);
const separator = args.indexOf('--');
const [tool, ...options] = separator >= 0 ? args.slice(separator + 1) : [];
if (!['psql', 'pg_dump', 'pg_restore'].includes(tool)) throw new Error('Usage: --project-ref REF -- psql|pg_dump|pg_restore [options]');
const env: NodeJS.ProcessEnv = { ...process.env, PGHOST: database.hostname, PGPORT: database.port || '5432', PGDATABASE: database.pathname.slice(1), PGUSER: decodeURIComponent(database.username), PGPASSWORD: decodeURIComponent(database.password), PGSSLMODE: database.searchParams.get('sslmode')! };
delete env.PGSERVICE;
delete env.PGSERVICEFILE;
const child = spawn(tool, tool === 'psql' ? ['-X', '--set=ON_ERROR_STOP=on', ...options] : options, { env, stdio: 'inherit' });
child.on('error', () => { console.error(`${tool} could not be started. Install PostgreSQL client tools first.`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
