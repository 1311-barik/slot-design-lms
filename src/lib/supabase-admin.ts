import { createClient } from '@supabase/supabase-js';
import { AppError } from './contract';

// Серверный клиент с ключом service role / secret: только на сервере и в служебных скриптах, никогда в браузере.
export function serviceClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new AppError('supabase_admin', 'Supabase administration is not configured.', 503);
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Профиль LMS использует id пользователя Supabase Auth. Пользователь создаётся без пароля и без письма Supabase:
// приглашение отправляет почта LMS, вход — одноразовой ссылкой (signInWithOtp, shouldCreateUser=false).
export async function ensureAuthUser(email: string): Promise<string> {
  const admin = serviceClient().auth.admin;
  const normalized = email.trim().toLowerCase();
  const created = await admin.createUser({ email: normalized, email_confirm: true });
  if (created.data.user) return created.data.user.id;
  if (created.error && !['email_exists', 'user_already_exists'].includes(created.error.code || '')) throw new AppError('auth_provisioning', 'The sign-in account could not be prepared. Try again shortly.', 503);
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.listUsers({ page, perPage: 1000 });
    if (error) throw new AppError('auth_provisioning', 'The sign-in account could not be found. Try again shortly.', 503);
    const user = data.users.find(u => u.email?.toLowerCase() === normalized);
    if (user) return user.id;
    if (data.users.length < 1000) break;
  }
  throw new AppError('auth_provisioning', 'The sign-in account could not be found. Try again shortly.', 503);
}
