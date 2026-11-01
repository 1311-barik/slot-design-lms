import { AppError } from './contract';
export function config() {
  const mode = process.env.LMS_MODE;
  const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:8787';
  if (mode !== 'local' && mode !== 'supabase') throw new AppError('configuration', 'The application is not configured.', 503);
  if (mode === 'local' && !['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname)) throw new Error('Local authentication requires a loopback origin.');
  if (mode === 'supabase' && (!process.env.DATABASE_URL || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)) throw new AppError('configuration', 'Supabase is not configured.', 503);
  return { mode, origin, runtime: process.env.LMS_RUNTIME_DIR || '/private/tmp/igaming-lms-development' };
}
