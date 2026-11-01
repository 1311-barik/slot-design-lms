import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command, readWorkspace } from '../src/lib/service';
import { sql } from '../src/lib/db';

const reviewer = '10000000-0000-4000-8000-000000000003';
const admin = '10000000-0000-4000-8000-000000000004';
const seeded = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (value: string) => ({ text: value, files: [], images: [] });
after(() => sql.end());

async function participant(name: string) {
  const id = randomUUID();
  await command(admin, 'enrollment.invite', { id, name, email: `${id}@example.test`, accessEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
  await sql`update lms.profiles set activated_at=now() where id=${id}`;
  return id;
}
async function submit(actor: string, assignmentId: string, parts: Record<string, unknown>) {
  const draft = await command(actor, 'draft.create', { assignmentId });
  const saved = await command(actor, 'draft.save', { draftId: draft.id, expectedRevision: draft.revision, payload: { parts } });
  return command(actor, 'draft.submit', { draftId: draft.id, expectedRevision: saved.revision, key: randomUUID() });
}
async function pack(actor: string) {
  const layer = await submit(actor, seeded(1), { analysis: text('Analysis'), concept: text('Concept') });
  return submit(actor, seeded(9), { layers: { ...text(''), submissions: [layer.id] }, documentation: text('Docs'), visuals: text('Visuals'), pitch: text('Pitch'), journal: text('Journal') });
}

test('journal scope: the expert sees every participant by name without emails; the administrator sees emails', async () => {
  const quiet = await participant('Quiet Participant');
  const team = await readWorkspace(reviewer);
  const row = team.people.find((p: { id: string }) => p.id === quiet);
  assert.equal(row?.name, 'Quiet Participant', 'a participant without submissions is still listed');
  assert.equal(row?.email, null);
  assert.ok(team.reviewers.length > 0);
  assert.ok((await readWorkspace(admin)).people.find((p: { id: string }) => p.id === quiet)?.email);
  assert.ok(!(await readWorkspace(quiet)).people.some((p: { id: string }) => p.id !== quiet), 'participants do not see a participant list');
});

test('published level is stored with the decision and is optional', async () => {
  const learner = await participant('Level Learner');
  const sent = await submit(learner, seeded(3), { curve: text('Curve'), ethics: text('Ethics'), changes: text('Changes') });
  const review = await command(reviewer, 'review.publish', { submissionId: sent.id, expectedRevision: 0, action: 'accepted', level: 'strong', body: 'Clear rhythm.', key: randomUUID() });
  assert.equal(review.level, 'strong');
  await assert.rejects(command(reviewer, 'review.publish', { submissionId: sent.id, expectedRevision: review.feedback_draft_revision, action: 'accepted', level: 'excellent', body: 'x', replacesId: review.id, reason: 'typo', key: randomUUID() }), /Invalid option|invalid/i);
});

test('review deadline cannot be before the submission deadline', async () => {
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await assert.rejects(command(admin, 'assignment.schedule', { assignmentId: seeded(4), published: true, opensAt: null, dueAt: due, reviewDueAt: new Date(Date.now() + 86_400_000).toISOString(), latePolicy: 'allow_mark' }), /review deadline/);
  const saved = await command(admin, 'assignment.schedule', { assignmentId: seeded(4), published: true, opensAt: null, dueAt: due, reviewDueAt: new Date(Date.now() + 4 * 86_400_000).toISOString(), latePolicy: 'allow_mark' });
  assert.ok(saved.review_due_at);
});

test('presentation: recorded by the responsible expert with an exact package; corrections keep history', async () => {
  const learner = await participant('Presentation Learner');
  const stranger = await participant('Presentation Stranger');
  const first = await pack(learner);
  const foreign = await pack(stranger);
  const base = { participantId: learner, outcome: 'held', packageId: first.id, withoutPackage: false, level: 'medium', comment: 'Confident pitch.' };
  await assert.rejects(command(admin, 'presentation.record', { ...base, key: randomUUID() }), /responsible for the final package/, 'the administrator records only when assigned');
  await assert.rejects(command(learner, 'presentation.record', { ...base, key: randomUUID() }), /responsible for the final package/);
  await assert.rejects(command(reviewer, 'presentation.record', { ...base, packageId: null, key: randomUUID() }), /Choose the package/);
  await assert.rejects(command(reviewer, 'presentation.record', { ...base, withoutPackage: true, key: randomUUID() }), /Choose the package/);
  await assert.rejects(command(reviewer, 'presentation.record', { ...base, packageId: foreign.id, key: randomUUID() }), /this participant/);
  await assert.rejects(command(reviewer, 'presentation.record', { ...base, outcome: 'absent', key: randomUUID() }), /absent/);
  const held = await command(reviewer, 'presentation.record', { ...base, key: randomUUID() });
  // Новый пакет после защиты не меняет запись.
  const layer = (await readWorkspace(learner)).submissions.find((s: { spec: { title: string } }) => s.spec.title.startsWith('1.2')).id;
  const second = await submit(learner, seeded(9), { layers: { ...text(''), submissions: [layer] }, documentation: text('Docs v2'), visuals: text('V'), pitch: text('P'), journal: text('J') });
  assert.equal((await readWorkspace(learner)).presentations.find((d: { id: string }) => d.id === held.id).package_id, first.id);
  await assert.rejects(command(reviewer, 'presentation.record', { ...base, key: randomUUID() }), /changed/, 'a second first record is a stale write');
  await assert.rejects(command(reviewer, 'presentation.record', { ...base, packageId: second.id, replacesId: held.id, reason: ' ', key: randomUUID() }), /Explain why/);
  const corrected = await command(reviewer, 'presentation.record', { ...base, packageId: second.id, replacesId: held.id, reason: 'Pitched the updated package', key: randomUUID() });
  const mine = (await readWorkspace(learner)).presentations;
  assert.deepEqual(mine.map((d: { id: string }) => d.id).sort(), [held.id, corrected.id].sort());
  assert.ok(!(await readWorkspace(stranger)).presentations.some((d: { participant_id: string }) => d.participant_id === learner));
  assert.ok((await readWorkspace(admin)).presentations.some((d: { id: string }) => d.id === corrected.id), 'the administrator reads the whole cohort');
  await assert.rejects(sql.begin(async tx => { await tx`update lms.presentations set comment='x' where id=${held.id}`; }), /Immutable/);
  const absent = await command(reviewer, 'presentation.record', { participantId: stranger, outcome: 'absent', packageId: null, withoutPackage: false, level: null, comment: '', key: randomUUID() });
  assert.equal(absent.package_id, null);
});
