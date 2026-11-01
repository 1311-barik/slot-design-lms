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

// Отдельные приглашённые участники: тест не зависит от данных других файлов.
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

test('project header is snapshotted into each submission; later edits do not rewrite history', async () => {
  const learner = await participant('Header Learner');
  const first = await command(learner, 'project.save', { expectedRevision: 0, theme: 'Deep sea', audience: 'Casual players' });
  await assert.rejects(command(learner, 'project.save', { expectedRevision: 0, theme: 'Other', audience: '' }), /changed/);
  const submission = await submit(learner, seeded(1), { analysis: text('Analysis'), concept: text('Concept') });
  await command(learner, 'project.save', { expectedRevision: first.revision, theme: 'Space', audience: 'Casual players' });
  const read = await readWorkspace(learner);
  assert.equal(read.project.theme, 'Space');
  assert.deepEqual(read.submissions.find((s: { id: string }) => s.id === submission.id).project_snapshot, { theme: 'Deep sea', audience: 'Casual players' });
  await assert.rejects(command(reviewer, 'project.save', { expectedRevision: 0, theme: 'x', audience: 'y' }), /Only participants/);
});

test('self-assessment is received without an expert decision', async () => {
  const learner = await participant('Self Learner');
  await assert.rejects(submit(learner, seeded(7), { level: text('Excellent'), reasons: text('Because'), weakSpot: text('Math') }), /Complete/);
  const draft = (await readWorkspace(learner)).drafts[0];
  const saved = await command(learner, 'draft.save', { draftId: draft.id, expectedRevision: draft.revision, payload: { parts: { level: text('Medium'), reasons: text('Because'), weakSpot: text('Math') } } });
  const sent = await command(learner, 'draft.submit', { draftId: draft.id, expectedRevision: saved.revision, key: randomUUID() });
  const team = await readWorkspace(reviewer);
  assert.ok(team.submissions.some((s: { id: string }) => s.id === sent.id), 'the responsible expert receives it');
  await assert.rejects(command(reviewer, 'submission.claim', { submissionId: sent.id }), /without an expert decision/);
  await assert.rejects(command(reviewer, 'review.publish', { submissionId: sent.id, expectedRevision: 0, action: 'accepted', body: 'Ok', key: randomUUID() }), /without an expert decision/);
});

test('final package keeps exact own versions; its reviewer reads them, other participants do not', async () => {
  const learner = await participant('Package Learner');
  const stranger = await participant('Package Stranger');
  const own = await submit(learner, seeded(1), { analysis: text('Analysis'), concept: text('Concept v1') });
  const foreign = await submit(stranger, seeded(1), { analysis: text('Their analysis'), concept: text('Their concept') });
  const rest = { documentation: text('Docs'), visuals: text('Visuals'), pitch: text('Pitch'), journal: text('Journal') };
  const draft = await command(learner, 'draft.create', { assignmentId: seeded(9) });
  await assert.rejects(command(learner, 'draft.save', { draftId: draft.id, expectedRevision: 0, payload: { parts: { ...rest, layers: { ...text(''), submissions: [foreign.id] } } } }), /own submitted versions/);
  const saved = await command(learner, 'draft.save', { draftId: draft.id, expectedRevision: 0, payload: { parts: { ...rest, layers: { ...text(''), submissions: [own.id] } } } });
  const pack = await command(learner, 'draft.submit', { draftId: draft.id, expectedRevision: saved.revision, key: randomUUID() });
  // Новая версия 1.2 после отправки пакета не меняет его состав.
  await submit(learner, seeded(1), { analysis: text('Analysis'), concept: text('Concept v2') });
  const team = await readWorkspace(reviewer);
  assert.deepEqual(team.packageItems.filter((i: { package_id: string }) => i.package_id === pack.id).map((i: { item_id: string }) => i.item_id), [own.id]);
  assert.ok(team.submissions.some((s: { id: string }) => s.id === own.id));
  await assert.rejects(sql.begin(async tx => { await tx`delete from lms.package_items where package_id=${pack.id}`; }), /Immutable/);
  const other = await readWorkspace(stranger);
  assert.ok(!other.submissions.some((s: { id: string }) => s.id === own.id || s.id === pack.id));
});

test('questions are private: the asker and the responsible team see them; only the team answers', async () => {
  const learner = await participant('Question Learner');
  const stranger = await participant('Question Stranger');
  const moduleQuestion = await command(learner, 'question.ask', { module: 3, body: 'How often should near-misses appear?', key: randomUUID() });
  const courseQuestion = await command(learner, 'question.ask', { module: null, body: 'Can I change my theme later?', key: randomUUID() });
  await assert.rejects(command(learner, 'question.ask', { module: 3, body: ' ​', key: randomUUID() }), /Check the entered values|Write your question/);
  assert.ok(!(await readWorkspace(stranger)).questions.some((q: { id: string }) => q.id === moduleQuestion.id));
  const team = await readWorkspace(reviewer);
  assert.ok(team.questions.some((q: { id: string }) => q.id === moduleQuestion.id));
  assert.ok(!team.questions.some((q: { id: string }) => q.id === courseQuestion.id), 'a question without a module goes to the administrator');
  assert.equal(team.people.find((p: { id: string }) => p.id === learner)?.name, 'Question Learner');
  await assert.rejects(command(stranger, 'question.answer', { questionId: moduleQuestion.id, body: 'Me', key: randomUUID() }), /course team|not available/);
  await assert.rejects(command(reviewer, 'question.answer', { questionId: courseQuestion.id, body: 'Yes', key: randomUUID() }), /not available/);
  await command(reviewer, 'question.answer', { questionId: moduleQuestion.id, body: 'About one in nine spins.', source: 'Ricardo Viana', key: randomUUID() });
  await command(admin, 'question.answer', { questionId: courseQuestion.id, body: 'Yes, any time.', key: randomUUID() });
  const mine = await readWorkspace(learner);
  assert.equal(mine.answers.length, 2);
  assert.equal(mine.answers.find((a: { question_id: string }) => a.question_id === moduleQuestion.id).source, 'Ricardo Viana');
});
