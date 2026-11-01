import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command, readWorkspace } from '../src/lib/service';
import { sql } from '../src/lib/db';

const learner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const reviewer = '10000000-0000-4000-8000-000000000003';
const admin = '10000000-0000-4000-8000-000000000004';
after(() => sql.end());

test('course feedback: any time, private to the author and administrators, immutable', async () => {
  const sent = await command(learner, 'feedback.send', { module: 2, rating: 4, body: 'The AI journal template helped.', key: randomUUID() });
  const general = await command(learner, 'feedback.send', { module: null, rating: null, body: 'Sessions start on time.', key: randomUUID() });
  assert.equal(sent.rating, 4); assert.equal(general.module, null);
  assert.ok((await readWorkspace(learner)).feedback.some((f: { id: string }) => f.id === sent.id));
  assert.ok(!(await readWorkspace(other)).feedback.some((f: { id: string }) => f.id === sent.id), 'other participants do not see it');
  assert.ok(!(await readWorkspace(reviewer)).feedback.some((f: { id: string }) => f.id === sent.id), 'experts do not see it');
  assert.ok((await readWorkspace(admin)).feedback.some((f: { id: string }) => f.id === sent.id));
  for (const rating of [0, 6, 2.5]) await assert.rejects(command(learner, 'feedback.send', { module: null, rating, body: 'x', key: randomUUID() }), /Too small|Too big|Invalid input|expected int/i);
  await assert.rejects(command(learner, 'feedback.send', { module: 8, rating: null, body: 'x', key: randomUUID() }), /Too big/i);
  await assert.rejects(command(learner, 'feedback.send', { module: null, rating: null, body: ' ​ ', key: randomUUID() }), /Write your feedback/);
  await assert.rejects(command(reviewer, 'feedback.send', { module: null, rating: null, body: 'Staff note', key: randomUUID() }), /Only participants/);
  const key = randomUUID();
  const once = await command(learner, 'feedback.send', { module: 1, rating: 5, body: 'Retry safe', key });
  assert.equal((await command(learner, 'feedback.send', { module: 1, rating: 5, body: 'Retry safe', key })).id, once.id, 'a repeated request does not duplicate');
  await assert.rejects(sql.begin(async tx => { await tx`update lms.feedback set body='edited' where id=${sent.id}`; }), /Immutable/);
  const [event] = await sql`select kind from lms.outbox where aggregate_id=${sent.id}`;
  assert.equal(event.kind, 'feedback.created');
});
