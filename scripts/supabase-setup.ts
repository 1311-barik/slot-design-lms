// Подготовка рабочего проекта Supabase. Повторный запуск безопасен: ничего не удаляет и не перезаписывает.
// Запуск (секреты — из файла вне workspace):
//   node --env-file=/secure/admin.env --import tsx scripts/supabase-setup.ts --project-ref REF [--admin email "Name"]… [--reviewer email "Name"]… [--access-until 2027-02-11]
// --admin и --reviewer можно повторять.
import { sql } from '../src/lib/db';
import { migrate } from '../src/lib/migrate';
import { courseAssignments } from '../src/lib/course';
import { ensureAuthUser, serviceClient } from '../src/lib/supabase-admin';
import { deploymentEnvironment, projectArgument } from './deployment-env';

deploymentEnvironment(process.env, 'admin', projectArgument());

const args = process.argv.slice(2);
const options = (flag: string) => args.flatMap((a, i) => a === flag ? [[args[i + 1], args[i + 2]]] : []);
for (const flag of ['--admin', '--reviewer']) for (const [email, name] of options(flag)) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name?.trim() || name.startsWith('--')) throw new Error(`Use ${flag} email "Full name".`);
}
const until = args.includes('--access-until') ? new Date(`${args[args.indexOf('--access-until') + 1]}T23:59:59+01:00`) : new Date(Date.now() + 2 * 365 * 86_400_000);
if (Number.isNaN(until.getTime())) throw new Error('Use --access-until YYYY-MM-DD.');
const log = (message: string) => console.log(`• ${message}`);

async function person(email: string | undefined, name: string | undefined, role: 'admin' | 'reviewer') {
  if (!email || !name || name.startsWith('--')) throw new Error(`Use --${role} email "Full name".`);
  const id = await ensureAuthUser(email);
  const [existing] = await sql`select id,role from lms.profiles where email=${email.toLowerCase()} or id=${id}`;
  if (existing) { log(`${role} ${email}: profile already exists (${existing.role}), not changed`); return existing.id as string; }
  // activated_at появится при первом входе по одноразовой ссылке.
  await sql`insert into lms.profiles(id,email,name,role,access_ends_at) values(${id},${email.toLowerCase()},${name},${role},${until})`;
  log(`${role} ${email}: created, access until ${until.toISOString().slice(0, 10)}`);
  return id;
}

try {
  const applied = await migrate(sql);
  log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations: up to date');
  const [member] = await sql`select pg_has_role(current_user, 'lms_runtime', 'member') as ok`;
  if (!member.ok) throw new Error('The database user is not a member of lms_runtime; domain commands would fail.');

  // Приватное хранилище работ: публичный bucket недопустим.
  const storage = serviceClient().storage; const bucket = process.env.SUPABASE_STORAGE_BUCKET!;
  const found = await storage.getBucket(bucket);
  if (found.data) { if (found.data.public) throw new Error(`Bucket ${bucket} is public. Make it private before continuing.`); log(`storage bucket ${bucket}: exists, private`); }
  else { const made = await storage.createBucket(bucket, { public: false, fileSizeLimit: '50MB' }); if (made.error) throw new Error(`Bucket ${bucket} could not be created: ${made.error.message}`); log(`storage bucket ${bucket}: created, private`); }

  // Структура курса без тестовых данных: задания не опубликованы и без сроков — даты и публикацию задаёт администратор.
  let added = 0;
  for (const { module, spec } of courseAssignments) {
    const rows = await sql`insert into lms.assignments(id,module,spec,published,late_policy) select gen_random_uuid(),${module},${sql.json(spec)},false,'allow_mark'
      where not exists(select 1 from lms.assignments where spec->>'title'=${spec.title}) returning id`;
    added += rows.length;
  }
  log(`assignments: ${added} added, ${courseAssignments.length - added} already present (unpublished until the administrator publishes them)`);
  const [sessions] = await sql`select count(*)::int as n from lms.sessions`;
  if (!sessions.n) {
    // Календарь потока: шесть воскресений с 15 ноября по 20 декабря 2026, 15:00 CET. Январский питч добавляется после утверждения даты.
    for (let module = 1; module <= 6; module++) await sql`insert into lms.sessions(id,module,title,starts_at) values(gen_random_uuid(),${module},${`Live session · Module ${module}`},${new Date(Date.UTC(2026, 10, 15 + (module - 1) * 7, 14))})`;
    log('sessions: six Sundays from 15 November to 20 December 2026, 15:00 CET; January pitch pending');
  } else log(`sessions: ${sessions.n} already present, not changed`);

  for (const admin of options('--admin')) await person(admin[0], admin[1], 'admin');
  for (const reviewer of options('--reviewer')) {
    const id = await person(reviewer[0], reviewer[1], 'reviewer');
    // Первый поток: эксперт отвечает за все задания без ответственного. Распределение по модулям — отдельной правкой.
    const rows = await sql`insert into lms.reviewers(assignment_id,reviewer_id) select id,${id} from lms.assignments a where not exists(select 1 from lms.reviewers r where r.assignment_id=a.id) returning assignment_id`;
    log(`reviewer assigned to ${rows.length} assignments without a responsible expert`);
  }

  // Закрытая схема не должна быть доступна через Data API (exposed schemas).
  const probe = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?select=id&limit=0`, { headers: { apikey: process.env.SUPABASE_ANON_KEY!, 'Accept-Profile': 'lms' }, signal: AbortSignal.timeout(15000) });
  const body = await probe.json().catch(() => ({}));
  if (probe.status !== 406 || body.code !== 'PGRST106') throw new Error('Cannot confirm that lms is excluded from the Data API. Check Exposed schemas before launch.');
  log('Data API: lms schema not exposed');
  log('done');
} finally { await sql.end(); }
