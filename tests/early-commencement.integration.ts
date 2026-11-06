// Сквозная проверка только на локальной LMS с синтетической БД.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
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
const restricted = (await call('workspace', undefined, no.jar)).body;
assert.equal(restricted.consentRequired, true);
for (const key of ['materials','assignments','project','questions','files']) assert.equal(restricted[key], undefined, 'no course content before consent');
for (const path of ['files/10000000-0000-4000-8000-000000000001/play','files/10000000-0000-4000-8000-000000000001/captions','files/10000000-0000-4000-8000-000000000001/download']) {
  const result = await call(path, undefined, no.jar);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'consent_required');
}
for (const path of ['uploads','commands']) {
  const result = await call(path, {}, no.jar);
  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'consent_required');
}
const pdf = await fetch(`${origin}${earlyCommencement.termsUrl}`);
assert.equal(pdf.status, 200, 'terms are available before sign-in');
assert.ok(pdf.headers.get('content-type')?.includes('application/pdf'));
assert.equal(createHash('sha256').update(Buffer.from(await pdf.arrayBuffer())).digest('hex'),earlyCommencement.termsSha256);
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
for (const payload of [{}, { ...late, earlyCommencementConsent: false }, { ...late, earlyCommencementConsent: 'true' }, { ...late, ownerId: yes.id }, { ...late, acceptedAt: '2000-01-01' }, { ...late, termsUrl: '/fake.pdf' }]) {
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
assert.equal(lateData.earlyCommencementConsents[0].terms_sha256, earlyCommencement.termsSha256);
assert.equal(lateData.me.password_set_at, originalPasswordAt);
assert.equal((await call('auth/password-login', { email: no.email, password })).status, 200, 'existing password is unchanged');
const returning = { cookie: '' };
assert.equal((await call('auth/password-login', { email: no.email, password }, returning)).status, 200);
const returningData = (await call('workspace', undefined, returning)).body;
assert.notEqual(returningData.consentRequired, true, 'returning participant does not need another checkbox');
assert.ok(Array.isArray(returningData.materials));
assert.equal(returningData.earlyCommencementConsents.length, 1);
assert.equal(returningData.earlyCommencementConsents[0].id, lateData.earlyCommencementConsents[0].id);
const first = await learner();
assert.equal((await call('auth/early-commencement', late, first.jar)).status, 200, 'first sign-in may confirm before creating password');
assert.equal((await call('workspace', undefined, first.jar)).body.consentRequired, false);
assert.equal((await call('commands', {}, first.jar)).body.code, 'password_required');
assert.equal((await call('auth/password', { password }, first.jar)).status, 200);
assert.ok(Array.isArray((await call('workspace', undefined, first.jar)).body.materials));
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
console.log('Consent HTTP integration passed: mandatory course gate, no content before consent, direct file/upload/command denial, public PDF hash, first and existing participant flows, authentication, strict input, version, retries, privacy and admin receipts.');
