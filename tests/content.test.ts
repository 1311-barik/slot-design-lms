import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command, readWorkspace } from '../src/lib/service';
import { downloadFile, playVideo, uploadFile } from '../src/lib/files';
import { sql } from '../src/lib/db';

const learner = '10000000-0000-4000-8000-000000000001';
const reviewer = '10000000-0000-4000-8000-000000000003';
const admin = '10000000-0000-4000-8000-000000000004';
const assignment = '20000000-0000-4000-8000-000000000005';
const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
const earlier = new Date(Date.now() - 86_400_000).toISOString();
after(() => sql.end());

const material = (id: string, revision: number, extra: Record<string, unknown>) => ({ id, expectedRevision: revision, module: 3, position: 1, audience: 'participant', title: 'Session curves', body: 'Secret body', links: [{ label: 'Reading', url: 'https://example.test/read' }], published: true, opensAt: null, files: [], ...extra });
const find = (rows: { id: string }[], id: string) => rows.find(r => r.id === id) as Record<string, unknown> | undefined;

test('Module 0 video opens only after publication and only for an active participant', async () => {
  const mp4 = Buffer.from('000000106674797069736f6d00000000000000086d6f6f76000000086d646174', 'hex');
  await assert.rejects(uploadFile(learner, 'lesson.mp4', mp4), /Only administrators/);
  const file = await uploadFile(admin, 'lesson.mp4', mp4);
  const id = randomUUID();
  const input = { id, expectedRevision: 0, module: 0, position: 1, audience: 'participant', title: 'Intro video', body: '', links: [], published: false, opensAt: null, files: [file.id] };
  const draft = await command(admin, 'material.save', input);
  await assert.rejects(playVideo(learner, file.id), /not available/);
  await command(admin, 'material.save', { ...input, expectedRevision: draft.revision, published: true });
  const open = await playVideo(learner, file.id);
  assert.equal(open.file.mime, 'video/mp4');
  assert.deepEqual(open.bytes, mp4);
  assert.ok((await readWorkspace(learner)).materialFiles.some((f: { file_id: string }) => f.file_id === file.id));
  await command(admin, 'material.save', { ...input, expectedRevision: draft.revision + 1, published: false });
  await assert.rejects(playVideo(learner, file.id), /not available/);
});

test('a material before its opening time shows only the title; content and files stay closed', async () => {
  const file = await uploadFile(admin, 'handout.txt', Buffer.from('Handout'));
  const id = randomUUID();
  const created = await command(admin, 'material.save', material(id, 0, { opensAt: later, files: [file.id] }));
  const closed = find((await readWorkspace(learner)).materials, id)!;
  assert.equal(closed.title, 'Session curves');
  assert.equal(closed.open, false);
  assert.equal(closed.body, undefined, 'the body is not sent before opening');
  assert.equal(closed.links, undefined);
  assert.ok(!(await readWorkspace(learner)).materialFiles.some((f: { file_id: string }) => f.file_id === file.id));
  await assert.rejects(downloadFile(learner, file.id), /not available/);
  await assert.rejects(command(learner, 'material.progress', { materialId: id, studied: true }), /not available/);
  await command(admin, 'material.save', material(id, created.revision, { opensAt: earlier, files: [file.id] }));
  assert.equal(find((await readWorkspace(learner)).materials, id)!.body, 'Secret body');
  assert.equal((await downloadFile(learner, file.id)).bytes.toString(), 'Handout');
  await assert.rejects(command(admin, 'material.save', material(id, created.revision, {})), /changed/, 'a stale editor cannot overwrite');
});

test('drafts and team notes are hidden from participants; only the administrator edits', async () => {
  const draft = randomUUID(); const team = randomUUID();
  await command(admin, 'material.save', material(draft, 0, { published: false, title: 'Draft' }));
  await command(admin, 'material.save', material(team, 0, { audience: 'team', title: 'Host script' }));
  const mine = await readWorkspace(learner);
  assert.ok(!find(mine.materials, draft) && !find(mine.materials, team));
  const staff = await readWorkspace(reviewer);
  assert.ok(find(staff.materials, team) && !find(staff.materials, draft));
  await assert.rejects(command(learner, 'material.save', material(randomUUID(), 0, {})), /Administrator/);
  await assert.rejects(command(reviewer, 'material.save', material(randomUUID(), 0, {})), /Administrator/);
  await assert.rejects(command(admin, 'material.save', material(randomUUID(), 0, { links: [{ label: 'Bad', url: 'javascript:alert(1)' }] })), /full https/);
});

test('studied mark can be set and removed without touching homework', async () => {
  const id = randomUUID();
  await command(admin, 'material.save', material(id, 0, {}));
  const before = (await readWorkspace(learner)).works.map((w: { id: string; status: string }) => `${w.id}:${w.status}`).sort();
  await command(learner, 'material.progress', { materialId: id, studied: true });
  await command(learner, 'material.progress', { materialId: id, studied: true });
  assert.equal((await readWorkspace(learner)).progress.filter((p: { material_id: string }) => p.material_id === id).length, 1);
  await command(learner, 'material.progress', { materialId: id, studied: false });
  const read = await readWorkspace(learner);
  assert.ok(!read.progress.some((p: { material_id: string }) => p.material_id === id));
  assert.deepEqual(read.works.map((w: { id: string; status: string }) => `${w.id}:${w.status}`).sort(), before);
});

test('sessions: end after start, recording hidden until published, editing by administrator only', async () => {
  const id = randomUUID(); const start = '2026-11-15T14:00:00.000Z';
  const input = { id, expectedRevision: 0, module: 2, title: 'Extra session', startsAt: start, endsAt: null, joinUrl: 'https://example.test/join', recordingUrl: 'https://example.test/rec', recordingPublished: false };
  await assert.rejects(command(admin, 'session.save', { ...input, endsAt: start }), /end must be later/);
  await assert.rejects(command(admin, 'session.save', { ...input, recordingUrl: '', recordingPublished: true }), /recording link/);
  await assert.rejects(command(learner, 'session.save', input), /Administrator/);
  const saved = await command(admin, 'session.save', input);
  assert.equal(find((await readWorkspace(learner)).sessions, id)!.recording_url, null);
  await command(admin, 'session.save', { ...input, expectedRevision: saved.revision, recordingPublished: true });
  assert.equal(find((await readWorkspace(learner)).sessions, id)!.recording_url, 'https://example.test/rec');
  const seeded = (await readWorkspace(learner)).sessions.filter((x: { module: number; title: string }) => x.module >= 1 && x.module <= 7 && x.title.startsWith('Live session'));
  assert.deepEqual(seeded.map((x: { module: number }) => x.module), [1, 2, 3, 4, 5, 6], 'seeded calendar: six classes; January pitch awaits a date');
});

test('assignment dates and publication are edited by the administrator; unpublishing keeps work', async () => {
  const schedule = { assignmentId: assignment, published: true, opensAt: null, dueAt: later, latePolicy: 'allow_mark' };
  await assert.rejects(command(admin, 'assignment.schedule', { ...schedule, opensAt: later, dueAt: earlier }), /deadline must be after/);
  await assert.rejects(command(learner, 'assignment.schedule', schedule), /Administrator/);
  const draft = await command(learner, 'draft.create', { assignmentId: assignment });
  await command(admin, 'assignment.schedule', { ...schedule, published: false });
  await assert.rejects(command(learner, 'draft.submit', { draftId: draft.id, expectedRevision: draft.revision, key: randomUUID() }), /unavailable/);
  assert.ok((await readWorkspace(learner)).drafts.some((d: { id: string }) => d.id === draft.id), 'the draft is kept');
  const restored = await command(admin, 'assignment.schedule', schedule);
  assert.equal(new Date(restored.due_at).toISOString(), later);
});
