// Одноразовая ссылка входа для синтетических аккаунтов @example.test на проекте Supabase — без отправки письма.
// Только для тестового прогона: встроенная почта Supabase шлёт письма лишь участникам команды проекта.
// Запуск: set -a; . ~/.config/slot-design-lms/env; set +a; node --import tsx scripts/supabase-test-link.ts someone@example.test
import { serviceClient } from '../src/lib/supabase-admin';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!/^[^@\s]+@example\.test$/.test(email)) throw new Error('Only @example.test addresses can get a test sign-in link.');
if (process.env.LMS_MODE !== 'supabase') throw new Error('Run with the Supabase environment loaded.');
const { data, error } = await serviceClient().auth.admin.generateLink({ type: 'magiclink', email });
if (error || !data.properties?.hashed_token) throw new Error(`No link: ${error?.code || error?.message || 'unknown'}`);
console.log(`${process.env.APP_ORIGIN}/?token_hash=${data.properties.hashed_token}`);
