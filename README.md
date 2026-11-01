# SMM Control Center

Десктоп-приложение для кросспостинга, планирования публикаций, парсинга аудитории и
локальной CRM-воронки. Tauri 2 (Rust) + React 19 + TypeScript, всё состояние хранится
локально в SQLite.

## Возможности

- **Публикации** — черновики, отложенные посты, статьи (Telegram Rich Messages),
  медиавложения. Публикация по официальному API (VK, Telegram) или через браузер
  (VK, OK) для аккаунтов без API-доступа.
- **Аккаунты** — VK ID OAuth (PKCE), ручной ввод токена, вход через браузер с
  сохранением сессии в отдельном профиле на аккаунт. Токены шифруются AES-256-GCM,
  ключ — в Windows Keyring.
- **Аудитория** — парсинг участников сообществ, массовая отправка заявок с
  человеческими задержками и ограничением частоты.
- **CRM** — лиды, стадии воронки, очередь автоматических действий.
- **Граббер** — импорт контента из RSS/Atom и HTML-страниц (OpenGraph).
- **AI** — переписывание текста и генерация сообщений через OpenAI-совместимые
  провайдеры и Anthropic.
- **Аналитика** — конверсии по воронке, метрики публикаций.
- **Служебное** — автозапуск с Windows, работа из трея, экспорт/импорт БД,
  автообновление.

## Требования

- Windows 10/11 x64 (основная платформа; Linux собирается, но не тестируется).
- Node.js 20+ и pnpm — только для сборки.
- Браузер для браузерной автоматизации: Microsoft Edge (есть в Windows) или Chrome.
  Если ни одного нет, Playwright скачает Chromium в
  `%APPDATA%\com.smm.controlcenter\playwright_browsers`.

Node.js для работы установленного приложения **не нужен**: `node.exe` упаковывается в
инсталлятор рядом с воркером автоматизации.

## Разработка

```bash
pnpm install
pnpm tauri:dev          # Vite на :1420 + приложение с hot reload
```

Проверки перед коммитом:

```bash
pnpm build              # tsc + vite build
cd src-tauri && cargo test --lib && cargo check
```

## Сборка инсталлятора

```bash
pnpm tauri:build        # prepare:automation -> build -> tauri build
```

Результат:
`src-tauri/target/release/bundle/nsis/smm-control-center_<version>_x64-setup.exe`.

`pnpm prepare:automation` копирует `automation/worker.mjs`, `human.js`, урезанный
`playwright-core` и `node.exe` в `src-tauri/resources/automation/`, откуда они
попадают в `bundle.resources`. Каталог генерируемый и в git не попадает.

- `SMM_SKIP_NODE_BUNDLE=1 pnpm prepare:automation` — не упаковывать Node
  (инсталлятор ~6 МБ вместо ~27 МБ, но на машине пользователя потребуется `node`
  в PATH).

## Архитектура

```
src/                    React UI (views, hooks, api/db.ts — типизированные вызовы)
src-tauri/src/
  commands.rs           Tauri-команды: аккаунты, посты, аудитория, AI
  db.rs                 SQLite (sqlx), миграции, инварианты доступа к данным
  scheduler.rs          Фоновый воркер публикаций (опрос раз в 30 с)
  automation_worker.rs  Очередь CRM-действий (опрос раз в 15 с, rate limit)
  publisher.rs          VK / Telegram / OK API-коннекторы
  browser_worker.rs     Запуск Node-воркера Playwright, диагностика рантайма
  crm.rs, crm_connectors.rs, analytics.rs, parser.rs, llm_gateway.rs
automation/worker.mjs   Playwright-воркер: логин, постинг, парсинг, заявки
src-tauri/migrations/   SQL-миграции (применяются в db.rs::apply_migrations)
```

Воркеры живут в Tokio и продолжают работать при закрытом окне (приложение остаётся
в трее). Выход — через меню трея.

## Диагностика

Вкладка **Аккаунты** показывает состояние браузерной автоматизации: версию Node,
найденный Playwright и источник (`resource` — упакованный рантайм, `dev` — дерево
репозитория, `env` — переопределение через переменные окружения).

Переменные окружения для отладки: `BROWSER_WORKER_SCRIPT`, `PLAYWRIGHT_MODULE_PATH`,
`BROWSER_NODE_BIN`, `BROWSER_CHANNEL`, `BROWSER_PROFILES_DIR`.

## Данные

`%APPDATA%\com.smm.controlcenter\`:

- `smm_local.db` — база (WAL);
- `browser_profiles/` — сессии браузера по аккаунтам;
- `playwright_browsers/` — скачанный Chromium (если использовался).
