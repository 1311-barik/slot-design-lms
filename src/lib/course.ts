import type { AssignmentSpec } from './contract';
// Названия — из английской программы для участников (igaming-course-programme-participants-en.docx).
export const modules = [
  'Orientation and preparation', 'Anatomy of a Hit', 'AI in Slot Design',
  'Player Psychology and Session Design', 'Advanced Maths and Feature Economics', 'Events and Meta Game',
  'Crash Test', 'Final Pitch',
];
// Состав частей — по §4 ТЗ v0.4. Порядок внутри модуля задаёт поле order.
const homework: AssignmentSpec[] = [
  { title: '1.2 · Game analysis & your concept', parts: [
    { id: 'analysis', title: 'A. Analyse an existing game', required: true, hint: 'Cover the mechanic, player experience, mathematical model and theme. Finish with a synthesis of how they work together.' },
    { id: 'concept', title: 'B. Draft your own concept', required: true, hint: 'Describe the theme, audience, core mechanic, hook feature and proposed volatility. Keep this separate from the existing game analysis.' },
  ] },
  { title: '2.2 · Develop a visual direction', parts: [
    { id: 'context', title: 'A. Context & definition of done', required: true, hint: 'Share your context pack and the criteria you will use to choose a direction.' },
    { id: 'variants', title: 'B. Explore & choose', required: true, hint: 'Show at least eight variants, stress-test two, choose one and explain why you rejected three. Your expert reviews the reasoning.' },
    { id: 'visuals', title: 'C. Final images', kind: 'images', required: true, hint: 'Upload 3–6 images. Add the final prompt and an explanation to each image.' },
    { id: 'journal', title: 'AI journal', required: true, hint: 'Paste your process journal or attach a document. AI tools are used outside this LMS.' },
    { id: 'application', title: 'Next week', required: true, hint: 'In one sentence, describe how you will apply this technique next week.' },
  ] },
  { title: '3.2 · Session curve & ethics check', parts: [
    { id: 'curve', title: 'A. Session curve', required: true, hint: 'Describe the session curve of your concept: near-misses and their frequency, the reward rhythm, how the player leaves and what brings them back. Attach a diagram or image if you have one.' },
    { id: 'ethics', title: 'B. Ethics check', required: true, hint: 'Answer the ethics check for your concept separately. Name the mechanics that could push players too far and how you limit them.' },
    { id: 'changes', title: 'C. Changes after the session', required: true, hint: 'What did you change after the review, and what did you keep? Explain why.' },
  ] },
  { title: '4.2 · RTP, volatility & feature budget', parts: [
    { id: 'rtp', title: 'A. RTP & volatility', required: true, hint: 'Justify RTP and volatility through the four inputs and check them for contradictions. Attach tables as files. Your expert reviews the numbers; they are not checked automatically.' },
    { id: 'budget', title: 'B. Feature budget & brief for the mathematician', required: true, hint: 'Share the feature budget, your explicit assumptions and open questions, and the brief for the mathematician.' },
    { id: 'changes', title: 'C. Changes after the session', required: true, hint: 'What did you change after the session, and why?' },
  ] },
  { title: '5.2 · Event & meta game design', parts: [
    { id: 'event', title: 'A. Event, step by step', required: true, hint: 'Describe the event step by step, following the documentation checklist. Attach documents or tables if needed.' },
    { id: 'economics', title: 'B. Rewards & impact', required: true, hint: 'Cover the reward source, cost, impact on the base game and the consequences of extending the event. Finish with a paragraph for the operator.' },
    { id: 'changes', title: 'C. Session questions & changes', required: true, hint: 'List the questions you received in the session and what you changed in response.' },
  ] },
  { title: '6.2 · Revised concept after the crash test', parts: [
    { id: 'versions', title: 'A. Before & after', required: true, hint: 'Attach the previous and revised versions of your concept and write a short before / after comparison.' },
    { id: 'accepted', title: 'B. Accepted comments', required: true, hint: 'Which comments did you accept, and what did you change for each one?' },
    { id: 'rejected', title: 'C. Rejected comments', required: true, hint: 'Which comments did you reject? Give your argument for each.' },
    { id: 'borrowed', title: 'D. A lesson from another review', required: true, hint: 'Pick one comment made about another participant’s concept and explain how you applied it to yours.' },
  ] },
];
const level = (when: string): AssignmentSpec => ({ title: '', mode: 'self_assessment', parts: [
  { id: 'level', title: 'A. Your level', kind: 'choice', options: ['Weak', 'Medium', 'Strong'], required: true, hint: `Rate your concept ${when}, using the weak / medium / strong descriptions from the module.` },
  { id: 'reasons', title: 'B. Why this level', required: true, hint: 'Explain your choice in two or three sentences.' },
  { id: 'weakSpot', title: 'C. Weakest point', required: true, hint: 'Name the weakest point of your concept. The team sees your self-assessment; other participants do not.' },
] });
const finalPackage: AssignmentSpec = { title: '7.2 · Final package for the pitch', parts: [
  { id: 'layers', title: 'A. Concept layers', kind: 'versions', required: true, hint: 'Choose the submitted versions you are presenting. The package keeps exactly these versions; later revisions do not change it.' },
  { id: 'documentation', title: 'B. Concept documentation', required: true, hint: 'Attach or paste the current documentation of your concept.' },
  { id: 'visuals', title: 'C. Updated visual direction', required: true, hint: 'Describe what changed in the visual direction and attach the images or a deck.' },
  { id: 'pitch', title: 'D. Pitch materials', required: true, hint: 'Attach your pitch deck or other materials for your project presentation.' },
  { id: 'journal', title: 'E. AI journal', required: true, hint: 'Add your updated AI journal so you can explain your decisions. It does not reopen the reviewed homework 2.2.' },
] };
// seed — постоянный номер в тестовом id задания: уже созданные задания 1–6 сохраняют свои id.
export const courseAssignments: { seed: number; module: number; order: number; spec: AssignmentSpec }[] = [
  ...homework.map((spec, index) => ({ seed: index + 1, module: index + 1, order: 2, spec })),
  { seed: 7, module: 6, order: 1, spec: { ...level('the day before the crash test'), title: '6.1 · Self-assessment before the crash test' } },
  { seed: 8, module: 7, order: 1, spec: { ...level('the day before your project presentation'), title: '7.1 · Self-assessment before the project presentation' } },
  { seed: 9, module: 7, order: 2, spec: finalPackage },
];
export const assignmentSpecs = courseAssignments.map(a => a.spec);
