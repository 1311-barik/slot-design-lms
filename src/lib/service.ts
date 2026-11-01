import { createHash } from 'node:crypto';
import { z } from 'zod';
import { transaction, type Tx } from './db';
import { mailProvider } from './mail';
import { AppError, attachedIds, isPackage, meaningful, packagedIds, payloadSchema, text, uuid, validateSubmission } from './contract';

const unavailable = () => new AppError('not_found', 'This item is not available.', 404);
const conflict = () => new AppError('conflict', 'This work changed. Keep your text and reload the saved version.', 409);
const version = z.number().int().nonnegative();
const reviewText = text.refine(meaningful, 'Write feedback before publishing.');
const decision = z.enum(['accepted', 'needs_revision']);
const level = z.enum(['weak', 'medium', 'strong']).nullable().default(null);
const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value));
const webUrl = z.string().trim().max(2000).refine(v => /^https?:\/\/\S+$/i.test(v), 'Use a full https:// link.');
const optionalUrl = z.union([z.literal(''), webUrl]).default('');
const moment = z.iso.datetime({ offset: true }).nullable();
async function requireAdmin(tx: Tx) {
  const [allowed] = await tx`select lms.is_admin() as ok`;
  if (!allowed.ok) throw new AppError('forbidden', 'Administrator access is required.', 403);
}

export async function readWorkspace(actor: string) {
  return transaction(actor, async tx => {
    const [me] = await tx`select id,name,email,role,access_ends_at,timezone,password_set_at from lms.profiles where id=${actor}`;
    const [assignments, works, drafts, submissions, reviews, reviewDrafts, files, people, claims, projects, packageItems, questions, answers] = await Promise.all([
      tx`select * from lms.assignments order by module`, tx`select * from lms.works`,
      tx`select * from lms.drafts where submitted_at is null`,
      tx`select s.*,coalesce((select r.action from lms.reviews r where r.submission_id=s.id and not exists(select 1 from lms.reviews n where n.replaces_id=r.id)),case when exists(select 1 from lms.review_claims c where c.submission_id=s.id) then 'in_review' else 'submitted' end) as status from lms.submissions s order by submitted_at desc, number desc`,
      tx`select * from lms.reviews order by created_at`, tx`select * from lms.review_drafts`,
      tx`select id,name,mime,size,owner_id from lms.files`,
      tx`select id,name,email,role,activated_at,revoked_at,access_ends_at,password_set_at from lms.profiles order by name`,
      tx`select * from lms.review_claims`, tx`select * from lms.project_headers`,
      tx`select * from lms.package_items`, tx`select * from lms.questions order by created_at desc`, tx`select * from lms.answers order by created_at`,
    ]);
    const [materials, materialFiles, progress, sessions, [clock], presentations, reviewers, notifications, feedback] = await Promise.all([
      tx`select *, (lms.is_admin() or opens_at is null or opens_at<=clock_timestamp()) as open from lms.materials order by module, position, title`,
      tx`select * from lms.material_files`, tx`select * from lms.material_progress`, tx`select * from lms.sessions order by starts_at`,
      tx`select clock_timestamp() as now`, tx`select * from lms.presentations order by created_at`, tx`select * from lms.reviewers`,
      // Администратор видит очередь писем; остальные — только свои уведомления (RLS).
      tx`select * from lms.notifications order by created_at desc limit ${me.role === 'admin' ? 500 : 50}`,
      tx`select * from lms.feedback order by created_at desc`,
    ]);
    const admin = me.role === 'admin';
    // Закрытый до даты материал: участник получает только название и время открытия (LMS-02).
    const visibleMaterials = materials.map(m => m.open ? m : { id: m.id, module: m.module, position: m.position, audience: m.audience, title: m.title, opens_at: m.opens_at, published: m.published, open: false });
    // Запись занятия видна участникам только после публикации.
    // Эксперт видит имена участников для журнала, но не их адреса (список email — только администратору).
    const visiblePeople = admin ? people : people.map(p => p.id === actor ? p : { ...p, email: null });
    const visibleSessions = sessions.map(x => admin || x.recording_published ? x : { ...x, recording_url: null });
    // Собственная история остаётся в навигации после снятия задания с публикации.
    // Показываем только закреплённый снимок условия, а не будущую редакцию задания.
    const visibleAssignments = [...assignments];
    for (const work of works) if (work.owner_id === actor && !visibleAssignments.some(a => a.id === work.assignment_id)) {
      visibleAssignments.push({ id: work.assignment_id, module: work.module, spec: work.spec, revision: work.assignment_revision, published: false, due_at: null, late_policy: null });
    }
    return jsonValue({ me, assignments: visibleAssignments.sort((a,b) => a.module-b.module || String(a.spec.title).localeCompare(b.spec.title)), works, drafts, submissions, reviews, reviewDrafts, files, people: visiblePeople, claims, presentations, reviewers, notifications, feedback, mail: admin ? { provider: mailProvider()?.name || null } : null, project: projects.find(p => p.owner_id === actor) || null, projects: admin ? projects : [], packageItems, questions, answers, materials: visibleMaterials, materialFiles, progress, sessions: visibleSessions, now: clock.now });
  });
}

export async function isAdmin(actor: string) {
  return transaction(actor, async tx => { const [row] = await tx`select lms.is_admin() as ok`; return !!row.ok; });
}

export async function command(actor: string, action: string, input: unknown) {
  return transaction(actor, async tx => {
    // Один actor не может выполнить две мутации одновременно, включая повтор после потери ответа.
    await tx`select pg_advisory_xact_lock(hashtextextended(${actor},0))`;
    const key = input && typeof input === 'object' && 'key' in input ? uuid.parse(input.key) : null;
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, input })).digest('hex');
    if (key) {
      const [prior] = await tx`select * from lms.idempotency where actor_id=${actor} and key=${key}`;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new AppError('key_reused', 'This request key belongs to a different action. Reload the work.', 409);
        return prior.result;
      }
    }
    const result = jsonValue(await perform(tx, actor, action, input));
    if (key) await tx`insert into lms.idempotency values(${actor},${key},${fingerprint},${tx.json(result)})`;
    return result;
  });
}

async function ownDraft(tx: Tx, actor: string, id: string, revision: number) {
  const [draft] = await tx`select * from lms.drafts where id=${id} and owner_id=${actor} for update`;
  if (!draft) throw unavailable();
  const [work] = await tx`select * from lms.works where id=${draft.work_id} for update`;
  if (draft.submitted_at) throw new AppError('already_submitted', 'This version is already submitted.', 409);
  if (draft.revision !== revision) throw conflict();
  return { draft, work };
}

// Версии, которые участник может включить в итоговый пакет: свои сдачи, кроме других пакетов.
async function packable(tx: Tx, actor: string): Promise<string[]> {
  const rows = await tx`select id,spec from lms.submissions where owner_id=${actor}`;
  return rows.filter(r => !isPackage(r.spec)).map(r => r.id);
}

async function assignedSubmission(tx: Tx, id: string) {
  const [submission] = await tx`select * from lms.submissions where id=${id}`;
  if (!submission) throw unavailable();
  const [visibleWork] = await tx`select * from lms.works where id=${submission.work_id}`;
  if (!visibleWork) throw unavailable();
  const [allowed] = await tx`select lms.can_review(${visibleWork.assignment_id}) as ok`;
  if (!allowed.ok) throw new AppError('forbidden', 'Only the responsible expert can review this work.', 403);
  if (visibleWork.spec.mode === 'self_assessment') throw new AppError('self_assessment', 'Self-assessments are received without an expert decision.', 409);
  const [work] = await tx`select * from lms.works where id=${submission.work_id} for update`;
  if (!work) throw unavailable();
  const [latest] = await tx`select id from lms.submissions where work_id=${work.id} order by number desc limit 1`;
  return { submission, work, isLatest: latest.id === id };
}

async function perform(tx: Tx, actor: string, action: string, input: unknown): Promise<unknown> {
  switch (action) {
    case 'draft.create': {
      const { assignmentId } = z.object({ assignmentId: uuid }).strict().parse(input);
      const [profile] = await tx`select role from lms.profiles where id=${actor}`;
      if (profile.role !== 'participant') throw new AppError('forbidden', 'Only participants can submit homework.', 403);
      const [assignment] = await tx`select * from lms.assignments where id=${assignmentId} and published=true`;
      if (!assignment) throw unavailable();
      let [work] = await tx`select * from lms.works where owner_id=${actor} and assignment_id=${assignmentId} for update`;
      if (!work) [work] = await tx`insert into lms.works(owner_id,assignment_id,module,spec,assignment_revision) values(${actor},${assignmentId},${assignment.module},${tx.json(assignment.spec)},${assignment.revision}) returning *`;
      const [existing] = await tx`select * from lms.drafts where work_id=${work.id} and submitted_at is null`;
      if (existing) return existing;
      const [last] = await tx`select payload from lms.submissions where work_id=${work.id} order by number desc limit 1`;
      const [draft] = await tx`insert into lms.drafts(work_id,owner_id,payload) values(${work.id},${actor},${tx.json(last?.payload || { parts: {} })}) returning *`;
      return draft;
    }
    case 'draft.save': {
      const data = z.object({ draftId: uuid, expectedRevision: version, payload: payloadSchema }).strict().parse(input);
      await ownDraft(tx, actor, data.draftId, data.expectedRevision);
      const own = await packable(tx, actor);
      const ids = attachedIds(data.payload);
      if (ids.length) {
        const files = await tx`select id from lms.files where id in ${tx(ids)} and owner_id=${actor}`;
        if (files.length !== ids.length) throw new AppError('invalid_file', 'One of the attached files is not available.');
      }
      const packaged = packagedIds(data.payload);
      if (packaged.some(id => !own.includes(id))) throw new AppError('invalid_version', 'Choose only your own submitted versions.');
      const [draft] = await tx`update lms.drafts set payload=${tx.json(data.payload)},revision=revision+1,updated_at=now() where id=${data.draftId} returning *`;
      return draft;
    }
    case 'draft.submit': {
      const data = z.object({ draftId: uuid, expectedRevision: version, key: uuid }).strict().parse(input);
      const [already] = await tx`select * from lms.submissions where draft_id=${data.draftId} and owner_id=${actor}`;
      if (already) {
        if (already.draft_revision !== data.expectedRevision) throw conflict();
        return already;
      }
      const { draft, work } = await ownDraft(tx, actor, data.draftId, data.expectedRevision);
      const [assignment] = await tx`select * from lms.assignments where id=${work.assignment_id} and published=true`;
      if (!assignment) throw new AppError('unpublished', 'This assignment is unavailable. Your saved draft is kept.', 409);
      const payload = payloadSchema.parse(draft.payload);
      const ids = attachedIds(payload);
      const files = ids.length ? await tx`select id,mime,size from lms.files where id in ${tx(ids)} and owner_id=${actor}` : [];
      if (files.length !== ids.length) throw new AppError('invalid_file', 'An attached file is unavailable.');
      validateSubmission(work.spec, payload, files as { id: string; mime: string; size: number }[], isPackage(work.spec) ? await packable(tx, actor) : []);
      const [project] = await tx`select theme,audience from lms.project_headers where owner_id=${actor}`;
      const [clock] = await tx`select clock_timestamp() as time`;
      const late = assignment.due_at ? new Date(clock.time) > new Date(assignment.due_at) : false;
      if (late && assignment.late_policy === 'block_after_due') throw new AppError('deadline', 'The submission deadline has passed. Your draft is kept.', 409);
      const [count] = await tx`select coalesce(max(number),0)+1 as next from lms.submissions where work_id=${work.id}`;
      const [submission] = await tx`insert into lms.submissions(work_id,owner_id,draft_id,draft_revision,number,payload,spec,late,submitted_at,due_at_snapshot,project_snapshot) values(${work.id},${actor},${draft.id},${draft.revision},${count.next},${tx.json(payload)},${tx.json(work.spec)},${late},${clock.time},${assignment.due_at},${project ? tx.json(project) : null}) returning *`;
      for (const id of ids) await tx`insert into lms.submission_files values(${submission.id},${id})`;
      for (const id of packagedIds(payload)) await tx`insert into lms.package_items values(${submission.id},${id})`;
      await tx`update lms.drafts set submitted_at=now() where id=${draft.id}`;
      await tx`update lms.works set status='submitted' where id=${work.id}`;
      await tx`insert into lms.outbox(kind,aggregate_id) values('submission.created',${submission.id})`;
      return submission;
    }
    case 'submission.claim': {
      const { submissionId } = z.object({ submissionId: uuid }).strict().parse(input);
      const { work, isLatest } = await assignedSubmission(tx, submissionId);
      const [decision] = await tx`select id from lms.reviews where submission_id=${submissionId} limit 1`;
      if (decision) throw new AppError('reviewed', 'This submission already has a decision.', 409);
      const [claimed] = await tx`select * from lms.review_claims where submission_id=${submissionId}`;
      if (claimed) return { ...work, status: 'in_review', claim: claimed };
      const [claim] = await tx`insert into lms.review_claims(submission_id,reviewer_id) values(${submissionId},${actor}) returning *`;
      if (isLatest) await tx`update lms.works set status='in_review' where id=${work.id}`;
      return { ...work, status: 'in_review', claim };
    }
    case 'review.save': {
      const data = z.object({ submissionId: uuid, expectedRevision: version, body: text, action: decision, level, reason: text.default(''), replacesId: uuid.optional() }).strict().parse(input);
      await assignedSubmission(tx, data.submissionId);
      const [current] = await tx`select r.id from lms.reviews r where submission_id=${data.submissionId} and not exists(select 1 from lms.reviews n where n.replaces_id=r.id)`;
      if (current?.id !== data.replacesId) throw conflict();
      const [old] = await tx`select * from lms.review_drafts where submission_id=${data.submissionId} and author_id=${actor} for update`;
      if ((old?.revision || 0) !== data.expectedRevision) throw conflict();
      const [saved] = await tx`insert into lms.review_drafts(submission_id,author_id,revision,body,action,level,reason,base_review_id) values(${data.submissionId},${actor},1,${data.body},${data.action},${data.level},${data.reason},${data.replacesId || null}) on conflict(submission_id,author_id) do update set revision=lms.review_drafts.revision+1,body=excluded.body,action=excluded.action,level=excluded.level,reason=excluded.reason,base_review_id=excluded.base_review_id returning *`;
      return saved;
    }
    case 'review.publish': {
      const data = z.object({ submissionId: uuid, expectedRevision: version, action: decision, level, body: reviewText, key: uuid, replacesId: uuid.optional(), reason: text.optional() }).strict().parse(input);
      const { work, isLatest } = await assignedSubmission(tx, data.submissionId);
      const [draft] = await tx`select * from lms.review_drafts where submission_id=${data.submissionId} and author_id=${actor} for update`;
      if ((draft?.revision || 0) !== data.expectedRevision) throw conflict();
      const [current] = await tx`select r.* from lms.reviews r where submission_id=${data.submissionId} and not exists(select 1 from lms.reviews n where n.replaces_id=r.id)`;
      if (current) {
        if (current.id !== data.replacesId) throw conflict();
        if (!data.reason || !meaningful(data.reason)) throw new AppError('reason_required', 'Explain why you are correcting the decision.', 422, ['reason']);
      } else if (data.replacesId) throw conflict();
      const [review] = await tx`insert into lms.reviews(submission_id,author_id,action,level,body,replaces_id,reason) values(${data.submissionId},${actor},${data.action},${data.level},${data.body},${data.replacesId || null},${data.replacesId ? data.reason! : null}) returning *`;
      // Публикация завершает этот черновик и делает устаревшие вкладки недействительными.
      const [saved] = await tx`insert into lms.review_drafts(submission_id,author_id,revision,body,action,level,reason,base_review_id) values(${data.submissionId},${actor},1,${data.body},${data.action},${data.level},'',${review.id}) on conflict(submission_id,author_id) do update set revision=lms.review_drafts.revision+1,body=excluded.body,action=excluded.action,level=excluded.level,reason='',base_review_id=excluded.base_review_id returning revision`;
      if (isLatest) await tx`update lms.works set status=${data.action} where id=${work.id}`;
      await tx`insert into lms.outbox(kind,aggregate_id) values('review.published',${review.id})`;
      return { ...review, feedback_draft_revision: saved.revision };
    }
    case 'enrollment.invite': {
      const data = z.object({ id: uuid, email: z.email().max(254), name: z.string().trim().min(1).max(150), accessEndsAt: z.iso.datetime() }).strict().parse(input);
      const [allowed] = await tx`select lms.is_admin() as ok`;
      if (!allowed.ok) throw new AppError('forbidden', 'Administrator access is required.', 403);
      if (new Date(data.accessEndsAt) <= new Date()) throw new AppError('access_date', 'Choose a future access end date.');
      const [existing] = await tx`select * from lms.profiles where email=${data.email.toLowerCase()}`;
      if (existing) return existing;
      const [person] = await tx`insert into lms.profiles(id,email,name,role,access_ends_at) values(${data.id},${data.email.toLowerCase()},${data.name},'participant',${data.accessEndsAt}) returning *`;
      await tx`insert into lms.outbox(kind,aggregate_id) values('enrollment.invited',${person.id})`;
      await tx`insert into lms.audit_events(actor_id,action,target_id) values(${actor},'enrollment.invited',${person.id})`;
      return person;
    }
    case 'enrollment.revoke':
    case 'enrollment.restore': {
      const { id } = z.object({ id: uuid }).strict().parse(input);
      const [allowed] = await tx`select lms.is_admin() as ok`;
      if (!allowed.ok) throw new AppError('forbidden', 'Administrator access is required.', 403);
      if (id === actor) throw new AppError('self_revoke', 'You cannot revoke your own administrator access.');
      await tx`select pg_advisory_xact_lock(hashtextextended(${id},0))`;
      const [person] = action === 'enrollment.revoke'
        ? await tx`update lms.profiles set revoked_at=now() where id=${id} and role='participant' returning id`
        : await tx`update lms.profiles set revoked_at=null where id=${id} and role='participant' and access_ends_at>clock_timestamp() returning id`;
      if (!person) throw unavailable();
      await tx`insert into lms.audit_events(actor_id,action,target_id) values(${actor},${action},${id})`;
      return person;
    }
    case 'material.save': {
      const data = z.object({ id: uuid, expectedRevision: version, module: z.number().int().min(0).max(7), position: z.number().int().min(0).max(999), audience: z.enum(['participant', 'team']),
        title: z.string().trim().min(1, 'Add a title.').max(200), body: text, links: z.array(z.object({ label: z.string().trim().min(1).max(200), url: webUrl })).max(20), published: z.boolean(), opensAt: moment, files: z.array(uuid).max(20) }).strict().parse(input);
      await requireAdmin(tx);
      const [old] = await tx`select revision from lms.materials where id=${data.id} for update`;
      if ((old?.revision || 0) !== data.expectedRevision) throw conflict();
      if (data.files.length) {
        const files = await tx`select id from lms.files where id in ${tx(data.files)}`;
        if (files.length !== new Set(data.files).size) throw new AppError('invalid_file', 'One of the attached files is not available.');
      }
      const [material] = old
        ? await tx`update lms.materials set module=${data.module},position=${data.position},audience=${data.audience},title=${data.title},body=${data.body},links=${tx.json(data.links)},published=${data.published},opens_at=${data.opensAt},revision=revision+1,updated_at=clock_timestamp() where id=${data.id} returning *`
        : await tx`insert into lms.materials(id,module,position,audience,title,body,links,published,opens_at) values(${data.id},${data.module},${data.position},${data.audience},${data.title},${data.body},${tx.json(data.links)},${data.published},${data.opensAt}) returning *`;
      await tx`delete from lms.material_files where material_id=${data.id}`;
      for (const id of new Set(data.files)) await tx`insert into lms.material_files values(${data.id},${id})`;
      await tx`insert into lms.audit_events(actor_id,action,target_id) values(${actor},'material.saved',${data.id})`;
      return material;
    }
    case 'material.progress': {
      const data = z.object({ materialId: uuid, studied: z.boolean() }).strict().parse(input);
      const [profile] = await tx`select role from lms.profiles where id=${actor}`;
      if (profile.role !== 'participant') throw new AppError('forbidden', 'Only participants track their progress.', 403);
      const [open] = await tx`select lms.material_open(${data.materialId}) as ok`;
      if (!open.ok) throw unavailable();
      // Отметка не связана с ДЗ: не принимает задание и не меняет его статус.
      if (data.studied) {
        const added = await tx`insert into lms.material_progress(owner_id,material_id) values(${actor},${data.materialId}) on conflict do nothing returning material_id`;
        if (added.length) await tx`insert into lms.outbox(kind,aggregate_id,payload) values('material.studied',gen_random_uuid(),${tx.json({ owner: actor, material: data.materialId })})`;
      }
      else await tx`delete from lms.material_progress where owner_id=${actor} and material_id=${data.materialId}`;
      return { materialId: data.materialId, studied: data.studied };
    }
    case 'session.save': {
      const data = z.object({ id: uuid, expectedRevision: version, module: z.number().int().min(0).max(7), title: z.string().trim().min(1, 'Add a title.').max(200), startsAt: z.iso.datetime({ offset: true }), endsAt: moment, joinUrl: optionalUrl, recordingUrl: optionalUrl, recordingPublished: z.boolean() }).strict().parse(input);
      await requireAdmin(tx);
      if (data.endsAt && new Date(data.endsAt) <= new Date(data.startsAt)) throw new AppError('session_time', 'The end must be later than the start.', 422, ['endsAt']);
      if (data.recordingPublished && !data.recordingUrl) throw new AppError('recording', 'Add the recording link before publishing it.', 422, ['recordingUrl']);
      const [old] = await tx`select revision,starts_at from lms.sessions where id=${data.id} for update`;
      if ((old?.revision || 0) !== data.expectedRevision) throw conflict();
      const values = { module: data.module, title: data.title, starts_at: data.startsAt, ends_at: data.endsAt, join_url: data.joinUrl || null, recording_url: data.recordingUrl || null, recording_published: data.recordingPublished };
      // Перенос занятия не меняет сроки заданий молча: их администратор правит отдельно (LMS-04).
      const [session] = old
        ? await tx`update lms.sessions set ${tx(values)}, revision=revision+1 where id=${data.id} returning *`
        : await tx`insert into lms.sessions ${tx({ id: data.id, ...values })} returning *`;
      await tx`insert into lms.audit_events(actor_id,action,target_id) values(${actor},'session.saved',${data.id})`;
      // Перенос уведомляет участников и команду; старые напоминания отменяются при проверке перед отправкой.
      if (old && new Date(old.starts_at).getTime() !== new Date(data.startsAt).getTime()) await tx`insert into lms.outbox(kind,aggregate_id,payload) values('session.changed',gen_random_uuid(),${tx.json({ sessionId: data.id })})`;
      return session;
    }
    case 'assignment.schedule': {
      const data = z.object({ assignmentId: uuid, published: z.boolean(), opensAt: moment, dueAt: moment, reviewDueAt: moment.default(null), latePolicy: z.enum(['allow_mark', 'block_after_due']) }).strict().parse(input);
      await requireAdmin(tx);
      if (data.opensAt && data.dueAt && new Date(data.opensAt) > new Date(data.dueAt)) throw new AppError('assignment_dates', 'The deadline must be after the opening time.', 422, ['dueAt']);
      if (data.dueAt && data.reviewDueAt && new Date(data.reviewDueAt) < new Date(data.dueAt)) throw new AppError('review_date', 'The review deadline must be after the submission deadline.', 422, ['reviewDueAt']);
      // Снятие с публикации закрывает новые отправки; черновики, сдачи и отзывы сохраняются.
      const [assignment] = await tx`update lms.assignments set published=${data.published},opens_at=${data.opensAt},due_at=${data.dueAt},review_due_at=${data.reviewDueAt},late_policy=${data.latePolicy} where id=${data.assignmentId} returning *`;
      if (!assignment) throw unavailable();
      await tx`insert into lms.audit_events(actor_id,action,target_id) values(${actor},'assignment.scheduled',${data.assignmentId})`;
      return assignment;
    }
    case 'presentation.record': {
      const data = z.object({ participantId: uuid, outcome: z.enum(['held', 'absent']), packageId: uuid.nullable(), withoutPackage: z.boolean(), level, comment: text.default(''), replacesId: uuid.optional(), reason: text.optional(), key: uuid }).strict().parse(input);
      const [allowed] = await tx`select lms.can_present() as ok`;
      if (!allowed.ok) throw new AppError('forbidden', 'Only the expert responsible for the final package records project presentations.', 403);
      const [person] = await tx`select role from lms.profiles where id=${data.participantId}`;
      if (person?.role !== 'participant') throw unavailable();
      await tx`select pg_advisory_xact_lock(hashtextextended(${data.participantId},1))`;
      if (data.outcome === 'absent' && (data.packageId || data.withoutPackage || data.level)) throw new AppError('presentation_absent', 'A participant who was absent has no presented package or level.', 422, ['outcome']);
      if (data.outcome === 'held' && !!data.packageId === data.withoutPackage) throw new AppError('presentation_package', 'Choose the package that was presented, or mark the presentation as held without a submitted package.', 422, ['packageId']);
      if (data.packageId) {
        const [pack] = await tx`select spec from lms.submissions where id=${data.packageId} and owner_id=${data.participantId}`;
        if (!pack || !isPackage(pack.spec)) throw new AppError('presentation_package', 'Choose one of this participant’s submitted final packages.', 422, ['packageId']);
      }
      // Исправление сохраняет прежнюю запись; правка без причины или по устаревшей записи отклоняется.
      const [current] = await tx`select d.id from lms.presentations d where participant_id=${data.participantId} and not exists(select 1 from lms.presentations n where n.replaces_id=d.id)`;
      if (current) {
        if (current.id !== data.replacesId) throw conflict();
        if (!data.reason || !meaningful(data.reason)) throw new AppError('reason_required', 'Explain why you are correcting the presentation record.', 422, ['reason']);
      } else if (data.replacesId) throw conflict();
      const [record] = await tx`insert into lms.presentations(participant_id,outcome,package_id,without_package,level,comment,author_id,replaces_id,reason) values(${data.participantId},${data.outcome},${data.packageId},${data.withoutPackage},${data.level},${data.comment},${actor},${data.replacesId || null},${current ? data.reason! : null}) returning *`;
      return record;
    }
    case 'feedback.send': {
      const data = z.object({ module: z.number().int().min(0).max(7).nullable(), rating: z.number().int().min(1).max(5).nullable(), body: text.refine(meaningful, 'Write your feedback first.'), key: uuid }).strict().parse(input);
      const [profile] = await tx`select role from lms.profiles where id=${actor}`;
      if (profile.role !== 'participant') throw new AppError('forbidden', 'Only participants send course feedback here.', 403);
      const [row] = await tx`insert into lms.feedback(owner_id,module,rating,body) values(${actor},${data.module},${data.rating},${data.body}) returning *`;
      await tx`insert into lms.outbox(kind,aggregate_id) values('feedback.created',${row.id})`;
      return row;
    }
    case 'notification.read': {
      const { ids } = z.object({ ids: z.array(uuid).min(1).max(200) }).strict().parse(input);
      const rows = await tx`update lms.notifications set read_at=coalesce(read_at,clock_timestamp()) where id in ${tx(ids)} and recipient_id=${actor} returning id`;
      return { read: rows.length };
    }
    case 'notification.retry': {
      const { id, confirmUnknown } = z.object({ id: uuid, confirmUnknown: z.boolean().default(false) }).strict().parse(input);
      await requireAdmin(tx);
      const [n] = await tx`select status from lms.notifications where id=${id} for update`;
      if (!n || !['failed', 'unknown', 'missed', 'cancelled'].includes(n.status)) throw new AppError('not_retryable', 'Only failed, unknown, missed or cancelled emails can be sent again.', 409);
      // Неизвестный исход сначала сверяют у провайдера: повтор может создать дубль письма.
      if (n.status === 'unknown' && !confirmUnknown) throw new AppError('confirm_unknown', 'Check the provider log first: this email may already have been delivered.', 409);
      await tx`update lms.notifications set status='pending',next_attempt_at=clock_timestamp(),last_error=null where id=${id}`;
      await tx`insert into lms.audit_events(actor_id,action,target_id) values(${actor},'notification.retried',${id})`;
      return { id };
    }
    case 'profile.timezone': {
      const { timezone } = z.object({ timezone: z.string().max(64).nullable() }).strict().parse(input);
      if (timezone && !Intl.supportedValuesOf('timeZone').includes(timezone)) throw new AppError('timezone', 'Choose a time zone from the list.', 422, ['timezone']);
      const [saved] = await tx`select lms.set_timezone(${timezone}) as timezone`;
      return saved;
    }
    case 'project.save': {
      const data = z.object({ expectedRevision: version, theme: text, audience: text }).strict().parse(input);
      const [profile] = await tx`select role from lms.profiles where id=${actor}`;
      if (profile.role !== 'participant') throw new AppError('forbidden', 'Only participants have a project.', 403);
      const [old] = await tx`select revision from lms.project_headers where owner_id=${actor} for update`;
      if ((old?.revision || 0) !== data.expectedRevision) throw conflict();
      const [saved] = await tx`insert into lms.project_headers(owner_id,theme,audience,revision) values(${actor},${data.theme},${data.audience},1) on conflict(owner_id) do update set theme=excluded.theme,audience=excluded.audience,revision=lms.project_headers.revision+1,updated_at=clock_timestamp() returning *`;
      await tx`insert into lms.outbox(kind,aggregate_id,payload) values('project.updated',gen_random_uuid(),${tx.json({ owner: actor })})`;
      return saved;
    }
    case 'question.ask': {
      const data = z.object({ module: z.number().int().min(0).max(7).nullable(), body: text.refine(meaningful, 'Write your question first.'), key: uuid }).strict().parse(input);
      const [profile] = await tx`select role from lms.profiles where id=${actor}`;
      if (profile.role !== 'participant') throw new AppError('forbidden', 'Only participants ask questions here.', 403);
      const [question] = await tx`insert into lms.questions(owner_id,module,body) values(${actor},${data.module},${data.body}) returning *`;
      await tx`insert into lms.outbox(kind,aggregate_id) values('question.asked',${question.id})`;
      return question;
    }
    case 'question.answer': {
      const data = z.object({ questionId: uuid, body: text.refine(meaningful, 'Write an answer first.'), source: z.string().trim().max(150).default(''), key: uuid }).strict().parse(input);
      const [question] = await tx`select * from lms.questions where id=${data.questionId}`;
      if (!question) throw unavailable();
      const [allowed] = await tx`select lms.can_answer(${question.module}) as ok`;
      if (!allowed.ok || question.owner_id === actor) throw new AppError('forbidden', 'Only the course team can answer this question.', 403);
      const [answer] = await tx`insert into lms.answers(question_id,author_id,body,source) values(${question.id},${actor},${data.body},${data.source || null}) returning *`;
      await tx`insert into lms.outbox(kind,aggregate_id) values('question.answered',${answer.id})`;
      return answer;
    }
    default: throw unavailable();
  }
}
