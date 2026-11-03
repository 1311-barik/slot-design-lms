import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { sql } from './db';
import { config } from './config';
import { modules } from './course';
import { serviceClient } from './supabase-admin';
import { requestLink } from './auth';

// LMS-11 и §6 технического проекта. Обработчик работает под служебным подключением (вне RLS):
// планирует письма из outbox и расписания, затем доставляет их с повторной проверкой прав и актуальности.
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const GRACE = 15 * MINUTE; // запоздавшее после простоя напоминание ещё отправляется; позже — missed
const RETRIES = [1, 5, 30]; // минуты между повторами при известной ошибке провайдера
type Row = Record<string, any>;
type Plan = { key: string; kind: string; recipient: Row; subject: string; body: string; link?: string; refId?: string; refVersion?: string; dueAt?: Date; notAfter?: Date; status?: 'pending' | 'missed' };

const fmt = (value: Date | string, timeZone: string, zoneName = false) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone, ...(zoneName ? { timeZoneName: 'short' } : {}) }).format(new Date(value));
const validZone = (zone: string | null | undefined) => { try { return !!zone && !!new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch { return false; } };
// Время курса — CET (UTC+1); рядом время в зоне участника, если он её выбрал.
export function when(value: Date | string, zone?: string | null) {
  const cet = `${fmt(value, 'Europe/Berlin')} CET`;
  if (!validZone(zone)) return `${cet}. Choose your time zone in the LMS to also see your local time.`;
  const local = fmt(value, zone!, true);
  return local.replace(/\s\S+$/, '') === cet.replace(/ CET$/, '') ? cet : `${cet} (${local} in your time zone)`;
}
const greet = (person: Row) => `Hi ${person.name},\n\n`;
const footer = (link: string) => `\n\nOpen the LMS: ${config().origin}${link}\n\n— Slot Design · From idea to release\nThis message was sent by the course platform. Course times are CET (UTC+1).`;
const moduleLink = (m: number | null) => m === null ? '/?module=project' : `/?module=${m}`;
const moduleName = (m: number | null) => m === null ? 'the course' : `Module ${m} · ${modules[m]}`;

async function people() {
  const rows = await sql`select * from lms.profiles where revoked_at is null and access_ends_at>now()`;
  return { all: rows, by: (id: string) => rows.find(r => r.id === id), participants: rows.filter(r => r.role === 'participant'), admins: rows.filter(r => r.role === 'admin'), staff: rows.filter(r => r.role !== 'participant') };
}

// Событие → письма. Содержание работ, отзывов и вопросов в письма не попадает: только ссылка в LMS.
async function fromOutbox(event: Row, crowd: Awaited<ReturnType<typeof people>>): Promise<Plan[]> {
  const responsibleFor = async (assignmentId: string) => { const rows = await sql`select reviewer_id from lms.reviewers where assignment_id=${assignmentId}`; const found = rows.map(r => crowd.by(r.reviewer_id)).filter(Boolean) as Row[]; return found.length ? found : crowd.admins; };
  const key = (who: Row) => `${event.kind}:${event.aggregate_id}:${who.id}`;
  switch (event.kind) {
    case 'submission.created': {
      const [s] = await sql`select s.*,w.assignment_id,w.module from lms.submissions s join lms.works w on w.id=s.work_id where s.id=${event.aggregate_id}`;
      if (!s) return [];
      const owner = crowd.by(s.owner_id); const self = s.spec.mode === 'self_assessment'; const plans: Plan[] = [];
      if (owner) plans.push({ key: key(owner), kind: event.kind, recipient: owner, subject: `Received: ${s.spec.title}, version ${s.number}`, link: moduleLink(s.module), body: `${greet(owner)}We received ${s.spec.title}, version ${s.number}, on ${when(s.submitted_at, owner.timezone)}.${s.late ? ' It was submitted after the deadline and is marked as late.' : ''} ${self ? 'The course team can now read your self-assessment.' : 'Your expert will review this version.'}` });
      const team = [...new Map([...(await responsibleFor(s.assignment_id)), ...crowd.admins].map(p => [p.id, p])).values()];
      for (const who of team) plans.push({ key: key(who), kind: event.kind, recipient: who, link: '/', subject: self ? `Self-assessment received: ${crowd.by(s.owner_id)?.name || 'Participant'} · ${s.spec.title}` : `New version to review: ${crowd.by(s.owner_id)?.name || 'Participant'} · ${s.spec.title}, version ${s.number}`, body: `${greet(who)}${self ? 'A self-assessment was received. No decision is needed.' : 'A new version is waiting in your review queue.'}` });
      return plans;
    }
    case 'review.published': {
      const [r] = await sql`select r.*,s.owner_id,s.number,s.spec,w.module from lms.reviews r join lms.submissions s on s.id=r.submission_id join lms.works w on w.id=s.work_id where r.id=${event.aggregate_id}`;
      const owner = r && crowd.by(r.owner_id); if (!owner) return [];
      return [{ key: key(owner), kind: event.kind, recipient: owner, link: moduleLink(r.module), subject: `${r.replaces_id ? 'Updated feedback' : 'Feedback published'}: ${r.spec.title}, version ${r.number}`, body: `${greet(owner)}Your expert ${r.replaces_id ? 'corrected the feedback' : 'published feedback'} on ${r.spec.title}, version ${r.number}. Open the LMS to read it.` }];
    }
    case 'question.asked': {
      const [q] = await sql`select * from lms.questions where id=${event.aggregate_id}`; if (!q) return [];
      const reviewers = q.module === null ? [] : (await sql`select distinct r.reviewer_id from lms.reviewers r join lms.assignments a on a.id=r.assignment_id where a.module=${q.module}`).map(r => crowd.by(r.reviewer_id)).filter(Boolean) as Row[];
      return [...new Map([...reviewers, ...crowd.admins].map(p => [p.id, p])).values()].map(who => ({ key: key(who), kind: event.kind, recipient: who, link: '/', subject: `New question about ${moduleName(q.module)}`, body: `${greet(who)}${crowd.by(q.owner_id)?.name || 'A participant'} asked a question about ${moduleName(q.module)}. Answer it in the Questions section of the team workspace.` }));
    }
    case 'question.answered': {
      const [a] = await sql`select a.*,q.owner_id,q.module from lms.answers a join lms.questions q on q.id=a.question_id where a.id=${event.aggregate_id}`;
      const owner = a && crowd.by(a.owner_id); if (!owner) return [];
      return [{ key: key(owner), kind: event.kind, recipient: owner, link: moduleLink(a.module), subject: 'The course team answered your question', body: `${greet(owner)}The course team answered your question about ${moduleName(a.module)}.` }];
    }
    case 'feedback.created': {
      const [f] = await sql`select * from lms.feedback where id=${event.aggregate_id}`; if (!f) return [];
      // Текст отзыва в письмо не попадает: его читают в LMS.
      return crowd.admins.map(who => ({ key: key(who), kind: event.kind, recipient: who, link: '/', subject: `New course feedback from ${crowd.by(f.owner_id)?.name || 'a participant'}`, body: `${greet(who)}${crowd.by(f.owner_id)?.name || 'A participant'} left feedback${f.module === null ? '' : ` about ${moduleName(f.module)}`}${f.rating ? ` with a rating of ${f.rating} out of 5` : ''}. Read it in the Feedback section of the team workspace.` }));
    }
    // Отбивки администраторам о действиях участников; подробности — на дашборде Activity.
    case 'participant.activated':
    case 'participant.password':
    case 'project.updated':
    case 'material.studied': {
      const ownerId = event.kind.startsWith('participant.') ? event.aggregate_id : event.payload.owner;
      const name = crowd.by(ownerId)?.name || 'A participant';
      const [m] = event.kind === 'material.studied' ? await sql`select title,module from lms.materials where id=${event.payload.material}` : [];
      const what = event.kind === 'participant.activated' ? 'signed in for the first time' : event.kind === 'participant.password' ? 'created a password' : event.kind === 'project.updated' ? 'updated the project theme and audience' : `marked “${m?.title || 'a material'}”${m ? ` (module ${m.module})` : ''} as studied`;
      return crowd.admins.map(who => ({ key: key(who), kind: event.kind, recipient: who, link: '/', subject: `${name} ${what}`, body: `${greet(who)}${name} ${what}. See all participant activity on the Activity dashboard.` }));
    }
    case 'enrollment.invited': {
      const owner = crowd.by(event.aggregate_id); if (!owner) return [];
      // Поздно приглашённый получает ближайшие события в приглашении, без пачки пропущенных напоминаний.
      const [next] = await sql`select * from lms.sessions where starts_at>now() order by starts_at limit 1`;
      const closing = new Date(owner.access_ends_at).getTime() - Date.now() < 7 * DAY;
      return [{ key: key(owner), kind: event.kind, recipient: owner, link: '/?module=0', subject: 'Welcome to Slot Design — your course access', body: `${greet(owner)}Welcome to Slot Design. Your course access is ready.\n\nOpen your personal sign-in link:\n{{SIGN_IN_LINK}}\n\nChoose “Continue to course”, create your password, and Module 0 will open with seven introductory videos and English subtitles. Next time, sign in with your email and password.\n\nThe link is for you only, works once, and expires soon. If it has expired, request a new link on the LMS sign-in page.${next ? `\n\nFirst live session: ${next.title}, ${when(next.starts_at, owner.timezone)}. You will get reminders 24 hours and 1 hour before each session, and 24 hours before each homework deadline if you have not submitted yet.` : ''}\n\nYour access ends on ${when(owner.access_ends_at, owner.timezone)}.${closing ? ' That is less than seven days from now.' : ''}` }];
    }
    case 'session.changed': {
      const [x] = await sql`select * from lms.sessions where id=${event.payload.sessionId}`; if (!x) return [];
      return [...crowd.participants, ...crowd.staff].map(who => ({ key: key(who), kind: event.kind, recipient: who, link: moduleLink(x.module), refId: x.id, refVersion: new Date(x.starts_at).toISOString(), notAfter: new Date(x.starts_at), subject: `New time: ${x.title}`, body: `${greet(who)}${x.title} has moved. The new time is ${when(x.starts_at, who.timezone)}.` }));
    }
    default: return [];
  }
}

// Напоминания по расписанию: от абсолютного момента события, а не от «утра» в зоне участника.
async function scheduled(now: Date, crowd: Awaited<ReturnType<typeof people>>): Promise<Plan[]> {
  const plans: Plan[] = [];
  const window = (due: Date, event: Date, recipient: Row, plan: Omit<Plan, 'recipient' | 'dueAt' | 'notAfter' | 'status'>) => {
    if (now < due || now >= event) return;
    if (new Date(recipient.created_at) > due) return; // приглашён позже момента отправки — без запоздалых писем
    plans.push({ ...plan, recipient, dueAt: due, notAfter: event, status: now.getTime() - due.getTime() <= GRACE ? 'pending' : 'missed' });
  };
  for (const x of await sql`select * from lms.sessions where starts_at>${now}`) {
    const starts = new Date(x.starts_at); const version = starts.toISOString();
    for (const [offset, label] of [[DAY, 'Tomorrow'], [HOUR, 'In one hour']] as const) for (const who of crowd.participants) window(new Date(starts.getTime() - offset), starts, who, {
      key: `session.reminder:${x.id}:${version}:${offset / HOUR}h:${who.id}`, kind: 'session.reminder', link: moduleLink(x.module), refId: x.id, refVersion: version,
      subject: `${label}: ${x.title}`, body: `${greet(who)}${x.title} starts ${when(starts, who.timezone)}.${x.join_url ? `\n\nJoin: ${x.join_url}\nThe joining link is shared by the whole cohort.` : '\n\nThe joining link will be in the LMS.'}` });
  }
  for (const a of await sql`select * from lms.assignments where published and due_at>${now} and (opens_at is null or opens_at<=${now})`) {
    const due = new Date(a.due_at); const version = due.toISOString();
    // Только тем, у кого нет ни одной отправленной версии; доработка с Needs revision серию не создаёт.
    const done = new Set((await sql`select distinct s.owner_id from lms.submissions s join lms.works w on w.id=s.work_id where w.assignment_id=${a.id}`).map(r => r.owner_id));
    for (const who of crowd.participants.filter(p => !done.has(p.id))) window(new Date(due.getTime() - DAY), due, who, {
      key: `deadline.reminder:${a.id}:${version}:${who.id}`, kind: 'deadline.reminder', link: moduleLink(a.module), refId: a.id, refVersion: version,
      subject: `Due in 24 hours: ${a.spec.title}`, body: `${greet(who)}${a.spec.title} is due ${when(due, who.timezone)}. You have not submitted a version yet. Your saved draft stays private until you submit.` });
  }
  for (const who of crowd.participants) {
    const ends = new Date(who.access_ends_at);
    window(new Date(ends.getTime() - 7 * DAY), ends, who, { key: `access.closing:${who.id}:${ends.toISOString()}`, kind: 'access.closing', link: '/?module=project', refId: who.id, refVersion: ends.toISOString(),
      subject: 'Your course access ends in 7 days', body: `${greet(who)}Your access to the Slot Design course ends on ${when(ends, who.timezone)}. Download any materials and copies of your work you want to keep before then.` });
  }
  return plans;
}

async function store(plan: Plan, now: Date) {
  const due = plan.dueAt || now;
  const missed = plan.status === 'missed';
  await sql`insert into lms.notifications(dedupe_key,kind,recipient_id,subject,body,link_path,ref_id,ref_version,due_at,next_attempt_at,not_after,status,last_error)
    values(${plan.key},${plan.kind},${plan.recipient.id},${plan.subject},${plan.body + footer(plan.link || '/')},${plan.link || '/'},${plan.refId || null},${plan.refVersion || null},${due},${due},${plan.notAfter || null},${plan.status || 'pending'},${missed ? 'The sending window passed while the mail worker was not running.' : null})
    on conflict(dedupe_key) do nothing`;
}

export async function plan(now = new Date()) {
  const crowd = await people(); let created = 0;
  // Каждое событие outbox обрабатывается один раз; повтор не дублирует письма благодаря dedupe_key.
  for (;;) {
    const batch = await sql.begin(async tx => {
      const events = await tx`select * from lms.outbox where processed_at is null order by created_at limit 50 for update skip locked`;
      for (const event of events) {
        for (const p of await fromOutbox(event, crowd)) { await store(p, now); created++; }
        await tx`update lms.outbox set processed_at=clock_timestamp() where id=${event.id}`;
      }
      return events.length;
    });
    if (batch < 50) break;
  }
  for (const p of await scheduled(now, crowd)) { await store(p, now); created++; }
  return created;
}

// Повторная проверка перед отправкой: доступ активен, событие не прошло, время/срок не менялись, сдачи нет.
async function stillValid(n: Row, now: Date): Promise<string | null> {
  const [who] = await sql`select * from lms.profiles where id=${n.recipient_id}`;
  if (!who || who.revoked_at || new Date(who.access_ends_at) <= now) return 'Recipient no longer has access.';
  if (n.not_after && new Date(n.not_after) <= now) return 'The event has already started or passed.';
  if (n.kind === 'session.reminder' || n.kind === 'session.changed') {
    const [x] = await sql`select starts_at from lms.sessions where id=${n.ref_id}`;
    if (!x || new Date(x.starts_at).toISOString() !== n.ref_version) return 'The session was moved; a new reminder replaces this one.';
  }
  if (n.kind === 'deadline.reminder') {
    const [a] = await sql`select due_at,published from lms.assignments where id=${n.ref_id}`;
    if (!a || !a.published || !a.due_at || new Date(a.due_at).toISOString() !== n.ref_version) return 'The deadline changed or the assignment was unpublished.';
    const [sent] = await sql`select 1 from lms.submissions s join lms.works w on w.id=s.work_id where w.assignment_id=${n.ref_id} and s.owner_id=${n.recipient_id} limit 1`;
    if (sent) return 'The participant has already submitted.';
  }
  if (n.kind === 'access.closing' && new Date(who.access_ends_at).toISOString() !== n.ref_version) return 'The access end date changed.';
  return null;
}

export type Outcome = { ok: true; providerId: string } | { ok: false; retry: boolean; unknown?: boolean; error: string };
export type Provider = { name: string; send: (mail: { id: string; to: string; name: string; subject: string; text: string }) => Promise<Outcome> };

// Провайдер выбирается окружением. Локальный ящик — только для синтетических данных в LMS_MODE=local.
export function mailProvider(): Provider | null {
  const cfg = config(); const chosen = process.env.MAIL_PROVIDER || (cfg.mode === 'local' ? 'local' : '');
  if (chosen === 'local' && cfg.mode === 'local') return { name: 'local', send: async mail => {
    const dir = join(cfg.runtime, 'mail'); await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, `${mail.id}.txt`), `To: ${mail.name} <${mail.to}>\nSubject: ${mail.subject}\n\n${mail.text}\n`, { mode: 0o600 });
    return { ok: true, providerId: `local:${mail.id}` };
  } };
  if (chosen === 'brevo' && process.env.BREVO_API_KEY && process.env.MAIL_FROM) return { name: 'brevo', send: async mail => {
    let response: Response;
    try {
      response = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'api-key': process.env.BREVO_API_KEY!, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'Slot Design' }, to: [{ email: mail.to, name: mail.name }], subject: mail.subject, textContent: mail.text, headers: { 'X-LMS-Notification': mail.id } }) });
    } catch (error) {
      // Запрос мог дойти до провайдера: слепой повтор создал бы дубль, поэтому — ручная сверка.
      return { ok: false, retry: false, unknown: true, error: `No response from Brevo: ${error instanceof Error ? error.name : 'network error'}` };
    }
    if (response.ok) { const data = await response.json().catch(() => ({})); return { ok: true, providerId: String(data.messageId || 'brevo') }; }
    return { ok: false, retry: response.status === 429 || response.status >= 500, error: `Brevo returned ${response.status}` };
  } };
  // SMTP — например, корпоративный Google Workspace (smtp.gmail.com, пароль приложения). Решение 31.10.2026.
  if (chosen === 'smtp' && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
    const port = Number(process.env.SMTP_PORT || 587);
    const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST, port, secure: port === 465, requireTLS: port !== 465, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 });
    return { name: 'smtp', send: async mail => {
      try {
        const info = await transport.sendMail({ from: { name: process.env.MAIL_FROM_NAME || 'Slot Design', address: process.env.MAIL_FROM || process.env.SMTP_USER! }, to: { name: mail.name, address: mail.to }, subject: mail.subject, text: mail.text, headers: { 'X-LMS-Notification': mail.id } });
        return { ok: true, providerId: info.messageId || 'smtp' };
      } catch (error) {
        const e = error as { responseCode?: number; code?: string; command?: string };
        // 4xx — временный отказ сервера, 5xx — постоянный (адрес, авторизация, лимит). Обрыв во время передачи письма — исход неизвестен.
        if (e.responseCode && e.responseCode >= 500) return { ok: false, retry: false, error: `SMTP rejected (${e.responseCode})` };
        if (e.responseCode && e.responseCode >= 400) return { ok: false, retry: true, error: `SMTP temporary failure (${e.responseCode})` };
        if (e.command === 'DATA' || e.code === 'ETIMEDOUT') return { ok: false, retry: false, unknown: true, error: `No confirmation from SMTP (${e.code || 'timeout'})` };
        return { ok: false, retry: true, error: `SMTP connection failed (${e.code || 'unknown'})` };
      }
    } };
  }
  return null;
}

// Фрагмент URL не отправляется серверу при открытии письма и не попадает в access log.
async function welcomeLink(email: string) {
  if (config().mode === 'local') {
    const result = await requestLink(email);
    if (!('localLink' in result)) throw new Error('Local invitation link is unavailable.');
    return result.localLink;
  }
  const { data, error } = await serviceClient().auth.admin.generateLink({ type: 'magiclink', email });
  const token = data?.properties?.hashed_token;
  if (error || !token) throw new Error('Invitation link could not be generated.');
  return `${config().origin}/#token=${encodeURIComponent(token)}`;
}

export async function deliver(now = new Date(), provider = mailProvider()) {
  if (!provider) return { processed: 0, sent: 0, failed: 0, skipped: 'Mail provider is not configured.' };
  // Строки, зависшие в sending (процесс упал после передачи), не повторяются вслепую.
  await sql`update lms.notifications set status='unknown',last_error='The worker stopped while sending. Check the provider before retrying.' where status='sending' and next_attempt_at<${new Date(now.getTime() - 10 * MINUTE)}`;
  const claimed = await sql`update lms.notifications set status='sending',attempts=attempts+1,next_attempt_at=${now} where id in (
    select id from lms.notifications where status='pending' and next_attempt_at<=${now} order by due_at limit 50 for update skip locked) returning *`;
  let sent = 0, failed = 0;
  for (const n of claimed) {
    const invalid = await stillValid(n, now);
    if (invalid) { await sql`update lms.notifications set status='cancelled',last_error=${invalid} where id=${n.id}`; continue; }
    const [who] = await sql`select name,email from lms.profiles where id=${n.recipient_id}`;
    let result: Outcome;
    let body = n.body;
    try {
      body = ['enrollment.invited', 'auth.link_requested'].includes(n.kind)
        ? n.body.replace('{{SIGN_IN_LINK}}', await welcomeLink(who.email))
        : n.body;
      if (['enrollment.invited', 'auth.link_requested'].includes(n.kind) && body === n.body) throw new Error('Sign-in template has no link placeholder.');
    } catch {
      result = { ok: false, retry: true, error: 'Invitation link could not be prepared. Check Supabase Auth.' };
      failed++;
      const delay = RETRIES[n.attempts - 1];
      await sql`update lms.notifications set status=${delay ? 'pending' : 'failed'},last_error=${result.error},next_attempt_at=${new Date(now.getTime() + (delay || 0) * MINUTE)} where id=${n.id}`;
      continue;
    }
    try { result = await provider.send({ id: n.id, to: who.email, name: who.name, subject: n.subject, text: body }); }
    catch { result = { ok: false, retry: false, unknown: true, error: 'The mail provider returned no result. Check delivery before retrying.' }; }
    if (result.ok) { sent++; await sql`update lms.notifications set status='sent',sent_at=clock_timestamp(),provider_id=${result.providerId},last_error=null where id=${n.id}`; continue; }
    failed++;
    const delay = RETRIES[n.attempts - 1];
    const status = result.unknown ? 'unknown' : result.retry && delay ? 'pending' : 'failed';
    await sql`update lms.notifications set status=${status},last_error=${result.error},next_attempt_at=${new Date(now.getTime() + (delay || 0) * MINUTE)} where id=${n.id}`;
  }
  return { processed: claimed.length, sent, failed, skipped: null };
}

export async function runMail(now = new Date(), provider = mailProvider()) {
  const created = await plan(now);
  return { created, ...(await deliver(now, provider)) };
}
