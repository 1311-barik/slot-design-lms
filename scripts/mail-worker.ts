// Фоновый обработчик почты: раз в минуту планирует письма и отправляет готовые.
// Запуск: LMS_MODE=local node --import tsx scripts/mail-worker.ts [--once]
import { runMail } from '../src/lib/mail';
import { sql } from '../src/lib/db';

const once = process.argv.includes('--once');
let stopping = false;
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
try {
  do {
    try {
      const result = await runMail();
      if (result.created || result.sent || result.failed || once) console.log(new Date().toISOString(), JSON.stringify(result));
    } catch (error) {
      // Сбой одного прохода не останавливает обработчик; адреса и тексты писем в журнал не пишутся.
      console.error(new Date().toISOString(), 'mail run failed', error instanceof Error ? error.name : 'unknown');
    }
    if (!once) for (let i = 0; i < 60 && !stopping; i++) await new Promise(r => setTimeout(r, 1000));
  } while (!once && !stopping);
} finally { await sql.end(); }
