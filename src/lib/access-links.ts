import { createHash, randomBytes } from 'node:crypto';
import { sql, type Tx } from './db';
import { config } from './config';
import { AppError } from './contract';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const invalid = () => new AppError('invalid_link', 'This personal sign-in link is invalid or has been revoked. Request a new link.', 401);

// Секрет возвращается только отправителю письма, в таблицу и очередь попадает только его хеш.
export async function createAccessLink(email: string) {
  const [person] = await sql`select id from lms.profiles where email=${email.trim().toLowerCase()} and role='participant' and revoked_at is null and access_ends_at>now()`;
  if (!person) throw new AppError('access_expired', 'Course access is not active. Contact the administrator.', 403);
  const token = randomBytes(32).toString('hex');
  await sql`insert into lms.sign_in_links(profile_id,token_hash) values(${person.id},${digest(token)})`;
  return `${config().origin}/#access=${token}`;
}

// Общая блокировка с отзывом доступа и созданием пароля. Время создания не ограничивает ссылку.
export async function withAccessLink<T>(token: string, use: (tx: Tx, person: { id: string; email: string }) => Promise<T>): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw invalid();
  const result = await sql.begin(async tx => {
    const [link] = await tx`select profile_id from lms.sign_in_links where token_hash=${digest(token)} and revoked_at is null`;
    if (!link) throw invalid();
    await tx`select pg_advisory_xact_lock(hashtextextended(${link.profile_id},0))`;
    const [person] = await tx`select p.id,p.email,p.role,p.revoked_at,p.access_ends_at,l.revoked_at as link_revoked_at from lms.sign_in_links l join lms.profiles p on p.id=l.profile_id where l.token_hash=${digest(token)}`;
    if (!person || person.link_revoked_at || person.role!=='participant') throw invalid();
    if (person.revoked_at || new Date(person.access_ends_at).getTime() <= Date.now()) throw new AppError('access_expired', 'Course access is not active. Contact the administrator.', 403);
    return use(tx, { id: person.id, email: person.email });
  });
  return result as T;
}
