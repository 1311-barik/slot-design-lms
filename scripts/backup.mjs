#!/usr/bin/env node
// Полный зашифрованный снимок БД и приватного бакета. Запускать с защищённым env.
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, chmod, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const base = process.env.LMS_BACKUP_DIR || join(homedir(), '.local/share/slot-design-lms/backups');
const keyPath = process.env.LMS_BACKUP_KEY_FILE || join(homedir(), '.config/slot-design-lms/backup-key');
const pgDump = process.env.PG_DUMP_BIN || '/opt/homebrew/opt/postgresql@17/bin/pg_dump';
const magic = Buffer.from('LMSBAK02');
const output = join(base, `${stamp}.aesgcm`);
const statusPath = join(base, 'status.json');
let work;

async function run(bin, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let err = '';
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-3000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err}`)));
  });
}

async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  if (!process.env.DATABASE_URL || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_STORAGE_BUCKET) throw new Error('Backup configuration is incomplete');
  const key = await readFile(keyPath);
  if (key.length !== 32) throw new Error('Backup key must be exactly 32 bytes');
  const keyStat = await stat(keyPath);
  if (keyStat.mode & 0o077) throw new Error('Backup key permissions are too broad');
  await mkdir(base, { recursive: true, mode: 0o700 });
  await chmod(base, 0o700);
  work = await mkdtemp(join(tmpdir(), 'slot-lms-backup-'));
  await chmod(work, 0o700);
  const dbPath = join(work, 'database.dump');
  const dbUrl = new URL(process.env.DATABASE_URL);
  const password = decodeURIComponent(dbUrl.password);
  dbUrl.password = '';
  let dumpError;
  let databaseAttempts = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    databaseAttempts = attempt;
    try {
      await run(pgDump, ['--dbname', dbUrl.toString(), '--format=custom', '--schema=lms', '--schema=auth', '--schema=storage', '--file', dbPath], { env: { ...process.env, PGPASSWORD: password, PGCONNECT_TIMEOUT: '20' }, timeout: 240_000 });
      dumpError = undefined;
      break;
    } catch (error) {
      dumpError = error;
      if (attempt < 3) { console.warn(`Database export attempt ${attempt} failed; retrying`); await delay(15_000 * attempt); }
    }
  }
  if (dumpError) throw dumpError;
  await run(pgDump.replace(/pg_dump$/, 'pg_restore'), ['--list', dbPath]);
  const db = postgres(process.env.DATABASE_URL, { max: 1 });
  let objects;
  try {
    objects = await db`select name from storage.objects where bucket_id=${process.env.SUPABASE_STORAGE_BUCKET} order by name`;
  } finally { await db.end(); }
  const filesDir = join(work, 'objects');
  await mkdir(filesDir, { mode: 0o700 });
  const files = [];
  for (let i = 0; i < objects.length; i++) {
    const object = objects[i];
    const encoded = object.name.split('/').map(encodeURIComponent).join('/');
    const url = `${process.env.SUPABASE_URL}/storage/v1/object/authenticated/${encodeURIComponent(process.env.SUPABASE_STORAGE_BUCKET)}/${encoded}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, apikey: process.env.SUPABASE_SERVICE_ROLE_KEY } });
    if (!response.ok || !response.body) throw new Error(`Storage download failed: ${response.status}`);
    const saved = `${String(i).padStart(6, '0')}.bin`;
    const path = join(filesDir, saved);
    await pipeline(response.body, createWriteStream(path, { mode: 0o600 }));
    files.push({ key: object.name, file: `objects/${saved}`, size: (await stat(path)).size, sha256: await sha(path) });
  }
  const manifest = { format: 2, createdAt: new Date().toISOString(), bucket: process.env.SUPABASE_STORAGE_BUCKET, database: { file: 'database.dump', sha256: await sha(dbPath) }, objects: files };
  await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  const zipPath = join(tmpdir(), `slot-lms-${stamp}-${process.pid}.zip`);
  try {
    await run('zip', ['-q', '-0', '-r', zipPath, '.'], { cwd: work });
    const nonce = randomBytes(12);
    const partial = `${output}.partial`;
    await writeFile(partial, Buffer.concat([magic, nonce]), { mode: 0o600, flag: 'wx' });
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    await pipeline(createReadStream(zipPath), cipher, createWriteStream(partial, { flags: 'a', mode: 0o600 }));
    await appendFile(partial, cipher.getAuthTag());
    // Проверяем расшифрование и структуру архива до публикации имени файла.
    const encryptedSize = (await stat(partial)).size;
    if (encryptedSize < 36) throw new Error('Backup is truncated');
    const start = Buffer.alloc(20);
    const tag = Buffer.alloc(16);
    const { open } = await import('node:fs/promises');
    const handle = await open(partial, 'r');
    try {
      await handle.read(start, 0, 20, 0);
      await handle.read(tag, 0, 16, encryptedSize - 16);
    } finally { await handle.close(); }
    if (!start.subarray(0, 8).equals(magic)) throw new Error('Backup header is invalid');
    const decipher = createDecipheriv('aes-256-gcm', key, start.subarray(8, 20));
    decipher.setAuthTag(tag);
    const verifyPath = join(work, 'verify.zip');
    await pipeline(createReadStream(partial, { start: 20, end: encryptedSize - 17 }), decipher, createWriteStream(verifyPath, { mode: 0o600 }));
    await run('unzip', ['-tq', verifyPath]);
    await rename(partial, output);
    if (process.env.LMS_BACKUP_REMOTE) {
      if (!process.env.LMS_BACKUP_SSH_KEY) throw new Error('Backup remote SSH key is not configured');
      await run('scp', ['-i', process.env.LMS_BACKUP_SSH_KEY, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', output, `${process.env.LMS_BACKUP_REMOTE}/${stamp}.aesgcm`]);
    }
    await writeFile(statusPath, JSON.stringify({ lastSuccess: new Date().toISOString(), archive: output, objects: files.length, bytes: (await stat(output)).size, remoteCopied: Boolean(process.env.LMS_BACKUP_REMOTE), databaseAttempts }, null, 2), { mode: 0o600 });
    console.log(`Backup verified: ${output}; objects=${files.length}`);
  } finally {
    await rm(zipPath, { force: true });
  }
}

try { await main(); }
catch (error) {
  console.error(`Backup failed: ${error.message.replace(/\/\/[^\s@]+@/g, '//[redacted]@')}`);
  if (base) {
    await mkdir(base, { recursive: true, mode: 0o700 }).catch(() => {});
    const previous = await readFile(statusPath, 'utf8').then(JSON.parse).catch(() => ({}));
    await writeFile(statusPath, JSON.stringify({ ...previous, lastFailure: new Date().toISOString(), error: 'Backup failed; inspect restricted log' }), { mode: 0o600 }).catch(() => {});
  }
  process.exitCode = 1;
} finally { if (work) await rm(work, { recursive: true, force: true }); }
