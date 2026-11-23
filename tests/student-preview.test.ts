import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseViewUrl, studentPreviewData, studentViewRequested } from '../src/lib/student-preview';

const fixture = () => ({
  me: { id: 'administrator', role: 'admin' }, now: '2026-11-23T12:00:00Z',
  materials: [
    { id: 'open', module: 0, position: 1, title: 'Welcome', published: true, audience: 'participant', opens_at: null, open: true, body: 'Welcome text' },
    { id: 'future', module: 0, position: 2, title: 'Later', published: true, audience: 'participant', opens_at: '2026-11-24T12:00:00Z', open: true, body: 'Hidden text', links: [{ label: 'Secret', url: 'https://example.test' }] },
    { id: 'draft', published: false, audience: 'participant', open: true },
    { id: 'team', published: true, audience: 'team', open: true },
  ],
  assignments: [{ id: 'published-homework', published: true }, { id: 'draft-homework', published: false }, { id: 'future-homework', published: true, opens_at: '2026-11-24T12:00:00Z' }],
  materialFiles: [
    { id: 'attachment-1', material_id: 'open', file_id: 'video' },
    { id: 'attachment-2', material_id: 'future', file_id: 'future-video' },
    { id: 'attachment-3', material_id: 'team', file_id: 'team-file' },
  ],
  files: [{ id: 'video' }, { id: 'future-video' }, { id: 'team-file' }, { id: 'student-work' }],
  sessions: [{ id: 'session', recording_published: false, recording_url: 'https://example.test/unpublished' }],
  people: [{ id: 'student' }], works: [{ id: 'student-work' }], progress: [{ id: 'studied' }],
  project: { id: 'admin-project' }, notifications: [{ id: 'admin-email' }],
});

test('student preview keeps published course order and gates future content even when admin can open it', () => {
  const view = studentPreviewData(fixture());
  assert.deepEqual(view.materials.map(m => m.id), ['open', 'future']);
  assert.equal(view.materials[0].open, true);
  assert.equal(view.materials[1].open, false);
  assert.equal('body' in view.materials[1], false);
  assert.equal('links' in view.materials[1], false);
  assert.deepEqual(view.assignments.map(a => a.id), ['published-homework']);
  assert.deepEqual(view.files.map(f => f.id), ['video']);
  assert.deepEqual(view.materialFiles.map(f => f.file_id), ['video']);
  assert.equal(view.sessions[0].recording_url, null);
});

test('switching view preserves the real administrator and original data without using a student identity', () => {
  const data = fixture(); const original = structuredClone(data);
  const view = studentPreviewData(data);
  assert.deepEqual(data, original);
  assert.equal(view.me.id, 'administrator');
  assert.equal(view.me.role, 'admin');
  assert.deepEqual(view.people, []);
  assert.deepEqual(view.works, []);
  assert.deepEqual(view.progress, []);
  assert.deepEqual(view.notifications, []);
  assert.equal(view.project, null);
});

test('preview uses the current course clock and reveals a material at its opening time', () => {
  const data = fixture(); data.now = '2026-11-24T12:00:00Z';
  const view = studentPreviewData(data);
  assert.equal(view.materials[1].open, true);
  assert.equal(view.materials[1].body, 'Hidden text');
  assert.deepEqual(view.files.map(f => f.id), ['video', 'future-video']);
  assert.deepEqual(view.assignments.map(a => a.id), ['published-homework', 'future-homework']);
});

test('student view survives module navigation and reload, and returning to admin clears the view flag', () => {
  assert.equal(courseViewUrl(2, true), '?module=2&view=student');
  assert.equal(studentViewRequested(courseViewUrl('project', true)), true);
  assert.equal(studentViewRequested(courseViewUrl(0, false)), false);
  assert.equal(studentViewRequested('?module=2&view=admin'), false);
});
