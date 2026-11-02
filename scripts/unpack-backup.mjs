#!/usr/bin/env node
// Расшифровать и проверить комплект в новом закрытом каталоге; БД не изменяет.
import { createDecipheriv, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const [archiveArg, targetArg] = process.argv.slice(2);
if (!archiveArg || !targetArg) throw new Error('Usage: node scripts/unpack-backup.mjs ARCHIVE NEW_TARGET_DIRECTORY');
const archive = resolve(archiveArg);
const target = resolve(targetArg);
const keyPath = process.env.LMS_BACKUP_KEY_FILE || join(homedir(), '.config/slot-design-lms/backup-key');
const key = await readFile(keyPath);
if (key.length !== 32 || (await stat(keyPath)).mode & 0o077) throw new Error('Backup key is invalid or readable by others');
const handle = await open(archive, 'r');
let size, start, tag;
try {
  size = (await handle.stat()).size;
  if (size < 36) throw new Error('Archive is truncated');
  start = Buffer.alloc(20); tag = Buffer.alloc(16);
  await handle.read(start, 0, 20, 0);
  await handle.read(tag, 0, 16, size - 16);
} finally { await handle.close(); }
if (start.subarray(0, 8).toString() !== 'LMSBAK02') throw new Error('Unsupported archive format');
const tmp = await mkdtemp(join(tmpdir(), 'slot-lms-unpack-'));
await chmod(tmp, 0o700);
const zipPath = join(tmp, 'backup.zip');
try {
  const decipher = createDecipheriv('aes-256-gcm', key, start.subarray(8, 20));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(archive, { start: 20, end: size - 17 }), decipher, createWriteStream(zipPath, { mode: 0o600 }));
  await new Promise((resolveDone, reject) => {
    const child = spawn('unzip', ['-tq', zipPath], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveDone() : reject(new Error('Archive ZIP verification failed')));
  });
  // Результат создаётся только в новом каталоге, чтобы не перезаписать рабочие данные.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(target, { mode: 0o700 });
  await new Promise((resolveDone, reject) => {
    const child = spawn('unzip', ['-q', zipPath, '-d', target], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveDone() : reject(new Error('Archive extraction failed')));
  });
  const manifest = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'));
  if (manifest.format !== 2 || !Array.isArray(manifest.objects)) throw new Error('Invalid backup manifest');
  async function digest(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
  }
  if (manifest.database.file !== 'database.dump' || await digest(join(target, 'database.dump')) !== manifest.database.sha256) throw new Error('Database checksum mismatch');
  for (const file of manifest.objects) {
    if (!/^objects\/\d{6}\.bin$/.test(file.file)) throw new Error('Invalid object name in manifest');
    const path = join(target, file.file);
    if ((await stat(path)).size !== file.size || await digest(path) !== file.sha256) throw new Error('Object checksum mismatch');
  }
  console.log(`Backup unpacked and verified: ${target}; objects=${manifest.objects.length}`);
} finally { await rm(tmp, { recursive: true, force: true }); }
