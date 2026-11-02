import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { sql } from '../src/lib/db';
import { command } from '../src/lib/service';
import { uploadFile } from '../src/lib/files';

const videos = [
  ['0.0 Ricardo Viana intro.mp4', 'Welcome from the course author'],
  ['1.0 The Course Introduction.mp4', 'The Course Introduction'],
  ['2.0 Final Project Expectations.mp4', 'Final Project Expectations'],
  ['2.1 Final Project Maths.mp4', 'Final Project Maths'],
  ['2.2 Final Project Developing Hand-off .mp4', 'Final Project Developing Hand-off'],
  ['3.0 Ideas Development.mp4', 'Ideas Development'],
  ['3.1 What do you need to start?.mp4', 'What do you need to start?'],
] as const;

const [directory, projectRef, adminEmail, subtitleDirectory] = process.argv.slice(2);
if (!directory || !projectRef || !adminEmail) throw new Error('Usage: import-module-zero <video-directory> <Supabase-project-ref> <admin-email> [subtitle-directory]');
if (process.env.LMS_MODE !== 'supabase' || new URL(process.env.SUPABASE_URL || '').hostname !== `${projectRef}.supabase.co`) throw new Error('The Supabase project does not match the explicit project ref.');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_STORAGE_BUCKET) throw new Error('Private Storage is not configured.');
if (!resolve(directory).endsWith('/Module 0')) throw new Error('Choose the source directory named Module 0.');

try {
  const [admin] = await sql`select id from lms.profiles where email=${adminEmail.toLowerCase()} and role='admin' and revoked_at is null and access_ends_at>now()`;
  if (!admin) throw new Error('The specified active administrator is not in this LMS.');
  for (const [name] of videos) {
    const path = join(directory, name);
    const details = await stat(path);
    if (!details.isFile() || details.size < 1000 || details.size > 50_000_000 || basename(path) !== name) throw new Error(`Invalid source video: ${name}`);
    if (subtitleDirectory) {
      const caption = name.replace(/\.mp4$/, '.vtt');
      const subtitle = await stat(join(subtitleDirectory, caption));
      if (!subtitle.isFile() || subtitle.size < 100 || subtitle.size > 1_000_000) throw new Error(`Invalid subtitle file: ${caption}`);
    }
  }
  const existing = await sql`select id,title from lms.materials where module=0`;
  if (existing.some(m => !videos.some(([, title]) => title === m.title))) throw new Error('Module 0 contains an unexpected material. Review it before importing.');
  for (let index = 0; index < videos.length; index++) {
    const [name, title] = videos[index];
    const details = await stat(join(directory, name));
    const [known] = await sql`select id,size from lms.files where owner_id=${admin.id} and name=${name} and mime='video/mp4' order by created_at desc limit 1`;
    if (known && known.size !== details.size) throw new Error(`An existing video has different size: ${name}`);
    const file = known || await uploadFile(admin.id, name, await readFile(join(directory, name)));
    let captionFile: { id: string } | null = null;
    if (subtitleDirectory) {
      const caption = name.replace(/\.mp4$/, '.vtt');
      const bytes = await readFile(join(subtitleDirectory, caption));
      const [stored] = await sql`select id,size from lms.files where owner_id=${admin.id} and name=${caption} and mime='text/vtt' order by created_at desc limit 1`;
      if (stored && stored.size !== bytes.length) throw new Error(`An existing subtitle has different size: ${caption}`);
      const uploaded = stored || await uploadFile(admin.id, caption, bytes);
      captionFile = { id: String(uploaded.id) };
    }
    const [old] = await sql`select * from lms.materials where module=0 and title=${title}`;
    const attached = old ? await sql`select file_id from lms.material_files where material_id=${old.id}` : [];
    if (old && old.published && attached.some(f => f.file_id === file.id) && (!captionFile || attached.some(f => f.file_id === captionFile.id))) { console.log(`Already published: ${title}`); continue; }
    const id = old?.id || crypto.randomUUID();
    const saved = await command(admin.id, 'material.save', {
      id, expectedRevision: old?.revision || 0, module: 0, position: index + 1,
      audience: 'participant', title, body: old?.body || 'Watch this video before our first live session.',
      links: old?.links || [], published: true, opensAt: null,
      files: [...new Set([...attached.map(f => f.file_id), file.id, ...(captionFile ? [captionFile.id] : [])])],
    });
    console.log(`Published: ${saved.title} (${Math.round(details.size / 1024)} KiB)`);
  }
  const [result] = await sql`select count(*)::int as total from lms.materials m join lms.material_files mf on mf.material_id=m.id join lms.files f on f.id=mf.file_id where m.module=0 and m.published and m.audience='participant' and f.mime='video/mp4'`;
  if (result.total !== videos.length) throw new Error(`Expected ${videos.length} published videos, found ${result.total}.`);
  console.log(`Verified ${result.total} published Module 0 videos.`);
  if (subtitleDirectory) {
    const [captions] = await sql`select count(*)::int as total from lms.materials m join lms.material_files mf on mf.material_id=m.id join lms.files f on f.id=mf.file_id where m.module=0 and m.published and f.mime='text/vtt'`;
    if (captions.total !== videos.length) throw new Error(`Expected ${videos.length} subtitle tracks, found ${captions.total}.`);
    console.log(`Verified ${captions.total} attached English subtitle tracks.`);
  }
} finally {
  await sql.end();
}
