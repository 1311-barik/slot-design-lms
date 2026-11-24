import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LessonVideo } from '../src/app/workspace';

test('participant player offers streaming and captions without a video download link', () => {
  const markup = renderToStaticMarkup(createElement(LessonVideo, { fileId: 'video', captionId: 'captions', title: 'Course video', studied: false }));
  assert.match(markup, /controlsList="nodownload"/i);
  assert.match(markup, /src="\/api\/v1\/files\/video\/play"/);
  assert.match(markup, /src="\/api\/v1\/files\/captions\/captions"/);
  assert.doesNotMatch(markup, /href="[^\"]*\/download/);
  assert.match(markup, /Turn on English subtitles/);
});

test('administrator can retain the original video download, and studied videos remain covered', () => {
  const admin = renderToStaticMarkup(createElement(LessonVideo, { fileId: 'video', title: 'Course video', studied: false, allowDownload: true }));
  assert.match(admin, /href="\/api\/v1\/files\/video\/download"/);
  assert.doesNotMatch(admin, /controlsList="nodownload"/i);
  const studied = renderToStaticMarkup(createElement(LessonVideo, { fileId: 'video', title: 'Course video', studied: true }));
  assert.match(studied, /Watch again/);
  assert.doesNotMatch(studied, /href="[^\"]*\/download/);
});
