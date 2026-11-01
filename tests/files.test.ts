import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { inspectFile } from '../src/lib/file-validation';
test('reject disguised files, empty files and Office macros', () => {
  assert.throws(() => inspectFile('picture.png', Buffer.from('<script>alert(1)</script>')), /format/);
  assert.throws(() => inspectFile('empty.txt', Buffer.alloc(0)), /empty/);
  assert.throws(() => inspectFile('macro.docx', Buffer.from(zipSync({ '[Content_Types].xml': strToU8('macroEnabled'), 'word/vbaProject.bin': strToU8('macro') }))), /macros/);
  assert.equal(inspectFile('notes.txt', Buffer.from('My analysis')).mime, 'text/plain');
  assert.throws(() => inspectFile('notes.txt', Buffer.from([0xff,0xfe])), /UTF-8/);
});
