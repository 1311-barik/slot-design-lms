import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command, readWorkspace } from '../src/lib/service';
import { sql, transaction } from '../src/lib/db';
const sam='10000000-0000-4000-8000-000000000002';
const expert='10000000-0000-4000-8000-000000000003';
const assignment='20000000-0000-4000-8000-000000000001';
after(()=>sql.end());
test('publication, opening time, deadline, assignment snapshot and database immutability',async()=>{
  const draft=await command(sam,'draft.create',{assignmentId:assignment});
  await command(sam,'draft.save',{draftId:draft.id,expectedRevision:0,payload:{parts:{analysis:{text:'Analysis'},concept:{text:'Concept'}}}});
  await sql`update lms.assignments set published=false where id=${assignment}`;
  await assert.rejects(command(sam,'draft.submit',{draftId:draft.id,expectedRevision:1,key:randomUUID()}),/unavailable/);
  assert.equal((await readWorkspace(sam)).drafts[0].payload.parts.analysis.text,'Analysis');
  assert.equal((await readWorkspace(sam)).assignments.find((a:any)=>a.id===assignment).published,false,'history remains in navigation without exposing future condition');
  await sql`update lms.assignments set published=true,opens_at=clock_timestamp()+interval '1 day' where id=${assignment}`;
  await assert.rejects(command(sam,'draft.submit',{draftId:draft.id,expectedRevision:1,key:randomUUID()}),/unavailable/);
  await sql`update lms.assignments set opens_at=null,due_at=clock_timestamp()-interval '1 day',late_policy='block_after_due' where id=${assignment}`;
  await assert.rejects(command(sam,'draft.submit',{draftId:draft.id,expectedRevision:1,key:randomUUID()}),/deadline/);
  await sql`update lms.assignments set late_policy='allow_mark',revision=2,spec=jsonb_set(spec,'{title}','"Changed later"') where id=${assignment}`;
  const submission=await command(sam,'draft.submit',{draftId:draft.id,expectedRevision:1,key:randomUUID()});
  assert.equal(submission.spec.title,'1.2 · Game analysis & your concept');assert.equal(submission.late,true);assert.ok(submission.due_at_snapshot);
  await assert.rejects(sql`update lms.submissions set payload='{}' where id=${submission.id}`,/Immutable/);
  await sql`update lms.reviewers set reviewer_id='10000000-0000-4000-8000-000000000004' where assignment_id=${assignment}`;
  await assert.rejects(command(expert,'submission.claim',{submissionId:submission.id}),/not available/);
  await sql`update lms.reviewers set reviewer_id=${expert} where assignment_id=${assignment}`;
  await sql`update lms.profiles set revoked_at=clock_timestamp() where id=${sam}`;
  await assert.rejects(readWorkspace(sam),/not active/);
  await sql`update lms.profiles set revoked_at=null where id=${sam}`;
  await sql`update lms.assignments set due_at=clock_timestamp()+interval '30 days',revision=1,spec=${sql.json(submission.spec)} where id=${assignment}`;
});

test('RLS denies other participants and staff access to private drafts',async()=>{
  const draft=await command(sam,'draft.create',{assignmentId:assignment});
  for(const actor of [expert,'10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001']) {
    const rows=await transaction(actor,tx=>tx`select * from lms.drafts where id=${draft.id}`);
    assert.equal(rows.length,0);
  }
});
