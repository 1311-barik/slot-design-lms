import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { acceptEarlyCommencement, setPassword } from '../src/lib/auth';
import { earlyCommencement } from '../src/lib/early-commencement';
import { sql, transaction } from '../src/lib/db';
import { command, readWorkspace } from '../src/lib/service';
import { deliver, plan, type Provider } from '../src/lib/mail';

const admin = '10000000-0000-4000-8000-000000000004';
const reviewer = '10000000-0000-4000-8000-000000000003';
const consent = { version: earlyCommencement.version };
after(() => sql.end());
async function participant() {
  const id = randomUUID();
  await command(admin, 'enrollment.invite', { id, name: 'Consent Learner', email: `${id}@example.test`, accessEndsAt: new Date(Date.now() + 86_400_000).toISOString() });
  await sql`update lms.profiles set activated_at=clock_timestamp() where id=${id}`;
  return id;
}

test('registration records only explicit consent; a missing or stale version changes nothing', async () => {
  const without = await participant();
  await setPassword(without, 'Registration without consent');
  assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${without}`).length, 0);
  await assert.rejects(setPassword(without, 'Later password change', consent), /only be recorded during participant registration/);
  const id = await participant();
  for (const version of ['', 'obsolete']) await assert.rejects(setPassword(id, 'Registration with consent', { version }), /consent text has changed/);
  await assert.rejects(setPassword(id, 'short', consent), /at least 8/);
  assert.equal((await sql`select password_set_at from lms.profiles where id=${id}`)[0].password_set_at, null);
  assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${id}`).length, 0);
  await assert.rejects(setPassword(admin, 'Staff cannot consent', consent), /participant registration/);
});

test('consent is an immutable identity/text/time snapshot; concurrent retries produce one event and one admin email', async () => {
  const id = await participant();
  const before = Date.now();
  await Promise.all([setPassword(id, 'Registration with consent', consent), setPassword(id, 'Registration with consent', consent)]);
  const records = await sql`select * from lms.early_commencement_consents where owner_id=${id}`;
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.participant_name, 'Consent Learner');
  assert.equal(record.participant_email, `${id}@example.test`);
  assert.equal(record.consent_text, earlyCommencement.text);
  assert.equal(record.consent_version, consent.version);
  assert.equal(record.course_title, earlyCommencement.courseTitle);
  assert.equal(record.course_key, earlyCommencement.courseKey);
  assert.equal(record.source, 'lms_registration');
  assert.equal(record.terms_url, earlyCommencement.termsUrl);
  assert.equal(record.terms_sha256, earlyCommencement.termsSha256);
  assert.ok(record.accepted_at.getTime() >= before && record.accepted_at.getTime() <= Date.now());
  assert.equal((await sql`select id from lms.outbox where kind='consent.early_commencement' and aggregate_id=${record.id}`).length, 1);
  for (const operation of [() => sql`update lms.early_commencement_consents set consent_text='Changed' where id=${record.id}`, () => sql`delete from lms.early_commencement_consents where id=${record.id}`]) await assert.rejects(operation);
  await sql`update lms.profiles set name='Renamed learner' where id=${id}`;
  await setPassword(id, 'New password without another checkbox');
  assert.equal((await sql`select participant_name from lms.early_commencement_consents where id=${record.id}`)[0].participant_name, 'Consent Learner');
  const sent: { to: string; subject: string; text: string }[] = [];
  const provider: Provider = { name: 'test', send: async mail => { sent.push(mail); return { ok: true, providerId: 'test-consent' }; } };
  for (let repeat = 0; repeat < 2; repeat++) {
    await plan();
    for (let batch = 0; batch < 10; batch++) if (!(await deliver(new Date(), provider)).processed) break;
  }
  const receipts = sent.filter(m => m.text.includes(record.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].to, 'admin@example.test');
  for (const text of [record.participant_name, record.participant_email, earlyCommencement.text, consent.version, record.accepted_at.toISOString(), earlyCommencement.termsUrl, earlyCommencement.termsSha256]) assert.ok(receipts[0].text.includes(text));
});

test('only the owner and administrator can read consent; backend can read but cannot alter evidence or choose its timestamp', async () => {
  const owner = await participant(); const other = await participant();
  await setPassword(owner, 'Consent permission check', consent);
  const own = (await readWorkspace(owner)).earlyCommencementConsents;
  assert.equal(own.length, 1);
  assert.equal(own[0].owner_id, owner);
  assert.ok((await readWorkspace(admin)).earlyCommencementConsents.some((c: { owner_id: string }) => c.owner_id === owner));
  assert.deepEqual((await readWorkspace(other)).earlyCommencementConsents, []);
  assert.deepEqual((await readWorkspace(reviewer)).earlyCommencementConsents, []);
  await sql.begin(async tx => { await tx`set local role lms_backend`; assert.ok((await tx`select id from lms.early_commencement_consents where owner_id=${owner}`).length); });
  for (const query of [
    'update lms.early_commencement_consents set consent_text=consent_text where false',
    'delete from lms.early_commencement_consents where false',
  ]) await assert.rejects(sql.begin(async tx => { await tx`set local role lms_backend`; await tx.unsafe(query); }), (e: any) => e.code === '42501');
  await assert.rejects(transaction(other, tx => tx`insert into lms.early_commencement_consents(owner_id,participant_name,participant_email,course_key,course_title,consent_version,consent_text) values(${owner},'Forged','fake@example.test','other','Other','fake','Fake')`), (e: any) => e.code === '42501');
  await assert.rejects(transaction(other, tx => tx`insert into lms.early_commencement_consents(owner_id,participant_name,participant_email,course_key,course_title,consent_version,consent_text,accepted_at) values(${other},'Forged','fake@example.test','other','Other','fake','Fake','2000-01-01')`), (e: any) => e.code === '42501');
});

test('failed receipt enqueue rolls back consent and registration; the next attempt can succeed', async () => {
  const id = await participant();
  await sql.unsafe("create function lms.test_reject_consent_event() returns trigger language plpgsql as $$ begin if new.kind='consent.early_commencement' then raise exception 'synthetic outbox failure'; end if; return new; end $$");
  await sql.unsafe('create trigger test_reject_consent_event before insert on lms.outbox for each row execute function lms.test_reject_consent_event()');
  try {
    await assert.rejects(setPassword(id, 'Registration retry phrase', consent), /synthetic outbox failure/);
    assert.equal((await sql`select password_set_at from lms.profiles where id=${id}`)[0].password_set_at, null);
    assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${id}`).length, 0);
    assert.equal((await sql`select profile_id from lms.dev_passwords where profile_id=${id}`).length, 0);
    assert.equal((await sql`select id from lms.outbox where kind='participant.password' and aggregate_id=${id}`).length, 0);
  } finally {
    await sql.unsafe('drop trigger test_reject_consent_event on lms.outbox');
    await sql.unsafe('drop function lms.test_reject_consent_event()');
  }
  await setPassword(id, 'Registration retry phrase', consent);
  assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${id}`).length, 1);
});

test('an existing participant can consent later without changing their password; concurrent retries keep the first evidence and receipt', async () => {
  const id = await participant();
  await setPassword(id, 'Already registered learner');
  const [before] = await sql`select p.password_set_at,d.hash from lms.profiles p join lms.dev_passwords d on d.profile_id=p.id where p.id=${id}`;
  const acceptedAfter = Date.now();
  await Promise.all([acceptEarlyCommencement(id, consent.version), acceptEarlyCommencement(id, consent.version)]);
  const records = await sql`select * from lms.early_commencement_consents where owner_id=${id}`;
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.source, 'lms_account');
  assert.equal(record.consent_text, earlyCommencement.text);
  assert.equal(record.participant_email, `${id}@example.test`);
  assert.ok(record.accepted_at.getTime() >= acceptedAfter);
  await sql`update lms.profiles set name='Later profile name' where id=${id}`;
  await acceptEarlyCommencement(id, consent.version);
  assert.equal((await sql`select participant_name from lms.early_commencement_consents where owner_id=${id}`)[0].participant_name, 'Consent Learner');
  assert.equal((await sql`select id from lms.outbox where kind='consent.early_commencement' and aggregate_id=${record.id}`).length, 1);
  const [after] = await sql`select p.password_set_at,d.hash from lms.profiles p join lms.dev_passwords d on d.profile_id=p.id where p.id=${id}`;
  assert.deepEqual(after, before);
  await plan();
  const receipts = await sql`select body from lms.notifications where kind='consent.early_commencement' and body like ${`%${record.id}%`}`;
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0].body.includes('in their LMS account after registration'));
  assert.ok(receipts[0].body.includes(record.accepted_at.toISOString()));
});

test('consent requires an active participant and current text, and can precede password setup; it cannot replace registration evidence', async () => {
  const id = await participant();
  await setPassword(id, 'Existing participant password');
  for (const version of ['', 'obsolete']) await assert.rejects(acceptEarlyCommencement(id, version), /consent text has changed/);
  for (const staff of [admin, reviewer]) await assert.rejects(acceptEarlyCommencement(staff, consent.version), /available to course participants/);
  assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${id}`).length, 0);
  await sql`update lms.profiles set revoked_at=clock_timestamp() where id=${id}`;
  await assert.rejects(acceptEarlyCommencement(id, consent.version), /access is not active/);
  const registered = await participant();
  await acceptEarlyCommencement(registered, consent.version);
  assert.equal((await sql`select password_set_at from lms.profiles where id=${registered}`)[0].password_set_at, null);
  await setPassword(registered, 'Original registration consent');
  await acceptEarlyCommencement(registered, consent.version);
  assert.equal((await sql`select source from lms.early_commencement_consents where owner_id=${registered}`)[0].source, 'lms_registration');
});

test('the linked terms document matches the immutable PDF fingerprint saved with consent', async () => {
  const pdf = await readFile(new URL(`../public${earlyCommencement.termsUrl}`, import.meta.url));
  assert.ok(pdf.subarray(0,5).equals(Buffer.from('%PDF-')));
  assert.equal(createHash('sha256').update(pdf).digest('hex'), earlyCommencement.termsSha256);
});

test('a failed late-consent receipt rolls back evidence and allows a retry', async () => {
  const id = await participant();
  await setPassword(id, 'Late consent failure check');
  await sql.unsafe("create function lms.test_reject_late_event() returns trigger language plpgsql as $$ begin if new.kind='consent.early_commencement' then raise exception 'synthetic late outbox failure'; end if; return new; end $$");
  await sql.unsafe('create trigger test_reject_late_event before insert on lms.outbox for each row execute function lms.test_reject_late_event()');
  try {
    await assert.rejects(acceptEarlyCommencement(id, consent.version), /synthetic late outbox failure/);
    assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${id}`).length, 0);
  } finally {
    await sql.unsafe('drop trigger test_reject_late_event on lms.outbox');
    await sql.unsafe('drop function lms.test_reject_late_event()');
  }
  await acceptEarlyCommencement(id, consent.version);
  assert.equal((await sql`select id from lms.early_commencement_consents where owner_id=${id}`).length, 1);
});
