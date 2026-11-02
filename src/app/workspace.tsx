'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isPackage, validateSubmission, type AssignmentSpec, type Payload } from '@/lib/contract';
import { modules } from '@/lib/course';

type Row = { id: string; [key: string]: any };
type Data = { me: Row; assignments: Row[]; works: Row[]; drafts: Row[]; submissions: Row[]; reviews: Row[]; reviewDrafts: Row[]; files: Row[]; people: Row[]; project: Row | null; packageItems: Row[]; questions: Row[]; answers: Row[]; materials: Row[]; materialFiles: Row[]; progress: Row[]; sessions: Row[]; now: string; presentations: Row[]; reviewers: Row[]; notifications: Row[]; feedback: Row[]; projects: Row[]; mail: { provider: string | null } | null };
type Tab = 'main' | 'questions' | 'content' | 'journal' | 'presentations' | 'email' | 'feedback' | 'activity';
type QueueFilter = { assignment: string; status: string; overdue: boolean };
type JournalFilter = { module: string; assignment: string; status: string; reviewer: string; late: boolean };
class RequestError extends Error { constructor(message: string, public code: string, public fields: string[] = []) { super(message); } }
async function api(path: string, body?: unknown) {
  let result: Response;
  try { result = await fetch(`/api/v1/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) }); }
  catch { throw new RequestError('Connection lost. Your text is still here. Reconnect and try again.', 'network'); }
  const data = await result.json();
  if (!result.ok) throw new RequestError(data.message || 'Something went wrong. Try again.', data.code, data.field_errors);
  return data;
}
const cmd = (action: string, input: unknown) => api('commands', { action, input });
const empty = () => ({ text: '', files: [] as string[], images: [] as { fileId: string; prompt: string; caption: string }[], submissions: [] as string[] });
const date = (value: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(new Date(value)) + ' CET';
// Время курса — фиксированное UTC+1 (CET); рядом показываем время устройства участника с зоной (LMS-04).
const localTime = (value: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
const toInput = (value: string | null | undefined) => value ? new Date(new Date(value).getTime() + 3_600_000).toISOString().slice(0, 16) : '';
const fromInput = (value: string) => value ? new Date(`${value}:00+01:00`).toISOString() : null;
// Встреча без окончания после начала показывается как «началась» ещё 12 часов, а не исчезает.
const sessionState = (x: Row, now: number) => { const start = new Date(x.starts_at).getTime(); const end = x.ends_at ? new Date(x.ends_at).getTime() : start + 12 * 3_600_000; return now < start ? 'upcoming' : now < end ? 'started' : 'finished'; };
const statuses: Record<string, string> = { draft: 'Draft', submitted: 'Submitted', in_review: 'In review', needs_revision: 'Needs revision', accepted: 'Accepted', received: 'Received', not_submitted: 'Not submitted' };
const levels: Record<string, string> = { weak: 'Weak', medium: 'Medium', strong: 'Strong' };
// Текущая запись — та, которую никто не заменил (решения, презентации).
const currentOf = (rows: Row[]) => rows.find(r => !rows.some(n => n.replaces_id === r.id));
const canReview = (data: Data, assignmentId: string) => data.reviewers.some(r => r.assignment_id === assignmentId && r.reviewer_id === data.me.id);
// Срок проверки задания (LMS-10): оставшееся время или просрочка.
function reviewDue(assignment: Row | undefined, now: number) {
  if (!assignment?.review_due_at) return null;
  const left = new Date(assignment.review_due_at).getTime() - now; const days = Math.round(Math.abs(left) / 86_400_000); const span = days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${Math.max(1, Math.round(Math.abs(left) / 3_600_000))} h`;
  return { overdue: left < 0, text: left < 0 ? `Review overdue by ${span}` : `Review due in ${span}` };
}
const selfAssessment = (spec: AssignmentSpec | undefined) => spec?.mode === 'self_assessment';
// Самооценка после отправки показывается как «получена»: экспертного решения у неё нет.
const shown = (spec: AssignmentSpec, status: string) => selfAssessment(spec) && status !== 'draft' ? 'received' : status;
const PROJECT = -1;
function Badge({ status }: { status: string }) { return <span className={`badge ${status}`}>{statuses[status] || status}</span>; }
function ErrorBox({ error }: { error: string }) { return error ? <div className="error" role="alert">{error}</div> : null; }
// Выбранный раздел хранится в адресе: reload, Back/Forward и прямая ссылка открывают тот же модуль или «Мой проект».
const moduleFromUrl = () => { const raw = new URLSearchParams(location.search).get('module'); if (raw === 'project') return PROJECT; const value = Number(raw); return raw !== null && raw !== '' && Number.isInteger(value) && value >= 0 && value < modules.length ? value : 1; };
// Первый вход без модуля в адресе: до первого занятия — модуль 0 (стартовое видео), потом — модуль последнего начавшегося занятия.
const startModule = (sessions: Row[], now: number) => { const started = sessions.filter(x => x.module >= 1 && new Date(x.starts_at).getTime() <= now).map(x => x.module); return started.length ? Math.max(...started) : 0; };
const urlFor = (module: number) => `?module=${module === PROJECT ? 'project' : module}`;
// Подсказка сверху повторяет состояние работы ниже, а не общий призыв к отправке.
function nextStep(assignment: Row | undefined, work: Row | undefined, draft: Row | undefined) {
  if (!assignment) return 'Materials and assignments will appear here when published.';
  if (!assignment.published) return 'Submission is currently unavailable. Your saved work and history are kept.';
  if (selfAssessment(assignment.spec)) {
    if (!work || work.status === 'draft') return 'Submit your self-assessment the day before the session. The team sees it; other participants do not.';
    return draft ? 'Your self-assessment has been received. You are editing a new version.' : 'Your self-assessment has been received. No expert decision is needed.';
  }
  if (!work) return 'Complete each part of the assignment below. Submit when you are ready for expert feedback.';
  if (work.status === 'needs_revision') return draft ? 'Your expert returned this work. Use the feedback to update your draft, then submit a new version.' : 'Your expert returned this work. Read the feedback and start a revision.';
  if (work.status === 'draft') return 'Complete each part of the assignment below. Submit when you are ready for expert feedback.';
  if (work.status === 'accepted') return draft ? 'Your work has been accepted. You are editing an optional new version.' : 'Your work has been accepted. No action is needed for this assignment.';
  const waiting = work.status === 'in_review' ? 'Your expert is reviewing your submitted version.' : 'Your work is submitted and waiting for your expert.';
  return draft ? `${waiting} You are editing a new version in parallel.` : `${waiting} Feedback will appear here when it is published.`;
}

function SignIn({ local, onSuccess, reauth = false }: { local: boolean; onSuccess: () => void; reauth?: boolean }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [message, setMessage] = useState(''); const [link, setLink] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [token, setToken] = useState('');
  // Новые письма несут token во фрагменте URL; query остаётся для уже отправленных ссылок.
  // code — стандартное письмо Supabase (PKCE). Ссылка тратится только после нажатия Continue.
  useEffect(() => {
    const params = new URLSearchParams(location.search); const hash = new URLSearchParams(location.hash.slice(1));
    const value = hash.get('token') || params.get('token') || params.get('token_hash'); const code = params.get('code'); const flow = params.get('sb_flow_id');
    if (value) setToken(value); else if (code) setToken(`code:${code}${flow ? `:${flow}` : ''}`);
    if (params.get('error') || hash.get('error')) setError('This sign-in link is invalid or expired. Request a new link.');
    if (value || code || params.get('error') || hash.get('error')) history.replaceState(null, '', '/');
  }, []);
  async function enter(value: string) { setBusy(true); setError(''); try { await api('auth/exchange', value.startsWith('code:') ? (([code, flowId]) => flowId ? { code, flowId } : { code })(value.slice(5).split(':')) : { token: value }); onSuccess(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <div className={reauth ? 'reauth' : 'login-shell'}><section className="login-card">
    <div className="brand"><img className="brand-logo" src="/brand/talentgrator.png" alt="Talentgrator" width={72} height={44}/><span>Slot design</span></div>
    <p className="eyebrow">FROM IDEA TO RELEASE</p><h1>{reauth ? 'Sign in to continue' : 'A space to build your next idea.'}</h1>
    <p className="muted">Your course, work in progress and expert feedback, together.</p>
    {token ? <><p>Continue to open your course. This link can be used once.</p><button disabled={busy} onClick={() => enter(token)}>Continue to course</button></> : <>
      <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await api('auth/password-login', { email, password }); onSuccess(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>
        <label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@example.com" />
        <label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        <button className="full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      {/* Первый вход и забытый пароль — ссылка на почту. */}
      <div className="link-sign-in"><p className="small">First time here or forgot your password?</p><button className="secondary full" disabled={busy || !email} onClick={async () => { setBusy(true); setError(''); setLink(''); try { const r = await api('auth/link', { email }); setMessage(r.message); setLink(r.localLink || ''); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}>{busy ? 'Requesting link…' : 'Email me a sign-in link'}</button>{!email && <p className="muted small">Enter your email address above first.</p>}</div>
    </>}
    <p className="muted small">Access is by invitation.</p><ErrorBox error={error} />
    {message && <p role="status">{message}</p>}
    {local && <div className="test-mail"><strong>Local test mailbox</strong><p>Use alex@example.test (participant), expert@example.test or admin@example.test. No real email is sent.</p>{link && <button className="secondary" onClick={() => enter(new URLSearchParams(new URL(link).hash.slice(1)).get('token')!)} disabled={busy}>Open test sign-in link</button>}</div>}
  </section><aside className="login-aside"><p>Explore the idea.<br/>Make the choices.<br/><em>Build the concept.</em></p><small>Live sessions on Sundays, 15:00 CET · 15 November–20 December 2026<br/>Final pitch in January 2027 · Europe/Berlin</small></aside></div>;
}

function ReauthDialog({ local, onSuccess }: { local: boolean; onSuccess: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="reauth-dialog" aria-label="Sign in to continue" onCancel={e => e.preventDefault()}><SignIn local={local} reauth onSuccess={onSuccess}/></dialog>;
}

export default function Workspace() {
  const [data, setData] = useState<Data | null>(null); const [local, setLocal] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [module, setModule] = useState(1); const [reauth, setReauth] = useState(false); const [activeReview, setActiveReview] = useState(''); const [dirty, setDirty] = useState(false); const [staffTab, setStaffTab] = useState<Tab>('main'); const [account, setAccount] = useState(false); const [feedback, setFeedback] = useState(false);
  const [queueFilter, setQueueFilter] = useState<QueueFilter>({ assignment: '', status: 'waiting', overdue: false }); const [journalFilter, setJournalFilter] = useState<JournalFilter>({ module: '', assignment: '', status: '', reviewer: '', late: false });
  const startApplied = useRef(false);
  const load = useCallback(async () => { try { const next = await api('workspace'); if (!startApplied.current) { startApplied.current = true; if (next.me.role === 'participant' && !next.me.password_set_at) { setModule(0); history.replaceState(null, '', urlFor(0)); } else if (next.me.role === 'participant' && !new URLSearchParams(location.search).get('module')) setModule(startModule(next.sessions, new Date(next.now).getTime())); if (next.me.role === 'admin') setStaffTab('activity'); } setData(old => { if (old && old.me.id !== next.me.id) { location.reload(); return old; } return next; }); setReauth(false); setError(''); } catch (e) { if ((e as RequestError).code === 'unauthenticated') { setReauth(true); } else setError((e as Error).message); } finally { setLoading(false); } }, []);
  const current = useRef({ module, dirty }); current.current = { module, dirty };
  useEffect(() => { api('config').then(r => setLocal(r.local)).catch(e => setError(e.message)); setModule(moduleFromUrl()); void load(); }, [load]);
  useEffect(() => { const listener = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener); }, [dirty]);
  useEffect(() => {
    // Back/Forward меняют модуль так же, как меню: несохранённый текст требует подтверждения.
    const listener = () => { const next = moduleFromUrl(); if (next === current.current.module) return; if (current.current.dirty && !confirm('You have unsaved text. Leave this page and discard those changes?')) { history.pushState(null, '', urlFor(current.current.module)); return; } setDirty(false); setModule(next); };
    window.addEventListener('popstate', listener); return () => window.removeEventListener('popstate', listener);
  }, []);
  function chooseReview(id: string, tab: Tab = 'main') { if (!dirty || confirm('Discard your unsaved feedback and return to the review queue?')) { setDirty(false); setActiveReview(id); setStaffTab(tab); } }
  function move(next: number) { if (!dirty || confirm('You have unsaved text. Leave this page and discard those changes?')) { setDirty(false); setModule(next); if (next !== module) history.pushState(null, '', urlFor(next)); } }
  if (loading) return <div className="loading" role="status">Opening your workspace…</div>;
  if (!data) return <>{error && <div className="startup-error"><ErrorBox error={error}/><button onClick={load}>Try again</button></div>}<SignIn local={local} onSuccess={load}/></>;
  if (data.me.role === 'participant' && !data.me.password_set_at) return <div className="first-password"><PasswordPrompt refresh={load} onAuth={() => setReauth(true)} done={() => { setModule(0); history.replaceState(null, '', urlFor(0)); }}/>{reauth && <ReauthDialog local={local} onSuccess={load}/>}</div>;
  const staff = data.me.role !== 'participant';
  const auth = () => setReauth(true);
  const inModule = data.assignments.filter(a => a.module === module);
  // Подсказка берёт первое задание модуля, где участнику есть что делать; иначе — первое задание.
  const states = inModule.map(a => { const work = data.works.find(w => w.assignment_id === a.id && w.owner_id === data.me.id); const draft = data.drafts.find(d => d.work_id === work?.id); return { a, work, draft, open: !work || work.status === 'draft' || work.status === 'needs_revision' || !!draft }; });
  const focus = states.find(x => x.open && x.a.published) || states[0];
  const summary = focus ? `${states.length > 1 ? `${focus.a.spec.title}: ` : ''}${nextStep(focus.a, focus.work, focus.draft)}` : nextStep(undefined, undefined, undefined);
  const now = new Date(data.now).getTime();
  const upcoming = data.sessions.find(x => sessionState(x, now) !== 'finished');
  const staffMain = data.me.role === 'admin' ? 'Course administration' : 'Review queue';
  const openQuestions = data.questions.filter(q => !data.answers.some(a => a.question_id === q.id)).length;
  return <>
    {local && <div className="dev-banner">LOCAL DEVELOPMENT · Synthetic accounts and test deadlines</div>}
    <a className="skip" href="#main">Skip to content</a>
    <div className="app-shell"><aside className="sidebar"><a href="/" className="brand"><img className="brand-logo" src="/brand/talentgrator.png" alt="Talentgrator" width={72} height={44}/><span>Slot design<br/><em>From idea to release</em></span></a>
      <div className="cohort"><span className="dot"/> November 2026 cohort</div>
      <p className="nav-label">{staff ? 'WORKSPACE' : 'YOUR COURSE'}</p>
      <nav aria-label="Course navigation">{staff ? <>
        {data.me.role === 'admin' && <button className={`nav-item ${staffTab === 'activity' ? 'selected' : ''}`} aria-current={staffTab === 'activity' ? 'page' : undefined} onClick={() => chooseReview('', 'activity')}>Activity</button>}
        <button className={`nav-item ${staffTab === 'main' ? 'selected' : ''}`} aria-current={staffTab === 'main' ? 'page' : undefined} onClick={() => chooseReview('')}>{staffMain}</button>
        <button className={`nav-item ${staffTab === 'journal' ? 'selected' : ''}`} aria-current={staffTab === 'journal' ? 'page' : undefined} onClick={() => chooseReview('', 'journal')}>Journal</button>
        {(data.me.role === 'admin' || data.reviewers.some(r => r.reviewer_id === data.me.id && data.assignments.some(a => a.id === r.assignment_id && isPackage(a.spec)))) && <button className={`nav-item ${staffTab === 'presentations' ? 'selected' : ''}`} aria-current={staffTab === 'presentations' ? 'page' : undefined} onClick={() => chooseReview('', 'presentations')}>Project presentations</button>}
        <button className={`nav-item ${staffTab === 'content' ? 'selected' : ''}`} aria-current={staffTab === 'content' ? 'page' : undefined} onClick={() => chooseReview('', 'content')}>{data.me.role === 'admin' ? 'Course content' : 'Materials'}</button>
        {data.me.role === 'admin' && <button className={`nav-item ${staffTab === 'email' ? 'selected' : ''}`} aria-current={staffTab === 'email' ? 'page' : undefined} onClick={() => chooseReview('', 'email')}><span>Email</span>{data.notifications.some(n => ['failed','unknown'].includes(n.status)) && <span className="count alert" aria-label="Emails need attention">!</span>}</button>}
        {data.me.role === 'admin' && <button className={`nav-item ${staffTab === 'feedback' ? 'selected' : ''}`} aria-current={staffTab === 'feedback' ? 'page' : undefined} onClick={() => chooseReview('', 'feedback')}>Feedback</button>}
        <button className={`nav-item ${staffTab === 'questions' ? 'selected' : ''}`} aria-current={staffTab === 'questions' ? 'page' : undefined} onClick={() => chooseReview('', 'questions')}><span>Questions</span>{openQuestions > 0 && <span className="count" aria-label={`${openQuestions} without an answer`}>{openQuestions}</span>}</button>
      </> : <>
        <button onClick={() => move(PROJECT)} className={`nav-item ${module === PROJECT ? 'selected' : ''}`} aria-current={module === PROJECT ? 'page' : undefined}><span className="nav-number">★</span><span>My project</span></button>
        {modules.map((name, index) => <button key={name} onClick={() => move(index)} className={`nav-item ${module === index ? 'selected' : ''}`} aria-current={module === index ? 'page' : undefined}><span className="nav-number">{String(index).padStart(2,'0')}</span><span>{name}</span></button>)}
      </>}</nav>
      <div className="sidebar-bottom"><span className="avatar">{data.me.name.slice(0,1)}</span><div><strong>{data.me.name}</strong><small>{data.me.role === 'reviewer' ? 'Expert' : data.me.role}</small></div><button className="text-button" onClick={() => setAccount(true)}>Account</button><button className="text-button" onClick={async () => { if (dirty && !confirm('Discard unsaved changes and sign out?')) return; await api('auth/logout', {}); location.reload(); }}>Sign out</button></div>
    </aside><main id="main" className="main"><header className="topbar"><span>{staff ? 'Team workspace' : 'Learning workspace'}</span><div className="topbar-actions">{!staff && <button className="secondary small-button" onClick={() => setFeedback(true)}>Feedback</button>}<Notifications data={data} refresh={load} onAuth={auth}/></div><span className="session-note">{upcoming ? <>{sessionState(upcoming, now) === 'started' ? 'Live session started' : 'Next live session'} <strong>{date(upcoming.starts_at)}</strong></> : 'No upcoming live sessions'}</span></header>
      <ErrorBox error={error}/>{error && <button className="secondary" onClick={load}>Retry loading</button>}
      {staff ? activeReview ? <Expert data={data} refresh={load} active={activeReview} setActive={id => chooseReview(id, staffTab)} onAuth={auth} onDirty={setDirty} filter={queueFilter} setFilter={setQueueFilter} now={now}/> : staffTab === 'journal' ? <Journal data={data} now={now} filter={journalFilter} setFilter={setJournalFilter} open={id => chooseReview(id, 'journal')}/> : staffTab === 'presentations' ? <Presentations data={data} refresh={load} onAuth={auth}/> : staffTab === 'email' ? <MailAdmin data={data} refresh={load} onAuth={auth}/> : staffTab === 'feedback' ? <FeedbackAdmin data={data}/> : staffTab === 'activity' ? <ActivityDashboard data={data} now={now} open={id => chooseReview(id, 'activity')}/> : staffTab === 'questions' ? <TeamQuestions data={data} refresh={load} onAuth={auth}/> : staffTab === 'content' ? data.me.role === 'admin' ? <ContentAdmin data={data} refresh={load} onAuth={auth} onDirty={setDirty}/> : <TeamMaterials data={data}/> : data.me.role === 'admin' ? <Admin data={data} refresh={load} local={local}/> : <Expert data={data} refresh={load} active={activeReview} setActive={id => chooseReview(id, staffTab)} onAuth={auth} onDirty={setDirty} filter={queueFilter} setFilter={setQueueFilter} now={now}/>
      : module === PROJECT ? <ProjectView data={data} refresh={load} onAuth={auth} open={move}/> : <>
        <div className="page-heading"><p className="eyebrow">MODULE {String(module).padStart(2,'0')}</p><h1>{modules[module]}</h1><p className="muted">{module === 0 ? 'Get ready for the first shared session.' : 'Build your concept one considered decision at a time.'}</p></div>
        <div className="lesson-summary"><span className="lesson-icon" aria-hidden="true">↗</span><div><strong>{module === 0 ? 'Before we meet' : 'Your next step'}</strong><p>{module === 0 ? (data.materials.some(m => m.module === 0 && m.audience === 'participant' && m.open) ? 'Start with the welcome video below. Then note the theme and audience of the slot you want to build — you can change them later.' : 'Check your course access and the session schedule. Note the theme and audience of the slot you want to build — you can change them later. Welcome materials will appear here when published.') : summary}</p></div><span className="small muted">One shared cohort</span></div>
        {data.sessions.filter(x => x.module === module).map(x => <SessionCard key={x.id} session={x} now={now}/>)}
        <Materials data={data} module={module} refresh={load} onAuth={auth}/>
        {module === 0 && <ProjectHeader data={data} refresh={load} onAuth={auth}/>}
        {inModule.map(a => <Assignment key={a.id} assignment={a} data={data} refresh={load} onAuth={auth} onDirty={setDirty}/>)}
        {module === 7 && <PresentationNotice data={data}/>}
        <Questions data={data} module={module} refresh={load} onAuth={auth}/>
      </>}
      <footer className="footer">Slot Design · From idea to release<span>Course times: CET · Europe/Berlin</span></footer>
    </main></div>{reauth && <ReauthDialog local={local} onSuccess={load}/>}
    {account && <Modal label="Account" close={() => setAccount(false)}><AccountPanel data={data} refresh={load} onAuth={auth}/></Modal>}
    {feedback && <Modal label="Course feedback" close={() => setFeedback(false)}><FeedbackForm data={data} module={module === PROJECT ? null : module} refresh={load} onAuth={auth}/></Modal>}</>;
}

function Assignment({ assignment, data, refresh, onAuth, onDirty }: { assignment: Row; data: Data; refresh: () => Promise<void>; onAuth: () => void; onDirty: (v: boolean) => void }) {
  const work = data.works.find(w => w.assignment_id === assignment.id && w.owner_id === data.me.id);
  const draft = data.drafts.find(d => d.work_id === work?.id);
  const submissions = data.submissions.filter(s => s.work_id === work?.id);
  const spec: AssignmentSpec = work?.spec || assignment.spec; const self = selfAssessment(spec);
  return <section className="work-section"><div className="section-heading"><div><p className="eyebrow">{self ? 'SELF-ASSESSMENT' : 'HOMEWORK'}</p><h2>{spec.title}</h2></div><Badge status={shown(spec, work?.status || 'draft')}/></div>
    <p className="muted small">{assignment.published ? <>Due {date(assignment.due_at)} · {assignment.late_policy === 'allow_mark' ? 'Late submissions are accepted and marked.' : 'Submission closes at the deadline.'}{self && ' · Received by the team, without an expert decision.'}</> : 'Submission is currently unavailable. Your saved work and history are kept.'}</p>
    {work?.status === 'needs_revision' && <Feedback data={data} submissions={submissions}/>}
    {draft ? <Editor canSubmit={assignment.published} key={draft.id} draft={draft} spec={work!.spec} data={data} refresh={refresh} onAuth={onAuth} onDirty={onDirty}/> : (!work || work.status === 'needs_revision') ? assignment.published ? <StartDraft assignment={assignment.id} refresh={refresh} revision={!!work} self={self}/> : null : <div className="confirmation"><h3>{self ? 'Your self-assessment has been received.' : work.status === 'accepted' ? 'Your work has been accepted.' : work.status === 'in_review' ? 'Your expert is reviewing this version.' : 'Your work is with your expert.'}</h3><p>{self ? 'The team can read it. No expert decision is needed.' : 'You can open your submitted version below. Feedback will appear here when published.'}</p>{assignment.published && <StartDraft assignment={assignment.id} refresh={refresh} revision self={self}/>}</div>}
    {work?.status !== 'needs_revision' && <Feedback data={data} submissions={submissions}/>}
    <History data={data} submissions={submissions}/>
  </section>;
}

function StartDraft({ assignment, refresh, revision, self = false }: { assignment: string; refresh: () => Promise<void>; revision: boolean; self?: boolean }) {
  const [busy,setBusy] = useState(false); const [error,setError] = useState('');
  return <div className="start-work"><p>{revision ? 'Start with a copy of your previous submission. The original stays in your history.' : self ? 'Your draft is private. The team sees it only after you submit.' : 'Your draft is private. Your expert sees it only after you submit.'}</p><button disabled={busy} onClick={async () => { setBusy(true); try { await cmd('draft.create',{ assignmentId: assignment }); await refresh(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? 'Opening…' : revision ? 'Start revision' : self ? 'Start self-assessment' : 'Start homework'}</button><ErrorBox error={error}/></div>;
}

function Editor({ canSubmit, draft, spec, data, refresh, onAuth, onDirty }: { canSubmit: boolean; draft: Row; spec: AssignmentSpec; data: Data; refresh: () => Promise<void>; onAuth: () => void; onDirty: (v: boolean) => void }) {
  const [payload,setPayload] = useState<Payload>(draft.payload); const payloadRef = useRef<Payload>(draft.payload); const revision = useRef<number>(draft.revision); const sequence = useRef(0); const saved = useRef(0); const inFlight = useRef<Promise<void> | null>(null); const blocked = useRef(false); const pendingKey = useRef<{ key: string; revision: number } | null>(null);
  const [status,setStatus] = useState('All changes saved'); const [error,setError] = useState(''); const [fields,setFields] = useState<string[]>([]); const [busy,setBusy] = useState(false); const [uploading,setUploading] = useState(false); const [files,setFiles] = useState<Row[]>(data.files); const [recovery,setRecovery] = useState(''); const [tick,setTick] = useState(0);
  const change = (id: string, part: Partial<Payload['parts'][string]>) => { if (busy) return; const next = { parts: { ...payloadRef.current.parts, [id]: { ...empty(), ...payloadRef.current.parts[id], ...part } } }; payloadRef.current = next; setPayload(next); setFields(previous => { try { validateSubmission({ ...spec, parts: spec.parts.filter(p => p.id === id) }, { parts: { [id]: next.parts[id] } }, files.filter(f => next.parts[id].files.includes(f.id) || next.parts[id].images.some(i => i.fileId === f.id)).map(f => ({ id:f.id, mime:f.mime, size:f.size }))); return previous.filter(f => f !== id); } catch { return previous; } }); sequence.current++; onDirty(true); setStatus('Unsaved changes'); setTick(v => v+1); };
  const save = useCallback(async () => {
    if (blocked.current) throw new RequestError('Resolve the saved-version conflict before continuing.', 'conflict');
    if (inFlight.current) await inFlight.current;
    if (sequence.current === saved.current) return;
    const snapshot = payloadRef.current; const sent = sequence.current; setStatus('Saving…');
    const promise = (async () => {
      try { const result = await cmd('draft.save', { draftId: draft.id, expectedRevision: revision.current, payload: snapshot }); revision.current = result.revision; saved.current = sent; onDirty(sequence.current !== sent); setStatus(sequence.current === sent ? 'All changes saved' : 'Unsaved changes'); setError(''); }
      catch(e) { const err = e as RequestError; setStatus('Not saved'); setError(err.message); if (err.code === 'conflict' || err.code === 'already_submitted') blocked.current = true; if (err.code === 'unauthenticated') onAuth(); throw err; }
    })();
    inFlight.current = promise;
    try { await promise; } finally { inFlight.current = null; }
  }, [draft.id,onDirty,onAuth]);
  useEffect(() => { if (sequence.current === saved.current || blocked.current || busy) return; const timer = setTimeout(() => void save().catch(() => {}), 2000); return () => clearTimeout(timer); }, [tick,save,busy]);
  async function upload(id: string, file: File) {
    setUploading(true); setError(''); try { const form = new FormData(); form.set('file',file); const stored = await api('uploads',form); setFiles(old => [...old,stored]); const part = payloadRef.current.parts[id] || empty(); const definition = spec.parts.find(p => p.id === id)!; if (definition.kind === 'images') change(id,{ images: [...part.images,{ fileId: stored.id,prompt:'',caption:'' }] }); else change(id,{ files:[...part.files,stored.id] }); } catch(e) { setError((e as Error).message); } finally { setUploading(false); }
  }
  async function submit() {
    setBusy(true); setError(''); setFields([]);
    try {
      await save(); if (saved.current !== sequence.current) await save();
      const prior = pendingKey.current;
      const request = prior && prior.revision === revision.current ? prior : { key: crypto.randomUUID(), revision: revision.current };
      pendingKey.current = request;
      await cmd('draft.submit',{ draftId: draft.id, expectedRevision: request.revision, key: request.key });
      onDirty(false); await refresh();
    } catch(e) { const err = e as RequestError; setError(err.message); setFields(err.fields || []); if (err.code === 'unauthenticated') onAuth(); if (err.fields?.[0]) requestAnimationFrame(() => document.getElementById(`part-${draft.id}-${err.fields[0]}`)?.focus()); }
    finally { setBusy(false); }
  }
  return <div className="editor"><div className="draft-note"><span className="dot"/><strong>Private draft</strong><span>{selfAssessment(spec) ? 'The team cannot see this yet.' : 'Your expert cannot see this yet.'}</span></div>
    {spec.parts.map((part,index) => { const answer = { ...empty(), ...payload.parts[part.id] }; const pid = `part-${draft.id}-${part.id}`; const chosen = answer.submissions; return <section className={`part ${fields.includes(part.id) ? 'invalid' : ''}`} key={part.id}><div className="part-heading"><span className="part-number">{String(index+1).padStart(2,'0')}</span><div><h3 id={`title-${pid}`}>{part.kind === 'choice' || part.kind === 'versions' ? part.title : <label htmlFor={pid}>{part.title}</label>}</h3><p id={`hint-${pid}`}>{part.hint}</p></div></div>
      {part.kind === 'choice' ? <div id={pid} tabIndex={-1} role="radiogroup" aria-labelledby={`title-${pid}`} aria-describedby={`hint-${pid}`} className="choices">{part.options!.map(option => <label className="choice" key={option}><input type="radio" name={pid} checked={answer.text === option} disabled={busy} onChange={() => change(part.id,{ text:option })}/>{option}</label>)}</div>
      : part.kind === 'versions' ? <div id={pid} tabIndex={-1} role="group" aria-labelledby={`title-${pid}`} aria-describedby={`hint-${pid}`} className="choices">{data.submissions.filter(s => s.owner_id === data.me.id && !s.spec.parts.some((p: { kind?: string }) => p.kind === 'versions')).map(s => <label className="choice" key={s.id}><input type="checkbox" checked={chosen.includes(s.id)} disabled={busy} onChange={e => change(part.id,{ submissions: e.target.checked ? [...chosen,s.id] : chosen.filter(id => id !== s.id) })}/><span>{s.spec.title} · Version {s.number} <span className="muted small">{date(s.submitted_at)}</span></span><Badge status={shown(s.spec, s.status)}/></label>)}{!data.submissions.some(s => s.owner_id === data.me.id && !s.spec.parts.some((p: { kind?: string }) => p.kind === 'versions')) && <p className="muted small">You have no submitted versions yet. Submit your homework first.</p>}</div>
      : part.kind !== 'images' ? <textarea id={pid} aria-describedby={`hint-${pid}`} aria-invalid={fields.includes(part.id)} value={answer.text} onChange={e => change(part.id,{ text:e.target.value })} disabled={busy} rows={6} placeholder="Write here, or attach a document below…"/> : <div id={pid} tabIndex={-1}>{answer.images.map((image,index) => <div className="image-answer" key={image.fileId}><strong>{files.find(f => f.id === image.fileId)?.name || `Image ${index+1}`}</strong><label htmlFor={`prompt-${image.fileId}`}>Final prompt</label><textarea id={`prompt-${image.fileId}`} value={image.prompt} disabled={busy} onChange={e => change(part.id,{ images:answer.images.map((i,n) => n === index ? {...i,prompt:e.target.value} : i) })}/><label htmlFor={`caption-${image.fileId}`}>Explanation</label><textarea id={`caption-${image.fileId}`} value={image.caption} disabled={busy} onChange={e => change(part.id,{ images:answer.images.map((i,n) => n === index ? {...i,caption:e.target.value} : i) })}/><button className="text-button" disabled={busy} onClick={() => change(part.id,{ images:answer.images.filter(i => i.fileId !== image.fileId) })}>Remove image</button></div>)}</div>}
      <ul className="file-list">{answer.files.map(id => <li key={id}><a href={`/api/v1/files/${id}/download`}>{files.find(f => f.id === id)?.name || 'Attachment'}</a><button className="text-button" disabled={busy} onClick={() => change(part.id,{ files:answer.files.filter(f => f!==id) })}>Remove</button></li>)}</ul>
      {part.kind !== 'choice' && part.kind !== 'versions' && <label className="upload-label">{uploading ? 'Uploading…' : part.kind === 'images' ? 'Add image' : 'Attach a file'}<input type="file" accept={part.kind === 'images' ? '.png,.jpg,.jpeg,.webp' : '.pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp'} disabled={busy || uploading} onChange={e => { const file = e.target.files?.[0]; if(file) void upload(part.id,file); e.target.value=''; }}/></label>}
      {fields.includes(part.id) && <p className="field-error">{part.kind === 'images' ? 'Add 3–6 different images, each with a prompt and explanation.' : part.kind === 'choice' ? 'Choose one option.' : part.kind === 'versions' ? 'Choose at least one of your submitted versions.' : 'Add meaningful text or a document for this part.'}</p>}
    </section>; })}
    <p className="muted small">Up to 50 MB per file, 20 files and 200 MB per submission. A page reload restores your last saved draft.</p>
    <ErrorBox error={error}/>{fields.length > 0 && <ul className="error-links">{fields.map(id => <li key={id}><a href={`#part-${draft.id}-${id}`} onClick={() => document.getElementById(`part-${draft.id}-${id}`)?.focus()}>{spec.parts.find(p => p.id === id)?.title || 'Check this part'}</a></li>)}</ul>}{blocked.current && <div className="recovery"><button className="secondary" onClick={() => setRecovery(JSON.stringify(payloadRef.current,null,2))}>Keep a copy of my text</button><button className="secondary" onClick={async () => { setRecovery(JSON.stringify(payloadRef.current,null,2)); const latest: Data = await api('workspace'); const d = latest.drafts.find(d => d.id === draft.id); if (!d) { setError('This draft was submitted in another window. Your text is preserved below.'); return; } payloadRef.current=d.payload;setPayload(d.payload);revision.current=d.revision;sequence.current=0;saved.current=0;blocked.current=false;onDirty(false);setError('');setStatus('Saved version loaded'); }}>Load saved version</button></div>}
    {recovery && <div><label htmlFor="recovery">Your preserved text — copy before leaving this page</label><textarea id="recovery" readOnly rows={8} value={recovery}/></div>}
    <div className="editor-actions"><div className="save-status" role="status"><span className="dot"/>{status}</div><div className="button-row"><button className="secondary" onClick={() => void save().catch(() => {})} disabled={busy || uploading}>Save draft</button><button onClick={submit} disabled={busy || uploading || blocked.current || !canSubmit}>{busy ? 'Submitting…' : !canSubmit ? 'Submission unavailable' : selfAssessment(spec) ? 'Submit self-assessment' : 'Submit for review'}<span aria-hidden="true"> ↗</span></button></div></div>
    <p className="privacy-note">{selfAssessment(spec) ? 'Submitting creates a permanent version that the team can read.' : 'Submitting creates a permanent version. You can start a new version while your expert reviews this one.'}</p>
  </div>;
}

function Feedback({ data, submissions }: { data: Data; submissions: Row[] }) {
  const latest = submissions[0]; const reviews = data.reviews.filter(r => r.submission_id === latest?.id); const current = reviews.find(r => !reviews.some(n => n.replaces_id === r.id));
  return current ? <section className="feedback"><p className="eyebrow">EXPERT FEEDBACK · VERSION {latest.number}</p><div className="section-heading"><h3>{current.action === 'accepted' ? 'Accepted' : 'A few things to revisit'}</h3><span className="small muted">{date(current.created_at)}</span></div>{current.level && <p className="small"><strong>Level:</strong> {levels[current.level]}</p>}<p className="preserve">{current.body}</p>{current.reason && <p className="small">Correction: {current.reason}</p>}</section> : null;
}
function SubmissionContent({ submission, data }: { submission: Row; data: Data }) {
  const payload = submission.payload as Payload; const spec = submission.spec as AssignmentSpec; const files = data.files; const project = submission.project_snapshot;
  return <div className="submitted-content">{project && (project.theme || project.audience) && <p className="small muted">Project at submission: {project.theme || '—'} · {project.audience || '—'}</p>}{spec.parts.map(part => { const answer = { ...empty(), ...payload.parts[part.id] }; return <section key={part.id}><h4>{part.title}</h4><p className="preserve">{answer.text}</p>{answer.submissions.map(id => { const item = data.submissions.find(s => s.id === id); return <details className="package-item" key={id}><summary>{item ? `${item.spec.title} · Version ${item.number}` : 'Selected version'}</summary>{item ? <SubmissionContent submission={item} data={data}/> : <p className="muted small">This version is not available to you.</p>}</details>; })}{answer.files.map(id => <p key={id}><a href={`/api/v1/files/${id}/download`}>{files.find(f => f.id === id)?.name || 'Download attachment'}</a></p>)}{answer.images.map(image => <div key={image.fileId}><a href={`/api/v1/files/${image.fileId}/download`}>{files.find(f => f.id === image.fileId)?.name || 'Download image'}</a><p className="preserve"><strong>Prompt:</strong> {image.prompt}</p><p className="preserve"><strong>Explanation:</strong> {image.caption}</p></div>)}</section>; })}</div>;
}
function History({ data, submissions, onReview }: { data: Data; submissions: Row[]; onReview?: (id: string) => void }) {
  const lastReviewed = submissions.find(s => data.reviews.some(r => r.submission_id === s.id));
  return submissions.length ? <section className="history"><h3>Submission history</h3>{lastReviewed && <p className="small">Latest reviewed version: {lastReviewed.number} · <Badge status={lastReviewed.status}/></p>}<p className="muted small">Every submitted version stays available.</p>{submissions.map(s => <details key={s.id}><summary>Version {s.number}<span>{date(s.submitted_at)}{s.late ? ' · Late' : ''}</span></summary><p className="history-status"><Badge status={shown(s.spec, s.status)}/>{s.id !== submissions[0].id ? ' Replaced by a newer version' : ' Latest submission'}</p>{onReview && <button className="secondary history-open" onClick={() => onReview(s.id)}>Review version {s.number}</button>}<SubmissionContent submission={s} data={data}/>{data.reviews.filter(r => r.submission_id === s.id).map(r => <div className="history-review" key={r.id}><strong>{statuses[r.action]}</strong> · {date(r.created_at)} <span>{data.reviews.some(n => n.replaces_id === r.id) ? '(replaced)' : '(current)'}</span>{r.level && <span> · Level: {levels[r.level]}</span>}<p className="preserve">{r.body}</p>{r.reason && <p>Reason for correction: {r.reason}</p>}</div>)}</details>)}</section> : null;
}

function Expert({ data, refresh, active, setActive, onAuth, onDirty, filter, setFilter, now }: { data: Data; refresh: () => Promise<void>; active: string; setActive: (id: string) => void; onAuth: () => void; onDirty: (v: boolean) => void; filter: QueueFilter; setFilter: (f: QueueFilter) => void; now: number }) {
  const selected = data.submissions.find(s => s.id === active);
  const work = data.works.find(w => w.id === selected?.work_id);
  const name = (id: string) => data.people.find(p => p.id === id)?.name || 'Participant';
  const assignmentOf = (w: Row) => data.assignments.find(a => a.id === w.assignment_id);
  const latestOf = (w: Row) => data.submissions.find(s => s.work_id === w.id);
  const row = (w: Row) => { const submission = latestOf(w); if (!submission) return null; const due = selfAssessment(w.spec) ? null : reviewDue(assignmentOf(w), now); return <button className="queue-row" key={w.id} onClick={() => setActive(submission.id)}><span className="avatar">{name(w.owner_id).slice(0,1)}</span><span className="queue-person"><strong>{name(w.owner_id)}</strong><small>{w.spec.title} · Version {submission.number} · {date(submission.submitted_at)}{submission.late ? ' · Late' : ''}</small>{due && ['submitted','in_review'].includes(w.status) && <small className={due.overdue ? 'overdue' : ''}>{due.text}</small>}</span><Badge status={shown(w.spec, w.status)}/><span aria-hidden="true">→</span></button>; };
  // Очередь: работы назначенных заданий; по умолчанию — последние версии без решения, сначала более ранняя отправка.
  const mine = data.works.filter(w => !selfAssessment(w.spec) && latestOf(w) && canReview(data, w.assignment_id));
  const matches = (w: Row) => (!filter.assignment || w.assignment_id === filter.assignment) && (filter.status === 'all' || (filter.status === 'waiting' ? ['submitted','in_review'].includes(w.status) : w.status === filter.status)) && (!filter.overdue || (['submitted','in_review'].includes(w.status) && !!reviewDue(assignmentOf(w), now)?.overdue));
  const queue = mine.filter(matches).sort((a, b) => new Date(latestOf(a)!.submitted_at).getTime() - new Date(latestOf(b)!.submitted_at).getTime() || String(latestOf(a)!.id).localeCompare(latestOf(b)!.id));
  const received = data.works.filter(w => selfAssessment(w.spec) && latestOf(w));
  const filtered = filter.assignment !== '' || filter.status !== 'waiting' || filter.overdue;
  const assignments = data.assignments.filter(a => canReview(data, a.id) && !selfAssessment(a.spec));
  if (selected && work) return <><div className="page-heading"><p className="eyebrow">{data.me.role === 'admin' ? 'TEAM WORKSPACE' : 'EXPERT WORKSPACE'}</p><h1>{selfAssessment(selected.spec) ? 'Self-assessment' : canReview(data, work.assignment_id) ? 'Review the work' : 'Submitted work'}</h1></div><button className="text-button" onClick={() => setActive('')}>← Back</button><section className="review-panel"><div className="section-heading"><div><h2>{name(selected.owner_id)}</h2><p>{selected.spec.title} · Version {selected.number}</p></div><Badge status={shown(selected.spec, selected.status)}/></div><SubmissionContent submission={selected} data={data}/>{selfAssessment(selected.spec) ? <p className="muted">Self-assessment received. No expert decision is needed; you can discuss it in the session.</p> : canReview(data, work.assignment_id) ? <ReviewEditor key={selected.id} submission={selected} work={{...work,status:selected.status}} data={data} refresh={refresh} onAuth={onAuth} onDirty={onDirty}/> : <p className="muted">Only the responsible expert for this assignment publishes decisions.</p>}</section><History data={data} submissions={data.submissions.filter(s => s.work_id===work.id)} onReview={setActive}/></>;
  return <><div className="page-heading"><p className="eyebrow">EXPERT WORKSPACE</p><h1>Review queue</h1><p className="muted">Submitted work for the assignments you are responsible for. Opening a work does not change its status.</p></div>
    <form className="filters" onSubmit={e => e.preventDefault()}><div><label htmlFor="q-assignment">Assignment</label><select id="q-assignment" value={filter.assignment} onChange={e => setFilter({ ...filter, assignment: e.target.value })}><option value="">All assignments</option>{assignments.map(a => <option key={a.id} value={a.id}>{a.spec.title}</option>)}</select></div>
      <div><label htmlFor="q-status">Status</label><select id="q-status" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}><option value="waiting">Waiting for a decision</option><option value="submitted">Submitted</option><option value="in_review">In review</option><option value="needs_revision">Needs revision</option><option value="accepted">Accepted</option><option value="all">All statuses</option></select></div>
      <label className="choice"><input type="checkbox" checked={filter.overdue} onChange={e => setFilter({ ...filter, overdue: e.target.checked })}/>Review overdue only</label>
      {filtered && <button type="button" className="text-button" onClick={() => setFilter({ assignment: '', status: 'waiting', overdue: false })}>Reset filters</button>}</form>
    <p className="small muted" role="status">{queue.length} {queue.length === 1 ? 'work' : 'works'}</p>
    <div className="queue">{queue.length ? queue.map(row) : filtered ? <div className="empty"><h2>No works match these filters.</h2><button className="secondary" onClick={() => setFilter({ assignment: '', status: 'waiting', overdue: false })}>Reset filters</button></div> : <div className="empty"><h2>You’re all caught up.</h2><p>New submissions will appear here.</p></div>}</div>
    {received.length > 0 && <section className="received"><h2>Self-assessments received</h2><p className="muted small">Read-only. No decision is needed.</p><div className="queue">{received.map(row)}</div></section>}</>;
}

function ReviewEditor({ submission, work, data, refresh, onAuth, onDirty }: { submission: Row; work: Row; data: Data; refresh: () => Promise<void>; onAuth: () => void; onDirty: (v: boolean) => void }) {
  const reviews = data.reviews.filter(r => r.submission_id===submission.id); const current = reviews.find(r => !reviews.some(n => n.replaces_id===r.id)); const initial = data.reviewDrafts.find(r => r.submission_id===submission.id);
  const usableDraft = (initial?.base_review_id || undefined) === current?.id ? initial : undefined;
  const [body,setBody] = useState(usableDraft?.body ?? current?.body ?? ''); const [action,setAction] = useState(usableDraft?.action ?? current?.action ?? 'needs_revision'); const [reason,setReason] = useState(usableDraft?.reason ?? ''); const [level,setLevel] = useState<string>(usableDraft?.level ?? current?.level ?? ''); const [baseReviewId,setBaseReviewId] = useState<string | undefined>(current?.id); const [revision,setRevision] = useState(initial?.revision || 0); const [error,setError] = useState(''); const [status,setStatus] = useState(''); const [busy,setBusy] = useState(false); const request = useRef<{ fingerprint: string; key: string } | null>(null);
  async function run(kind: string) { setBusy(true);setError('');setStatus('');try {
    if (kind === 'claim') await cmd('submission.claim',{submissionId:submission.id});
    else if (kind === 'save') { const r = await cmd('review.save',{submissionId:submission.id,expectedRevision:revision,body,action,level:level || null,reason,...(baseReviewId ? {replacesId:baseReviewId} : {})});setRevision(r.revision);setStatus('Private feedback draft saved');onDirty(false); }
    else { const input = {submissionId:submission.id,expectedRevision:revision,body,action,level:level || null,...(baseReviewId ? { replacesId:baseReviewId,reason } : {})}; const fingerprint=JSON.stringify(input);if(request.current?.fingerprint!==fingerprint) request.current={fingerprint,key:crypto.randomUUID()};const published = await cmd('review.publish',{...input,key:request.current.key});setRevision(published.feedback_draft_revision);setBaseReviewId(published.id);setReason('');request.current=null;onDirty(false);setStatus('Decision published'); }
    await refresh();
  } catch(e) { setError((e as Error).message); if((e as RequestError).code==='unauthenticated') onAuth(); if((e as RequestError).fields?.includes('reason')) requestAnimationFrame(() => document.getElementById('correction-reason')?.focus()); } finally { setBusy(false); } }
  return <section className="review-editor"><div className="section-heading"><h3>{current ? 'Correct published feedback' : 'Expert feedback'}</h3>{work.status==='submitted' && <button className="secondary" disabled={busy} onClick={() => run('claim')}>Take for review</button>}</div><p className="muted small">{current ? 'A correction keeps the previous decision in the history.' : 'Your feedback draft is private until you publish a decision.'}</p><label htmlFor="feedback-body">Feedback</label><textarea id="feedback-body" value={body} onChange={e => {setBody(e.target.value);onDirty(true);}} disabled={busy} rows={6}/><label htmlFor="decision">Outcome</label><select id="decision" value={action} onChange={e => {setAction(e.target.value);onDirty(true);}} disabled={busy}><option value="needs_revision">Needs revision</option><option value="accepted">Accepted</option></select><label htmlFor="review-level">Level (optional)</label><select id="review-level" value={level} onChange={e => {setLevel(e.target.value);onDirty(true);}} disabled={busy}><option value="">Not set</option><option value="weak">Weak</option><option value="medium">Medium</option><option value="strong">Strong</option></select><p className="muted small">The level describes the result using the module rubric. It is not a score and does not replace the outcome.</p>{current && <><label htmlFor="correction-reason">Reason for correction</label><textarea id="correction-reason" value={reason} onChange={e => {setReason(e.target.value);onDirty(true);}} disabled={busy}/></>}<ErrorBox error={error}/><div className="editor-actions"><span role="status">{status}</span><div className="button-row"><button className="secondary" disabled={busy} onClick={() => run('save')}>Save feedback draft</button><button disabled={busy} onClick={() => run('publish')}>{busy ? 'Working…' : current ? 'Publish correction' : 'Publish decision'}</button></div></div></section>;
}

function Admin({ data, refresh, local }: { data: Data; refresh: () => Promise<void>; local: boolean }) {
  const [name,setName] = useState('');const [email,setEmail] = useState('');const [end,setEnd] = useState('');const [error,setError] = useState('');const [message,setMessage] = useState(''); const [busy,setBusy] = useState(false);
  return <><div className="page-heading"><p className="eyebrow">ADMINISTRATION</p><h1>People & course access</h1><p className="muted">One shared cohort. Participants keep their drafts private.</p></div><section className="admin-card"><h2>Invite a participant</h2><form onSubmit={async e => {e.preventDefault();setBusy(true);setError('');try {const inferred = email.split('@')[0].replace(/[._+-]+/g,' ').trim().replace(/\b\p{L}/gu, c => c.toUpperCase());await cmd('enrollment.invite',{id:crypto.randomUUID(),name:name.trim() || inferred || 'Student',email,accessEndsAt:new Date(`${end}T23:59:59+01:00`).toISOString()});setMessage(`Access prepared for ${email}. Welcome email queued; check delivery in Email.`);await refresh();}catch(err){setError((err as Error).message);}finally{setBusy(false);}}}><label htmlFor="invite-name">Name (optional)</label><input id="invite-name" value={name} onChange={e => setName(e.target.value)} placeholder="Inferred from email if blank"/><label htmlFor="invite-email">Email</label><input id="invite-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required/><label htmlFor="access-end">Access ends on (CET)</label><input id="access-end" type="date" value={end} onChange={e => setEnd(e.target.value)} required/><p className="small muted">{local ? 'Use an @example.test address for this local build.' : 'The participant receives one welcome email with a personal sign-in link.'}</p><button disabled={busy}>{busy ? 'Preparing…' : 'Prepare course access'}</button><ErrorBox error={error}/>{message && <p role="status">{message}</p>}</form></section><section className="people"><h2>Course members</h2>{data.people.map(p => <div className="person-row" key={p.id}><div><strong>{p.name}</strong><small>{p.email}</small></div><span>{p.revoked_at ? 'Access revoked' : p.activated_at ? p.role : 'Invited'}</span>{p.role==='participant' && <button className="secondary" onClick={async () => {if(!p.revoked_at && !confirm(`Revoke course access for ${p.name}? They will no longer be able to open their work or files.`))return;try{await cmd(p.revoked_at ? 'enrollment.restore' : 'enrollment.revoke',{id:p.id});await refresh();}catch(e){setError((e as Error).message);}}}>{p.revoked_at ? 'Restore access' : 'Revoke access'}</button>}</div>)}</section></>;
}

function ProjectHeader({ data, refresh, onAuth }: { data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const [theme,setTheme] = useState(data.project?.theme || ''); const [audience,setAudience] = useState(data.project?.audience || ''); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [status,setStatus] = useState('');
  return <section className="admin-card project-header"><p className="eyebrow">YOUR PROJECT</p><h2>Theme & audience</h2><p className="muted small">A working hypothesis is fine. Each submission keeps a copy of what is written here, so later changes do not rewrite your history.</p>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); setStatus(''); try { await cmd('project.save',{ expectedRevision: data.project?.revision || 0, theme, audience }); setStatus('Saved'); await refresh(); } catch(err) { setError((err as Error).message); if ((err as RequestError).code === 'unauthenticated') onAuth(); } finally { setBusy(false); } }}>
      <label htmlFor="project-theme">Slot theme</label><input id="project-theme" value={theme} onChange={e => { setTheme(e.target.value); setStatus(''); }} placeholder="For example: deep-sea treasure hunt"/>
      <label htmlFor="project-audience">Target audience</label><input id="project-audience" value={audience} onChange={e => { setAudience(e.target.value); setStatus(''); }} placeholder="Who is this slot for?"/>
      <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button> <span role="status" className="small">{status}</span><ErrorBox error={error}/>
    </form></section>;
}

// LMS-09: слои концепта по заданиям — последняя отправленная версия и последний экспертный результат.
function ProjectView({ data, refresh, onAuth, open }: { data: Data; refresh: () => Promise<void>; onAuth: () => void; open: (module: number) => void }) {
  const layers = data.assignments.filter(a => !selfAssessment(a.spec));
  return <><div className="page-heading"><p className="eyebrow">MY PROJECT</p><h1>{data.project?.theme || 'Your slot concept'}</h1><p className="muted">Every layer of your concept, with the latest version you submitted and the latest expert result.</p></div>
    <ProjectHeader data={data} refresh={refresh} onAuth={onAuth}/>
    <section className="layers"><h2>Concept layers</h2>{layers.map(a => { const work = data.works.find(w => w.assignment_id === a.id && w.owner_id === data.me.id); const subs = data.submissions.filter(s => s.work_id === work?.id); const latest = subs[0]; const reviewed = subs.find(s => data.reviews.some(r => r.submission_id === s.id));
      return <div className="layer-row" key={a.id}><div><strong>{(work?.spec || a.spec).title}</strong><small>{latest ? `Latest version ${latest.number} · ${date(latest.submitted_at)}` : work ? 'Draft in progress, not submitted yet' : 'Not started yet'}</small>{a.module === 1 && <small>Part A, the existing game analysis, is a learning exercise and stays separate from your own concept.</small>}</div><span>{reviewed ? <>Version {reviewed.number}: <Badge status={reviewed.status}/></> : latest ? <span className="small muted">No feedback yet</span> : null}</span><button className="secondary" onClick={() => open(a.module)}>Open module {a.module}</button></div>; })}</section>
    <Questions data={data} module={null} refresh={refresh} onAuth={onAuth}/></>;
}

// LMS-13: вопрос видит только автор и команда; общего чата и списка участников нет.
function Questions({ data, module, refresh, onAuth }: { data: Data; module: number | null; refresh: () => Promise<void>; onAuth: () => void }) {
  const [body,setBody] = useState(''); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const key = useRef<string>('');
  const own = data.questions.filter(q => q.owner_id === data.me.id && q.module === module);
  return <section className="questions"><h2>Questions for the team</h2><p className="muted small">{module === null ? 'Ask about the course or your project.' : 'Ask about this module.'} Only you and the course team can see your questions.</p>
    {own.map(q => <Question key={q.id} question={q} data={data}/>)}
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); key.current ||= crypto.randomUUID(); try { await cmd('question.ask',{ module, body, key: key.current }); setBody(''); key.current = ''; await refresh(); } catch(err) { setError((err as Error).message); if ((err as RequestError).code === 'unauthenticated') onAuth(); } finally { setBusy(false); } }}>
      <label htmlFor={`question-${module ?? 'course'}`}>Your question</label><textarea id={`question-${module ?? 'course'}`} required value={body} onChange={e => { setBody(e.target.value); key.current = ''; }} rows={3} disabled={busy}/>
      <button disabled={busy}>{busy ? 'Sending…' : 'Send question'}</button><ErrorBox error={error}/>
    </form></section>;
}
function Question({ question, data, children }: { question: Row; data: Data; children?: React.ReactNode }) {
  const answers = data.answers.filter(a => a.question_id === question.id);
  return <article className="question"><p className="small muted">{date(question.created_at)}</p><p className="preserve">{question.body}</p>
    {answers.map(a => <div className="answer" key={a.id}><strong>{data.people.find(p => p.id === a.author_id && data.me.role !== 'participant')?.name || 'Course team'}</strong>{a.source && <span className="small muted"> · Answer from {a.source}</span>}<span className="small muted"> · {date(a.created_at)}</span><p className="preserve">{a.body}</p></div>)}
    {!answers.length && <p className="small muted">Waiting for an answer.</p>}{children}</article>;
}
function TeamQuestions({ data, refresh, onAuth }: { data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const waiting = data.questions.filter(q => !data.answers.some(a => a.question_id === q.id)); const answered = data.questions.filter(q => !waiting.includes(q));
  const card = (q: Row) => <div key={q.id}><p className="eyebrow">{data.people.find(p => p.id === q.owner_id)?.name || 'Participant'} · {q.module === null ? 'Course & project' : `Module ${q.module} · ${modules[q.module]}`}</p><Question question={q} data={data}><AnswerForm question={q} refresh={refresh} onAuth={onAuth}/></Question></div>;
  return <><div className="page-heading"><p className="eyebrow">TEAM WORKSPACE</p><h1>Questions</h1><p className="muted">Private questions from participants in your area. Answers are visible only to the participant who asked.</p></div>
    {data.questions.length ? <><h2>Waiting for an answer ({waiting.length})</h2>{waiting.length ? waiting.map(card) : <p className="muted">Nothing is waiting.</p>}{answered.length > 0 && <><h2>Answered</h2>{answered.map(card)}</>}</> : <div className="empty"><h2>No questions yet.</h2><p>Questions from participants will appear here.</p></div>}</>;
}
function AnswerForm({ question, refresh, onAuth }: { question: Row; refresh: () => Promise<void>; onAuth: () => void }) {
  const [body,setBody] = useState(''); const [source,setSource] = useState(''); const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const key = useRef('');
  return <form className="answer-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); key.current ||= crypto.randomUUID(); try { await cmd('question.answer',{ questionId: question.id, body, source, key: key.current }); setBody(''); setSource(''); key.current = ''; await refresh(); } catch(err) { setError((err as Error).message); if ((err as RequestError).code === 'unauthenticated') onAuth(); } finally { setBusy(false); } }}>
    <label htmlFor={`answer-${question.id}`}>Answer</label><textarea id={`answer-${question.id}`} required value={body} onChange={e => { setBody(e.target.value); key.current = ''; }} rows={3} disabled={busy}/>
    <label htmlFor={`source-${question.id}`}>Answer from (optional)</label><input id={`source-${question.id}`} value={source} onChange={e => { setSource(e.target.value); key.current = ''; }} placeholder="For example: Ricardo Viana" disabled={busy}/>
    <button disabled={busy}>{busy ? 'Sending…' : 'Send answer'}</button><ErrorBox error={error}/>
  </form>;
}

function SessionCard({ session, now }: { session: Row; now: number }) {
  const state = sessionState(session, now);
  return <section className="session-card"><div className="section-heading"><div><p className="eyebrow">LIVE SESSION</p><h2>{session.title}</h2></div><span className={`badge ${state === 'started' ? 'submitted' : state === 'finished' ? '' : 'accepted'}`}>{state === 'upcoming' ? 'Upcoming' : state === 'started' ? 'Started' : 'Finished'}</span></div>
    <p><strong>{date(session.starts_at)}</strong>{session.ends_at && <> – {date(session.ends_at)}</>} <span className="muted small">· {localTime(session.starts_at)} on your device</span></p>
    {!session.ends_at && <p className="muted small">End time not set.</p>}
    <div className="button-row">{session.join_url && state !== 'finished' && <a className="button-link" href={session.join_url} target="_blank" rel="noopener noreferrer">Join the session ↗</a>}{session.recording_url && <a className="button-link secondary" href={session.recording_url} target="_blank" rel="noopener noreferrer">Watch the recording ↗</a>}</div>
    {!session.join_url && state !== 'finished' && <p className="muted small">The joining link will appear here before the session.</p>}
    {!session.recording_url && state === 'finished' && <p className="muted small">If this session has a recorded lecture, it will appear here when published.</p>}
  </section>;
}

function LessonVideo({ fileId, captionId, title, studied }: { fileId: string; captionId?: string; title: string; studied: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const covered = studied && !replaying;
  useEffect(() => { if (studied) { video.current?.pause(); setReplaying(false); } }, [studied]);
  useEffect(() => { if (video.current?.textTracks[0]) video.current.textTracks[0].mode = captionsOn ? 'showing' : 'disabled'; }, [captionsOn, captionId]);
  return <div className="lesson-player">
    <div className={`lesson-video-wrap ${covered ? 'is-studied' : ''}`}>
      <video ref={video} className="lesson-video" controls={!covered} playsInline preload="metadata" aria-label={title} aria-hidden={covered} tabIndex={covered ? -1 : undefined} src={`/api/v1/files/${fileId}/play`}>
        {captionId && <track kind="captions" src={`/api/v1/files/${captionId}/captions`} srcLang="en" label="English"/>}
        Your browser cannot play this video. <a href={`/api/v1/files/${fileId}/download`}>Download it here</a>.
      </video>
      {covered && <div className="lesson-watched-cover"><span>Studied</span><button type="button" onClick={() => setReplaying(true)}>Watch again</button></div>}
    </div>
    {captionId && !covered && <button type="button" className="secondary captions-toggle" aria-pressed={captionsOn} onClick={() => setCaptionsOn(on => !on)}>{captionsOn ? 'Turn off English subtitles' : 'Turn on English subtitles'}</button>}
  </div>;
}

function MaterialBody({ material, data, studied = false }: { material: Row; data: Data; studied?: boolean }) {
  const files = data.materialFiles.filter(f => f.material_id === material.id);
  const videos = files.filter(f => data.files.find(x => x.id === f.file_id)?.mime === 'video/mp4');
  const captions = files.find(f => data.files.find(x => x.id === f.file_id)?.mime === 'text/vtt');
  const attachments = files.filter(f => !videos.includes(f) && f !== captions);
  return <>{material.body && <p className="preserve">{material.body}</p>}
    {videos.map(f => <LessonVideo key={f.file_id} fileId={f.file_id} captionId={captions?.file_id} title={material.title} studied={studied}/>)}
    {(material.links?.length > 0 || attachments.length > 0) && <ul className="material-links">{material.links?.map((l: { label: string; url: string }) => <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label} ↗</a></li>)}{attachments.map(f => <li key={f.file_id}><a href={`/api/v1/files/${f.file_id}/download`}>{data.files.find(x => x.id === f.file_id)?.name || 'Download file'}</a></li>)}</ul>}</>;
}

// LMS-02/LMS-10: закрытый материал показывает только название и время открытия; отметка «изучено» не связана с ДЗ.
function Materials({ data, module, refresh, onAuth }: { data: Data; module: number; refresh: () => Promise<void>; onAuth: () => void }) {
  const [busy,setBusy] = useState(''); const [error,setError] = useState('');
  const list = data.materials.filter(m => m.module === module && m.audience === 'participant');
  const open = list.filter(m => m.open); const studied = open.filter(m => data.progress.some(p => p.material_id === m.id && p.owner_id === data.me.id));
  if (!list.length) return <section className="materials"><h2>Materials</h2><p className="muted">Materials for this module will appear here when published.</p></section>;
  return <section className="materials"><div className="section-heading"><h2>Materials</h2>{open.length > 0 && <span className="small muted" role="status">{studied.length} of {open.length} studied</span>}</div><ErrorBox error={error}/>
    {list.map(m => { const done = studied.includes(m); return <article className={`material ${m.open ? '' : 'locked'}`} key={m.id}><div className="section-heading"><h3>{m.title}</h3>{m.open && <label className="studied"><input type="checkbox" checked={done} disabled={busy === m.id} onChange={async e => { setBusy(m.id); setError(''); try { await cmd('material.progress',{ materialId: m.id, studied: e.target.checked }); await refresh(); } catch(err) { setError((err as Error).message); if ((err as RequestError).code === 'unauthenticated') onAuth(); } finally { setBusy(''); } }}/>Studied</label>}</div>
      {m.open ? <MaterialBody material={m} data={data} studied={done}/> : <p className="muted small">Opens {date(m.opens_at)}.</p>}</article>; })}
  </section>;
}

function TeamMaterials({ data }: { data: Data }) {
  return <><div className="page-heading"><p className="eyebrow">TEAM WORKSPACE</p><h1>Materials</h1><p className="muted">Published course materials, including notes for the team. Participants do not see team notes.</p></div>
    {modules.map((name, module) => { const list = data.materials.filter(m => m.module === module); return list.length ? <section className="materials" key={name}><h2>Module {module} · {name}</h2>{list.map(m => <article className="material" key={m.id}><div className="section-heading"><h3>{m.title}</h3><span className="badge">{m.audience === 'team' ? 'Team only' : 'Participants'}</span></div>{m.open ? <MaterialBody material={m} data={data}/> : <p className="muted small">Opens {date(m.opens_at)}.</p>}</article>)}</section> : null; })}
    {!data.materials.length && <div className="empty"><h2>No materials yet.</h2></div>}</>;
}

function ContentAdmin({ data, refresh, onAuth, onDirty }: { data: Data; refresh: () => Promise<void>; onAuth: () => void; onDirty: (v: boolean) => void }) {
  const [module,setModule] = useState(1); const [fresh,setFresh] = useState(0);
  const session = data.sessions.find(x => x.module === module);
  return <><div className="page-heading"><p className="eyebrow">ADMINISTRATION</p><h1>Course content</h1><p className="muted">Sessions, assignment dates and materials. Times are course time, CET (UTC+1).</p></div>
    <label htmlFor="content-module">Module</label><select id="content-module" value={module} onChange={e => setModule(Number(e.target.value))}>{modules.map((name, index) => <option key={name} value={index}>{index} · {name}</option>)}</select>
    <section className="admin-card"><h2>Live session</h2><SessionEditor key={`${module}-${session?.id}`} session={session} module={module} data={data} refresh={refresh} onAuth={onAuth} onDirty={onDirty}/></section>
    <section className="admin-card"><h2>Assignments</h2>{data.assignments.filter(a => a.module === module).map(a => <ScheduleEditor key={a.id} assignment={a} refresh={refresh} onAuth={onAuth}/>)}{!data.assignments.some(a => a.module === module) && <p className="muted">No assignments in this module.</p>}</section>
    <section className="admin-card"><h2>Materials</h2>{data.materials.filter(m => m.module === module).map(m => <MaterialEditor key={m.id} material={m} module={module} data={data} refresh={refresh} onAuth={onAuth} onDirty={onDirty}/>)}
      <details className="new-material" key={`new-${module}-${fresh}`}><summary>Add a material</summary><MaterialEditor module={module} data={data} refresh={async () => { await refresh(); setFresh(v => v + 1); }} onAuth={onAuth} onDirty={onDirty}/></details></section></>;
}

function useSave(refresh: () => Promise<void>, onAuth: () => void) {
  const [busy,setBusy] = useState(false); const [error,setError] = useState(''); const [fields,setFields] = useState<string[]>([]); const [status,setStatus] = useState('');
  async function run(action: string, input: unknown, done = 'Saved') { setBusy(true); setError(''); setFields([]); setStatus(''); try { await cmd(action, input); setStatus(done); await refresh(); return true; } catch(e) { const err = e as RequestError; setError(err.message); setFields(err.fields || []); if (err.code === 'unauthenticated') onAuth(); return false; } finally { setBusy(false); } }
  return { busy, error, fields, status, run };
}

function SessionEditor({ session, module, data, refresh, onAuth, onDirty }: { session?: Row; module: number; data: Data; refresh: () => Promise<void>; onAuth: () => void; onDirty: (v: boolean) => void }) {
  const id = useRef(session?.id || crypto.randomUUID());
  const [title,setTitle] = useState(session?.title || `Live session · Module ${module}`); const [starts,setStarts] = useState(toInput(session?.starts_at)); const [ends,setEnds] = useState(toInput(session?.ends_at)); const [join,setJoin] = useState(session?.join_url || ''); const [recording,setRecording] = useState(session?.recording_url || ''); const [published,setPublished] = useState(!!session?.recording_published);
  const save = useSave(refresh, onAuth); const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); onDirty(true); };
  const related = data.assignments.filter(a => a.module === module);
  return <form onSubmit={async e => { e.preventDefault(); if (await save.run('session.save', { id: id.current, expectedRevision: session?.revision || 0, module, title, startsAt: fromInput(starts), endsAt: fromInput(ends), joinUrl: join, recordingUrl: recording, recordingPublished: published })) onDirty(false); }}>
    <label htmlFor={`s-title-${module}`}>Title</label><input id={`s-title-${module}`} value={title} onChange={e => edit(setTitle)(e.target.value)} required/>
    <div className="field-row"><div><label htmlFor={`s-start-${module}`}>Starts (CET)</label><input id={`s-start-${module}`} type="datetime-local" value={starts} onChange={e => edit(setStarts)(e.target.value)} required/></div><div><label htmlFor={`s-end-${module}`}>Ends (CET, optional)</label><input id={`s-end-${module}`} type="datetime-local" value={ends} onChange={e => edit(setEnds)(e.target.value)} aria-invalid={save.fields.includes('endsAt')}/></div></div>
    <label htmlFor={`s-join-${module}`}>Joining link</label><input id={`s-join-${module}`} type="url" value={join} onChange={e => edit(setJoin)(e.target.value)} placeholder="https://"/>
    <label htmlFor={`s-rec-${module}`}>Recording link</label><input id={`s-rec-${module}`} type="url" value={recording} onChange={e => edit(setRecording)(e.target.value)} placeholder="https://" aria-invalid={save.fields.includes('recordingUrl')}/>
    <p className="muted small">Use a protected video host with subtitles. A public link does not meet the course requirement; the host is not chosen yet.</p>
    <label className="choice"><input type="checkbox" checked={published} onChange={e => edit(setPublished)(e.target.checked)}/>Show the recording to participants</label>
    {session && related.length > 0 && <p className="small">Moving the session does not change deadlines. Check them below: {related.map(a => `${a.spec.title.split(' ')[0]} due ${a.due_at ? date(a.due_at) : 'not set'}`).join('; ')}.</p>}
    <button disabled={save.busy}>{save.busy ? 'Saving…' : session ? 'Save session' : 'Create session'}</button> <span role="status" className="small">{save.status}</span><ErrorBox error={save.error}/>
  </form>;
}

function ScheduleEditor({ assignment, refresh, onAuth }: { assignment: Row; refresh: () => Promise<void>; onAuth: () => void }) {
  const [published,setPublished] = useState(!!assignment.published); const [opens,setOpens] = useState(toInput(assignment.opens_at)); const [due,setDue] = useState(toInput(assignment.due_at)); const [policy,setPolicy] = useState(assignment.late_policy || 'allow_mark'); const [reviewDue,setReviewDue] = useState(toInput(assignment.review_due_at));
  const save = useSave(refresh, onAuth); const key = assignment.id;
  return <form className="schedule" onSubmit={async e => { e.preventDefault(); await save.run('assignment.schedule', { assignmentId: assignment.id, published, opensAt: fromInput(opens), dueAt: fromInput(due), reviewDueAt: fromInput(reviewDue), latePolicy: policy }); }}>
    <h3>{assignment.spec.title}</h3>
    <label className="choice"><input type="checkbox" checked={published} onChange={e => setPublished(e.target.checked)}/>Published — participants can submit</label>
    <div className="field-row"><div><label htmlFor={`a-open-${key}`}>Opens (CET, optional)</label><input id={`a-open-${key}`} type="datetime-local" value={opens} onChange={e => setOpens(e.target.value)}/></div><div><label htmlFor={`a-due-${key}`}>Due (CET)</label><input id={`a-due-${key}`} type="datetime-local" value={due} onChange={e => setDue(e.target.value)} aria-invalid={save.fields.includes('dueAt')}/></div></div>
    <label htmlFor={`a-review-${key}`}>Review due (CET, optional)</label><input id={`a-review-${key}`} type="datetime-local" value={reviewDue} onChange={e => setReviewDue(e.target.value)} aria-invalid={save.fields.includes('reviewDueAt')}/>
    <label htmlFor={`a-policy-${key}`}>After the deadline</label><select id={`a-policy-${key}`} value={policy} onChange={e => setPolicy(e.target.value)}><option value="allow_mark">Accept and mark as late</option><option value="block_after_due">Close submission</option></select>
    <button className="secondary" disabled={save.busy}>{save.busy ? 'Saving…' : 'Save dates'}</button> <span role="status" className="small">{save.status}</span><ErrorBox error={save.error}/>
  </form>;
}

function MaterialEditor({ material, module, data, refresh, onAuth, onDirty }: { material?: Row; module: number; data: Data; refresh: () => Promise<void>; onAuth: () => void; onDirty: (v: boolean) => void }) {
  const id = useRef(material?.id || crypto.randomUUID()); const key = id.current;
  const [title,setTitle] = useState(material?.title || ''); const [body,setBody] = useState(material?.body || ''); const [links,setLinks] = useState<string>((material?.links || []).map((l: { label: string; url: string }) => `${l.label} | ${l.url}`).join('\n'));
  const [audience,setAudience] = useState(material?.audience || 'participant'); const [published,setPublished] = useState(!!material?.published); const [opens,setOpens] = useState(toInput(material?.opens_at)); const [position,setPosition] = useState(String(material?.position ?? 1));
  const [files,setFiles] = useState<string[]>(data.materialFiles.filter(f => f.material_id === material?.id).map(f => f.file_id)); const [names,setNames] = useState<Record<string, string>>({}); const [uploading,setUploading] = useState(false); const [uploadError,setUploadError] = useState('');
  const save = useSave(refresh, onAuth); const touch = () => onDirty(true);
  // Ссылка — строка «Название | https://…»; одна ссылка без названия подписывается самим адресом.
  const parsed = links.split('\n').map(line => line.trim()).filter(Boolean).map(line => { const [a, b] = line.split('|').map(x => x.trim()); return b ? { label: a, url: b } : { label: a, url: a }; });
  return <form className="material-editor" onSubmit={async e => { e.preventDefault(); if (await save.run('material.save', { id: id.current, expectedRevision: material?.revision || 0, module, position: Number(position) || 0, audience, title, body, links: parsed, published, opensAt: fromInput(opens), files })) onDirty(false); }}>
    {material && <h3>{material.title} <span className="badge">{material.published ? material.open === false || (material.opens_at && new Date(material.opens_at) > new Date(data.now)) ? 'Scheduled' : 'Published' : 'Draft'}</span></h3>}
    <label htmlFor={`m-title-${key}`}>Title</label><input id={`m-title-${key}`} value={title} onChange={e => { setTitle(e.target.value); touch(); }} required/>
    <label htmlFor={`m-body-${key}`}>Text</label><textarea id={`m-body-${key}`} value={body} onChange={e => { setBody(e.target.value); touch(); }} rows={5}/>
    <label htmlFor={`m-links-${key}`}>Links, one per line: Title | https://…</label><textarea id={`m-links-${key}`} value={links} onChange={e => { setLinks(e.target.value); touch(); }} rows={2}/>
    <ul className="file-list">{files.map(f => <li key={f}><a href={`/api/v1/files/${f}/download`}>{names[f] || data.files.find(x => x.id === f)?.name || 'File'}</a><button type="button" className="text-button" onClick={() => { setFiles(files.filter(x => x !== f)); touch(); }}>Remove</button></li>)}</ul>
    <label className="upload-label">{uploading ? 'Uploading…' : 'Attach a file or video captions'}<input type="file" accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp,.mp4,.vtt" disabled={uploading} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setUploading(true); setUploadError(''); try { const form = new FormData(); form.set('file', file); const stored = await api('uploads', form); setFiles(old => [...old, stored.id]); setNames(old => ({ ...old, [stored.id]: stored.name })); touch(); } catch(err) { setUploadError((err as Error).message); } finally { setUploading(false); } }}/></label><ErrorBox error={uploadError}/>
    <div className="field-row"><div><label htmlFor={`m-aud-${key}`}>Audience</label><select id={`m-aud-${key}`} value={audience} onChange={e => { setAudience(e.target.value); touch(); }}><option value="participant">Participants</option><option value="team">Team only (host script, expert notes)</option></select></div><div><label htmlFor={`m-pos-${key}`}>Order</label><input id={`m-pos-${key}`} type="number" min={0} max={999} value={position} onChange={e => { setPosition(e.target.value); touch(); }}/></div></div>
    <div className="field-row"><div><label htmlFor={`m-open-${key}`}>Opens (CET, optional)</label><input id={`m-open-${key}`} type="datetime-local" value={opens} onChange={e => { setOpens(e.target.value); touch(); }}/></div><div><label className="choice publish"><input type="checkbox" checked={published} onChange={e => { setPublished(e.target.checked); touch(); }}/>Published</label></div></div>
    <p className="muted small">Before the opening time participants see only the title and when it opens. Unpublishing hides the content again.</p>
    <button disabled={save.busy || uploading}>{save.busy ? 'Saving…' : material ? 'Save material' : 'Add material'}</button> <span role="status" className="small">{save.status}</span><ErrorBox error={save.error}/>
  </form>;
}

// LMS-10/LMS-12: журнал — каждый участник × каждое опубликованное задание в области доступа; черновики не раскрываются.
function journalRows(data: Data) {
  const admin = data.me.role === 'admin';
  const assignments = data.assignments.filter(a => a.published && (admin || canReview(data, a.id)));
  return data.people.filter(p => p.role === 'participant').flatMap(person => assignments.map(assignment => {
    const work = data.works.find(w => w.assignment_id === assignment.id && w.owner_id === person.id);
    const latest = data.submissions.find(s => s.work_id === work?.id && s.owner_id === person.id);
    const review = latest ? currentOf(data.reviews.filter(r => r.submission_id === latest.id)) : undefined;
    const responsible = data.reviewers.find(r => r.assignment_id === assignment.id);
    const presentation = isPackage(assignment.spec) ? currentOf(data.presentations.filter(d => d.participant_id === person.id)) : undefined;
    return { person, assignment, latest, status: latest ? shown(latest.spec, latest.status) : 'not_submitted', review, responsible: responsible ? data.people.find(p => p.id === responsible.reviewer_id)?.name || 'Assigned' : 'No responsible expert', reviewerId: responsible?.reviewer_id || 'none', presentation };
  }));
}
const presentationLabel = (d: Row | undefined, data: Data) => !d ? 'Not held yet' : d.outcome === 'absent' ? 'Absent' : d.without_package ? 'Held · without a submitted package' : `Held · package version ${data.submissions.find(s => s.id === d.package_id)?.number ?? '?'}`;

function Journal({ data, now, filter, setFilter, open }: { data: Data; now: number; filter: JournalFilter; setFilter: (f: JournalFilter) => void; open: (submissionId: string) => void }) {
  const all = journalRows(data); const admin = data.me.role === 'admin';
  const rows = all.filter(r => (!filter.module || String(r.assignment.module) === filter.module) && (!filter.assignment || r.assignment.id === filter.assignment) && (!filter.status || r.status === filter.status) && (!filter.reviewer || r.reviewerId === filter.reviewer) && (!filter.late || r.latest?.late));
  const assignments = [...new Map(all.map(r => [r.assignment.id, r.assignment])).values()];
  const reviewerIds = [...new Set(all.map(r => r.reviewerId))];
  const active = Object.entries(filter).filter(([, v]) => v).map(([k, v]) => k === 'late' ? 'late only' : k === 'module' ? `module ${v}` : k === 'assignment' ? assignments.find(a => a.id === v)?.spec.title : k === 'reviewer' ? (v === 'none' ? 'no responsible expert' : data.people.find(p => p.id === v)?.name) : statuses[String(v)] || v);
  const reset = () => setFilter({ module: '', assignment: '', status: '', reviewer: '', late: false });
  function download() {
    // Защита от формул в таблицах: значения, начинающиеся с = + - @, экранируются апострофом.
    const cell = (v: unknown) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
    const header = ['Participant','Email','Assignment','Latest version','Submitted at (UTC)','Status','Due at (UTC)','Late','Responsible','Level','Project presentation'];
    const lines = rows.map(r => [r.person.name, r.person.email, r.assignment.spec.title, r.latest?.number, r.latest?.submitted_at, statuses[r.status], r.latest?.due_at_snapshot ?? r.assignment.due_at, r.latest ? (r.latest.late ? 'yes' : 'no') : '', r.responsible, r.review?.level ? levels[r.review.level] : '', isPackage(r.assignment.spec) ? presentationLabel(r.presentation, data) : ''].map(cell).join(','));
    const stamp = new Date(now).toISOString().slice(0, 16).replace(':', '');
    const url = URL.createObjectURL(new Blob(['\ufeff' + [header.map(cell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `slot-design-journal-${stamp}Z.csv`; link.click(); URL.revokeObjectURL(url);
  }
  return <><div className="page-heading"><p className="eyebrow">TEAM WORKSPACE</p><h1>Journal</h1><p className="muted">{admin ? 'Every participant and every published assignment.' : 'Every participant for the assignments you are responsible for.'} Status comes from the latest submitted version; drafts are not shown.</p></div>
    <form className="filters" onSubmit={e => e.preventDefault()}>
      <div><label htmlFor="j-module">Module</label><select id="j-module" value={filter.module} onChange={e => setFilter({ ...filter, module: e.target.value, assignment: '' })}><option value="">All modules</option>{[...new Set(assignments.map(a => a.module))].map(m => <option key={m} value={m}>{m} · {modules[m]}</option>)}</select></div>
      <div><label htmlFor="j-assignment">Assignment</label><select id="j-assignment" value={filter.assignment} onChange={e => setFilter({ ...filter, assignment: e.target.value })}><option value="">All assignments</option>{assignments.filter(a => !filter.module || String(a.module) === filter.module).map(a => <option key={a.id} value={a.id}>{a.spec.title}</option>)}</select></div>
      <div><label htmlFor="j-status">Status</label><select id="j-status" value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}><option value="">All statuses</option>{['not_submitted','submitted','in_review','needs_revision','accepted','received'].map(x => <option key={x} value={x}>{statuses[x]}</option>)}</select></div>
      {admin && <div><label htmlFor="j-reviewer">Responsible</label><select id="j-reviewer" value={filter.reviewer} onChange={e => setFilter({ ...filter, reviewer: e.target.value })}><option value="">Everyone</option>{reviewerIds.map(id => <option key={id} value={id}>{id === 'none' ? 'No responsible expert' : data.people.find(p => p.id === id)?.name || 'Assigned'}</option>)}</select></div>}
      <label className="choice"><input type="checkbox" checked={filter.late} onChange={e => setFilter({ ...filter, late: e.target.checked })}/>Late submissions only</label>
      {active.length > 0 && <button type="button" className="text-button" onClick={reset}>Reset filters</button>}
    </form>
    <div className="journal-bar"><p className="small muted" role="status">{rows.length} of {all.length} rows{active.length ? ` · Filters: ${active.join(', ')}` : ''}</p>{admin && <button className="secondary" onClick={download} disabled={!rows.length}>Download CSV ({rows.length} rows)</button>}</div>
    {rows.length ? <div className="table-wrap"><table className="journal"><thead><tr><th scope="col">Participant</th><th scope="col">Assignment</th><th scope="col">Latest version</th><th scope="col">Status</th><th scope="col">Responsible</th><th scope="col">Level / presentation</th></tr></thead><tbody>
      {rows.map(r => <tr key={`${r.person.id}-${r.assignment.id}`}><th scope="row">{r.person.name}</th><td>{r.assignment.spec.title}</td><td>{r.latest ? <button className="text-button" onClick={() => open(r.latest!.id)}>Version {r.latest.number} · {date(r.latest.submitted_at)}</button> : <span className="muted">—</span>}{r.latest?.late && <span className="late"> Late</span>}</td><td><Badge status={r.status}/>{r.latest && ['submitted','in_review'].includes(r.status) && reviewDue(r.assignment, now)?.overdue && <small className="overdue"> Review overdue</small>}</td><td className={r.reviewerId === 'none' ? 'overdue' : ''}>{r.responsible}</td><td>{r.review?.level ? levels[r.review.level] : ''}{isPackage(r.assignment.spec) && <small className="presentation-cell">{presentationLabel(r.presentation, data)}</small>}</td></tr>)}
    </tbody></table></div> : all.length ? <div className="empty"><h2>No rows match these filters.</h2><button className="secondary" onClick={reset}>Reset filters</button></div> : <div className="empty"><h2>The journal is empty.</h2><p>Participants and published assignments will appear here.</p></div>}</>;
}

// §7.4: запись о презентации проекта фиксирует ответственный за итоговый пакет; исправление — с причиной, прежняя запись сохраняется.
function Presentations({ data, refresh, onAuth }: { data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const responsible = data.reviewers.some(r => r.reviewer_id === data.me.id && data.assignments.some(a => a.id === r.assignment_id && isPackage(a.spec)));
  const people = data.people.filter(p => p.role === 'participant');
  return <><div className="page-heading"><p className="eyebrow">TEAM WORKSPACE</p><h1>Project presentations</h1><p className="muted">Record what happened at the shared project presentations in module 7. Uploading a pitch does not mark the presentation as held.</p></div>
    {!responsible && <p className="muted">Read-only: only the expert responsible for the final package records project presentations.</p>}
    {people.map(p => { const records = data.presentations.filter(d => d.participant_id === p.id); const current = currentOf(records); return <section className="admin-card presentation" key={p.id}><div className="section-heading"><h2>{p.name}</h2><span className={`badge ${current?.outcome === 'held' ? 'accepted' : current ? 'needs_revision' : ''}`}>{presentationLabel(current, data)}</span></div>
      {current && <p className="small">{current.level && <>Level: {levels[current.level]} · </>}Recorded {date(current.created_at)} by {data.people.find(x => x.id === current.author_id)?.name || 'the course team'}{current.comment && <><br/><span className="preserve">{current.comment}</span></>}</p>}
      {records.length > 1 && <details><summary>Record history ({records.length})</summary>{[...records].reverse().map(d => <p className="small" key={d.id}>{date(d.created_at)} · {presentationLabel(d, data)}{d.level ? ` · ${levels[d.level]}` : ''}{d.reason ? ` · Reason for correction: ${d.reason}` : ''}{d.id !== current?.id ? ' (replaced)' : ' (current)'}</p>)}</details>}
      {responsible && <PresentationForm key={current?.id || 'new'} participant={p} current={current} data={data} refresh={refresh} onAuth={onAuth}/>}
    </section>; })}
    {!people.length && <div className="empty"><h2>No participants yet.</h2></div>}</>;
}
function PresentationForm({ participant, current, data, refresh, onAuth }: { participant: Row; current?: Row; data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const packages = data.submissions.filter(s => s.owner_id === participant.id && isPackage(s.spec));
  const [outcome,setOutcome] = useState(current?.outcome || 'held'); const [pack,setPack] = useState(current ? current.without_package ? 'none' : current.package_id || '' : packages[0]?.id || 'none');
  const [level,setLevel] = useState(current?.level || ''); const [comment,setComment] = useState(current?.comment || ''); const [reason,setReason] = useState(''); const key = useRef(''); const save = useSave(refresh, onAuth); const id = participant.id;
  return <details className="presentation-form" open={!current}><summary>{current ? 'Correct this record' : 'Record the presentation'}</summary><form onSubmit={async e => { e.preventDefault(); key.current ||= crypto.randomUUID(); const ok = await save.run('presentation.record', { participantId: id, outcome, packageId: outcome === 'held' && pack !== 'none' ? pack : null, withoutPackage: outcome === 'held' && pack === 'none', level: outcome === 'held' && level ? level : null, comment, ...(current ? { replacesId: current.id, reason } : {}), key: key.current }, 'Recorded'); if (ok) key.current = ''; }}>
    <fieldset><legend>Outcome</legend><label className="choice"><input type="radio" name={`outcome-${id}`} checked={outcome === 'held'} onChange={() => { setOutcome('held'); key.current = ''; }}/>Held</label><label className="choice"><input type="radio" name={`outcome-${id}`} checked={outcome === 'absent'} onChange={() => { setOutcome('absent'); key.current = ''; }}/>Participant was absent</label></fieldset>
    {outcome === 'held' && <><label htmlFor={`d-pack-${id}`}>Package that was presented</label><select id={`d-pack-${id}`} value={pack} onChange={e => { setPack(e.target.value); key.current = ''; }} aria-invalid={save.fields.includes('packageId')}>{packages.map(s => <option key={s.id} value={s.id}>Version {s.number} · submitted {date(s.submitted_at)}</option>)}<option value="none">Held without a submitted package</option></select>
      <label htmlFor={`d-level-${id}`}>Level (optional)</label><select id={`d-level-${id}`} value={level} onChange={e => { setLevel(e.target.value); key.current = ''; }}><option value="">Not set</option><option value="weak">Weak</option><option value="medium">Medium</option><option value="strong">Strong</option></select></>}
    <label htmlFor={`d-comment-${id}`}>Comment (optional)</label><textarea id={`d-comment-${id}`} value={comment} onChange={e => { setComment(e.target.value); key.current = ''; }} rows={2}/>
    {current && <><label htmlFor={`d-reason-${id}`}>Reason for correction</label><textarea id={`d-reason-${id}`} value={reason} onChange={e => { setReason(e.target.value); key.current = ''; }} rows={2} aria-invalid={save.fields.includes('reason')}/></>}
    <button disabled={save.busy}>{save.busy ? 'Saving…' : current ? 'Save correction' : 'Record presentation'}</button> <span role="status" className="small">{save.status}</span><ErrorBox error={save.error}/>
  </form></details>;
}
function PresentationNotice({ data }: { data: Data }) {
  const current = currentOf(data.presentations.filter(d => d.participant_id === data.me.id));
  return <section className="session-card"><p className="eyebrow">PROJECT PRESENTATION</p><h2>{presentationLabel(current, data)}</h2>{current ? <>{current.level && <p className="small"><strong>Level:</strong> {levels[current.level]}</p>}{current.comment && <p className="preserve">{current.comment}</p>}<p className="muted small">Recorded {date(current.created_at)}. Submitting a new package later does not change this record.</p></> : <p className="muted small">Your expert records your project presentation after the shared session. Submitting your package does not mark it as held.</p>}</section>;
}

// LMS-11: уведомления в интерфейсе повторяют письма; ссылка ведёт к модулю или кабинету команды.
function Notifications({ data, refresh, onAuth }: { data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const [open,setOpen] = useState(false); const [error,setError] = useState('');
  const mine = data.notifications.filter(n => n.recipient_id === data.me.id && !['cancelled','missed'].includes(n.status)).slice(0, 30);
  const unread = mine.filter(n => !n.read_at);
  async function read(ids: string[]) { if (!ids.length) return; setError(''); try { await cmd('notification.read', { ids }); await refresh(); } catch(e) { setError((e as Error).message); if ((e as RequestError).code === 'unauthenticated') onAuth(); } }
  return <div className="notifications"><button className="secondary small-button" aria-expanded={open} aria-controls="notification-panel" onClick={() => setOpen(!open)}>Notifications{unread.length > 0 && <span className="count">{unread.length}</span>}</button>
    {open && <section id="notification-panel" className="notification-panel" aria-label="Notifications"><div className="section-heading"><h2>Notifications</h2>{unread.length > 0 && <button className="text-button" onClick={() => read(unread.map(n => n.id))}>Mark all as read</button>}</div><ErrorBox error={error}/>
      {mine.length ? <ul>{mine.map(n => <li key={n.id} className={n.read_at ? '' : 'unread'}><a href={n.link_path} onClick={() => { if (!n.read_at) void cmd('notification.read', { ids: [n.id] }).catch(() => {}); }}>{n.subject}</a><small>{date(n.created_at)}</small>{!n.read_at && <button className="text-button" onClick={() => read([n.id])}>Mark as read</button>}</li>)}</ul> : <p className="muted small">No notifications yet.</p>}
      <p className="small muted">Time zone for emails: Account.</p></section>}</div>;
}
function TimeZone({ data, refresh, onAuth }: { data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [zone,setZone] = useState<string>(data.me.timezone || ''); const save = useSave(refresh, onAuth);
  return <form className="timezone" onSubmit={async e => { e.preventDefault(); await save.run('profile.timezone', { timezone: zone || null }); }}>
    <label htmlFor="timezone">Time zone for emails</label><p className="muted small">Emails show course time (CET) and the time in this zone.{!data.me.timezone && detected ? ` Your device uses ${detected}.` : ''}</p>
    <div className="inline-form"><select id="timezone" value={zone} onChange={e => setZone(e.target.value)}><option value="">Course time only (CET)</option>{detected && !zones.includes(detected) && <option value={detected}>{detected}</option>}{zones.map(z => <option key={z} value={z}>{z}</option>)}</select><button className="secondary" disabled={save.busy}>Save</button></div>
    <span role="status" className="small">{save.status}</span><ErrorBox error={save.error}/></form>;
}

const mailStatuses: Record<string, string> = { pending: 'Queued', sending: 'Sending', sent: 'Accepted by provider', failed: 'Failed', unknown: 'Unknown result', cancelled: 'Cancelled', missed: 'Missed' };
function MailAdmin({ data, refresh, onAuth }: { data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const [status,setStatus] = useState(''); const [run,setRun] = useState(''); const save = useSave(refresh, onAuth);
  const rows = data.notifications.filter(n => !status || n.status === status);
  const counts = Object.keys(mailStatuses).map(k => [k, data.notifications.filter(n => n.status === k).length] as const).filter(([, c]) => c);
  const person = (id: string) => data.people.find(p => p.id === id);
  return <><div className="page-heading"><p className="eyebrow">ADMINISTRATION</p><h1>Email</h1><p className="muted">Course emails and reminders. “Accepted by provider” does not mean the email reached the inbox.</p></div>
    <section className="admin-card"><p><strong>Provider:</strong> {data.mail?.provider === 'local' ? 'Local test mailbox — emails are written to files on this computer, nothing is sent.' : data.mail?.provider ? data.mail.provider : 'Not configured — emails stay queued until a provider is set up.'}</p>
      <p className="small">{counts.length ? counts.map(([k, c]) => `${mailStatuses[k]}: ${c}`).join(' · ') : 'No emails yet.'}</p>
      {data.mail?.provider === 'local' && <><button className="secondary" disabled={save.busy} onClick={async () => { setRun(''); try { const r = await cmd('mail.run', {}); setRun(`Planned ${r.created}, sent ${r.sent}, failed ${r.failed}.`); await refresh(); } catch(e) { setRun((e as Error).message); } }}>Process mail now</button> <span role="status" className="small">{run}</span></>}
    </section>
    <form className="filters" onSubmit={e => e.preventDefault()}><div><label htmlFor="mail-status">Status</label><select id="mail-status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All</option>{Object.entries(mailStatuses).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div></form>
    <ErrorBox error={save.error}/>
    {rows.length ? <div className="table-wrap"><table className="journal"><thead><tr><th scope="col">Email</th><th scope="col">Recipient</th><th scope="col">Planned</th><th scope="col">Status</th><th scope="col"></th></tr></thead><tbody>
      {rows.map(n => <tr key={n.id}><td><details><summary>{n.subject}</summary><pre className="mail-body">{n.body}</pre></details><small className="muted">{n.kind}</small></td><td>{person(n.recipient_id)?.name || '—'}<small className="recipient-email">{person(n.recipient_id)?.email}</small></td><td>{date(n.due_at)}{n.sent_at && <small>Sent {date(n.sent_at)}</small>}</td><td><span className={`badge ${n.status === 'sent' ? 'accepted' : ['failed','unknown'].includes(n.status) ? 'needs_revision' : ''}`}>{mailStatuses[n.status]}</span>{n.attempts > 0 && <small>Attempts: {n.attempts}</small>}{n.last_error && <small className={['failed','unknown'].includes(n.status) ? 'overdue' : 'muted'}>{n.last_error}</small>}</td>
        <td>{['failed','unknown','missed','cancelled'].includes(n.status) && <button className="secondary" disabled={save.busy} onClick={() => { const unknown = n.status === 'unknown'; if (unknown && !confirm('This email may already have been delivered. Send it again anyway?')) return; void save.run('notification.retry', { id: n.id, confirmUnknown: unknown }, 'Queued again'); }}>Send again</button>}</td></tr>)}
    </tbody></table></div> : <div className="empty"><h2>{status ? 'No emails with this status.' : 'No emails yet.'}</h2></div>}</>;
}

function Modal({ label, close, children }: { label: string; close: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="modal" aria-label={label} onCancel={e => { e.preventDefault(); close(); }}><div className="modal-head"><h2>{label}</h2><button className="text-button" onClick={close}>Close</button></div>{children}</dialog>;
}

// Решение 31.10.2026: после первого входа по ссылке — свой пароль; ссылка остаётся запасным входом.
function PasswordForm({ refresh, onAuth, done, submitLabel }: { refresh: () => Promise<void>; onAuth: () => void; done?: () => void; submitLabel: string }) {
  const [password,setPassword] = useState(''); const [repeat,setRepeat] = useState(''); const [shown,setShown] = useState(false);
  const [local,setLocal] = useState(''); const [busy,setBusy] = useState(false);
  return <form onSubmit={async e => { e.preventDefault(); if (busy) return; setLocal(''); if (password !== repeat) { setLocal('The passwords do not match.'); return; } setBusy(true); let r: Response; try { r = await fetch('/api/v1/auth/password', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); } catch { setBusy(false); setLocal('Connection lost. Your password was not saved; try again.'); return; } const body = await r.json().catch(() => ({})); setBusy(false); if (!r.ok) { if (body.code === 'unauthenticated') onAuth(); setLocal(body.message || 'The password could not be saved.'); return; } setPassword(''); setRepeat(''); setLocal(''); await refresh(); done?.(); }}>
    <label htmlFor="new-password">New password</label><input id="new-password" type={shown ? 'text' : 'password'} autoComplete="new-password" minLength={8} maxLength={72} value={password} onChange={e => setPassword(e.target.value)} required aria-describedby="password-rules"/>
    <p id="password-rules" className="muted small">At least 8 characters. A short phrase is easier to remember than random symbols.</p>
    <label htmlFor="repeat-password">Repeat the password</label><input id="repeat-password" type={shown ? 'text' : 'password'} autoComplete="new-password" value={repeat} onChange={e => setRepeat(e.target.value)} required/>
    <label className="choice"><input type="checkbox" checked={shown} onChange={e => setShown(e.target.checked)}/>Show password</label>
    <button disabled={busy}>{busy ? 'Saving…' : submitLabel}</button><ErrorBox error={local}/>
  </form>;
}
function PasswordPrompt({ refresh, onAuth, done }: { refresh: () => Promise<void>; onAuth: () => void; done: () => void }) {
  return <section className="admin-card password-prompt"><p className="eyebrow">FIRST SIGN-IN</p><h1>Create your password</h1><p className="muted small">Create a password to open Module 0. Next time, sign in with your email and password. You can still request an email link if you forget it.</p><PasswordForm refresh={refresh} onAuth={onAuth} done={done} submitLabel="Save password and open Module 0"/></section>;
}
function AccountPanel({ data, refresh, onAuth }: { data: Data; refresh: () => Promise<void>; onAuth: () => void }) {
  const [saved,setSaved] = useState(false);
  return <div className="account"><p><strong>{data.me.name}</strong><br/><span className="muted small">{data.me.email}</span></p>
    <h3>{data.me.password_set_at ? 'Change password' : 'Create a password'}</h3>{data.me.password_set_at && <p className="muted small">Password set {date(data.me.password_set_at)}.</p>}
    {saved && <p role="status" className="small">Password saved.</p>}
    <PasswordForm refresh={refresh} onAuth={onAuth} done={() => setSaved(true)} submitLabel={data.me.password_set_at ? 'Change password' : 'Save password'}/>
    <hr/><TimeZone data={data} refresh={refresh} onAuth={onAuth}/></div>;
}

// Отзыв о курсе в любой момент: видят автор и администраторы.
function FeedbackForm({ data, module, refresh, onAuth }: { data: Data; module: number | null; refresh: () => Promise<void>; onAuth: () => void }) {
  const [about,setAbout] = useState<string>(module === null ? '' : String(module)); const [rating,setRating] = useState(''); const [body,setBody] = useState(''); const [sent,setSent] = useState(false); const key = useRef(''); const save = useSave(refresh, onAuth);
  const mine = data.feedback.filter(f => f.owner_id === data.me.id);
  if (sent) return <div><p role="status"><strong>Thank you.</strong> The course team will read your feedback.</p><button className="secondary" onClick={() => { setSent(false); setBody(''); setRating(''); }}>Write more</button></div>;
  return <form onSubmit={async e => { e.preventDefault(); key.current ||= crypto.randomUUID(); if (await save.run('feedback.send', { module: about === '' ? null : Number(about), rating: rating ? Number(rating) : null, body, key: key.current }, 'Sent')) { key.current = ''; setSent(true); } }}>
    <p className="muted small">Tell us what works and what does not, at any time. The course team sees your name; other participants do not see your feedback.</p>
    <label htmlFor="feedback-about">About</label><select id="feedback-about" value={about} onChange={e => { setAbout(e.target.value); key.current = ''; }}><option value="">The course in general</option>{modules.map((name, index) => <option key={name} value={index}>Module {index} · {name}</option>)}</select>
    <fieldset><legend>How is it going? (optional)</legend><div className="rating">{[1,2,3,4,5].map(n => <label className="choice" key={n}><input type="radio" name="feedback-rating" checked={rating === String(n)} onChange={() => { setRating(String(n)); key.current = ''; }}/>{n}</label>)}<button type="button" className="text-button" style={{ visibility: rating ? 'visible' : 'hidden' }} onClick={() => setRating('')}>Clear</button></div><p className="muted small">1 — not good, 5 — very good.</p></fieldset>
    <label htmlFor="feedback-body">Your feedback</label><textarea id="feedback-body" value={body} onChange={e => { setBody(e.target.value); key.current = ''; }} rows={5} required/>
    <button disabled={save.busy}>{save.busy ? 'Sending…' : 'Send feedback'}</button><ErrorBox error={save.error}/>
    {mine.length > 0 && <p className="muted small">You have sent feedback {mine.length} {mine.length === 1 ? 'time' : 'times'}, last on {date(mine[0].created_at)}.</p>}
  </form>;
}
function FeedbackAdmin({ data }: { data: Data }) {
  const rated = data.feedback.filter(f => f.rating); const average = rated.length ? (rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(1) : null;
  return <><div className="page-heading"><p className="eyebrow">ADMINISTRATION</p><h1>Feedback</h1><p className="muted">Course feedback from participants. Each entry is visible only to its author and administrators.</p></div>
    <p className="small">{data.feedback.length} entries{average ? ` · average rating ${average} of 5 (${rated.length} rated)` : ''}</p>
    {data.feedback.length ? data.feedback.map(f => <article className="question" key={f.id}><p className="eyebrow">{data.people.find(p => p.id === f.owner_id)?.name || 'Participant'} · {f.module === null ? 'Course in general' : `Module ${f.module} · ${modules[f.module]}`}{f.rating ? ` · ${f.rating}/5` : ''}</p><p className="small muted">{date(f.created_at)}</p><p className="preserve">{f.body}</p></article>) : <div className="empty"><h2>No feedback yet.</h2></div>}</>;
}

// Дашборд администратора: кто что сделал. Строится из уже доступных администратору данных; черновики не учитываются (§5.1).
type Activity = { at: string; who: string; text: string; submission?: string };
function activityFeed(data: Data): Activity[] {
  const name = (id: string) => data.people.find(p => p.id === id)?.name || 'Participant';
  const participant = (id: string) => data.people.some(p => p.id === id && p.role === 'participant');
  const feed: Activity[] = [];
  for (const p of data.people.filter(x => x.role === 'participant')) {
    if (p.activated_at) feed.push({ at: p.activated_at, who: p.id, text: 'signed in for the first time' });
    if (p.password_set_at) feed.push({ at: p.password_set_at, who: p.id, text: 'created a password' });
  }
  for (const s of data.submissions.filter(x => participant(x.owner_id))) feed.push({ at: s.submitted_at, who: s.owner_id, text: `submitted ${s.spec.title}, version ${s.number}${s.late ? ' (late)' : ''}`, submission: s.id });
  for (const x of data.progress.filter(x => participant(x.owner_id))) feed.push({ at: x.studied_at, who: x.owner_id, text: `studied “${data.materials.find(m => m.id === x.material_id)?.title || 'a material'}”` });
  for (const q of data.questions) feed.push({ at: q.created_at, who: q.owner_id, text: `asked a question about ${q.module === null ? 'the course' : `module ${q.module}`}` });
  for (const f of data.feedback) feed.push({ at: f.created_at, who: f.owner_id, text: `left course feedback${f.rating ? ` (${f.rating}/5)` : ''}` });
  for (const p of data.projects.filter(x => x.revision > 0)) feed.push({ at: p.updated_at, who: p.owner_id, text: `updated the project: ${p.theme || 'no theme yet'}` });
  for (const r of data.reviews) { const s = data.submissions.find(x => x.id === r.submission_id); if (s) feed.push({ at: r.created_at, who: s.owner_id, text: `received ${r.replaces_id ? 'a corrected decision' : statuses[r.action]} on ${s.spec.title}, version ${s.number} from ${name(r.author_id)}`, submission: s.id }); }
  for (const d of data.presentations) feed.push({ at: d.created_at, who: d.participant_id, text: `project presentation recorded: ${presentationLabel(d, data)}` });
  return feed.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}
function ActivityDashboard({ data, now, open }: { data: Data; now: number; open: (submissionId: string) => void }) {
  const [who,setWho] = useState('');
  const feed = activityFeed(data); const participants = data.people.filter(p => p.role === 'participant' && !p.revoked_at);
  const week = now - 7 * 86_400_000; const name = (id: string) => data.people.find(p => p.id === id)?.name || 'Participant';
  const openMaterials = data.materials.filter(m => m.audience === 'participant' && m.published && m.open);
  const published = data.assignments.filter(a => a.published);
  const waiting = data.works.filter(w => ['submitted','in_review'].includes(w.status) && !selfAssessment(w.spec));
  const rated = data.feedback.filter(f => f.rating);
  const kpis: [string, string | number][] = [
    ['Participants', participants.length], ['Signed in', participants.filter(p => p.activated_at).length], ['Created a password', participants.filter(p => p.password_set_at).length],
    ['Active in the last 7 days', new Set(feed.filter(e => new Date(e.at).getTime() >= week).map(e => e.who)).size], ['Works waiting for review', waiting.length],
    ['Questions without an answer', data.questions.filter(q => !data.answers.some(a => a.question_id === q.id)).length], ['Average feedback', rated.length ? `${(rated.reduce((s, f) => s + f.rating, 0) / rated.length).toFixed(1)} / 5` : '—'],
  ];
  const shown = feed.filter(e => !who || e.who === who).slice(0, 80);
  return <><div className="page-heading"><p className="eyebrow">ADMINISTRATION</p><h1>Activity</h1><p className="muted">Who did what on the platform. Private drafts are not shown. Each of these actions also sends you an email once the mail provider is connected.</p></div>
    <div className="kpis">{kpis.map(([label, value]) => <div className="kpi" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div>
    <h2>Participants</h2>
    {participants.length ? <div className="table-wrap"><table className="journal"><thead><tr><th scope="col">Participant</th><th scope="col">Signed in</th><th scope="col">Password</th><th scope="col">Materials studied</th><th scope="col">Assignments submitted</th><th scope="col">Waiting for review</th><th scope="col">Last activity</th></tr></thead><tbody>
      {participants.map(p => { const last = feed.find(e => e.who === p.id); const subs = new Set(data.submissions.filter(s => s.owner_id === p.id && published.some(a => a.id === data.works.find(w => w.id === s.work_id)?.assignment_id)).map(s => s.work_id)); const studied = data.progress.filter(x => x.owner_id === p.id && openMaterials.some(m => m.id === x.material_id)).length;
        return <tr key={p.id}><th scope="row"><button className="text-button" onClick={() => setWho(who === p.id ? '' : p.id)} aria-pressed={who === p.id}>{p.name}</button><small className="muted">{p.email}</small></th><td>{p.activated_at ? date(p.activated_at) : <span className="overdue">Not yet</span>}</td><td>{p.password_set_at ? 'Yes' : 'No'}</td><td>{studied} of {openMaterials.length}</td><td>{subs.size} of {published.length}</td><td>{waiting.filter(w => w.owner_id === p.id).length}</td><td>{last ? <>{date(last.at)}<small className="muted">{last.text}</small></> : '—'}</td></tr>; })}
    </tbody></table></div> : <p className="muted">No participants yet. Invite them in Course administration.</p>}
    <div className="section-heading activity-head"><h2>Recent activity{who ? ` · ${name(who)}` : ''}</h2>{who && <button className="text-button" onClick={() => setWho('')}>Show everyone</button>}</div>
    {shown.length ? <ol className="activity">{shown.map((e, i) => <li key={`${e.at}-${i}`}><span className="small muted">{date(e.at)}</span><span><strong>{name(e.who)}</strong> {e.text}</span>{e.submission && <button className="text-button" onClick={() => open(e.submission!)}>Open</button>}</li>)}</ol> : <p className="muted">Nothing has happened yet.</p>}</>;
}
