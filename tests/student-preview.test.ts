import { test } from 'node:test';
import assert from 'node:assert/strict';
import { courseViewUrl, expertViewRequested, previewRequested, studentPreviewUrl, studentViewRequested } from '../src/lib/student-preview';
const learner = '10000000-0000-4000-8000-000000000001';

test('student preview retains the selected participant through navigation, files, notifications and reload', () => {
  const search = courseViewUrl(2, true, learner);
  assert.equal(studentViewRequested(search), true);
  assert.equal(new URLSearchParams(search).get('student'), learner);
  const notification = studentPreviewUrl('/?module=2#feedback', search);
  assert.equal(notification, `/?module=2&view=student&student=${learner}#feedback`);
  assert.equal(studentPreviewUrl('/api/v1/files/abc/play', search, true), `/api/v1/files/abc/play?preview=student&student=${learner}`);
  assert.equal(studentPreviewUrl('https://example.test/', search), 'https://example.test/');
  assert.equal(studentPreviewUrl('//example.test/', search), '//example.test/');
  assert.equal(courseViewUrl('project', false, learner), '?module=project');
  assert.equal(studentPreviewUrl('/?module=2', '?module=1'), '/?module=2');
});

test('expert preview retains the selected expert for navigation and every internal API link', () => {
  const expert = '10000000-0000-4000-8000-000000000003';
  const search = courseViewUrl(2, 'expert', expert);
  assert.equal(expertViewRequested(search), true);
  assert.equal(previewRequested(search), true);
  assert.equal(studentViewRequested(search), false);
  assert.equal(studentPreviewUrl('/?module=1#review', search), `/?module=1&view=expert&expert=${expert}#review`);
  assert.equal(studentPreviewUrl('/api/v1/commands', search, true), `/api/v1/commands?preview=expert&expert=${expert}`);
  assert.equal(studentPreviewUrl('/api/v1/files/abc/play', search, true), `/api/v1/files/abc/play?preview=expert&expert=${expert}`);
  assert.equal(courseViewUrl(2, false, expert), '?module=2');
  assert.equal(studentPreviewUrl('https://example.test/', search), 'https://example.test/');
});
