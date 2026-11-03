import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actor, exchange, logout, passwordLogin, rateLimit, requestLink, setPassword } from '@/lib/auth';
import { command, isAdmin, readWorkspace } from '@/lib/service';
import { runMail } from '@/lib/mail';
import { ensureAuthUser } from '@/lib/supabase-admin';
import { AppError } from '@/lib/contract';
import { config } from '@/lib/config';
import { downloadFile, playVideo, uploadFile } from '@/lib/files';
import { sql } from '@/lib/db';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function setupState(user: string) {
  const [profile] = await sql`select id,name,email,role,password_set_at,activated_at,revoked_at,access_ends_at from lms.profiles where id=${user}`;
  if (!profile || !profile.activated_at || profile.revoked_at || new Date(profile.access_ends_at) <= new Date()) throw new AppError('access_expired', 'Course access is not active. Contact the administrator.', 403);
  return profile as { role: string; password_set_at: Date | null; [key: string]: unknown };
}
const requireSetupDone = (profile: { role: string; password_set_at: Date | null }) => {
  if (profile.role === 'participant' && !profile.password_set_at) throw new AppError('password_required', 'Create your password to open the course.', 403);
};
async function limitedBody(request: Request, limit: number) {
  const reader = request.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  if (!reader) return Buffer.alloc(0);
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new AppError('too_large', 'This request is too large.', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function handle(request: Request, context: Context) {
  const cfg = config();
  if (request.headers.get('host') !== new URL(cfg.origin).host) throw new AppError('origin', 'This application address is not allowed.', 403);
  if (request.method === 'POST' && request.headers.get('origin') !== cfg.origin) throw new AppError('origin', 'Refresh this page before trying again.', 403);
  const path = (await context.params).path.join('/');
  if (request.method === 'GET') {
    if (path === 'config') return response({ local: cfg.mode === 'local' });
    const user = await actor();
    const profile = await setupState(user);
    if (path === 'workspace') return response(profile.role === 'participant' && !profile.password_set_at ? { me: profile } : await readWorkspace(user));
    requireSetupDone(profile);
    if (/^files\/[\da-f-]+\/captions$/.test(path)) {
      const { file, bytes } = await downloadFile(user, path.split('/')[1]);
      if (file.mime !== 'text/vtt') throw new AppError('not_found', 'These captions are not available.', 404);
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (/^files\/[\da-f-]+\/play$/.test(path)) {
      const video = await playVideo(user, path.split('/')[1]);
      const range = request.headers.get('range');
      if (range && !/^bytes=(\d+-\d*|\d*-\d+)$/.test(range)) throw new AppError('invalid_range', 'This video range is not available.', 416);
      const headers = new Headers({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      if (video.url) {
        let upstream: Response;
        try { upstream = await fetch(video.url, { headers: range ? { Range: range } : {}, redirect: 'error', signal: AbortSignal.timeout(300_000) }); }
        catch { throw new AppError('video_unavailable', 'The video is temporarily unavailable. Try again.', 503); }
        if (![200,206,416].includes(upstream.status)) throw new AppError('video_unavailable', 'The video is temporarily unavailable. Try again.', 503);
        for (const name of ['content-length','content-range']) { const value = upstream.headers.get(name); if (value) headers.set(name, value); }
        return new Response(upstream.body, { status: upstream.status, headers });
      }
      const bytes = video.bytes!;
      if (!range) { headers.set('Content-Length', String(bytes.length)); return new Response(new Uint8Array(bytes), { headers }); }
      const [, first, last] = /^bytes=(\d*)-(\d*)$/.exec(range)!;
      const start = first ? Number(first) : Math.max(0, bytes.length - Number(last));
      const end = first && last ? Math.min(Number(last), bytes.length - 1) : bytes.length - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= bytes.length || start > end) {
        headers.set('Content-Range', `bytes */${bytes.length}`);
        return new Response(null, { status: 416, headers });
      }
      headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      headers.set('Content-Length', String(end - start + 1));
      return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206, headers });
    }
    if (/^files\/[\da-f-]+\/download$/.test(path)) {
      const { file, bytes } = await downloadFile(user, path.split('/')[1]);
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
  } else if (request.method === 'POST') {
    if (path === 'uploads') {
      const user = await actor();
      requireSetupDone(await setupState(user));
      await rateLimit(`upload:${user}`, 50);
      const bytes = await limitedBody(request, 50_100_000);
      let form: FormData;
      try { form = await new Response(new Uint8Array(bytes), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData(); }
      catch { throw new AppError('invalid_upload', 'Choose the file again and retry the upload.'); }
      const file = form.get('file');
      if (!(file instanceof File) || form.getAll('file').length !== 1) throw new AppError('file_required', 'Choose one file to upload.');
      return response(await uploadFile(user, file.name, Buffer.from(await file.arrayBuffer())), 201);
    }
    let data: unknown;
    try { data = JSON.parse((await limitedBody(request, 2_000_000)).toString() || '{}'); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError('invalid_json', 'This request could not be read.'); }
    if (path === 'auth/link') {
      const { email } = z.object({ email: z.email().max(254) }).strict().parse(data);
      await rateLimit(`sign-in:${request.headers.get('x-real-ip') || 'local'}`, 50);
      return response(await requestLink(email), 202);
    }
    if (path === 'auth/exchange') {
      await rateLimit(`exchange:${request.headers.get('x-real-ip') || 'local'}`, 50);
      const link = z.union([z.object({ token: z.string() }).strict(), z.object({ code: z.string(), flowId: z.string().max(200).optional() }).strict()]).parse(data);
      await exchange('token' in link ? link.token : null, 'code' in link ? link.code : null, 'code' in link ? link.flowId : undefined); return response({ ok: true });
    }
    if (path === 'auth/password-login') {
      const login = z.object({ email: z.email().max(254), password: z.string().max(200) }).strict().parse(data);
      await rateLimit(`password-ip:${request.headers.get('x-real-ip') || 'local'}`, 50);
      await passwordLogin(login.email, login.password); return response({ ok: true });
    }
    if (path === 'auth/logout') { await logout(); return response({ ok: true }); }
    if (path === 'auth/password') {
      const user = await actor();
      const input = z.object({ password: z.string().max(200), earlyCommencementConsent: z.boolean().optional(), consentVersion: z.string().max(100).optional() }).strict().parse(data);
      await setPassword(user, input.password, input.earlyCommencementConsent === true ? { version: input.consentVersion || '' } : undefined); return response({ ok: true });
    }
    const user = await actor();
    requireSetupDone(await setupState(user));
    if (path === 'commands') {
      const payload = z.object({ action: z.string(), input: z.unknown() }).strict().parse(data);
      // Локальная кнопка «обработать почту сейчас» для демонстрации; в рабочей среде письма отправляет фоновый обработчик.
      if (payload.action === 'mail.run') {
        if (cfg.mode !== 'local' || !(await isAdmin(user))) throw new AppError('forbidden', 'This action is available to the administrator in the local build only.', 403);
        return response(await runMail());
      }
      // В режиме Supabase профиль получает id пользователя Supabase Auth: сначала проверяем права, затем создаём вход.
      if (payload.action === 'enrollment.invite' && cfg.mode === 'supabase') {
        if (!(await isAdmin(user))) throw new AppError('forbidden', 'Administrator access is required.', 403);
        const input = z.object({ email: z.email().max(254) }).passthrough().parse(payload.input);
        return response(await command(user, payload.action, { ...input, id: await ensureAuthUser(input.email) }));
      }
      return response(await command(user, payload.action, payload.input));
    }
  }
  throw new AppError('not_found', 'This page is not available.', 404);
}
async function safe(request: Request, context: Context) {
  const correlationId = randomUUID();
  try { return await handle(request, context); }
  catch (error) {
    const invalid = error instanceof z.ZodError;
    const status = error instanceof AppError ? error.status : invalid ? 422 : 503;
    if (status === 503) console.error('LMS request failed', correlationId, error instanceof Error ? error.name : 'unknown', typeof error === 'object' && error && 'code' in error ? error.code : '', typeof error === 'object' && error && 'table_name' in error ? error.table_name : '');
    return Response.json({ code: error instanceof AppError ? error.code : invalid ? 'validation' : 'unavailable', message: error instanceof AppError ? error.message : invalid ? (error.issues.find(i => i.code === 'custom')?.message || 'Check the entered values and try again.') : 'The service is temporarily unavailable. Your text is kept; try again.', field_errors: error instanceof AppError ? error.fields : invalid ? error.issues.map(i => i.path.join('.')) : [], retryable: status === 503, correlation_id: correlationId }, { status, headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': '900' } : {}) } });
  }
}
export const GET = safe;
export const POST = safe;
