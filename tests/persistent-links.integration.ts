// Только локальная синтетическая LMS: реальные ссылки участников не открываем.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
const origin = process.env.QA_ORIGIN || 'http://127.0.0.1:8793';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const target = new URL(process.env.LMS_TEST_DATABASE_URL || 'postgres://shura@127.0.0.1:54431/igaming_lms_test');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname) && target.pathname === '/igaming_lms_test');
const db = postgres(target.href, { max: 1, prepare: false });
type Jar = { cookie: string };
async function call(path: string, body?: unknown, jar: Jar = { cookie: '' }) {
  const response = await fetch(`${origin}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: jar.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('='));
  if (cookies.length) jar.cookie = cookies.join('; ');
  return { status: response.status, body: await response.json() };
}
const payload = (url: string) => { const parts = new URLSearchParams(new URL(url).hash.slice(1)); return parts.has('access') ? { accessToken: parts.get('access')! } : { token: parts.get('token')! }; };
try {
  const admin = { cookie: '' };
  const adminLink = (await call('auth/link', { email: 'admin@example.test' })).body.localLink;
  assert.equal((await call('auth/exchange', payload(adminLink), admin)).status, 200);
  const id = randomUUID(), email = `${id}@example.test`;
  assert.equal((await call('commands', { action: 'enrollment.invite', input: { id, name: 'Persistent Link QA', email, accessEndsAt: new Date(Date.now() + 86400000).toISOString() } }, admin)).status, 200);
  const link = (await call('auth/link', { email })).body.localLink;
  const input = payload(link);
  const raw = 'accessToken' in input ? input.accessToken : input.token;
  assert.ok(raw);
  const digest = createHash('sha256').update(raw).digest('hex');
  if ('accessToken' in input) await db`update lms.sign_in_links set created_at=now()-interval '10 years' where token_hash=${digest}`;
  else await db`update lms.dev_tokens set expires_at=now()-interval '30 minutes' where hash=${digest}`;
  const jar = { cookie: '' };
  const first = await call('auth/exchange', input, jar);
  assert.equal(first.status, 200, 'A mailed sign-in link must still open after time has passed');
  assert.equal((await call('workspace', undefined, jar)).body.me.id, id);
  assert.equal((await call('workspace', undefined, jar)).body.consentRequired, true, 'Permanent entry does not accept legal consent');
  assert.equal((await call('auth/exchange', input, { cookie: '' })).status, 200, 'The same personal link remains usable');
  await call('auth/link', { email });
  assert.equal((await call('auth/exchange', input, { cookie: '' })).status, 200, 'A new email must not invalidate an earlier permanent link');
  assert.equal((await call('auth/exchange', { accessToken: 'a'.repeat(64) })).status, 401);
  assert.equal((await call('auth/exchange', { ...input, email: 'admin@example.test' })).status, 422);
  await db`update lms.profiles set access_ends_at=now()-interval '1 second' where id=${id}`;
  assert.equal((await call('auth/exchange', input)).status, 403, 'Course access expiry still applies');
  await db`update lms.profiles set access_ends_at=now()+interval '1 day' where id=${id}`;
  assert.equal((await call('commands', { action: 'enrollment.revoke', input: { id } }, admin)).status, 200);
  assert.equal((await call('auth/exchange', input)).status, 401, 'Revoking access invalidates its personal links');
  assert.equal((await call('commands', { action: 'enrollment.restore', input: { id } }, admin)).status, 200);
  assert.equal((await call('auth/exchange', input)).status, 401, 'Restoring the profile must not revive revoked links');
  console.log('Persistent links HTTP passed: aged link, repeat, second email, identity, consent gate, invalid input, access expiry, revoke and restore.');
} finally { await db.end(); }
