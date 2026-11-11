import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createAccessLink, withAccessLink } from '../src/lib/access-links';
import { command } from '../src/lib/service';
import { sql, transaction } from '../src/lib/db';
const admin = '10000000-0000-4000-8000-000000000004';
after(() => sql.end());
async function person() {
  const id = randomUUID(), email = `${id}@example.test`;
  await command(admin, 'enrollment.invite', { id, email, name: 'Link QA', accessEndsAt: new Date(Date.now()+86400000).toISOString() });
  const url = await createAccessLink(email);
  const token = new URLSearchParams(new URL(url).hash.slice(1)).get('access')!;
  return { id, email, token };
}
test('personal links do not expire with age, survive reuse and newer mail, and store only a digest', async () => {
  const p = await person();
  assert.match(p.token,/^[a-f0-9]{64}$/);
  const [stored] = await sql`select * from lms.sign_in_links where profile_id=${p.id}`;
  assert.equal(stored.token_hash,createHash('sha256').update(p.token).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(p.token));
  await sql`update lms.sign_in_links set created_at=now()-interval '10 years' where profile_id=${p.id}`;
  for(let i=0;i<2;i++) assert.equal(await withAccessLink(p.token,async(_,who)=>who.id),p.id);
  await createAccessLink(p.email);
  assert.equal(await withAccessLink(p.token,async(_,who)=>who.email),p.email);
  const [profile] = await sql`select activated_at,password_set_at from lms.profiles where id=${p.id}`;
  assert.equal(profile.activated_at,null);assert.equal(profile.password_set_at,null);
  assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${p.id}`).length,0);
});
test('invalid, expired-access and revoked links cannot authenticate; restoring access does not revive a revoked link', async () => {
  for(const token of ['wrong','a'.repeat(64)]) await assert.rejects(withAccessLink(token,async()=>true),e=>(e as any).status===401);
  const p=await person();
  await sql`update lms.profiles set access_ends_at=now()-interval '1 second' where id=${p.id}`;
  await assert.rejects(withAccessLink(p.token,async()=>true),e=>(e as any).status===403);
  await assert.rejects(createAccessLink(p.email),e=>(e as any).status===403);
  await sql`update lms.profiles set access_ends_at=now()+interval '1 day' where id=${p.id}`;
  await command(admin,'enrollment.revoke',{id:p.id});
  await command(admin,'enrollment.restore',{id:p.id});
  await assert.rejects(withAccessLink(p.token,async()=>true),e=>(e as any).status===401);
  const fresh=new URLSearchParams(new URL(await createAccessLink(p.email)).hash.slice(1)).get('access')!;
  assert.equal(await withAccessLink(fresh,async(_,who)=>who.id),p.id);
});
test('link secrets are private to the backend; runtime actors cannot inspect or mint them',async()=>{
  const p=await person();
  await sql`update lms.profiles set activated_at=now() where id=${p.id}`;
  for(const actor of [admin,p.id]) await assert.rejects(transaction(actor,tx=>tx`select token_hash from lms.sign_in_links`),e=>(e as any).code==='42501');
  await assert.rejects(sql.begin(async tx=>{await tx`set local role lms_backend`;await tx`update lms.sign_in_links set revoked_at=now() where profile_id=${p.id}`;}),e=>(e as any).code==='42501');
  await sql.begin(async tx=>{await tx`set local role lms_backend`;assert.equal((await tx`select profile_id from lms.sign_in_links where profile_id=${p.id}`).length,1);});
});
test('a participant link cannot acquire team privileges after a role change',async()=>{
  const p=await person();
  try {
    await sql`update lms.profiles set role='admin' where id=${p.id}`;
    await assert.rejects(withAccessLink(p.token,async()=>true),e=>(e as any).status===401);
    await assert.rejects(createAccessLink(p.email),e=>(e as any).status===403);
  } finally { await sql`update lms.profiles set revoked_at=now() where id=${p.id}`; }
});
test('link authentication serializes with administrative access revocation',async()=>{
  const p=await person(); let enter!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});const finish=new Promise<void>(resolve=>{release=resolve;});
  const authentication=withAccessLink(p.token,async(_,who)=>{enter();await finish;return who.id;});
  await entered;const revoke=command(admin,'enrollment.revoke',{id:p.id});release();
  assert.equal((await Promise.all([authentication,revoke]))[0],p.id);
  await assert.rejects(withAccessLink(p.token,async()=>true),e=>(e as any).status===401);
});
