import { z } from 'zod';

// Дата из HTML date — календарный день CET, а не локальная зона браузера.
export function accessEndFromDate(value: string, now = new Date()): string {
  if (!z.iso.date().safeParse(value).success) throw new Error('Choose a valid access end date (day, month and four-digit year).');
  const end = new Date(`${value}T23:59:59+01:00`);
  if (!Number.isFinite(end.getTime())) throw new Error('Choose a valid access end date.');
  if (end <= now) throw new Error('Choose a future access end date.');
  return end.toISOString();
}
