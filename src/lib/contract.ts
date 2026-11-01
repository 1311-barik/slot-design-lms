import { z } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 422, public fields: string[] = []) { super(message); }
}
export const uuid = z.string().uuid();
export const text = z.string().refine(v => [...v].length <= 50_000, 'Maximum 50,000 characters.').refine(v => !v.includes('\0'), 'Remove the unsupported NUL character.');
export const payloadSchema = z.object({
  parts: z.record(z.string(), z.object({
    text: text.default(''), files: z.array(uuid).max(20).default([]),
    images: z.array(z.object({ fileId: uuid, prompt: text, caption: text })).max(6).default([]),
    // Необязательно: прежние черновики и сдачи этого поля не содержат.
    submissions: z.array(uuid).max(20).optional(),
  }).strict()),
}).strict();
export type Payload = z.infer<typeof payloadSchema>;
// choice — выбор одного варианта из options (уровень самооценки); versions — собственные отправленные версии для итогового пакета.
export type Part = { id: string; title: string; hint: string; kind?: 'images' | 'choice' | 'versions'; options?: string[]; required: boolean };
// self_assessment — сдача «получено» без экспертного решения (LMS-05).
export type AssignmentSpec = { title: string; mode?: 'self_assessment'; parts: Part[] };
export type FileMeta = { id: string; mime: string; size: number };
export const meaningful = (s: string) => s.replace(/[\s\p{Cf}\p{Cc}]/gu, '').length > 0;
const substantive = (s: string) => meaningful(s.replace(/https?:\/\/\S+/giu, ''));
export const isPackage = (spec: AssignmentSpec) => spec.parts.some(p => p.kind === 'versions');
export const packagedIds = (payload: Payload) => [...new Set(Object.values(payload.parts).flatMap(p => p.submissions ?? []))];
export function attachedIds(payload: Payload): string[] {
  return [...new Set(Object.values(payload.parts).flatMap(p => [...p.files, ...p.images.map(i => i.fileId)]))];
}
// ownSubmissions передаёт сервер: выбранные версии пакета должны принадлежать участнику. Клиент проверяет только комплектность.
export function validateSubmission(spec: AssignmentSpec, payload: Payload, files: FileMeta[], ownSubmissions?: string[]) {
  const invalid: string[] = [];
  for (const part of spec.parts) {
    const answer = payload.parts[part.id];
    if (part.kind === 'images') {
      if (!answer || answer.images.length < 3 || answer.images.length > 6 ||
          new Set(answer.images.map(i => i.fileId)).size !== answer.images.length ||
          answer.images.some(i => !meaningful(i.prompt) || !meaningful(i.caption) || !files.find(f => f.id === i.fileId)?.mime.startsWith('image/'))) invalid.push(part.id);
    } else if (part.kind === 'choice') {
      if ((part.required || answer?.text) && !part.options?.includes(answer?.text ?? '')) invalid.push(part.id);
    } else if (part.kind === 'versions') {
      if ((part.required && !answer?.submissions?.length) || (ownSubmissions && answer?.submissions?.some(id => !ownSubmissions.includes(id)))) invalid.push(part.id);
    } else if (part.required && (!answer || (!substantive(answer.text) && !answer.files.some(id => files.find(f => f.id === id && !f.mime.startsWith('image/')))))) invalid.push(part.id);
  }
  if (invalid.length) throw new AppError('incomplete', 'Complete the highlighted parts before submitting.', 422, invalid);
  if (files.length > 20 || files.reduce((sum, file) => sum + file.size, 0) > 200_000_000) throw new AppError('file_limit', 'Use at most 20 files and 200 MB per submission.');
  if (Object.keys(payload.parts).some(id => !spec.parts.some(p => p.id === id))) throw new AppError('invalid_part', 'This part does not belong to the assignment.');
}
