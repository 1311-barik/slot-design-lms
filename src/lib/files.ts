import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { transaction } from './db';
import { config } from './config';
import { AppError, uuid } from './contract';
import { inspectContent } from './file-validation';
function storage() {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_STORAGE_BUCKET) throw new AppError('storage_unconfigured', 'File storage is not configured.', 503);
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } }).storage.from(process.env.SUPABASE_STORAGE_BUCKET);
}
export async function uploadFile(actor: string, name: string, bytes: Buffer) {
  const cfg = config(); const meta = await inspectContent(name, bytes); const id = randomUUID();
  const path = join(cfg.runtime, 'files', id);
  let stored = false;
  try {
    return await transaction(actor, async tx => {
      if (cfg.mode === 'local') {
        await mkdir(join(cfg.runtime, 'files'), { recursive: true, mode: 0o700 });
        await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      } else {
        const { error } = await storage().upload(id, bytes, { contentType: meta.mime, upsert: false });
        if (error) throw new AppError('upload_failed', 'The file could not be stored. Please try again.', 503);
      }
      stored = true;
      const [file] = await tx`insert into lms.files(id,owner_id,name,mime,size) values(${id},${actor},${name},${meta.mime},${meta.size}) returning *`;
      return file;
    });
  } catch (error) {
    if (stored) {
      if (cfg.mode === 'local') await unlink(path).catch(() => {});
      else await storage().remove([id]).catch(() => {});
    }
    throw error;
  }
}
export async function downloadFile(actor: string, id: string) {
  uuid.parse(id);
  return transaction(actor, async tx => {
    const [file] = await tx`select * from lms.files where id=${id}`;
    if (!file) throw new AppError('not_found', 'This file is not available.', 404);
    if (config().mode === 'local') return { file, bytes: await readFile(join(config().runtime, 'files', id)) };
    const { data, error } = await storage().download(id);
    if (error || !data) throw new AppError('download_failed', 'The file is temporarily unavailable. Try again.', 503);
    return { file, bytes: Buffer.from(await data.arrayBuffer()) };
  });
}
