import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmission, type Payload } from '../src/lib/contract';
import { assignmentSpecs } from '../src/lib/course';

test('composite homework requires both named parts, including meaningful text', () => {
  const spec = { title: '1.2', parts: [{ id: 'a', title: 'Analysis', hint: '', required: true }, { id: 'b', title: 'Concept', hint: '', required: true }] };
  const payload: Payload = { parts: { a: { text: 'Analysis', files: [], images: [] }, b: { text: '\u200b  ', files: [], images: [] } } };
  assert.throws(() => validateSubmission(spec, payload, []), /Complete/);
  payload.parts.b.text = 'Concept';
  assert.doesNotThrow(() => validateSubmission(spec, payload, []));
  payload.parts.b.text = 'https://example.test/my-work';
  assert.throws(() => validateSubmission(spec,payload,[]),/Complete/,'a link alone is not a completed part');
});

test('visual homework requires 3–6 different image files with prompts and explanations',()=>{
  const spec={title:'2.2',parts:[{id:'visuals',title:'Visuals',hint:'',required:true,kind:'images' as const}]};
  const files=[1,2,3].map(n=>({id:`30000000-0000-4000-8000-00000000000${n}`,mime:'image/png',size:100}));
  const payload:Payload={parts:{visuals:{text:'',files:[],images:files.map(f=>({fileId:f.id,prompt:'A final prompt',caption:'Why it fits'}))}}};
  assert.doesNotThrow(()=>validateSubmission(spec,payload,files));
  payload.parts.visuals.images[1].prompt='\u200b';assert.throws(()=>validateSubmission(spec,payload,files),/Complete/);
  payload.parts.visuals.images[1].prompt='Restored';payload.parts.visuals.images[1].fileId=files[0].id;assert.throws(()=>validateSubmission(spec,payload,files),/Complete/);
});

test('homework 3.2–6.2 follow the programme: every named part is required and checked separately', () => {
  const expected: Record<string, string[]> = { '3.2': ['curve','ethics','changes'], '4.2': ['rtp','budget','changes'], '5.2': ['event','economics','changes'], '6.2': ['versions','accepted','rejected','borrowed'] };
  for (const [code, ids] of Object.entries(expected)) {
    const spec = assignmentSpecs.find(s => s.title.startsWith(code));
    assert.ok(spec, `${code} is defined`);
    assert.deepEqual(spec.parts.map(p => p.id), ids);
    assert.ok(spec.parts.every(p => p.required && p.kind === undefined && p.hint.length > 0));
    const full: Payload = { parts: Object.fromEntries(ids.map(id => [id, { text: `Answer for ${id}`, files: [], images: [] }])) };
    assert.doesNotThrow(() => validateSubmission(spec, full, []));
    full.parts[ids.at(-1)!].text = ' ';
    assert.throws(() => validateSubmission(spec, full, []), (e: { fields: string[] }) => e.fields.length === 1 && e.fields[0] === ids.at(-1));
  }
  assert.deepEqual(assignmentSpecs.map(s => s.title.split(' ')[0]), ['1.2','2.2','3.2','4.2','5.2','6.2','6.1','7.1','7.2']);
});

test('self-assessment needs one of the three levels; the final package needs own submitted versions', () => {
  const self = assignmentSpecs.find(s => s.title.startsWith('6.1'))!;
  assert.equal(self.mode, 'self_assessment');
  const answer: Payload = { parts: { level: { text: 'Strong', files: [], images: [] }, reasons: { text: 'Clear hook.', files: [], images: [] }, weakSpot: { text: 'Math.', files: [], images: [] } } };
  assert.doesNotThrow(() => validateSubmission(self, answer, []));
  answer.parts.level.text = 'Excellent';
  assert.throws(() => validateSubmission(self, answer, []), (e: { fields: string[] }) => e.fields.join() === 'level');
  const pack = assignmentSpecs.find(s => s.title.startsWith('7.2'))!;
  const own = '40000000-0000-4000-8000-000000000001', foreign = '40000000-0000-4000-8000-000000000002';
  const parts = Object.fromEntries(pack.parts.map(p => [p.id, { text: 'Ready', files: [], images: [], submissions: [] as string[] }]));
  assert.throws(() => validateSubmission(pack, { parts }, [], [own]), (e: { fields: string[] }) => e.fields.join() === 'layers');
  parts.layers.submissions = [own];
  assert.doesNotThrow(() => validateSubmission(pack, { parts }, [], [own]));
  parts.layers.submissions = [own, foreign];
  assert.throws(() => validateSubmission(pack, { parts }, [], [own]), /Complete/, 'another participant’s version is rejected');
});
