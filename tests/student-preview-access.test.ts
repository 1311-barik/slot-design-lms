import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { studentPreviewTarget } from '../src/lib/student-preview-service';
import { command, readWorkspace } from '../src/lib/service';
import { sql } from '../src/lib/db';

after(() => sql.end());
const admin = '10000000-0000-4000-8000-000000000004';
const learner = '10000000-0000-4000-8000-000000000001';
const reviewer = '10000000-0000-4000-8000-000000000003';

test('only active administrators can select an active participant; staff and revoked people cannot be targets', async () => {
  await assert.rejects(studentPreviewTarget(learner, learner), /administrators only/);
  await assert.rejects(studentPreviewTarget(reviewer, learner), /administrators only/);
  await assert.rejects(studentPreviewTarget(admin, admin), /active course access/);
  await assert.rejects(studentPreviewTarget(admin, reviewer), /active course access/);
  const target = await studentPreviewTarget(admin, learner);
  assert.equal(target.administratorId, admin);
  assert.equal(target.participantId, learner);
  assert.ok(target.participants.every(p => p.id !== admin && p.id !== reviewer));
  const revoked = randomUUID();
  await sql`insert into lms.profiles(id,name,email,role,activated_at,revoked_at,access_ends_at) values(${revoked},'Preview revoked',${revoked + '@example.test'},'participant',now(),now(),now()+interval '1 year')`;
  await assert.rejects(studentPreviewTarget(admin, revoked), /active course access/);
});

test('preview reads the same student data, feedback gate and notifications without creating or reading notifications', async () => {
  const person = randomUUID();
  await sql`insert into lms.profiles(id,name,email,role,activated_at,access_ends_at) values(${person},'Preview fixture',${person + '@example.test'},'participant',now(),now()+interval '1 year')`;
  await sql`insert into lms.module_feedback_prompts values(2,now()-interval '1 hour') on conflict(module) do update set request_after=excluded.request_after`;
  const draft = await command(person, 'draft.create', { assignmentId: '20000000-0000-4000-8000-000000000001' });
  await command(person, 'question.ask', { module: 1, body: 'Preview fixture question', key: randomUUID() });
  await command(person, 'project.save', { expectedRevision: 0, theme: 'Preview fixture', audience: 'Adult players' });
  const target = await studentPreviewTarget(admin, person);
  const before = await readWorkspace(target.participantId, { scheduleNotifications: false });
  assert.equal(before.feedbackRequests.find((r: any) => r.module === 2).required, true);
  assert.equal(before.notifications.length, 0, 'preview does not schedule notifications');
  const actual = await readWorkspace(person);
  const snapshot = await readWorkspace(target.participantId, { scheduleNotifications: false });
  for (const field of ['me','works','drafts','submissions','reviews','files','people','project','questions','answers','materials','progress','sessions','notifications','feedback','feedbackRequests']) {
    assert.deepEqual(snapshot[field], actual[field], field);
  }
  assert.ok(snapshot.drafts.some((d: any) => d.id === draft.id), 'the participant’s real draft remains visible');
  assert.ok(snapshot.notifications.some((n: any) => n.kind === 'feedback.requested' && !n.read_at));
  const [counts] = await sql`select count(*)::int as n,count(read_at)::int as read from lms.notifications where recipient_id=${person}`;
  await readWorkspace(target.participantId, { scheduleNotifications: false });
  const [after] = await sql`select count(*)::int as n,count(read_at)::int as read from lms.notifications where recipient_id=${person}`;
  assert.deepEqual(after, counts, 'viewing a preview does not mark notifications as read');
  assert.equal((await readWorkspace(admin)).me.role, 'admin', 'the real account remains the administrator');
  await sql`delete from lms.module_feedback_prompts where module=2`;
});
