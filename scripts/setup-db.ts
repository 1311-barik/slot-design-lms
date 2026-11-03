import { sql } from '../src/lib/db';
import { migrate } from '../src/lib/migrate';
import { courseAssignments } from '../src/lib/course';
if (process.env.LMS_MODE !== 'local') throw new Error('Local seed requires LMS_MODE=local. Apply migrations separately to Supabase.');
try {
  await migrate(sql);
  const users = [
    ['10000000-0000-4000-8000-000000000001', 'alex@example.test', 'Alex Morgan', 'participant'],
    ['10000000-0000-4000-8000-000000000002', 'sam@example.test', 'Sam Taylor', 'participant'],
    ['10000000-0000-4000-8000-000000000003', 'expert@example.test', 'Jordan Lee', 'reviewer'],
    ['10000000-0000-4000-8000-000000000004', 'admin@example.test', 'Course administrator', 'admin'],
  ];
  for (const [id, email, name, role] of users) await sql`insert into lms.profiles(id,email,name,role,activated_at,access_ends_at) values(${id},${email},${name},${role},now(),now()+interval '1 year') on conflict do nothing`;
  for (const { seed, module, spec } of courseAssignments) {
    const id = `20000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
    await sql`insert into lms.assignments(id,module,spec,published,due_at,late_policy) values(${id},${module},${sql.json(spec)},true,now()+interval '30 days','allow_mark') on conflict do nothing`;
    await sql`insert into lms.reviewers values(${id},'10000000-0000-4000-8000-000000000003') on conflict do nothing`;
  }
  // Календарь курса: шесть воскресений с 15 ноября по 20 декабря 2026, 15:00 CET (UTC+1). Дата январского питча ещё не утверждена.
  for (let module = 1; module <= 6; module++) {
    const starts = new Date(Date.UTC(2026, 10, 15 + (module - 1) * 7, 14));
    await sql`insert into lms.sessions(id,module,title,starts_at) values(${`50000000-0000-4000-8000-${String(module).padStart(12, '0')}`},${module},${`Live session · Module ${module}`},${starts}) on conflict do nothing`;
  }
  await sql`insert into lms.materials(id,module,position,title,body,published) values('60000000-0000-4000-8000-000000000001',0,1,'How this course works',${'Six live Sunday classes at 15:00 CET run from 15 November to 20 December 2026. The final pitch is in January 2027; its date will be confirmed separately. Each module adds a layer to your own slot concept.\n\nSubmit homework here, in each module. Your draft stays private until you submit it; your expert then reviews that exact version.\n\nAsk the team in the Questions block of a module. There is no group chat in this cohort.'},true) on conflict do nothing`;
  console.log('Local synthetic course ready. Seed deadlines are test values, not course policy.');
} finally { await sql.end(); }
