// Только синтетические участники и одноразовая локальная БД; в рабочую LMS тест не подключается.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { earlyCommencement } from '../src/lib/early-commencement';
const origin = process.env.QA_ORIGIN || 'http://127.0.0.1:8793';
assert.match(origin, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
const target = new URL(process.env.LMS_TEST_DATABASE_URL || 'postgres://shura@127.0.0.1:54431/igaming_lms_test');
assert.ok(['localhost','127.0.0.1','[::1]'].includes(target.hostname) && target.pathname === '/igaming_lms_test');
const db = postgres(target.href, { max: 1, prepare: false });
type Jar = { cookie: string };
async function call(path: string, body?: unknown, jar: Jar = { cookie: '' }) {
  const response = await fetch(`${origin}/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: jar.cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookies = response.headers.getSetCookie().map(c => c.split(';')[0]).filter(c => !c.endsWith('='));
  if (cookies.length) jar.cookie = cookies.join('; ');
  return { status: response.status, body: await response.json() };
}
async function login(email: string) {
  const jar = { cookie: '' };
  const link = (await call('auth/link', { email })).body.localLink;
  const parts = new URLSearchParams(new URL(link).hash.slice(1));
  const payload = parts.has('access') ? { accessToken: parts.get('access') } : { token: parts.get('token') };
  assert.equal((await call('auth/exchange', payload, jar)).status, 200);
  return jar;
}
try {
  const admin = await login('admin@example.test');
  const expert = await login('expert@example.test');
  const expertWorkspace = (await call('workspace', undefined, expert)).body;
  const expertPreview = `?preview=expert&expert=${expertWorkspace.me.id}`;
  const expertView = await call('workspace'+expertPreview, undefined, admin);
  assert.equal(expertView.status, 200);
  for (const key of Object.keys(expertWorkspace)) if (key !== 'now') assert.deepEqual(expertView.body[key], expertWorkspace[key], 'expert '+key);
  assert.equal(expertView.body.preview.administratorId, '10000000-0000-4000-8000-000000000004');
  assert.equal(expertView.body.preview.kind, 'expert');
  assert.equal(expertView.body.drafts.length, 0);
  assert.equal((await call('workspace'+expertPreview, undefined, expert)).status, 403);
  assert.equal((await call('workspace?preview=expert&expert=10000000-0000-4000-8000-000000000001', undefined, admin)).status, 404);
  const [expertBefore] = await db`select (select count(*) from lms.review_claims)::int as claims,(select count(*) from lms.review_drafts)::int as drafts,(select count(*) from lms.reviews)::int as reviews,(select count(*) from lms.answers)::int as answers,(select count(*) from lms.outbox)::int as events,(select count(read_at) from lms.notifications)::int as receipts`;
  for (const path of ['commands','uploads','auth/password','auth/logout','auth/link']) {
    const denied = await call(path+expertPreview, { action: 'submission.claim', input: { submissionId: randomUUID() } }, admin);
    assert.equal(denied.status, 403, 'expert '+path);
    assert.equal(denied.body.code, 'preview_read_only');
  }
  const [expertAfter] = await db`select (select count(*) from lms.review_claims)::int as claims,(select count(*) from lms.review_drafts)::int as drafts,(select count(*) from lms.reviews)::int as reviews,(select count(*) from lms.answers)::int as answers,(select count(*) from lms.outbox)::int as events,(select count(read_at) from lms.notifications)::int as receipts`;
  assert.deepEqual(expertAfter, expertBefore, 'expert preview never mutates course data');
  assert.equal((await call('workspace', undefined, admin)).body.me.role, 'admin');
  const id = randomUUID(), email = `${id}@example.test`;
  assert.equal((await call('commands', { action: 'enrollment.invite', input: { id, name: 'Student Preview HTTP QA', email, accessEndsAt: new Date(Date.now() + 86400000).toISOString() } }, admin)).status, 200);
  const student = await login(email);
  const preview = `?preview=student&student=${id}`;
  let result = await call(`workspace${preview}`, undefined, admin);
  assert.equal(result.status, 200);
  assert.equal(result.body.consentRequired, true, 'preview reproduces the first-entry restriction');
  assert.deepEqual(result.body.materials, []);
  assert.equal(result.body.me.id, id);
  assert.equal(result.body.preview.administratorId, '10000000-0000-4000-8000-000000000004');
  assert.equal((await call('auth/early-commencement', { earlyCommencementConsent: true, consentVersion: earlyCommencement.version }, student)).status, 200);
  assert.equal((await call('auth/password', { password: 'Synthetic preview passphrase 2026' }, student)).status, 200);
  assert.equal((await call('commands', { action: 'draft.create', input: { assignmentId: '20000000-0000-4000-8000-000000000001' } }, student)).status, 200);
  await db`insert into lms.module_feedback_prompts values(2,now()-interval '1 hour') on conflict(module) do update set request_after=excluded.request_after`;
  for (let index=0; index<55; index++) await db`insert into lms.notifications(dedupe_key,kind,recipient_id,subject,body,link_path,status,channel) values(${randomUUID()},'review.published',${id},${'Preview notification '+index},'Synthetic notification','/?module=1','sent','in_app')`;
  const actual = (await call('workspace', undefined, student)).body;
  result = await call(`workspace${preview}`, undefined, admin);
  assert.equal(result.status, 200);
  for (const key of Object.keys(actual)) if (key !== 'now') assert.deepEqual(result.body[key], actual[key], key);
  assert.equal(result.body.notifications.length, 56, 'notification history is not truncated');
  assert.equal(result.body.feedbackRequests.find((r: any) => r.module === 2).required, true);
  assert.ok(result.body.drafts.length, 'private student draft is visible only in the explicit administrator preview');
  const form = new FormData(); form.set('file', new File(['Synthetic preview attachment'], 'preview.txt', { type: 'text/plain' }));
  const upload = await fetch(`${origin}/api/v1/uploads`, { method:'POST', headers:{Origin:origin,Cookie:student.cookie}, body:form });
  assert.equal(upload.status, 201);
  const file = await upload.json();
  const download = (suffix: string, jar: Jar) => fetch(`${origin}/api/v1/files/${file.id}/download${suffix}`, { headers:{Cookie:jar.cookie} });
  assert.equal((await download('',admin)).status, 404, 'ordinary admin mode cannot open a private draft upload');
  const opened = await download(preview,admin);
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), 'Synthetic preview attachment');
  // Видео доступно для просмотра, но обычный download закрыт и участнику, и его предпросмотру.
  const mp4 = Buffer.from('000000106674797069736f6d00000000000000086d6f6f76000000086d646174', 'hex');
  const videoForm = new FormData(); videoForm.set('file', new File([mp4], 'preview-video.mp4', { type: 'video/mp4' }));
  const videoUpload = await fetch(`${origin}/api/v1/uploads`, { method: 'POST', headers: { Origin: origin, Cookie: admin.cookie }, body: videoForm });
  assert.equal(videoUpload.status, 201);
  const video = await videoUpload.json();
  assert.equal((await call('commands', { action: 'material.save', input: { id: randomUUID(), expectedRevision: 0, module: 0, position: 99, audience: 'participant', title: 'Streaming policy QA', body: '', links: [], published: true, opensAt: null, files: [video.id] } }, admin)).status, 200);
  for (const [suffix, jar] of [['', student], [preview, admin]] as const) {
    const denied = await call(`files/${video.id}/download${suffix}`, undefined, jar);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'video_download_disabled');
    assert.equal((await call(`files/${video.id}/captions${suffix}`, undefined, jar)).status, 403, 'captions endpoint cannot download an MP4');
    const stream = await fetch(`${origin}/api/v1/files/${video.id}/play${suffix}`, { headers: { Cookie: jar.cookie, Range: 'bytes=0-15' } });
    assert.equal(stream.status, 206);
    assert.equal(stream.headers.get('content-disposition'), null, 'playback is not an attachment download');
    assert.deepEqual(Buffer.from(await stream.arrayBuffer()), mp4.subarray(0, 16));
  }
  const adminVideo = await fetch(`${origin}/api/v1/files/${video.id}/download`, { headers: { Cookie: admin.cookie } });
  assert.equal(adminVideo.status, 200);
  assert.match(adminVideo.headers.get('content-disposition') || '', /^attachment;/);
  assert.deepEqual(Buffer.from(await adminVideo.arrayBuffer()), mp4);
  assert.equal((await call(`workspace${preview}`, undefined, student)).status, 403, 'participant cannot preview another account');
  const [before] = await db`select (select count(*) from lms.feedback)::int as feedback,(select count(*) from lms.outbox)::int as events,(select count(read_at) from lms.notifications where recipient_id=${id})::int as read`;
  for (const path of ['commands','uploads','auth/password','auth/early-commencement','auth/logout','auth/link']) {
    result = await call(path+preview, { action:'feedback.send', input:{module:2,body:'Must not be saved',key:randomUUID()} }, admin);
    assert.equal(result.status, 403, path);
    assert.equal(result.body.code, 'preview_read_only', path);
  }
  const [after] = await db`select (select count(*) from lms.feedback)::int as feedback,(select count(*) from lms.outbox)::int as events,(select count(read_at) from lms.notifications where recipient_id=${id})::int as read`;
  assert.deepEqual(after,before,'preview does not save feedback, mark notifications or emit events');
  assert.equal((await call('workspace',undefined,admin)).body.me.role,'admin');
  await db`delete from lms.module_feedback_prompts where module=2`;
  assert.equal((await call('commands',{action:'enrollment.revoke',input:{id}},admin)).status,200);
  assert.equal((await call(`workspace${preview}`,undefined,admin)).status,404);
  console.log('Student preview HTTP passed: exact workspace, consent/password gates, notifications, feedback, private files, streaming-only participant videos, administrator identity, access restrictions and no mutations.');
} finally { await db.end(); }
