import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const origin = 'http://127.0.0.1:8787';
async function call(path: string, body?: unknown, cookie = '') {
  const response = await fetch(`${origin}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, Cookie: cookie, ...(body instanceof FormData ? {} : { 'Content-Type':'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  return response;
}
async function login(email: string) {
  const response = await call('auth/link',{email}); assert.equal(response.status,202);
  const parts = new URLSearchParams(new URL((await response.json()).localLink).hash.slice(1)); const credentials = parts.has('access') ? { accessToken: parts.get('access') } : { token: parts.get('token') };
  const exchange = await call('auth/exchange',credentials); assert.equal(exchange.status,200);
  assert.equal((await call('auth/exchange',credentials)).status,parts.has('access')?200:401,'link lifetime matches its kind');
  return exchange.headers.get('set-cookie')!.split(';')[0];
}
const unauth = await call('workspace'); assert.equal(unauth.status,401);
const csrf = await fetch(`${origin}/api/v1/auth/link`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@example.test'})});assert.equal(csrf.status,403);
const admin = await login('admin@example.test');
const email = `test-${randomUUID()}@example.test`;
const person = randomUUID();
let r = await call('commands',{action:'enrollment.invite',input:{id:person,email,name:'HTTP test participant',accessEndsAt:'2027-11-01T14:00:00Z'}},admin);assert.equal(r.status,200);
const learner = await login(email); const stranger = await login('sam@example.test');
r = await call('commands',{action:'draft.create',input:{assignmentId:'20000000-0000-4000-8000-000000000001'}},learner);assert.equal(r.status,200);const draft = await r.json();
const upload = new FormData();upload.set('file',new File(['A synthetic game analysis.'],'analysis.txt',{type:'text/plain'}));
r = await call('uploads',upload,learner);assert.equal(r.status,201);const file = await r.json();
assert.equal((await call(`files/${file.id}/download`,undefined,learner)).status,200);
assert.equal((await call(`files/${file.id}/download`,undefined,stranger)).status,404);
assert.equal((await call(`files/${file.id}/download`,undefined,admin)).status,404,'admin cannot read private draft files');
r = await call('commands',{action:'draft.save',input:{draftId:draft.id,expectedRevision:0,payload:{parts:{analysis:{text:'',files:[file.id],images:[]},concept:{text:'A coherent concept.',files:[],images:[]}}}}},learner);assert.equal(r.status,200);
const request = {action:'draft.submit',input:{draftId:draft.id,expectedRevision:1,key:randomUUID()}};
const results = await Promise.all([call('commands',request,learner),call('commands',request,learner)]);
assert.deepEqual(results.map(r=>r.status),[200,200]);const copies = await Promise.all(results.map(r=>r.json()));assert.equal(copies[0].id,copies[1].id,'concurrent retry yields one submission');
assert.equal((await call(`files/${file.id}/download`,undefined,admin)).status,200,'admin may read submitted files');
assert.equal((await call(`files/${file.id}/download`,undefined,stranger)).status,404);
r=await call('commands',{action:'enrollment.revoke',input:{id:person}},admin);assert.equal(r.status,200);
assert.equal((await call('workspace',undefined,learner)).status,403);
assert.equal((await call(`files/${file.id}/download`,undefined,learner)).status,403,'revocation applies to existing file links');
console.log('HTTP integration passed: CSRF, invitation, one-use login, real upload/download, private files, concurrent submission, revocation.');
