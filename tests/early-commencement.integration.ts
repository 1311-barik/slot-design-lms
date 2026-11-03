// Сквозная проверка только на локальной LMS с синтетической БД.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { earlyCommencement } from '../src/lib/early-commencement';

const origin = process.env.QA_ORIGIN || 'http://127.0.0.1:8791';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('Consent integration requires a local origin.');
type Jar = { cookie: string };
async function call(path: string, body?: unknown, jar: Jar = { cookie: '' }) {
  const response = await fetch(`${origin}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: jar.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('='));
  if (cookies.length) jar.cookie = cookies.join('; ');
  return { status: response.status, body: await response.json() };
}
async function signIn(email: string) {
  const result = await call('auth/link', { email });
  const jar = { cookie: '' };
  const token = new URLSearchParams(new URL(result.body.localLink).hash.slice(1)).get('token');
  assert.equal((await call('auth/exchange', { token }, jar)).status, 200);
  return jar;
}
const admin = await signIn('admin@example.test');
async function learner() {
  const id = randomUUID(); const email = `${id}@example.test`;
  assert.equal((await call('commands', { action: 'enrollment.invite', input: { id, name: 'HTTP Consent Learner', email, accessEndsAt: new Date(Date.now() + 86_400_000).toISOString() } }, admin)).status, 200);
  return { id, email, jar: await signIn(email) };
}
const yes = await learner(); const no = await learner();
const password = 'Synthetic consent test phrase';
const accepted = { password, earlyCommencementConsent: true, consentVersion: earlyCommencement.version };
assert.equal((await call('auth/password', accepted)).status, 401);
assert.equal((await call('auth/password', { ...accepted, earlyCommencementConsent: 'true' }, yes.jar)).status, 422);
assert.equal((await call('auth/password', { ...accepted, acceptedAt: '2000-01-01' }, yes.jar)).status, 422);
assert.equal((await call('auth/password', { ...accepted, consentVersion: undefined }, yes.jar)).status, 409);
assert.equal((await call('auth/password', { ...accepted, consentVersion: 'stale' }, yes.jar)).status, 409);
assert.equal((await call('auth/password', { ...accepted, password: 'short' }, yes.jar)).status, 422);
assert.equal((await call('workspace', undefined, yes.jar)).body.me.password_set_at, null);
assert.equal((await call('auth/password', accepted, yes.jar)).status, 200);
assert.equal((await call('auth/password', accepted, yes.jar)).status, 200, 'retry does not duplicate consent');
const own = (await call('workspace', undefined, yes.jar)).body;
assert.ok(Array.isArray(own.materials));
assert.equal(own.earlyCommencementConsents.length, 1);
assert.equal(own.earlyCommencementConsents[0].consent_text, earlyCommencement.text);
assert.equal((await call('auth/password', { password, earlyCommencementConsent: false, consentVersion: earlyCommencement.version }, no.jar)).status, 200);
assert.deepEqual((await call('workspace', undefined, no.jar)).body.earlyCommencementConsents, []);
assert.equal((await call('auth/password', accepted, no.jar)).status, 409, 'no retroactive consent through password changes');
const late = { earlyCommencementConsent: true, consentVersion: earlyCommencement.version };
assert.equal((await call('auth/early-commencement', late)).status, 401);
for (const payload of [{}, { ...late, earlyCommencementConsent: false }, { ...late, earlyCommencementConsent: 'true' }, { ...late, ownerId: yes.id }, { ...late, acceptedAt: '2000-01-01' }]) {
  assert.equal((await call('auth/early-commencement', payload, no.jar)).status, 422);
}
assert.equal((await call('auth/early-commencement', { ...late, consentVersion: 'stale' }, no.jar)).status, 409);
assert.equal((await call('auth/early-commencement', late, admin)).status, 403);
const originalPasswordAt = (await call('workspace', undefined, no.jar)).body.me.password_set_at;
assert.equal((await call('auth/early-commencement', late, no.jar)).status, 200);
assert.equal((await call('auth/early-commencement', late, no.jar)).status, 200);
const lateData = (await call('workspace', undefined, no.jar)).body;
assert.equal(lateData.earlyCommencementConsents.length, 1);
assert.equal(lateData.earlyCommencementConsents[0].source, 'lms_account');
assert.equal(lateData.me.password_set_at, originalPasswordAt);
assert.equal((await call('auth/password-login', { email: no.email, password })).status, 200, 'existing password is unchanged');
const adminData = (await call('workspace', undefined, admin)).body;
assert.equal(adminData.earlyCommencementConsents.filter((c: { owner_id: string }) => c.owner_id === yes.id).length, 1);
let receipt: { status: string; body: string }[] = [];
for (let batch = 0; batch < 20; batch++) {
  assert.equal((await call('commands', { action: 'mail.run', input: {} }, admin)).status, 200);
  const queue = (await call('workspace', undefined, admin)).body.notifications;
  receipt = queue.filter((n: { kind: string; body: string }) => n.kind === 'consent.early_commencement' && n.body.includes(yes.email));
  if (receipt[0]?.status === 'sent') break;
}
assert.equal(receipt.length, 1);
assert.equal(receipt[0].status, 'sent');
assert.ok(receipt[0].body.includes(earlyCommencement.text));
const lateReceipts = (await call('workspace', undefined, admin)).body.notifications.filter((n: { kind: string; body: string }) => n.kind === 'consent.early_commencement' && n.body.includes(no.email));
assert.equal(lateReceipts.length, 1);
assert.equal(lateReceipts[0].status, 'sent');
assert.ok(lateReceipts[0].body.includes('after registration'));
console.log('Consent HTTP integration passed: authentication, strict input, stale version, checked/unchecked registration, retries, privacy, admin receipt and local delivery.');
