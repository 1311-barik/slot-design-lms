import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command, readWorkspace } from '../src/lib/service';
import { deliver, plan, when, type Outcome, type Provider } from '../src/lib/mail';
import { setPassword } from '../src/lib/auth';
import { sql } from '../src/lib/db';

const learner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const reviewer = '10000000-0000-4000-8000-000000000003';
const admin = '10000000-0000-4000-8000-000000000004';
const seeded = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (value: string) => ({ text: value, files: [], images: [] });
after(() => sql.end());

// Подставной провайдер: запоминает письма, исход задаётся тестом.
function fake(outcome: () => Outcome = () => ({ ok: true, providerId: 'test' })) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const provider: Provider = { name: 'test', send: async mail => { const result = outcome(); if (result.ok) sent.push(mail); return result; } };
  return { sent, provider };
}
async function drain(now: Date, provider: Provider) {
  await plan(now);
  for (let i = 0; i < 20; i++) if (!(await deliver(now, provider)).processed) break;
}
const byKey = async (like: string) => sql`select * from lms.notifications where dedupe_key like ${like} order by created_at`;

test('welcome email contains the recipient’s one-time link and no token is stored in the mail queue', async () => {
  const id = randomUUID(); const address = `${id}@example.test`;
  await command(admin, 'enrollment.invite', { id, name: 'New Student', email: address, accessEndsAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
  const mail = fake();
  await drain(new Date(), mail.provider);
  const welcome = mail.sent.find(m => m.to === address && m.subject.startsWith('Welcome to Slot Design'));
  assert.ok(welcome);
  assert.match(welcome.text, /Open your personal sign-in link:\nhttp:\/\/127\.0\.0\.1:8787\/#token=[a-f0-9]{64}/);
  assert.match(welcome.text, /create your password, and Module 0 will open/i);
  const [queued] = await byKey(`enrollment.invited:${id}:%`);
  assert.equal(queued.status, 'sent');
  assert.ok(!queued.body.includes('token='));
  assert.ok(queued.body.includes('{{SIGN_IN_LINK}}'));
});

test('a replacement sign-in link uses the same mail worker and stays out of course notifications', async () => {
  const key = `auth.link:${randomUUID()}`;
  await sql`insert into lms.notifications(dedupe_key,kind,recipient_id,subject,body,link_path,not_after)
    values(${key},'auth.link_requested',${learner},'Your Slot Design sign-in link','Open {{SIGN_IN_LINK}}','/',now()+interval '15 minutes')`;
  const mail = fake();
  await deliver(new Date(Date.now() + 2_000), mail.provider);
  const sent = mail.sent.find(m => m.to === 'alex@example.test' && m.subject === 'Your Slot Design sign-in link');
  assert.ok(sent);
  assert.match(sent.text, /\/#token=[a-f0-9]{64}/);
  assert.ok(!(await readWorkspace(learner)).notifications.some((n: { dedupe_key: string }) => n.dedupe_key === key));
  const [queued] = await sql`select body,status from lms.notifications where dedupe_key=${key}`;
  assert.equal(queued.status, 'sent');
  assert.ok(queued.body.includes('{{SIGN_IN_LINK}}') && !queued.body.includes('token='));
});

test('events become emails once: confirmation, expert notice, feedback without the content of the work', async () => {
  // Отдельный участник: другие тесты ожидают, что у Sam нет отзывов.
  const writer = randomUUID(); const address = `${writer}@example.test`;
  await command(admin, 'enrollment.invite', { id: writer, name: 'Mail Writer', email: address, accessEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
  await sql`update lms.profiles set activated_at=now() where id=${writer}`;
  const mail = fake();
  const draft = await command(writer, 'draft.create', { assignmentId: seeded(4) });
  const saved = await command(writer, 'draft.save', { draftId: draft.id, expectedRevision: 0, payload: { parts: { rtp: text('SECRET-RTP-TEXT'), budget: text('Budget'), changes: text('Changes') } } });
  const sub = await command(writer, 'draft.submit', { draftId: draft.id, expectedRevision: saved.revision, key: randomUUID() });
  await drain(new Date(), mail.provider);
  await drain(new Date(), mail.provider);
  const forSub = mail.sent.filter(m => m.subject.includes('4.2'));
  assert.deepEqual(forSub.map(m => m.to).sort(), [address, 'admin@example.test', 'expert@example.test'].sort(), 'one confirmation, one expert notice and one copy for the administrator, no duplicates');
  assert.ok(forSub.every(m => !m.text.includes('SECRET-RTP-TEXT')));
  assert.match(forSub.find(m => m.to === address)!.text, /We received 4\.2/);
  await command(reviewer, 'review.publish', { submissionId: sub.id, expectedRevision: 0, action: 'needs_revision', body: 'SECRET-FEEDBACK', key: randomUUID() });
  await drain(new Date(), mail.provider);
  const feedback = mail.sent.find(m => m.subject.startsWith('Feedback published: 4.2'))!;
  assert.equal(feedback.to, address);
  assert.ok(!feedback.text.includes('SECRET-FEEDBACK'));
  assert.ok(feedback.text.includes('/?module=4'));
});

test('a self-assessment notifies the expert as received; a course question goes to the administrator', async () => {
  const mail = fake();
  const draft = await command(other, 'draft.create', { assignmentId: seeded(7) });
  const saved = await command(other, 'draft.save', { draftId: draft.id, expectedRevision: 0, payload: { parts: { level: text('Weak'), reasons: text('R'), weakSpot: text('W') } } });
  await command(other, 'draft.submit', { draftId: draft.id, expectedRevision: saved.revision, key: randomUUID() });
  await command(other, 'question.ask', { module: null, body: 'Course question', key: randomUUID() });
  await drain(new Date(), mail.provider);
  assert.ok(mail.sent.some(m => m.to === 'expert@example.test' && m.subject.startsWith('Self-assessment received')));
  const asked = mail.sent.filter(m => m.subject === 'New question about the course');
  assert.deepEqual(asked.map(m => m.to), ['admin@example.test']);
});

test('session reminders 24 h and 1 h before; late runs are missed; a move cancels old reminders and announces the new time', async () => {
  const id = randomUUID(); const starts = new Date('2027-01-17T14:00:00Z');
  const saved = await command(admin, 'session.save', { id, expectedRevision: 0, module: 2, title: 'Mail test session', startsAt: starts.toISOString(), endsAt: null, joinUrl: 'https://example.test/join', recordingUrl: '', recordingPublished: false });
  const mail = fake();
  await drain(new Date(starts.getTime() - 24 * 3_600_000 + 5 * 60_000), mail.provider);
  const tomorrow = mail.sent.filter(m => m.subject === 'Tomorrow: Mail test session');
  assert.deepEqual(tomorrow.map(m => m.to).sort(), ['alex@example.test', 'sam@example.test']);
  assert.match(tomorrow[0].text, /Sunday 17 January.*15:00 CET/);
  assert.match(tomorrow[0].text, /https:\/\/example\.test\/join/);
  // Обработчик стоял 40 минут: напоминание за час не отправляется, а помечается пропущенным.
  await drain(new Date(starts.getTime() - 3_600_000 + 40 * 60_000), mail.provider);
  assert.ok(!mail.sent.some(m => m.subject === 'In one hour: Mail test session'));
  assert.ok((await byKey(`session.reminder:${id}:%:1h:%`)).every(n => n.status === 'missed'));
  // Перенос: запланированное, но не отправленное напоминание отменяется при проверке.
  const moved = new Date('2027-01-24T14:00:00Z');
  await plan(new Date(moved.getTime() - 7 * 24 * 3_600_000 - 1));
  const id2 = randomUUID();
  const s2 = await command(admin, 'session.save', { id: id2, expectedRevision: 0, module: 2, title: 'Movable session', startsAt: moved.toISOString(), endsAt: null, joinUrl: '', recordingUrl: '', recordingPublished: false });
  await plan(new Date(moved.getTime() - 24 * 3_600_000 + 60_000));
  await command(admin, 'session.save', { id: id2, expectedRevision: s2.revision, module: 2, title: 'Movable session', startsAt: '2027-01-31T14:00:00.000Z', endsAt: null, joinUrl: '', recordingUrl: '', recordingPublished: false });
  const later = fake();
  await drain(new Date(moved.getTime() - 24 * 3_600_000 + 2 * 60_000), later.provider);
  assert.ok(!later.sent.some(m => m.subject === 'Tomorrow: Movable session'));
  assert.ok((await byKey(`session.reminder:${id2}:%`)).every(n => n.status === 'cancelled'));
  assert.ok(later.sent.some(m => m.subject === 'New time: Movable session' && m.to === 'alex@example.test'));
  assert.ok(later.sent.some(m => m.subject === 'New time: Movable session' && m.to === 'expert@example.test'));
  assert.ok(saved.id);
});

test('deadline reminder only without any submitted version; a submission before sending cancels it', async () => {
  const due = new Date('2027-01-20T14:00:00Z');
  await command(admin, 'assignment.schedule', { assignmentId: seeded(6), published: true, opensAt: null, dueAt: due.toISOString(), reviewDueAt: null, latePolicy: 'allow_mark' });
  const now = new Date(due.getTime() - 24 * 3_600_000 + 60_000);
  await plan(now);
  const draft = await command(learner, 'draft.create', { assignmentId: seeded(6) });
  const saved = await command(learner, 'draft.save', { draftId: draft.id, expectedRevision: draft.revision, payload: { parts: { versions: text('v'), accepted: text('a'), rejected: text('r'), borrowed: text('b') } } });
  await command(learner, 'draft.submit', { draftId: draft.id, expectedRevision: saved.revision, key: randomUUID() });
  const mail = fake();
  await drain(now, mail.provider);
  const reminders = mail.sent.filter(m => m.subject === 'Due in 24 hours: 6.2 · Revised concept after the crash test');
  assert.deepEqual(reminders.map(m => m.to), ['sam@example.test']);
  assert.equal((await byKey(`deadline.reminder:${seeded(6)}:%:${learner}`))[0].status, 'cancelled');
});

test('provider failures: retry known errors, never blindly retry an unknown result, cancel for revoked access', async () => {
  await drain(new Date(), fake().provider); // очередь других тестов не мешает проверке
  const failing = fake(() => ({ ok: false, retry: true, error: 'Brevo returned 503' }));
  await command(other, 'question.ask', { module: 3, body: 'Retry me', key: randomUUID() });
  const t0 = new Date();
  await plan(t0);
  const [n] = await sql`select * from lms.notifications where kind='question.asked' and status='pending' order by created_at desc limit 1`;
  // Повторы через 1, 5 и 30 минут, после четвёртой неудачи — failed.
  for (const minutes of [0, 2, 8, 40]) await deliver(new Date(t0.getTime() + minutes * 60_000), failing.provider);
  const [failed] = await sql`select status,attempts from lms.notifications where id=${n.id}`;
  assert.deepEqual([failed.status, failed.attempts], ['failed', 4]);
  await command(admin, 'notification.retry', { id: n.id });
  const unknown = fake(() => ({ ok: false, retry: false, unknown: true, error: 'No response' }));
  await deliver(new Date(t0.getTime() + 41 * 60_000), unknown.provider);
  await deliver(new Date(t0.getTime() + 50 * 60_000), unknown.provider);
  const [u] = await sql`select status,attempts from lms.notifications where id=${n.id}`;
  assert.deepEqual([u.status, u.attempts], ['unknown', 5], 'an unknown result is not sent again automatically');
  await assert.rejects(command(admin, 'notification.retry', { id: n.id }), /may already have been delivered/);
  await assert.rejects(command(learner, 'notification.retry', { id: n.id, confirmUnknown: true }), /Administrator/);
  // Отозванный получатель: письмо отменяется перед отправкой.
  const id = randomUUID();
  await command(admin, 'enrollment.invite', { id, name: 'Revoked Mail', email: `${id}@example.test`, accessEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
  await plan();
  await command(admin, 'enrollment.revoke', { id });
  const mail = fake();
  for (let i = 0; i < 20; i++) if (!(await deliver(new Date(), mail.provider)).processed) break;
  assert.ok(!mail.sent.some(m => m.to === `${id}@example.test`));
  assert.equal((await byKey(`enrollment.invited:${id}:%`))[0].status, 'cancelled');
});

test('in-app notifications: own list, mark as read, time zone shown in emails', async () => {
  const mine = (await readWorkspace(other)).notifications;
  assert.ok(mine.length > 0 && mine.every((n: { recipient_id: string }) => n.recipient_id === other));
  assert.ok(!(await readWorkspace(learner)).notifications.some((n: { recipient_id: string }) => n.recipient_id === other));
  const target = mine.find((n: { read_at: string | null }) => !n.read_at);
  assert.equal((await command(learner, 'notification.read', { ids: [target.id] })).read, 0, 'another user cannot mark it');
  assert.equal((await command(other, 'notification.read', { ids: [target.id] })).read, 1);
  await assert.rejects(command(other, 'profile.timezone', { timezone: 'Mars/Base' }), /Choose a time zone/);
  assert.equal((await command(other, 'profile.timezone', { timezone: 'Europe/Lisbon' })).timezone, 'Europe/Lisbon');
  assert.match(when('2026-11-15T14:00:00Z', 'Europe/Lisbon'), /15:00 CET \(.*14:00.*in your time zone\)/);
  assert.match(when('2026-11-15T14:00:00Z', null), /15:00 CET\. Choose your time zone/);
  await command(other, 'profile.timezone', { timezone: null });
});

test('administrators get a note for each participant action, without private drafts', async () => {
  const id = randomUUID(); const address = `${id}@example.test`;
  await command(admin, 'enrollment.invite', { id, name: 'Activity Learner', email: address, accessEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
  await sql`update lms.profiles set activated_at=now() where id=${id}`;
  await drain(new Date(), fake().provider);
  const mail = fake();
  await setPassword(id, 'activity phrase one');
  await setPassword(id, 'activity phrase two'); // смена пароля отдельного письма не создаёт
  await command(id, 'project.save', { expectedRevision: 0, theme: 'Space casino', audience: 'Adults' });
  const material = randomUUID();
  await command(admin, 'material.save', { id: material, expectedRevision: 0, module: 0, position: 1, audience: 'participant', title: 'Welcome video', body: '', links: [{ label: 'Video', url: 'https://example.test/v' }], published: true, opensAt: null, files: [] });
  await command(id, 'material.progress', { materialId: material, studied: true });
  await command(id, 'material.progress', { materialId: material, studied: false });
  await command(id, 'material.progress', { materialId: material, studied: true });
  await command(id, 'draft.create', { assignmentId: seeded(3) }); // черновик приватен — без отбивки
  await drain(new Date(), mail.provider);
  const toAdmin = mail.sent.filter(m => m.to === 'admin@example.test' && m.subject.startsWith('Activity Learner')).map(m => m.subject).sort();
  assert.deepEqual(toAdmin, ['Activity Learner created a password', 'Activity Learner marked “Welcome video” (module 0) as studied', 'Activity Learner marked “Welcome video” (module 0) as studied', 'Activity Learner updated the project theme and audience'].sort());
  assert.ok(!mail.sent.some(m => m.to === 'expert@example.test' && m.subject.startsWith('Activity Learner')), 'experts do not get activity notes');
});
