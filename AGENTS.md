# Разработка LMS

Канонический код и отдельный Git-репозиторий — эта папка. Александр разрешил создание приватного `1311-barik/slot-design-lms` и первый push 1 ноября 2026; размещение в личном аккаунте временное, затем перенос в организацию компании. Исключение относится только к LMS; весь workspace в Git не помещать. Затем Александр отдельно поручил размещение на Hetzner по пяти пунктам подготовки запуска; оно выполнено с временным HTTPS-адресом. Изменения вне этой задачи требуют нового указания.

- Начать с `README.md`, `docs/architecture.md`, `docs/agents/domain.md` и `docs/agents/usability.md`. Путь к полному ТЗ в workspace указан в `docs/DEVELOPMENT.md`; эти материалы не подменяют ТЗ.
- 2 ноября Александр поручил подготовить передачу через Git на другие серверы. Инструкция получателю — `docs/HANDOFF.md`, переносимый запуск — `docs/SERVER-SETUP.md`. Позднее 2 ноября Александр прямо поручил сделать репозиторий публичным: чтение и клонирование открыты. Доступы к Supabase, серверу и почте остаются отдельными.
- Готовность запуска и остаток — `docs/RELEASE-CHECKLIST.md`.
- Supabase — рабочие PostgreSQL/Auth. Локальная проверка использует отдельный PostgreSQL и тестовую почту, только синтетические данные.
- Секреты, локальная база, загрузки, зависимости — вне workspace. Текущее размещение и ограничения — `docs/DEPLOYMENT.md`.
- Не добавлять игнорируемые QA-артефакты/архивы через `git add -f`. Проверять состав и секреты перед push; четыре старых и три временных QA-аккаунта отключены, пароли заменены. Не восстанавливать их доступ без конкретной тестовой задачи.
- Границы тестов: публичные команды сервиса, реальные транзакции/права БД, HTTP и браузер. Проверять поведение, не устройство функций.
- UI на английском; документы и комментарии на русском. Без подгрупп, тьютора, оплаты и AI.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
