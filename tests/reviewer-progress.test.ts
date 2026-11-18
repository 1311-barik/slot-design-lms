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

test('explicit reviewer access shows participant studied marks without granting write or admin access', async () => {
  const materialId = randomUUID();
  await command(admin, 'material.save', {
    id: materialId, expectedRevision: 0, module: 1, position: 1,
    audience: 'participant', title: 'Progress example', body: '', links: [],
    published: true, opensAt: null, files: [],
  });
  await command(learner, 'material.progress', { materialId, studied: true });

  const before = await readWorkspace(reviewer);
  assert.equal(before.progressAccess, false);
  assert.ok(!before.progress.some((p: { material_id: string }) => p.material_id === materialId));

  await sql`insert into lms.reviewer_progress_access(reviewer_id) values(${reviewer})`;
  const granted = await readWorkspace(reviewer);
  assert.equal(granted.progressAccess, true);
  assert.ok(granted.progress.some((p: { material_id: string; owner_id: string }) => p.material_id === materialId && p.owner_id === learner));
  assert.equal(granted.people.find((p: { id: string }) => p.id === learner)?.email, null);
  assert.ok(!(await readWorkspace(other)).progress.some((p: { material_id: string }) => p.material_id === materialId));
  await assert.rejects(command(reviewer, 'material.progress', { materialId, studied: false }), /Only participants/);
  await assert.rejects(command(reviewer, 'material.save', {
    id: randomUUID(), expectedRevision: 0, module: 1, position: 1,
    audience: 'participant', title: 'Forbidden edit', body: '', links: [],
    published: true, opensAt: null, files: [],
  }), /Administrator/);
});

test('an expert without an assigned homework cannot use a progress grant', async () => {
  const id = randomUUID();
  await sql`insert into lms.profiles(id,email,name,role,activated_at,access_ends_at) values(${id},${`${id}@example.test`},'Unassigned expert','reviewer',now(),now()+interval '1 year')`;
  await sql`insert into lms.reviewer_progress_access(reviewer_id) values(${id})`;
  const workspace = await readWorkspace(id);
  assert.equal(workspace.progressAccess, false);
  assert.deepEqual(workspace.progress, []);
});
