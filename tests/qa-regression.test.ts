import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { command, readWorkspace } from '../src/lib/service';
import { sql } from '../src/lib/db';
import { payloadSchema, validateSubmission, type Payload } from '../src/lib/contract';
import { inspectFile, inspectContent } from '../src/lib/file-validation';
import sharp from 'sharp';

after(() => sql.end());
async function fixture() {
  const learner = randomUUID(), expert = randomUUID(), assignment = randomUUID();
  for (const [id, role] of [[learner,'participant'],[expert,'reviewer']]) {
    await sql`insert into lms.profiles(id,email,name,role,activated_at,access_ends_at) values(${id},${`${id}@example.test`},'QA synthetic',${role},now(),now()+interval '1 year')`;
  }
  await sql`insert into lms.assignments(id,module,spec,published,due_at,late_policy) select ${assignment},module,spec,true,now()+interval '1 day','allow_mark' from lms.assignments where id='20000000-0000-4000-8000-000000000001'`;
  await sql`insert into lms.reviewers values(${assignment},${expert})`;
  const draft = await command(learner,'draft.create',{assignmentId:assignment});
  await command(learner,'draft.save',{draftId:draft.id,expectedRevision:0,payload:{parts:{analysis:{text:'QA analysis'},concept:{text:'QA concept'}}}});
  const submission = await command(learner,'draft.submit',{draftId:draft.id,expectedRevision:1,key:randomUUID()});
  return { learner, expert, assignment, submission };
}

test('publishing supersedes the saved feedback draft and invalidates stale editors', async () => {
  const f = await fixture();
  await command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:0,body:'Old draft',action:'needs_revision'});
  await command(f.expert,'review.publish',{submissionId:f.submission.id,expectedRevision:1,body:'Published final text',action:'accepted',key:randomUUID()});
  const workspace = await readWorkspace(f.expert);
  assert.equal(workspace.reviewDrafts.find((d: any) => d.submission_id===f.submission.id)?.body,'Published final text');
  await assert.rejects(command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:1,body:'Stale overwrite',action:'needs_revision'}),/changed/);
});

test('correction draft persists its reason together with the feedback', async () => {
  const f = await fixture();
  const review = await command(f.expert,'review.publish',{submissionId:f.submission.id,expectedRevision:0,body:'Initial',action:'accepted',key:randomUUID()});
  const workspace = await readWorkspace(f.expert);
  const revision = workspace.reviewDrafts.find((d: any) => d.submission_id===f.submission.id)?.revision || 0;
  await command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:revision,body:'Correction draft',action:'needs_revision',reason:'Original criterion was incomplete.',replacesId:review.id});
  assert.equal((await readWorkspace(f.expert)).reviewDrafts.find((d: any) => d.submission_id===f.submission.id)?.reason,'Original criterion was incomplete.');
});

test('replacement expert can save own draft without seeing the former expert draft', async () => {
  const f = await fixture();
  await command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:0,body:'Private former expert',action:'needs_revision'});
  const replacement=randomUUID();
  await sql`insert into lms.profiles(id,email,name,role,activated_at,access_ends_at) values(${replacement},${`${replacement}@example.test`},'Replacement expert','reviewer',now(),now()+interval '1 year')`;
  await sql`update lms.reviewers set reviewer_id=${replacement} where assignment_id=${f.assignment}`;
  assert.equal((await readWorkspace(replacement)).reviewDrafts.filter((d: any)=>d.submission_id===f.submission.id).length,0);
  await command(replacement,'review.save',{submissionId:f.submission.id,expectedRevision:0,body:'New expert private draft',action:'accepted'});
  assert.equal((await readWorkspace(f.expert)).reviewDrafts.filter((d: any)=>d.submission_id===f.submission.id).length,0);
});

test('feedback accepts 50000 Unicode code points and rejects 50001',async()=>{
  const f=await fixture();
  await command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:0,body:'🎰'.repeat(50000),action:'accepted'});
  await assert.rejects(command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:1,body:'🎰'.repeat(50001),action:'accepted'}));
});

test('stale publication cannot overwrite a newer saved draft; retry creates one review',async()=>{
  const f=await fixture();
  await command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:0,body:'Tab A',action:'needs_revision'});
  await command(f.expert,'review.save',{submissionId:f.submission.id,expectedRevision:1,body:'Newer tab B',action:'accepted'});
  await assert.rejects(command(f.expert,'review.publish',{submissionId:f.submission.id,expectedRevision:1,body:'Stale tab A',action:'needs_revision',key:randomUUID()}),/changed/);
  const input={submissionId:f.submission.id,expectedRevision:2,body:'Newer tab B',action:'accepted',key:randomUUID()};
  const [a,b]=await Promise.all([command(f.expert,'review.publish',input),command(f.expert,'review.publish',input)]);
  assert.equal(a.id,b.id);
  assert.equal((await readWorkspace(f.learner)).reviews.length,1);
  const [outbox]=await sql`select count(*)::int as n from lms.outbox where aggregate_id=${a.id}`;assert.equal(outbox.n,1);
  await assert.rejects(command(f.expert,'review.publish',{...input,body:'Changed payload'}),/different action/);
  await assert.rejects(command(f.expert,'submission.claim',{submissionId:f.submission.id}),/already has a decision/);
});

test('correction requires meaningful reason and rejects a stale published base',async()=>{
  const f=await fixture();
  const first=await command(f.expert,'review.publish',{submissionId:f.submission.id,expectedRevision:0,body:'First',action:'accepted',key:randomUUID()});
  for(const reason of ['', ' \n ', '\u200b\u2060']) await assert.rejects(command(f.expert,'review.publish',{submissionId:f.submission.id,expectedRevision:1,body:'Correction',action:'needs_revision',replacesId:first.id,reason,key:randomUUID()}),/Explain why/);
  const next=await command(f.expert,'review.publish',{submissionId:f.submission.id,expectedRevision:1,body:'Correction',action:'needs_revision',replacesId:first.id,reason:'Criterion clarified',key:randomUUID()});
  await assert.rejects(command(f.expert,'review.publish',{submissionId:f.submission.id,expectedRevision:2,body:'Stale correction',action:'accepted',replacesId:first.id,reason:'Old base',key:randomUUID()}),/changed/);
  const reviews=(await readWorkspace(f.learner)).reviews;
  assert.equal(reviews.length,2);assert.equal(reviews.find((r:any)=>r.id===first.id).body,'First');assert.equal(reviews.find((r:any)=>r.id===next.id).replaces_id,first.id);
  assert.equal((await readWorkspace(f.learner)).reviewDrafts.length,0);
});

test('image decoding accepts real PNG/JPEG/WebP and rejects marker-only or truncated files',async()=>{
  for(const ext of ['png','jpeg','webp'] as const) {
    const bytes=await sharp({create:{width:4,height:4,channels:3,background:'#246e59'}})[ext]().toBuffer();
    assert.equal((await inspectContent(`valid.${ext}`,bytes)).mime,`image/${ext}`);
    await assert.rejects(inspectContent(`truncated.${ext}`,bytes.subarray(0,24)));
  }
  await assert.rejects(inspectContent('corrupt.jpg',Buffer.from([255,216,255,217])),/cannot be read/);
});

test('text boundaries, invisible input, link-only, unknown parts and injection literals',()=>{
  const spec={title:'QA',parts:[{id:'a',title:'A',hint:'',required:true}]};
  for(const length of [0,1,49999,50000,50001]) {
    const result=payloadSchema.safeParse({parts:{a:{text:'🎰'.repeat(length)}}});
    assert.equal(result.success,length<=50000,`code points ${length}`);
  }
  for(const value of ['', ' \t\n', '\u200b\u2060', 'https://example.test/answer']) {
    const p=payloadSchema.parse({parts:{a:{text:value}}});
    assert.throws(()=>validateSubmission(spec,p,[]),/Complete/);
  }
  const p=payloadSchema.parse({parts:{a:{text:'<script>literal</script> <>& Тест 🎰'}}});
  assert.doesNotThrow(()=>validateSubmission(spec,p,[]));
  assert.throws(()=>validateSubmission(spec,{parts:{...p.parts,extra:p.parts.a}},[]),/does not belong/);
  assert.equal(payloadSchema.safeParse({parts:{a:{text:'OK',role:'admin'}}}).success,false);
});

test('file size boundaries and format/name/UTF8 classes',()=>{
  for(const size of [0,1,49999999,50000000,50000001]) {
    const bytes=Buffer.alloc(size,65);
    if(size===0||size>50000000) assert.throws(()=>inspectFile('QA.txt',bytes));
    else assert.equal(inspectFile('QA.txt',bytes).size,size);
  }
  for(const name of ['../work.txt','work\\answer.txt','a\n.txt','x'.repeat(241)+'.txt','work.exe']) assert.throws(()=>inspectFile(name,Buffer.from('Answer')));
  for(const data of [Buffer.from([0xff]),Buffer.from('nul\0byte')]) assert.throws(()=>inspectFile('work.txt',data));
  assert.equal(inspectFile('Анализ 🎰.TXT',Buffer.from('UTF-8 answer')).mime,'text/plain');
});

test('visual collections at every count and removal of a middle image preserve the remaining identities',()=>{
  const spec={title:'Visuals',parts:[{id:'images',title:'Images',hint:'',required:true,kind:'images' as const}]};
  const files=Array.from({length:7},()=>({id:randomUUID(),mime:'image/png',size:100}));
  for(let count=0;count<=7;count++) {
    const p:Payload={parts:{images:{text:'',files:[],images:files.slice(0,count).map((f,i)=>({fileId:f.id,prompt:`Prompt ${i}`,caption:`Caption ${i}`}))}}};
    if(count<3||count>6) assert.throws(()=>validateSubmission(spec,p,files.slice(0,count)));
    else assert.doesNotThrow(()=>validateSubmission(spec,p,files.slice(0,count)));
  }
  const images=files.slice(0,4).map((f,i)=>({fileId:f.id,prompt:`Prompt ${i}`,caption:`Caption ${i}`}));
  images.splice(1,1);
  const p:Payload={parts:{images:{text:'',files:[],images}}};
  assert.doesNotThrow(()=>validateSubmission(spec,p,files.filter((_,i)=>[0,2,3].includes(i))));
  assert.deepEqual(images.map(i=>i.prompt),['Prompt 0','Prompt 2','Prompt 3']);
  images[1].fileId=images[0].fileId; assert.throws(()=>validateSubmission(spec,p,files),/Complete/);
});

test('total attachment boundaries: 20 files and 200 MB inclusive',()=>{
  const spec={title:'QA',parts:[{id:'a',title:'A',hint:'',required:true}]};
  for(const count of [19,20,21]) {
    const files=Array.from({length:count},()=>({id:randomUUID(),mime:'text/plain',size:1}));
    const p:Payload={parts:{a:{text:'Answer',files:files.map(f=>f.id),images:[]}}};
    if(count>20) assert.throws(()=>validateSubmission(spec,p,files),/at most/); else assert.doesNotThrow(()=>validateSubmission(spec,p,files));
  }
  for(const total of [199999999,200000000,200000001]) {
    const files=Array.from({length:5},(_,i)=>({id:randomUUID(),mime:'text/plain',size:i===4 ? total-160000000 : 40000000}));
    const p:Payload={parts:{a:{text:'Answer',files:files.map(f=>f.id),images:[]}}};
    if(total>200000000) assert.throws(()=>validateSubmission(spec,p,files),/200 MB/); else assert.doesNotThrow(()=>validateSubmission(spec,p,files));
  }
});
