import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { sql, type Tx } from './db';
import { AppError } from './contract';
import { config } from './config';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const derive = promisify(scrypt) as (password: string, salt: Buffer, length: number) => Promise<Buffer>;
const cookieName = 'lms_session';
async function supabase() {
  config();
  const jar = await cookies();
  return createServerClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => jar.getAll(), setAll: values => values.forEach(({ name, value, options }) => jar.set(name, value, { ...options, httpOnly: true, sameSite: 'lax', secure: new URL(config().origin).protocol === 'https:' })) },
  });
}
export async function rateLimit(key: string, limit: number) {
  const [row] = await sql`insert into lms.rate_limits(key) values(${hash(key)}) on conflict(key) do update set hits=case when lms.rate_limits.window_at<now()-interval '15 minutes' then 1 else lms.rate_limits.hits+1 end,window_at=case when lms.rate_limits.window_at<now()-interval '15 minutes' then now() else lms.rate_limits.window_at end returning hits`;
  if (row.hits > limit) throw new AppError('rate_limit', 'Too many attempts. Try again in 15 minutes.', 429);
}
// Первый вход фиксируется один раз; событие для письма администраторам — в той же операции.
async function activate(db: typeof sql | Tx, id: string) {
  await db`with first as (update lms.profiles set activated_at=now() where id=${id} and activated_at is null and revoked_at is null and access_ends_at>now() returning id)
    insert into lms.outbox(kind,aggregate_id) select 'participant.activated', id from first on conflict do nothing`;
}
export async function requestLink(email: string) {
  const cfg = config();
  email = email.toLowerCase();
  await rateLimit(`email:${email}`, 6);
  const [profile] = await sql`select id,revoked_at,access_ends_at from lms.profiles where email=${email}`;
  const generic = { message: 'If you have course access, a one-time sign-in link is on its way. It expires soon.' };
  if (!profile || profile.revoked_at || new Date(profile.access_ends_at) <= new Date()) return generic;
  if (cfg.mode === 'local') {
    if (!email.endsWith('@example.test')) return generic;
    const token = randomBytes(32).toString('hex');
    await sql`insert into lms.dev_tokens(hash,profile_id,expires_at) values(${hash(token)},${profile.id},now()+interval '15 minutes')`;
    return { ...generic, localLink: `${cfg.origin}/?token=${token}`, localEmail: email };
  }
  // Повторный вход и восстановление идут через тот же корпоративный SMTP, что и первое приглашение.
  // Токен генерирует обработчик непосредственно перед отправкой, не хранит в БД и не раскрывает через API.
  await sql`insert into lms.notifications(dedupe_key,kind,recipient_id,subject,body,link_path,not_after)
    values(${`auth.link:${randomUUID()}`},'auth.link_requested',${profile.id},'Your Slot Design sign-in link',${`Hi,\n\nOpen your personal sign-in link:\n{{SIGN_IN_LINK}}\n\nChoose “Continue to course”. This link works once and expires soon. If you did not ask for it, you can ignore this email.`},'/',now()+interval '15 minutes')`;
  return generic;
}
export async function exchange(token: string | null, code: string | null = null, flowId?: string) {
  const invalid = () => new AppError('invalid_link', 'This sign-in link is invalid or expired. Request a new link.', 401);
  const cfg = config();
  // Стандартное письмо Supabase возвращает PKCE-код; работает в том же браузере, где запрошен вход.
  if (code !== null) {
    if (cfg.mode !== 'supabase' || !/^[a-zA-Z0-9-]{16,512}$/.test(code)) throw invalid();
    const verifier = (await cookies()).getAll().some(c => c.name.endsWith('-auth-token-code-verifier'));
    const { data, error } = await (await supabase()).auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    // Только код ошибки и наличие cookie, без значений: нужно для разбора неудачных входов.
    if (error || !data.user) console.error('sign-in code exchange failed', JSON.stringify({ name: error?.name, code: error?.code, status: error?.status, message: error?.message, verifierCookie: verifier }));
    if (error || !data.user) throw new AppError('invalid_link', 'This sign-in link is invalid, expired or was opened in another browser. Request a new link here.', 401);
    await activate(sql, data.user.id);
    return;
  }
  if (!token || !/^[a-zA-Z0-9_-]{32,512}$/.test(token)) throw invalid();
  if (cfg.mode === 'local') {
    const session = randomBytes(32).toString('hex');
    await sql.begin(async tx => {
      const [link] = await tx`select * from lms.dev_tokens where hash=${hash(token)} and used_at is null and expires_at>now() for update`;
      if (!link) throw new AppError('invalid_link', 'This sign-in link is invalid or expired. Request a new link.', 401);
      await tx`select pg_advisory_xact_lock(hashtextextended(${link.profile_id},0))`;
      const [profile] = await tx`select * from lms.profiles where id=${link.profile_id} and revoked_at is null and access_ends_at>now()`;
      if (!profile) throw new AppError('access_expired', 'Course access is not active. Contact the administrator.', 403);
      await tx`update lms.dev_tokens set used_at=now() where hash=${hash(token)}`;
      await activate(tx, profile.id);
      await tx`insert into lms.dev_sessions values(${hash(session)},${profile.id},now()+interval '8 hours')`;
    });
    (await cookies()).set(cookieName, session, { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 8 * 3600 });
  } else {
    const client = await supabase();
    const { data, error } = await client.auth.verifyOtp({ token_hash: token, type: 'email' });
    if (error || !data.user) throw new AppError('invalid_link', 'This sign-in link is invalid or expired. Request a new link.', 401);
    await activate(sql, data.user.id);
  }
}
// Пароль: 8–72 символа (72 — предел bcrypt в Supabase Auth), не из одних пробелов.
export function checkPassword(password: string) {
  if ([...password].length < 8) throw new AppError('weak_password', 'Use at least 8 characters.', 422, ['password']);
  if (Buffer.byteLength(password) > 72) throw new AppError('weak_password', 'Use at most 72 characters.', 422, ['password']);
  if (!password.trim()) throw new AppError('weak_password', 'The password cannot be only spaces.', 422, ['password']);
}
async function startLocalSession(profileId: string) {
  const session = randomBytes(32).toString('hex');
  await sql`insert into lms.dev_sessions values(${hash(session)},${profileId},now()+interval '8 hours')`;
  (await cookies()).set(cookieName, session, { httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: 8 * 3600 });
}
// Создать или сменить пароль может только вошедший пользователь; ссылка на почту остаётся запасным входом.
export async function setPassword(user: string, password: string) {
  checkPassword(password);
  const [profile] = await sql`select id from lms.profiles where id=${user} and revoked_at is null and access_ends_at>now()`;
  if (!profile) throw new AppError('access_expired', 'Course access is not active. Contact the administrator.', 403);
  if (config().mode === 'local') {
    const salt = randomBytes(16); const derived = await derive(password, salt, 32);
    await sql`insert into lms.dev_passwords(profile_id,hash) values(${user},${`${salt.toString('hex')}:${derived.toString('hex')}`}) on conflict(profile_id) do update set hash=excluded.hash,updated_at=now()`;
  } else {
    const { error } = await (await supabase()).auth.updateUser({ password });
    if (error) throw error.code === 'weak_password' ? new AppError('weak_password', 'Choose a stronger password.', 422, ['password'])
      : error.code === 'same_password' ? new AppError('same_password', 'Choose a password different from the current one.', 422, ['password'])
      : new AppError('password_unavailable', 'The password could not be saved. Sign in again and retry.', 503);
  }
  // Первое создание пароля — событие для администраторов; смена пароля писем не создаёт.
  await sql`with first as (select id from lms.profiles where id=${user} and password_set_at is null and role='participant')
    insert into lms.outbox(kind,aggregate_id) select 'participant.password', id from first on conflict do nothing`;
  await sql`update lms.profiles set password_set_at=now() where id=${user}`;
}
// Ответ один для неизвестного адреса и неверного пароля: не раскрываем, есть ли аккаунт.
export async function passwordLogin(email: string, password: string) {
  email = email.trim().toLowerCase();
  await rateLimit(`password:${email}`, 10);
  const wrong = () => new AppError('wrong_password', 'Email or password is incorrect.', 401);
  const [profile] = await sql`select * from lms.profiles where email=${email}`;
  if (config().mode === 'local') {
    const [stored] = profile ? await sql`select hash from lms.dev_passwords where profile_id=${profile.id}` : [];
    const [salt, expected] = String(stored?.hash || ':').split(':');
    const derived = await derive(password, Buffer.from(salt || '00', 'hex'), 32);
    if (!stored || !timingSafeEqual(derived, Buffer.from(expected, 'hex'))) throw wrong();
  } else {
    const { data, error } = await (await supabase()).auth.signInWithPassword({ email, password });
    if (error || !data.user) throw wrong();
  }
  if (!profile || profile.revoked_at || new Date(profile.access_ends_at) <= new Date()) {
    if (config().mode !== 'local') await (await supabase()).auth.signOut();
    throw profile ? new AppError('access_expired', 'Course access is not active. Contact the administrator.', 403) : wrong();
  }
  await activate(sql, profile.id);
  if (config().mode === 'local') await startLocalSession(profile.id);
}
export async function actor() {
  const cfg = config();
  if (cfg.mode === 'local') {
    const session = (await cookies()).get(cookieName)?.value;
    if (session) {
      const [row] = await sql`select profile_id from lms.dev_sessions where hash=${hash(session)} and expires_at>now()`;
      if (row) return row.profile_id as string;
    }
  } else {
    const client = await supabase();
    const { data, error } = await client.auth.getUser();
    if (!error && data.user) return data.user.id;
  }
  throw new AppError('unauthenticated', 'Your session ended. Sign in again to continue.', 401);
}
export async function logout() {
  if (config().mode === 'local') {
    const jar = await cookies();
    const session = jar.get(cookieName)?.value;
    if (session) await sql`delete from lms.dev_sessions where hash=${hash(session)}`;
    jar.delete(cookieName);
  } else { await (await supabase()).auth.signOut(); }
}
