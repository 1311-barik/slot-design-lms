// Пароль после входа по ссылке. Нужен локальный сервер (LMS_MODE=local) на QA_ORIGIN, по умолчанию http://127.0.0.1:8787.
// Только синтетические @example.test аккаунты локальной базы.
import assert from 'node:assert/strict';

const origin = process.env.QA_ORIGIN || 'http://127.0.0.1:8787';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('Password test runs only against a local origin.');
type Jar = { cookie: string };
async function call(path: string, body: unknown, jar: Jar = { cookie: '' }) {
  const r = await fetch(`${origin}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: jar.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const set = r.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('='));
  if (set.length) jar.cookie = set.join('; ');
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function signInByLink(email: string) {
  const jar = { cookie: '' };
  const link = await call('auth/link', { email });
  const token = new URL(link.body.localLink).searchParams.get('token');
  assert.equal((await call('auth/exchange', { token }, jar)).status, 200);
  return jar;
}

const email = 'sam@example.test';
const jar = await signInByLink(email);
const before = await call('workspace', undefined, jar);
assert.equal(before.status, 200);
assert.equal(before.body.materials, undefined, 'course content is hidden until a password is created');
assert.equal((await call('commands', { action: 'project.save', input: { expectedRevision: 0, theme: 'Too early', audience: 'Adults' } }, jar)).status, 403, 'course commands are blocked before password setup');
for (const [password, reason] of [['short7!', 'under 8'], ['        ', 'only spaces'], ['я'.repeat(37), 'over 72 bytes']] as const) {
  const r = await call('auth/password', { password }, jar);
  assert.equal(r.status, 422, `rejects ${reason}`);
}
const unauth = await call('auth/password', { password: 'long enough phrase' });
assert.equal(unauth.status, 401, 'cannot set a password without a session');
const password = `Concept phrase ${Date.now()}`;
assert.equal((await call('auth/password', { password }, jar)).status, 200);
const after = await call('workspace', undefined, jar);
assert.ok(after.body.me.password_set_at, 'password_set_at is recorded');
assert.ok(Array.isArray(after.body.materials), 'course content opens after password setup');
await call('auth/logout', {}, jar);

const wrong = await call('auth/password-login', { email, password: 'wrong password!' });
const unknown = await call('auth/password-login', { email: 'nobody@example.test', password });
assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
assert.equal(wrong.body.message, unknown.body.message, 'same answer for a wrong password and an unknown email');
const fresh = { cookie: '' };
assert.equal((await call('auth/password-login', { email: email.toUpperCase(), password }, fresh)).status, 200, 'email is case-insensitive');
assert.equal((await call('workspace', undefined, fresh)).body.me.email, email);
// Ссылка на почту по-прежнему работает как запасной вход.
assert.equal((await call('workspace', undefined, await signInByLink(email))).status, 200);
console.log('Password integration passed: link → create password → limits → password sign-in → same error for unknown → link fallback.');
