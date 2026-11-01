import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actor, exchange, logout, passwordLogin, rateLimit, requestLink, setPassword } from '@/lib/auth';
import { command, isAdmin, readWorkspace } from '@/lib/service';
import { runMail } from '@/lib/mail';
import { ensureAuthUser } from '@/lib/supabase-admin';
import { AppError } from '@/lib/contract';
import { config } from '@/lib/config';
import { downloadFile, uploadFile } from '@/lib/files';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const response = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
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
    if (path === 'workspace') return response(await readWorkspace(user));
    if (/^files\/[\da-f-]+\/download$/.test(path)) {
      const { file, bytes } = await downloadFile(user, path.split('/')[1]);
      return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
  } else if (request.method === 'POST') {
    if (path === 'uploads') {
      const user = await actor();
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
      await setPassword(user, z.object({ password: z.string().max(200) }).strict().parse(data).password); return response({ ok: true });
    }
    const user = await actor();
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
