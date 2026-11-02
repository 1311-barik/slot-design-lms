import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from '../src/lib/db';
after(() => sql.end());

test('backend can authenticate and plan mail but cannot change roles, schema or read private drafts', async () => {
  await sql.begin(async tx => {
    await tx`set local role lms_backend`;
    const profiles = await tx`select id from lms.profiles`;
    assert.ok(profiles.length >= 4);
    await tx`update lms.profiles set activated_at=activated_at where false`;
    await tx`select s.id from lms.submissions s join lms.works w on w.id=s.work_id limit 1`;
    await tx`select count(*) from lms.notifications`;
    const [role] = await tx`select rolsuper,rolbypassrls,rolcreatedb,rolcreaterole from pg_roles where rolname=current_user`;
    assert.deepEqual({...role}, {rolsuper:false,rolbypassrls:false,rolcreatedb:false,rolcreaterole:false});
  });
  for (const query of [
    'select * from lms.drafts',
    'select * from lms.dev_passwords',
    "update lms.profiles set role='admin' where false",
    'alter table lms.profiles add column unauthorized text',
  ]) await assert.rejects(sql.begin(async tx => {
    await tx`set local role lms_backend`;
    await tx.unsafe(query);
  }), (error: any) => error.code === '42501');
  await sql.begin(async tx => {
    await tx`set local session authorization lms_backend`;
    await tx`set local role lms_runtime`;
    await tx`select set_config('app.actor','10000000-0000-4000-8000-000000000001',true)`;
    const profiles=await tx`select id from lms.profiles`;
    assert.deepEqual(profiles.map(p=>p.id),['10000000-0000-4000-8000-000000000001']);
  });
});
