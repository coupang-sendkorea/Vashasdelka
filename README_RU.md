# ВашаСделка.Крипто. — GitHub Pages + Supabase Free

В архиве:
- `public/` — готовый сайт для GitHub Pages
- `schema.sql` — SQL-схема для Supabase
- `README_RU.md` — инструкция

## Коротко
1. Создайте аккаунт GitHub.
2. Создайте аккаунт Supabase.
3. Создайте проект Supabase.
4. Выполните `schema.sql` в SQL Editor.
5. Включите Email/Password в Auth.
6. Возьмите `Project URL` и `Publishable/anon key`.
7. В файле `public/config.js` вставьте эти значения.
8. Загрузите содержимое `public/` в публичный GitHub-репозиторий.
9. Включите GitHub Pages: branch `main`, folder `/root`.
10. Откройте ссылку, которую покажет GitHub Pages.

## Важно
- `service_role` в браузер **не вставлять**.
- В `config.js` используйте только `Publishable key` или `anon key`.
- Bucket `client-files` создаётся SQL-скриптом автоматически.

## Структура данных
- `app_settings` — начальные данные программы
- `cycles` — циклы
- `deals` — сделки внутри цикла
- `client-files` — файлы клиентов в Storage

## Что уже работает
- регистрация и вход
- начальные данные
- циклы
- сделки
- хэш транзакции по каждой сделке
- файлы клиента по каждой сделке
- поиск по клиенту
- выгрузка в Excel
- экспорт/импорт JSON

## Что нужно будет делать дальше
- менять дизайн/поля — прямо в `public/app.js` и `public/styles.css`
- публиковать обновления — просто загружать новые файлы в репозиторий GitHub
