import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = process.env.QA_ORIGIN || 'http://localhost:8788';
assert.equal(origin,'http://localhost:8788','QA runs only on the isolated local server');
const results: {name:string;status:string;detail?:string}[]=[];
async function check(name:string, run:()=>Promise<void>) {
  try { await run(); results.push({name,status:'Pass'}); }
  catch(e) { results.push({name,status:'Fail',detail:(e as Error).message}); }
}
async function call(path:string,body?:unknown,cookie='') {
  return fetch(`${origin}/api/v1/${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});
}
async function login(email:string) {
  const response=await call('auth/link',{email}); assert.equal(response.status,202);
  const link=(await response.json()).localLink; assert.ok(link);
  assert.equal((await fetch(link)).status,200,'opening the email URL must not consume the token');
  const token=new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  const exchange=await call('auth/exchange',{token}); assert.equal(exchange.status,200);
  assert.equal((await call('auth/exchange',{token})).status,401);
  return exchange.headers.get('set-cookie')!.split(';')[0];
}
const admin=await login('admin@example.test');
const id=randomUUID(),email=`qa-${id}@example.test`;
assert.equal((await call('commands',{action:'enrollment.invite',input:{id,email,name:'QA HTTP disposable',accessEndsAt:'2027-11-01T14:00:00Z'}},admin)).status,200);
const learner=await login(email),stranger=await login('sam@example.test');
const draft=await (await call('commands',{action:'draft.create',input:{assignmentId:'20000000-0000-4000-8000-000000000001'}},learner)).json();
const payload=(text:string)=>({parts:{analysis:{text},concept:{text:'A clear QA concept'}}});

await check('anonymous, CSRF, unknown account and invalid token',async()=>{
  assert.equal((await call('workspace')).status,401);
  const csrf=await fetch(`${origin}/api/v1/auth/link`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}); assert.equal(csrf.status,403);
  const unknown=await call('auth/link',{email:`unknown-${randomUUID()}@example.test`}); assert.equal(unknown.status,202); assert.equal((await unknown.json()).localLink,undefined);
  assert.equal((await call('auth/exchange',{token:'not-a-token'})).status,401);
});
await check('malformed JSON and forbidden admin command return safe client errors',async()=>{
  const r=await fetch(`${origin}/api/v1/commands`,{method:'POST',headers:{Origin:origin,Cookie:learner,'Content-Type':'application/json'},body:'{broken'}); assert.equal(r.status,422);assert.equal((await r.json()).code,'invalid_json');
  assert.equal((await call('commands',{action:'enrollment.revoke',input:{id}},stranger)).status,403);
});
await check('malformed upload body is a validation error, not service unavailable',async()=>{
  const r=await fetch(`${origin}/api/v1/uploads`,{method:'POST',headers:{Origin:origin,Cookie:learner,'Content-Type':'text/plain'},body:'not multipart'}); assert.equal(r.status,422);
});
await check('NUL in an answer is rejected as validation without a database error',async()=>{
  const r=await call('commands',{action:'draft.save',input:{draftId:draft.id,expectedRevision:0,payload:payload('Nul\u0000text')}},learner);assert.equal(r.status,422);
});
await check('corrupt JPEG with only opening and closing markers is rejected',async()=>{
  const f=new FormData();f.set('file',new File([new Uint8Array([255,216,255,217])],'corrupt.jpg',{type:'image/jpeg'}));
  assert.equal((await call('uploads',f,learner)).status,422);
});
let fileId='';
await check('upload, private download, foreign attachment, single concurrent submission',async()=>{
  const f=new FormData();f.set('file',new File(['QA synthetic file'],'Анализ 🎰.txt',{type:'text/plain'}));
  const upload=await call('uploads',f,learner);assert.equal(upload.status,201);fileId=(await upload.json()).id;
  const download=await call(`files/${fileId}/download`,undefined,learner);assert.equal(download.status,200);assert.equal(await download.text(),'QA synthetic file');
  assert.equal((await call(`files/${fileId}/download`,undefined,admin)).status,404);
  assert.equal((await call(`files/${fileId}/download`,undefined,stranger)).status,404);
  const foreign=await (await call('commands',{action:'draft.create',input:{assignmentId:'20000000-0000-4000-8000-000000000001'}},stranger)).json();
  assert.equal((await call('commands',{action:'draft.save',input:{draftId:foreign.id,expectedRevision:foreign.revision,payload:{parts:{analysis:{files:[fileId]}}}}},stranger)).status,422);
  const r=await call('commands',{action:'draft.save',input:{draftId:draft.id,expectedRevision:0,payload:{parts:{analysis:{files:[fileId]},concept:{text:'QA concept'}}}}},learner);assert.equal(r.status,200);
  const input={draftId:draft.id,expectedRevision:1,key:randomUUID()};
  const duplicates=await Promise.all([call('commands',{action:'draft.submit',input},learner),call('commands',{action:'draft.submit',input},learner)]);
  assert.deepEqual(duplicates.map(r=>r.status),[200,200]);const values=await Promise.all(duplicates.map(r=>r.json()));assert.equal(values[0].id,values[1].id);
  assert.equal((await call('commands',{action:'draft.submit',input:{...input,expectedRevision:2}},learner)).status,409);
  assert.equal((await call(`files/${fileId}/download`,undefined,admin)).status,200);
});
await check('revocation and restoration apply to the existing session and files',async()=>{
  assert.equal((await call('commands',{action:'enrollment.revoke',input:{id}},admin)).status,200);
  assert.equal((await call('workspace',undefined,learner)).status,403);
  assert.equal((await call(`files/${fileId}/download`,undefined,learner)).status,403);
  assert.equal((await call('commands',{action:'enrollment.restore',input:{id}},admin)).status,200);
  assert.equal((await call('workspace',undefined,learner)).status,200);
  assert.equal((await call('auth/logout',{},learner)).status,200);
  assert.equal((await call('workspace',undefined,learner)).status,401);
});
await check('email rate limit returns 429 and Retry-After',async()=>{
  let limited:Response|undefined;
  for(let n=0;n<7;n++){const r=await call('auth/link',{email});if(r.status===429){limited=r;break;}assert.equal(r.status,202);}
  assert.ok(limited);assert.equal(limited.headers.get('retry-after'),'900');
});
await call('commands',{action:'enrollment.revoke',input:{id}},admin);
await call('auth/logout',{},admin); await call('auth/logout',{},stranger);
console.log(JSON.stringify({origin,testAccount:email,results},null,2));
process.exitCode=results.some(r=>r.status==='Fail')?1:0;
