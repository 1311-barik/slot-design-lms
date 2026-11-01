import { readFile, readdir } from 'node:fs/promises';
import type postgres from 'postgres';

// Миграции применяются по порядку и записываются в lms.migrations; каждая — в своей транзакции.
// Одна и та же процедура для локальной БД и Supabase, без тестовых данных.
export async function migrate(sql: postgres.Sql) {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const [exists] = await sql`select to_regnamespace('lms') is not null as present`;
  if (!exists.present) await sql.begin(async tx => { await tx.unsafe(await readFile(new URL('001_core.sql', dir), 'utf8')); });
  await sql`create table if not exists lms.migrations(name text primary key, applied_at timestamptz not null default now())`;
  await sql`insert into lms.migrations(name) values('001_core.sql') on conflict do nothing`;
  const applied: string[] = [];
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
    const [done] = await sql`select name from lms.migrations where name=${name}`;
    if (done) continue;
    await sql.begin(async tx => {
      await tx.unsafe(await readFile(new URL(name, dir), 'utf8'));
      await tx`insert into lms.migrations(name) values(${name})`;
    });
    applied.push(name);
  }
  return applied;
}
