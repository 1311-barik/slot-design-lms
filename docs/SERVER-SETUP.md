# Установка LMS на свой сервер

Инструкция для Ubuntu 24.04 с systemd и пользователем, имеющим sudo. Приложение запускается как `lms` без shell и прав администратора. Сборка — обычным пользователем. Все команды ниже выполняются на **новом целевом сервере**, а не на компьютере автора и не внутри Supabase SQL Editor.

Заменить `lms.example.org`, email и `PROJECT_REF` своими значениями. Публичный адрес должен быть доступен по HTTPS на 443. Если своего домена нет, можно использовать временное имя вида `lms-<IP-с-дефисами>.nip.io`; сначала проверить, что оно разрешается в IP сервера. Для IPv6 нужны отдельная DNS/TLS-проверка и настройки nginx; пример ниже для IPv4.

## 1. Проверить сервер и получить Git

Проверить `node --version`, `git --version`, `nginx -v`, `certbot --version`, наличие `curl`, `xz`, `tar`, `sha256sum`, `sudo`, свободные RAM/диск. Установить только недостающие пакеты. На чистой Ubuntu это обычно:

```sh
sudo apt-get update
sudo apt-get install git nginx certbot curl xz-utils ca-certificates
```

Нужен Node **24.x**. Если уже установлен подходящий системный Node, доступный пользователю `lms` вне `/home` и `/root`, использовать его через `LMS_NODE_BIN` и согласованные `ExecStart` в обоих сервисах. Иначе отдельная установка не затрагивает Node других приложений:

```sh
LMS_NODE_VERSION=24.15.0
case "$(uname -m)" in x86_64) LMS_NODE_ARCH=x64 ;; aarch64) LMS_NODE_ARCH=arm64 ;; *) exit 1 ;; esac
LMS_NODE_TMP=$(mktemp -d)
cd "$LMS_NODE_TMP"
LMS_NODE_ARCHIVE="node-v${LMS_NODE_VERSION}-linux-${LMS_NODE_ARCH}.tar.xz"
curl --fail --location --remote-name "https://nodejs.org/dist/v${LMS_NODE_VERSION}/${LMS_NODE_ARCHIVE}"
curl --fail --location --remote-name "https://nodejs.org/dist/v${LMS_NODE_VERSION}/SHASUMS256.txt"
grep " ${LMS_NODE_ARCHIVE}$" SHASUMS256.txt > checksum.txt
sha256sum --check checksum.txt
# Продолжить только после OK. Каталог должен быть новым; существующую установку не перетирать.
sudo install -d -m 0755 "/opt/slot-design-node-v${LMS_NODE_VERSION}"
sudo tar -xJf "$LMS_NODE_ARCHIVE" --strip-components=1 -C "/opt/slot-design-node-v${LMS_NODE_VERSION}"
sudo ln -s "/opt/slot-design-node-v${LMS_NODE_VERSION}" /opt/slot-design-node
export PATH="/opt/slot-design-node/bin:$PATH"
node --version
cd ~
```

Если ссылка `/opt/slot-design-node` уже есть, проверить её назначение; не заменять вслепую. В следующих SSH-сессиях снова добавить этот каталог в PATH. При обновлении Node согласовать его с `.nvmrc` и повторить проверки.

Репозиторий публичный: для клонирования по HTTPS не нужны GitHub CLI, токен или приглашение. Право записи в основной репозиторий для установки не требуется.

```sh
git clone https://github.com/1311-barik/slot-design-lms.git
cd slot-design-lms
git rev-parse HEAD
npm ci
```

Выбрать согласованный commit с зелёным Actions; при необходимости `git checkout <commit>`. Не копировать зависимости или `.next` с Mac. Серверу нужен исходящий доступ к GitHub, npm и Supabase.

## 2. Создать служебные каталоги и окружение

Убедиться, что имя `lms`, каталог `/opt/slot-design-lms` и сервисы с этим именем не заняты другой установкой. Для второй LMS на том же сервере нужны отдельные имена, пути и порт; этот сценарий шаблон автоматически не настраивает.

```sh
sudo useradd --system --home-dir /var/lib/slot-design-lms --shell /usr/sbin/nologin lms
sudo install -d -m 0755 /opt/slot-design-lms/releases
sudo install -d -o lms -g lms -m 0750 /var/lib/slot-design-lms
sudo install -d -m 0700 /etc/slot-design-lms
sudo install -m 0600 .env.example /etc/slot-design-lms/env
sudoedit /etc/slot-design-lms/env
```

Заполнить все обязательные значения. `APP_ORIGIN=https://ВАШЕ-ИМЯ` **без завершающего `/`**; `LMS_MODE=supabase`. Для БД — Session pooler **5432**, пользователь `lms_backend.PROJECT_REF`, либо direct connection `db.PROJECT_REF.supabase.co` с пользователем `lms_backend`. Direct может требовать IPv6. Хост pooler берётся из Connect конкретного проекта, не выводится из примера. Специальные символы пароля в URL должны быть percent-encoded. Требуется `sslmode=require` либо проверка сертификата через `verify-full` с настроенным CA. [Типы подключений Supabase](https://supabase.com/docs/guides/database/connecting-to-postgres).

`SUPABASE_ANON_KEY` — публичный anon/publishable key. `SUPABASE_SERVICE_ROLE_KEY` — серверный service_role/secret key, никогда не `NEXT_PUBLIC_*`. Приватный бакет указан в `SUPABASE_STORAGE_BUCKET`. В файле окружения использовать простой `NAME=value`, без `export` и команд shell; не выполнять его через `source`. `MAIL_PROVIDER` пока пустой. Реальный файл не хранить в клоне Git.

### Ветка A: существующий Supabase — перенос текущей LMS

Получить значения через защищённый канал от владельца, изменить только публичный адрес и локальный runtime-каталог. Сохранить прежний Supabase project ref и бакет. Не запускать `db:setup` и не загружать seed. Данные уже находятся в Supabase. При той же версии миграций административный пароль для запуска не нужен.

Проверить версию схемы и выбранный commit с владельцем. Если код требует новые миграции — выполнить раздел «Обновление» с отдельным административным подключением и резервной копией.

### Ветка B: новый пустой Supabase — самостоятельная установка

Владелец создаёт hosted-проект Supabase, сохраняет пароль БД, project ref и API-ключи. PostgreSQL 17 текущего рабочего проекта совместим; PostgreSQL 16 проверяется в CI. Self-hosted Supabase этим комплектом не разворачивается.

В настройках Auth отключить публичную самостоятельную регистрацию, оставить email-вход. В Data API **не включать схему `lms`** в Exposed schemas. Создать административное окружение:

```sh
sudo install -m 0600 .env.admin.example /etc/slot-design-lms/admin.env
sudoedit /etc/slot-design-lms/admin.env
```

Заполнить те же значения проекта, но `DATABASE_URL` с ролью **postgres**, а не `lms_backend`. Выбрать настоящий email первого администратора и срок его доступа; адреса ниже — примеры. Подготовка создаст схему, приватный бакет, неопубликованные задания, семь встреч курса и указанный административный аккаунт. Писем не отправляет. Реальных пользователей и работы со старого проекта не копирует.

```sh
sudo /opt/slot-design-node/bin/node --env-file=/etc/slot-design-lms/admin.env --import tsx scripts/supabase-setup.ts \
  --project-ref PROJECT_REF --admin owner@example.org "Course administrator" --access-until 2027-02-11
```

Для эксперта можно добавить `--reviewer expert@example.org "Course expert"` с реальным адресом. Первый указанный эксперт назначается на задания без ответственного. Существующие профили, задания и сроки повторный запуск не перезаписывает. Не использовать эту команду для обычного обновления кода.

Миграция создаёт `lms_backend` без возможности входа. Установить пароль интерактивно через `psql` (клиент PostgreSQL должен быть установлен; для dump нужен клиент не старее сервера):

```sh
sudo /opt/slot-design-node/bin/node --env-file=/etc/slot-design-lms/admin.env --import tsx scripts/db-tool.ts --project-ref PROJECT_REF -- psql
```

Внутри `psql`:

```sql
ALTER ROLE lms_backend LOGIN;
\password lms_backend
\q
```

Вставить этот пароль в **runtime** `/etc/slot-design-lms/env` через `sudoedit`, с URL-кодированием. Не заменять ограниченную роль на postgres. Административный env нужен только ответственному за миграции и резервирование; сервис его не читает.

## 3. Проверить настройки и установить приложение

Из корня клона:

```sh
sudo /opt/slot-design-node/bin/node --env-file=/etc/slot-design-lms/env --import tsx scripts/check-deployment.ts --project-ref PROJECT_REF
sudo install -m 0644 docs/deployment/slot-design-lms.service.example /etc/systemd/system/slot-design-lms.service
sudo install -m 0644 docs/deployment/slot-design-lms-mail.service.example /etc/systemd/system/slot-design-lms-mail.service
sudo systemctl daemon-reload
bash scripts/deploy.sh https://lms.example.org
```

Проверка читает права БД, доступность приватного бакета, запрет Data API и количество ожидающих писем; ничего не отправляет и не меняет. При ошибке исправить настройки до запуска. Ограничения по проекту и роли проверяются до подключения; в сообщениях нет пароля.

`deploy.sh` собирает только чистый сохранённый commit, устанавливает root-owned release, включает автозапуск и ждёт ответа приложения. Рабочие секреты в сборку не передаются. Код не доступен `lms` для записи, кэш и runtime доступны. Node-зависимости `tsx` нужны почтовому процессу — **не выполнять `npm prune --omit=dev`**. Это обычная сборка Next.js, не standalone-пакет.

Откат кода при неудачной активации автоматический, если была предыдущая версия. При первом неудачном запуске сервис останавливается. Скрипт не настраивает DNS/TLS и не проверяет вход по почте. Почтовый сервис установлен, но ещё не запущен и не включён.

## 4. Настроить HTTPS

Задать A-запись имени на IP сервера и проверить её снаружи. Открыть входящие 80/443 и сохранить доступ SSH в firewall сервера и провайдера. Порт 8787 и PostgreSQL наружу не открывать. Не заменять общую конфигурацию nginx и чужие сайты.

В шаблонах заменить все `lms.example.org` настоящим именем. Для первого сертификата:

```sh
sudo install -d -m 0755 /var/www/letsencrypt
sudo install -m 0644 docs/deployment/nginx-http.conf.example /etc/nginx/sites-available/slot-design-lms
sudoedit /etc/nginx/sites-available/slot-design-lms
sudo ln -s /etc/nginx/sites-available/slot-design-lms /etc/nginx/sites-enabled/slot-design-lms
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt -d lms.example.org --email admin@example.org --agree-tos --no-eff-email
```

После успешной выдачи заменить сайт на TLS-шаблон, снова вписать правильное имя в `server_name` и пути сертификата:

```sh
sudo install -m 0644 docs/deployment/nginx.conf.example /etc/nginx/sites-available/slot-design-lms
sudoedit /etc/nginx/sites-available/slot-design-lms
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run
sudo systemctl status certbot.timer --no-pager
```

Настроить reload nginx после обновления сертификата: executable-файл `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx` с содержимым `#!/bin/sh` и следующей строкой `systemctl reload nginx`. Проверить его запуск. Для необычного имени сертификата использовать фактический путь из `certbot certificates`. После перезагрузки проверить автозапуск nginx и LMS.

## 5. Настроить вход и принять установку

В Supabase → Authentication → URL Configuration:

- Site URL: `https://lms.example.org/`.
- Redirect URLs: точные `https://lms.example.org` и `https://lms.example.org/`. Во время переноса прежний рабочий адрес оставить до окончания проверки; localhost убрать из рабочего списка.
- Настроить SMTP Supabase Auth для писем входа. Это отдельно от почты курса в env приложения. Использовать свежую ссылку из нового сайта в том же браузере, где её запросили.

Проверить с внешнего компьютера:

```sh
curl --fail https://lms.example.org/api/v1/config
# Ожидается {"local":false}.
curl -s -o /dev/null -w '%{http_code}\n' https://lms.example.org/api/v1/workspace
# Ожидается 401 без входа.
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://wrong.example.org' \
  -H 'Content-Type: application/json' -d '{}' https://lms.example.org/api/v1/auth/link
# Ожидается 403.
```

Затем войти реальным администратором, проверить расписание/права, на согласованных тестовых аккаунтах пройти сдачу с вложением → эксперт → доработка → повторная сдача. Проверить приватность черновика и чужого файла, мобильный браузер. В новой установке сначала назначить экспертов, материалы и сроки, затем публиковать задания. Записать адрес, commit и результаты. Полная приёмка — [RELEASE-CHECKLIST](RELEASE-CHECKLIST.md).

## Почта курса

Не включать обработчик, пока не проверены `MAIL_PROVIDER`, отправитель, SMTP/Brevo и очередь. `check-deployment.ts` показывает pending/sending; историю и получателей проверить в административном разделе Notifications. Для отмены ошибочных pending-записей ответственный администратор БД должен отдельно отобрать конкретные ID и зафиксировать решение — массовая отправка или очистка при установке не выполняется.

После согласованного контрольного прогона на одном адресе, разбора всей очереди и остановки прежнего обработчика:

```sh
sudo touch /etc/slot-design-lms/mail-enabled
sudo systemctl enable --now slot-design-lms-mail.service
```

Отключение: `sudo systemctl disable --now slot-design-lms-mail.service`, затем удалить только маркер `mail-enabled`. Почтовые ключи, корректность получателей и результаты доставки проверяются отдельно; успешный запуск процесса их не доказывает.

## Обновление и откат

Сначала выбрать commit с успешным CI и прочитать изменения миграций. Снять резервную копию. На время несовместимого изменения схемы остановить LMS и почту, согласовав окно работ; **не запускать два мигратора одновременно**. Для обновления обычной ветки:

```sh
git switch main
git pull --ff-only
npm ci
# Только если новая версия содержит неприменённые миграции, с проверенным PROJECT_REF:
sudo /opt/slot-design-node/bin/node --env-file=/etc/slot-design-lms/admin.env --import tsx scripts/migrate-production.ts --project-ref PROJECT_REF
bash scripts/deploy.sh https://lms.example.org
```

Команда миграций не создаёт учебные или тестовые данные. Каждая миграция выполняется в транзакции; предыдущие успешно выполненные миграции при последующей ошибке остаются применёнными. Если env или сервисы изменились, применить их изменения отдельно и повторить `check-deployment.ts`. После обновления повторить HTTPS и контрольный пользовательский сценарий.

Список версий: `ls -1 /opt/slot-design-lms/releases`; активный commit: `cat /opt/slot-design-lms/current/DEPLOYED_COMMIT`. Для ручного возврата выбрать существующий каталог вида `12-символов-SHA-YYYYMMDDhhmmss`:

```sh
bash scripts/deploy.sh https://lms.example.org --rollback RELEASE_NAME
```

Откат меняет **код**, сохраняя env и данные. Если новая схема несовместима со старым кодом, сначала план восстановления данных, затем переключение; автоматического обратного выполнения SQL нет. Не удалять текущую и предыдущую рабочую версии. Старые каталоги убираются вручную после окна отката и проверки свободного места.

## Диагностика

```sh
sudo systemctl status slot-design-lms.service --no-pager
sudo journalctl -u slot-design-lms.service -n 80 --no-pager
sudo nginx -t
curl --fail -H 'Host: lms.example.org' http://127.0.0.1:8787/api/v1/config
```

502 — проверить сервис, Node, env и порт; 403 — совпадение Host/Origin с `APP_ORIGIN`; возврат на localhost — запросить новую ссылку после исправления Auth URL. Ошибка соединения с БД — сеть, Session pooler 5432, пользователь проекта и пароль, без переключения приложения на postgres. Не публиковать полные логи до удаления адресов, токенов и содержимого работ.

Если после аварии осталась `/opt/slot-design-lms/.deploy-lock`, сначала убедиться, что развёртывание больше не идёт, проверить `current` и возможную `current.next`; затем вручную убрать только подтверждённо устаревшие lock/temporary symlink. Одновременный deploy запрещён. Резервирование и восстановление описаны [отдельно](BACKUP-RESTORE.md).
