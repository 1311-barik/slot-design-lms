import postgres from 'postgres';
import { migrate } from '../src/lib/migrate';
import { deploymentEnvironment, projectArgument } from './deployment-env';

// Только миграции; ни пользователей, ни учебных, ни тестовых данных.
deploymentEnvironment(process.env, 'admin', projectArgument());
const database = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, connect_timeout: 15 });
try {
  const applied = await migrate(database);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Migrations are up to date.');
} catch (error) {
  console.error('Migration failed. Database error code:', typeof error === 'object' && error && 'code' in error ? error.code : 'unknown');
  process.exitCode = 1;
} finally { await database.end(); }
