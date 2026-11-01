# Разработка LMS

Канонический код и отдельный локальный Git-репозиторий — эта папка. Александр разрешил подготовку репозитория 1 ноября 2026. Исключение относится только к LMS; весь workspace в Git не помещать. Создание удалённого репозитория, push и развёртывание требуют отдельного указания.

- Начать с `README.md`, `docs/architecture.md`, `docs/agents/domain.md` и `docs/agents/usability.md`. Путь к полному ТЗ в workspace указан в `docs/DEVELOPMENT.md`; эти материалы не подменяют ТЗ.
- Готовность запуска и остаток — `docs/RELEASE-CHECKLIST.md`.
- Supabase — рабочие PostgreSQL/Auth. Локальная проверка использует отдельный PostgreSQL и тестовую почту, только синтетические данные.
- Секреты, локальная база, загрузки, зависимости — вне workspace. Не запускать развёртывание на Hetzner без отдельного указания.
- Не добавлять игнорируемые QA-артефакты/архивы через `git add -f`. До первого push повторить проверку состава и секретов; текущие тестовые доступы Supabase ещё требуют замены/отключения перед запуском.
- Границы тестов: публичные команды сервиса, реальные транзакции/права БД, HTTP и браузер. Проверять поведение, не устройство функций.
- UI на английском; документы и комментарии на русском. Без подгрупп, тьютора, оплаты и AI.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
