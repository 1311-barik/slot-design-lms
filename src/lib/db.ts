import postgres from 'postgres';
export const sql = postgres(process.env.DATABASE_URL || 'postgres://shura@127.0.0.1:54431/igaming_lms', { max: 6, prepare: false, idle_timeout: 15 });
export type Tx = postgres.TransactionSql;
export async function transaction<T>(actor: string, operation: (tx: Tx) => Promise<T>): Promise<T> {
  const result = await sql.begin(async tx => {
    await tx`set local role lms_runtime`;
    await tx`select set_config('app.actor', ${actor}, true)`;
    // Общий ключ для команды и отзыва доступа; RLS не требует права UPDATE профиля.
    await tx`select pg_advisory_xact_lock(hashtextextended(${actor},0))`;
    const [profile] = await tx`select * from lms.profiles where id=${actor}`;
    if (!profile || !profile.activated_at || profile.revoked_at || new Date(profile.access_ends_at).getTime() <= Date.now()) {
      const { AppError } = await import('./contract');
      throw new AppError('access_expired', 'Course access is not active. Contact the administrator.', 403);
    }
    return operation(tx);
  });
  return result as T;
}
