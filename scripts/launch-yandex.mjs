#!/usr/bin/env node
// Запускает Яндекс.Браузер с выделенным профилем и открытым CDP-портом, к которому
// подключается SMM-Control Center.
//
//   node scripts/launch-yandex.mjs            — обыч запуск
//   node scripts/launch-yandex.mjs --kill     — сначала закрыть все окна Яндекс.Браузера
//   node scripts/launch-yandex.mjs --status    — только проверить, отвечает ли CDP-порт
//
// Почему отдельный профиль: Chromium даёт подключиться по DevTools Protocol только
// к тому экземпляру, который был запущен с --remote-debugging-port. Тот же
// user-data-dir нельзя открыть дважды, поэтому рабочие окна Яндекс.Браузера
// придётся закрыть — ваш основной профиль и его сессии при этом не трогаются.

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';

const CDP_PORT = Number(process.env.SMM_CDP_PORT || 9223);
const CDP_HOST = '127.0.0.1';

const LOCALAPPDATA = process.env.LOCALAPPDATA || '';
const APPDATA = process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming');

// Официальные места установки. Исполняемый файл Яндекс.Браузера называется
// browser.exe и лежит в подпапке Application.
const BROWSER_CANDIDATES = [
  join(LOCALAPPDATA, 'Yandex', 'YandexBrowser', 'Application', 'browser.exe'),
  'C:\\Program Files\\Yandex\\YandexBrowser\\Application\\browser.exe',
  'C:\\Program Files (x86)\\Yandex\\YandexBrowser\\Application\\browser.exe',
  join(LOCALAPPDATA, 'Yandex', 'YandexBrowserBeta', 'Application', 'browser.exe'),
];

// Профиль автоматизации живёт рядом с базой приложения и не пересекается с
// основным профилем пользователя.
const PROFILE_DIR = join(APPDATA, 'com.smm.controlcenter', 'yandex_profile');

function log(msg) {
  console.log(`[launch-yandex] ${msg}`);
}

function fail(msg, hints = []) {
  console.error(`\n[launch-yandex] ОШИБКА: ${msg}`);
  for (const hint of hints) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

function findBrowser() {
  return BROWSER_CANDIDATES.find((candidate) => candidate && existsSync(candidate)) || null;
}

/** Проба CDP-порта через /json/version — тот же путь, что использует Playwright. */
function probeCdp(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: CDP_HOST, port: CDP_PORT }, () => {
      socket.setTimeout(timeoutMs);
      socket.write(`GET /json/version HTTP/1.1\r\nHost: ${CDP_HOST}:${CDP_PORT}\r\n\r\n`);
    });

    let body = '';
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.includes('webSocketDebuggerUrl')) done(true);
    });
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
    socket.on('end', () => done(body.includes('Browser')));
  });
}

async function waitForCdp(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeCdp()) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

function isBrowserRunning() {
  try {
    // tasklist завершается с кодом 1, когда процесс не найден.
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq browser.exe', '/NH'], {
      encoding: 'utf8',
    });
    return /browser\.exe/i.test(out);
  } catch {
    return false;
  }
}

function killBrowser() {
  try {
    execFileSync('taskkill', ['/F', '/IM', 'browser.exe', '/T'], { stdio: 'ignore' });
    log('Окна Яндекс.Браузера закрыты.');
  } catch {
    log('Запущенных окон Яндекс.Браузера нет.');
  }
}

const args = process.argv.slice(2);

async function main() {
  console.log('═'.repeat(64));
  console.log('  SMM-Control Center · выделенный профиль Яндекс.Браузера');
  console.log('═'.repeat(64));
  console.log('');
  log(`CDP:      http://${CDP_HOST}:${CDP_PORT}`);
  log(`Профиль:  ${PROFILE_DIR}`);
  console.log('');

  // Только диагностика — ничего не запускаем и не закрываем.
  if (args.includes('--status')) {
    const ok = await probeCdp();
    console.log('');
    log(ok ? 'Браузер с CDP-портом запущен и отвечает.' : 'CDP-порт не отвечает — браузер не запущен.');
    process.exit(ok ? 0 : 1);
  }

  const browserPath = findBrowser();
  if (!browserPath) {
    fail('Яндекс.Браузер не найден.', [
      'Установите Яндекс.Браузер или укажите путь вручную:',
      ...BROWSER_CANDIDATES.map((p) => `- ${p}`),
    ]);
  }
  log(`Браузер:  ${browserPath}`);

  const alreadyUp = await probeCdp();
  if (alreadyUp) {
    log('Браузер с выделенным профилем уже запущен — повторный запуск не нужен.');
    console.log('\n  Достаточно войти в vk.com и ok.ru в его окне, затем нажать');
    console.log('  «Проверить подключение» в приложении.\n');
    return;
  }

  // Второй экземпляр с тем же user-data-dir не откроется, а закрытие чужих окон
  // без явного согласия — слишком дорогое побочное действие.
  if (isBrowserRunning() && !args.includes('--kill')) {
    fail('Открыты окна Яндекс.Браузера.', [
      'Chromium не позволяет открыть второй экземпляр с тем же профилем.',
      'Сохраните работу и перезапустите так: node scripts/launch-yandex.mjs --kill',
      'Основной профиль и его сессии не изменяются — закроются только окна.',
    ]);
  }
  if (args.includes('--kill')) killBrowser();

  await mkdir(PROFILE_DIR, { recursive: true });

  const flags = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--remote-allow-origins=http://${CDP_HOST}:${CDP_PORT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--window-size=1440,900',
  ];

  // Ярлык для повторного запуска без Node.
  const batPath = join(APPDATA, 'com.smm.controlcenter', 'launch-yandex-browser.bat');
  await mkdir(join(APPDATA, 'com.smm.controlcenter'), { recursive: true });
  await writeFile(
    batPath,
    `@echo off\r\nchcp 65001 >nul\r\nstart "" "${browserPath}" ${flags.join(' ')}\r\n`,
    'utf8'
  );

  log('Запускаем браузер...');
  const child = spawn(browserPath, flags, { detached: true, stdio: 'ignore' });
  child.unref();

  if (!(await waitForCdp(60_000))) {
    fail(`CDP-порт ${CDP_PORT} не ответил за 60 с.`, [
      'Проверьте, что окно браузера действительно открылось.',
      `Возможно порт занят: SMM_CDP_PORT=9224 node scripts/launch-yandex.mjs`,
      'Антивирус может блокировать локальные подключения к порту отладки.',
    ]);
  }
  log(`CDP-порт ${CDP_PORT} отвечает.`);

  console.log('');
  console.log('─'.repeat(64));
  console.log('  ДАЛЬНЕЙШИЕ ШАГИ');
  console.log('─'.repeat(64));
  console.log('');
  console.log('  1. В открывшемся окне войдите в аккаунты:');
  console.log('       vk.com — аккаунт ВКонтакте');
  console.log('       ok.ru  — аккаунт Одноклассники');
  console.log('     Это окно принадлежит профилю автоматизации и не связано с');
  console.log('     вашим основным профилем Яндекса.');
  console.log('');
  console.log('  2. Не закрывайте это окно во время работы приложения.');
  console.log('     Когда браузер не нужен: taskkill /F /IM browser.exe /T');
  console.log('');
  console.log('  3. В SMM-Control Center нажмите «Проверить подключение».');
  console.log('');
  console.log(`  Ярлык для следующего запуска: ${batPath}`);
  console.log('');
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
