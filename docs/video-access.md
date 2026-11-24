# Просмотр видео без отдельной загрузки

Решение Александра от 23 ноября 2026: студенту не показывается скачивание видео и не разрешается прямая загрузка MP4. В обычном кабинете участника и в административном `View as student` действуют одинаковые правила.

- Плеер передаёт браузеру `controlsList=nodownload`; для участника отключено контекстное меню видео и отсутствует запасная ссылка скачивания. Поддержка скрытия встроенной кнопки зависит от браузера.
- Серверный `/api/v1/files/:id/download` отклоняет MP4 с HTTP 403 для всех, кроме администратора, до чтения объекта из хранилища. Документы и другие разрешённые файлы сохраняют возможность скачивания.
- Просмотр и перемотка работают через существующий `/play` с проверкой доступа и Range. Ссылки приватного хранилища остаются внутри сервера. Просроченный/отозванный доступ, неопубликованные материалы и обязательный отзыв продолжают ограничивать просмотр.
- Администратор в собственном кабинете сохраняет доступ к исходному видео. При предпросмотре выбранного участника применяется его ограничение.

Это ограничение интерфейса и отдельной загрузки, а не DRM и не абсолютная защита от копирования. Пользователь, которому разрешён просмотр, технически может сохранить передаваемые данные или записать экран. Не описывать доработку как невозможность любого скачивания или копирования.

Проверки: `video-player.test.ts` проверяет разметку реального плеера, отсутствие ссылки скачивания и сохранение субтитров/повторного просмотра; `content.test.ts` проверяет права на MP4 и сохранение административного доступа; `student-preview.integration.ts` проверяет HTTP 403 для обычного скачивания и обхода через captions, HTTP 206 при просмотре, режим предпросмотра и административный download. Фактическую установку и визуальную проверку рабочего сайта подтверждать отдельно от готовности кода.

## Release correction, 24 November 2026

The previous installer correctly refused to replace the newer homework-submission release. This version is based on the confirmed installed commit `0034550155ba5481095bf963dcac3cdb694557a8`, also the current GitHub main branch. It preserves the updated Module 2 submission form, acceptance of HTTPS links, unpublished-deadline labels, revised mail scheduling, module feedback and complete student preview. Only the previously authorized video-download restriction and its tests are reapplied.

The owner has explicitly authorized publication of this video-access change and installation after successful checks, and has now requested this installer correction. No renewed permission is required. A new CI run must validate the combined release; the older successful run is not sufficient. The installation guard remains active. The corrected installer must report the actual and expected releases on mismatch and recognize an already installed target without redeploying it. No migrations or seed are needed.
