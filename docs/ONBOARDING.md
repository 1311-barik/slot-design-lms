# Первый вход участника

Курс: Slot Design · From Idea to Release. Рабочий сайт: `https://lms-135-181-197-13.nip.io/` до выбора постоянного домена. Это инструкция для команды; участнику отправляется только письмо ниже.

## Образец письма

**From:** Slot Design `<a.barskiy@talentgrator.com>`  
**Subject:** Welcome to Slot Design — your course access

> Hi [first name],
>
> Welcome to Slot Design. Your course access is ready.
>
> Open your personal sign-in link:  
> [one-time sign-in link]
>
> Choose **Continue to course**, create your password, and Module 0 will open with seven introductory videos and English subtitles. Next time, sign in with your email and password.
>
> The link is for you only, works once, and expires soon. If it has expired, request a new link on the LMS sign-in page.
>
> Our first live session is on Sunday, 15 November 2026, at 15:00 CET. [If the calendar has changed, the LMS inserts the next scheduled session instead.]
>
> See you in the course,  
> Slot Design team

В рабочем письме LMS подставляет имя, персональную ссылку, ближайшее занятие и срок доступа. В квадратных скобках здесь показаны поля образца; их не нужно копировать в отправку вручную. Фактический шаблон — `src/lib/mail.ts`, событие `enrollment.invited`.

## Что происходит автоматически

1. Администратор вводит email участника и дату окончания доступа в **People & course access**. Имя можно оставить пустым: интерфейс составит его из адреса. LMS создаёт вход Supabase Auth без пароля и профиль участника, затем ставит приветствие в очередь.
2. Почтовый обработчик перед отправкой проверяет доступ, генерирует одноразовую ссылку Supabase Auth, вставляет её в письмо и отправляет через SMTP `a.barskiy@talentgrator.com`. Токен не хранится в БД или журналах.
3. Студент открывает письмо в своём браузере и нажимает **Continue to course**. До создания пароля сервер выдаёт только экран настройки пароля; содержимое курса, видео и команды закрыты.
4. После сохранения пароля открывается **Module 0**. Семь MP4 и дорожки VTT находятся в приватном Storage, видео передаётся через проверяющий доступ серверный endpoint. По запросу новой ссылки используется тот же почтовый обработчик и SMTP; отдельная отправка Supabase Auth не нужна.

VTT созданы автоматическим распознаванием; формат и синхронизация проверены, но перед началом потока нужна редакторская вычитка терминов и имён по исходной речи.

Если обработчик выключен, приглашение остаётся в очереди и письмо не уходит. Экран **Email** показывает состояние отправки; `sent` означает принятие SMTP, а не факт прочтения письма. При неопределённом ответе провайдера обработчик не повторяет отправку автоматически.

## Перед первым адресом

- В защищённом серверном env заданы `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=a.barskiy@talentgrator.com`, `SMTP_PASSWORD` и `MAIL_FROM=a.barskiy@talentgrator.com`. `MAIL_PROVIDER=smtp` пока не задан: автоматическая отправка не разрешена. Пароль приложения хранится только на сервере в закрытом env и в менеджере паролей владельца; в Git и отчётах его нет.
- SMTP-аутентификация прошла; одно контрольное письмо на согласованный адрес принято SMTP и получено Александром. Перед попыткой включения были только 16 старых `cancelled`, а `pending`, `sending` и необработанных событий — 0. Повторить проверку очереди непосредственно перед включением.
- Постоянное включение требует отдельного явного разрешения на будущие письма. После него установить `MAIL_PROVIDER=smtp`, создать защитный маркер `/etc/slot-design-lms/mail-enabled` и включить `slot-design-lms-mail.service`; до этого служба и маркер остаются выключенными.
- Для реального приглашения нужен email участника; имя желательно, но необязательно. После регистрации проверить в **Email** статус конкретного приглашения и затем пройти вход на телефоне.

Технические шаги включения службы и защита очереди — [DEPLOYMENT](DEPLOYMENT.md). Ограничения запуска — [RELEASE-CHECKLIST](RELEASE-CHECKLIST.md).
