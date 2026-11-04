// Browser automation worker (Playwright) — CDP-режим.
//
// Подключается к запущенному Яндекс.Браузеру через CDP-порт (по умолчанию
// http://127.0.0.1:9223) и выполняет действия в его дефолтном контексте.
//
// Запуск (из Rust или вручную):
//   node automation/worker.mjs
//
// Переменные окружения:
//   SMM_CDP_URL          — CDP endpoint (default: http://127.0.0.1:9223)
//   PLAYWRIGHT_MODULE_PATH — путь к playwright-core (для packaged-сборки)
//
// Протокол (newline-delimited JSON на stdin/stdout):
//   Request:  { "id": number, "cmd": string, ...args }
//   Response: { "id": number, "ok": boolean, "data"?: any, "error"?: string }
//
// Команды:
//   ping   — проверить, что воркер жив и браузер подключён
//   action — выполнить действие (post, parse_members, friend_requests и т.п.)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { humanPause, humanType, humanScroll } from './human.js';

// ---Guard against silent crashes: log and keep the process alive---
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException:', err && err.stack ? err.stack : err);
});

// --- Configuration ---

const CDP_URL = process.env.SMM_CDP_URL || 'http://127.0.0.1:9223';
const NAV_TIMEOUT_MS = 45_000;

// --- Playwright loader (works both in dev and packaged layout) ---

function moduleEntry(packageDir) {
  for (const entry of ['index.mjs', 'index.js']) {
    const candidate = join(packageDir, entry);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function loadChromium() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE_PATH) {
    const dir = process.env.PLAYWRIGHT_MODULE_PATH;
    const entry = moduleEntry(dir);
    if (!entry) {
      throw new Error(
        `PLAYWRIGHT_MODULE_PATH points to "${dir}", but it is not a Playwright package ` +
          '(index.mjs / index.js not found). Rebuild with `pnpm prepare:automation`.'
      );
    }
    candidates.push(entry);
  }
  candidates.push('playwright', 'playwright-core');

  const failures = [];
  for (const candidate of candidates) {
    const isPath = candidate.includes('/') || candidate.includes('\\');
    const specifier = isPath ? pathToFileURL(candidate).href : candidate;
    try {
      const mod = await import(specifier);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium) return { chromium, resolvedFrom: candidate };
      failures.push(`${candidate}: module has no chromium export`);
    } catch (err) {
      failures.push(`${candidate}: ${err && err.message ? err.message : String(err)}`);
    }
  }

  throw new Error(
    `Playwright is not available. Tried:\n  ${failures.join('\n  ')}\n` +
      'Install it with `pnpm add -D playwright` or bundle the runtime via `pnpm prepare:automation`.'
  );
}

const { chromium, resolvedFrom: PLAYWRIGHT_SOURCE } = await loadChromium();

// --- CDP connection (singleton) ---

let browser = null;        // playwright Browser instance
let defaultContext = null; // the only context available over CDP

/**
 * Подключается к браузеру через CDP. Повторные вызовы безопасны: при обрыве
 * соединения (браузер закрыли или перезапустили) следующий вызов подключается заново.
 */
async function ensureBrowser() {
  if (browser && defaultContext) return { browser, context: defaultContext };

  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new Error('Браузер подключён, но контекстов нет — перезапустите браузер');
    }
    defaultContext = contexts[0]; // over CDP ровно один контекст
    console.error(`[worker] CDP connected: ${CDP_URL}`);

    browser.on('disconnected', () => {
      console.error('[worker] CDP disconnected, will reconnect on next request');
      browser = null;
      defaultContext = null;
      automationPage = null;
    });

    return { browser, context: defaultContext };
  } catch (err) {
    const reason = String(err && err.message ? err.message : err);
    throw new Error(
      `Не удалось подключиться к браузеру через CDP (${CDP_URL}): ${reason}\n` +
        'Запустите скрипт: node scripts/launch-yandex.mjs\n' +
        'Затем войдите в аккаунты VK/OK вручную и повторите.'
    );
  }
}

// Вкладка, которую ведёт автоматизация. Переиспользуется между запросами, чтобы
// не множить табы, но никогда не забирается вкладка, открытая пользователем.
let automationPage = null;

/**
 * Возвращает собственную вкладку автоматизации, создавая её при необходимости.
 */
async function getOrCreatePage() {
  const { context } = await ensureBrowser();

  if (automationPage && !automationPage.isClosed()) {
    return automationPage;
  }

  automationPage = await context.newPage();
  return automationPage;
}

// --- Helpers ---

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function gotoVk(page, url, settleMs = 4000) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(settleMs);
}

function vkChallengeReason(url) {
  const u = String(url || '');
  if (/challenge\.html|checkpoint|show_autosubscribe|\/login/i.test(u)) {
    return (
      'VK запросил проверку безопасности (антибот). ' +
      'Откройте браузер, пройдите проверку вручную и повторите'
    );
  }
  return null;
}

function vkNormalize(target) {
  return String(target || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(m\.)?vk\.(com|ru)\//i, '')
    .replace(/^@/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

const VK_NAV = new Set([
  '/feed', '/im', '/mail', '/friends', '/groups', '/clips', '/audio', '/music',
  '/video', '/videos', '/services', '/market', '/orders', '/bookmarks', '/docs',
  '/files', '/games', '/apps', '/search', '/settings', '/help', '/support', '/pay',
  '/store', '/notes', '/calls', '/reactions', '/ads', '/vk', '/',
]);

// --- Command handlers ---

async function cmdPing() {
  try {
    const { browser, context } = await ensureBrowser();
    const pages = context.pages();
    return {
      pong: true,
      node: process.version,
      playwright: PLAYWRIGHT_SOURCE,
      cdpUrl: CDP_URL,
      connected: true,
      openPages: pages.length,
    };
  } catch (err) {
    return {
      pong: true,
      node: process.version,
      playwright: PLAYWRIGHT_SOURCE,
      cdpUrl: CDP_URL,
      connected: false,
      error: String(err && err.message ? err.message : err),
    };
  }
}

// Проверка авторизации в VK/OK (браузер должен быть запущен и залогинен).
async function cmdCheckAuth(platform) {
  const cfg = {
    vk: { url: 'https://vk.com/', check: (page, ctx) => checkVkAuth(page, ctx) },
    ok:  { url: 'https://ok.ru/',  check: (page, ctx) => checkOkAuth(page, ctx) },
  }[platform];
  if (!cfg) return { error: `unknown platform: ${platform}` };

  const page = await getOrCreatePage();
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(3000);

  const { context } = await ensureBrowser();
  const result = await cfg.check(page, context).catch(() => ({ loggedIn: false }));
  return result;
}

async function checkVkAuth(page, ctx) {
  const url = page.url();
  if (/login|challenge/i.test(url)) return { loggedIn: false, reason: 'redirected to login/challenge', url };

  const cookies = await ctx.cookies();
  const hasAuth = cookies.some((c) => c.name === 'remixsid' && c.value);
  if (!hasAuth) return { loggedIn: false, reason: 'no remixsid cookie', url };

  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
  if (/Войти|Зарегистрироваться/.test(txt)) return { loggedIn: false, reason: 'guest UI detected', url };

  return { loggedIn: true, url };
}

async function checkOkAuth(page, ctx) {
  const url = page.url();
  if (/\/feed|st\.cmd=userMain|my\.ok\.ru/i.test(url)) return { loggedIn: true, url };

  const cookies = await ctx.cookies();
  const hasAuthCode = cookies.some((c) => c.name === 'AUTHCODE' && c.value);

  const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
  const guestMarkers = /Зарегистрироваться|Войти по QR-коду|Телефон или почта/i.test(txt);
  if (guestMarkers) return { loggedIn: false, reason: 'guest UI detected', url };

  if (hasAuthCode) return { loggedIn: true, url };
  return { loggedIn: /Что у вас нового|Мои друзья|Сообщения/i.test(txt), url };
}

// Единая точка входа для всех действий.
//
// Перед каждой задачей вкладка сбрасывается на about:blank: предыдущая задача
// могла оставить открытую модалку или чужую страницу, и работа с таким состоянием
// приводит к кликам «не туда». Сбрасывается только собственная вкладка
// автоматизации — вкладки пользователя не затрагиваются.
async function resetAutomationPage(page) {
  try {
    if (page.url() !== 'about:blank') {
      await page.goto('about:blank', { timeout: 10000 });
    }
  } catch {
    // A stuck page is recreated on the next request rather than failing the task.
    automationPage = null;
  }
}

async function cmdAction(req) {
  const { action, params = {} } = req;
  const page = await getOrCreatePage();

  // Read-only probes must not disturb the page the user may be looking at, and
  // they do not depend on a clean state.
  const needsCleanState = ['post', 'parse_members', 'friend_requests', 'resolve_target'].includes(action);
  if (needsCleanState) await resetAutomationPage(page);

  if (action === 'get_url') {
    const platform = req.platform || 'vk';
    const url = platform === 'ok' ? 'https://ok.ru/' : 'https://vk.com/';
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    const pageUrl = page.url();
    const { context } = await ensureBrowser();
    const loggedIn = platform === 'ok'
      ? await checkOkAuth(page, context).then(r => r.loggedIn)
      : await checkVkAuth(page, context).then(r => r.loggedIn);
    return { url: pageUrl, loggedIn };
  }

  if (action === 'check_auth') {
    return await cmdCheckAuth(req.platform || 'vk');
  }

  if (action === 'resolve_target') {
    if (req.platform === 'vk') return await resolveVkTarget(page, params.query || '');
    return { error: `resolve_target not implemented for ${req.platform}` };
  }

  if (action === 'parse_members') {
    if (req.platform === 'vk') return await parseVkMembers(page, params);
    return { error: `parse_members not implemented for ${req.platform}` };
  }

  if (action === 'friend_requests') {
    if (req.platform === 'vk') return await sendVkFriendRequests(page, params);
    return { error: `friend_requests not implemented for ${req.platform}` };
  }

  if (action === 'post') {
    if (req.platform === 'vk') return await postVk(page, params);
    if (req.platform === 'ok') return await postOk(page, params);
    return { error: `post not implemented for ${req.platform}` };
  }

  return { error: `action not implemented: ${action}` };
}

// --- VK-specific functions ---

async function resolveVkTarget(page, query) {
  const q = vkNormalize(query);
  if (!q) return { error: 'empty community reference' };

  if (/^-?\d+$/.test(q)) {
    const gid = q.replace(/^-/, '');
    return { targetId: `-${gid}`, targetTitle: `Сообщество ${gid}` };
  }

  await gotoVk(page, `https://vk.com/${encodeURIComponent(q)}`, 4500);

  const challenge = vkChallengeReason(page.url());
  if (challenge) return { error: challenge, url: page.url() };

  const html = await page.content().catch(() => '');
  const mostFrequent = (ids) => {
    const freq = {};
    for (const id of ids) freq[id] = (freq[id] || 0) + 1;
    return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  };
  const groupKeys = Array.from(html.matchAll(/"(?:group_?id|gid)":\s*"?(\d+)"?/g), (m) => m[1]);
  const wallIds = Array.from(html.matchAll(/wall-(\d+)_?\d*/g), (m) => m[1]);
  const gid = mostFrequent(groupKeys) || mostFrequent(wallIds);
  if (!gid) return { error: `community not found: ${q}`, url: page.url() };

  const rawTitle = await page.evaluate(() => {
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.getAttribute('content')) return og.getAttribute('content');
    return document.title || '';
  }).catch(() => '');

  const title = String(rawTitle)
    .replace(/\s*[|—]\s*ВКонтакте\s*$/i, '')
    .replace(/:\s*записи сообщества\s*$/i, '')
    .trim();

  return { targetId: `-${gid}`, targetTitle: title || `Сообщество ${gid}`, screenName: q };
}

// Парсинг подписчиков сообщества через клик по счётчику (десктопный VK).
//
// Модалка подписчиков — это <div role="dialog" aria-modal="true"> с бесконечным
// скроллом. Селекторы VK меняются, поэтому используем структурный подход:
// 1) кликаем по ссылке, содержащей "подписчик" или "?act=members"
// 2) ждём появления модалки с role="dialog"
// 3) скроллим контейнер внутри модалки, собирая ссылки на профили
//
// Ссылки на профили в VK имеют вид /id12345 или /username.
async function parseVkMembers(page, params) {
  const q = vkNormalize(params.query || params.targetId || '');
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 300);
  if (!q) return { error: 'empty community reference' };

  const name = q.replace(/^-/, '').replace(/^(club|public)/, '');
  try {
    await gotoVk(page, `https://vk.com/${encodeURIComponent(name)}`, 5000);

    const challenge = vkChallengeReason(page.url());
    if (challenge) return { error: challenge, url: page.url() };

    // --- Шаг 1: открываем модалку подписчиков ---

    // VK показывает счётчик в виде ссылки с текстом типа "1 880 подписчиков"
    // или "1.2K подписчиков". Ищем любую ссылку, содержащую эти слова.
    const subscriberLink = page.locator('a:has-text("подписчик")').first();
    const isSubscriber = await subscriberLink.isVisible({ timeout: 15000 }).catch(() => false);

    if (isSubscriber) {
      // Проверяем, что это именно счётчик подписчиков, а не что-то другое.
      const text = await subscriberLink.textContent().catch(() => '');
      if (/подписчик/i.test(text)) {
        await subscriberLink.click({ timeout: 10000 }).catch(() => {});
        // Модалка появляется с анимацией, даём ей отрисоваться.
        await page.waitForTimeout(2500);
      }
    }

    // Проверяем, открылась ли модалка (VK использует aria-modal="true").
    const modal = page.locator('div[aria-modal="true"], dialog[role="dialog"]').first();
    const modalVisible = await modal.isVisible({ timeout: 10000 }).catch(() => false);

    if (!modalVisible) {
      // Альтернативный путь: если модалка не открылась, пробуем перейти на
      // мобильную версию — она стабильнее показывает список участников.
      await gotoVk(page, `https://m.vk.com/${encodeURIComponent(name)}?act=members`, 6000);

      if (/login|challenge/i.test(page.url())) {
        return { error: `Не удалось получить список участников (URL: ${page.url()})` };
      }

      // На мобильной версии участники — это ссылки вида /id123 или /username
      // в блоке с классами .section > .page_row.
      return await parseVkMembersMobile(page, limit);
    }

    // --- Шаг 2: скроллим модалку и собираем ссылки ---

    // Контейнер со списком внутри модалки. VK обычно оборачивает его в
    // <div class="ModalPage"> или <div class="sc-...">. Ищем по наличию
    // элементов с аватарами (img с src="/img/avatar...").
    const listContainer = modal.locator('div').filter({ has: page.locator('img[src*="avatar"]') }).first();

    const seen = new Set();
    const members = [];
    let stagnant = 0;
    let prevCount = 0;

    for (let round = 0; round < 40 && members.length < limit; round++) {
      // Собираем все ссылки на профили в видимой области.
      const hrefs = await page.evaluate(({ navSet }) => {
        const nav = new Set(navSet);
        const results = [];
        // Ищем все <a> внутри модалки.
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        for (const a of anchors) {
          const href = a.getAttribute('href') || '';
          if (!/^\/(id\d+|[A-Za-z][A-Za-z0-9_.]{2,32})$/.test(href)) continue;
          if (nav.has(href)) continue;
          if (/^\/(photos|audios|videos|albums|board|topic|wall|away|login|join|share|dev|faq|about|public|club)/.test(href)) continue;
          if (!results.includes(href)) results.push(href);
        }
        return results;
      }, { navSet: Array.from(VK_NAV) });

      for (const href of hrefs) {
        if (!seen.has(href)) {
          seen.add(href);
          // Текст ссылки — имя пользователя (или пусто).
          members.push({ href, name: '' });
        }
      }

      // Если новых элементов нет, проверяем ещё один раунд на случай
      // ленивой загрузки.
      if (members.length === prevCount) {
        stagnant++;
        if (stagnant >= 2) break;
      } else {
        stagnant = 0;
      }
      prevCount = members.length;

      // Скроллим контейнер. Если контейнер не найден — скроллим всю страницу.
      if (listContainer && await listContainer.isVisible({ timeout: 1000 }).catch(() => false)) {
        await listContainer.evaluate((el) => {
          el.scrollTop += 600;
        });
      } else {
        await humanScroll(page, 1).catch(() => {});
      }

      // Даем ленивой подгрузке отработать.
      await humanPause(1500, 3000);
    }

    // --- Шаг 3: собираём имена из href (VK не всегда показывает name в href) ---

    // Для каждого href пробуем получить имя из data-атрибутов или текста ссылки.
    const enriched = await page.evaluate((hrefs) => {
      const results = [];
      for (const href of hrefs) {
        const a = Array.from(document.querySelectorAll('a[href]')).find(
          (el) => el.getAttribute('href') === href
        );
        const name = a ? (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) : '';
        results.push({ href, name });
      }
      return results;
    }, members.map((m) => m.href));

    return {
      ok: true,
      url: page.url(),
      community: name,
      count: enriched.length,
      members: enriched.slice(0, limit),
    };
  } catch (err) {
    return { error: `${String(err && err.message ? err.message : err)} @ ${page.url()}` };
  }
}

// Парсинг подписчиков с мобильной версии (f.vk.com / m.vk.com).
// Используется как fallback, когда десктопная модалка не открывается.
async function parseVkMembersMobile(page, limit) {
  const collect = () => page.evaluate(({ navArr }) => {
    const nav = new Set(navArr);
    const rows = [];
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      if (!text) continue;
      if (!/^\/(id\d+|[A-Za-z][A-Za-z0-9_.]{2,32})$/.test(href)) continue;
      if (nav.has(href)) continue;
      if (/^\/(photos|audios|videos|albums|board|topic|wall|away|login|join|share|dev|faq|about|public|club)/.test(href)) continue;
      rows.push({ href, name: text.slice(0, 80) });
    }
    return rows;
  }, { navArr: Array.from(VK_NAV) });

  const seen = new Map();
  let stagnant = 0;
  let prev = 0;

  for (let i = 0; i < 30 && seen.size < limit; i++) {
    const rows = await collect();
    for (const r of rows) {
      if (!seen.has(r.href)) seen.set(r.href, r);
      if (seen.size >= limit) break;
    }

    if (seen.size === prev) stagnant += 1;
    else stagnant = 0;
    prev = seen.size;

    if (stagnant >= 3) break;

    await humanScroll(page, 1).catch(() => {});
    await humanPause(1200, 2600);
  }

  return {
    ok: true,
    url: page.url(),
    community: '',
    count: seen.size,
    members: Array.from(seen.values()).slice(0, limit),
  };
}

// Friend requests are the most bot-shaped action, so gaps are minutes long:
// sub-minute regularity is the clearest machine signal. Callers may pass
// minDelayMs/maxDelayMs; the defaults are already the safe human range.
async function sendVkFriendRequests(page, params) {
  const hrefs = Array.isArray(params.hrefs) ? params.hrefs : [];
  const minDelay = Math.max(Number(params.minDelayMs) || 120000, 60000);
  const maxDelay = Math.max(Number(params.maxDelayMs) || 360000, minDelay + 30000);

  if (hrefs.length === 0) return { error: 'no profile hrefs given' };

  const results = [];

  for (let i = 0; i < hrefs.length; i++) {
    const href = hrefs[i];
    try {
      await page.goto(`https://vk.com${href}`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
      await page.waitForTimeout(3500);

      if (/login/i.test(page.url())) {
        return { error: 'not logged in (session expired) — re-login in the browser', results };
      }

      await humanScroll(page, 1).catch(() => {});
      await humanPause(800, 2200);

      const bodyText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

      if (/Заявка отправлена/.test(bodyText)) {
        results.push({ href, status: 'already_requested' });
        continue;
      }

      const labels = ['Добавить в друзья', 'Отправить заявку'];
      let clicked = false;
      for (const label of labels) {
        const btn = page.getByText(label, { exact: true }).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
          await humanPause(700, 1800);
          await btn.click({ timeout: 15000 }).catch(() => {});
          clicked = true;
          break;
        }
      }

      if (!clicked) {
        results.push({ href, status: 'no_button' });
        continue;
      }

      await humanPause(1500, 3200);
      const afterText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
      results.push({
        href,
        status: /Заявка отправлена/.test(afterText) ? 'sent' : 'sent_unconfirmed',
      });
    } catch (err) {
      results.push({
        href,
        status: 'error',
        message: String(err && err.message ? err.message : err),
      });
    }

    if (i < hrefs.length - 1) {
      await humanPause(minDelay, maxDelay);
    }
  }

  return {
    ok: true,
    results,
    sent: results.filter((r) => r.status === 'sent' || r.status === 'sent_unconfirmed').length,
  };
}

async function postVk(page, params) {
  const target = String(params.targetId || '').trim();
  if (target) return await postVkCommunity(page, params, target);

  const { content = '', mediaPaths = [] } = params;
  try {
    await gotoVk(page, 'https://vk.com/feed', 5000);

    if (/login/i.test(page.url())) {
      return { error: 'not logged in (session expired) — re-login in the browser', url: page.url() };
    }

    await humanScroll(page, 1).catch(() => {});

    const composer = page.locator('span[contenteditable="true"][role="textbox"]').first();
    await composer.waitFor({ state: 'visible', timeout: 30000 });

    await composer.click();
    await humanPause(500, 1200);
    await humanType(page, content);
    await humanPause();

    if (mediaPaths.length > 0) {
      for (const p of mediaPaths) {
        await page.locator('input[type="file"]').first().setInputFiles(p).catch(() => {});
        await humanPause(1500, 3000);
      }
    }

    const publishBtn = page.getByText('Опубликовать', { exact: true }).first();
    await publishBtn.waitFor({ state: 'visible', timeout: 20000 });
    await publishBtn.click({ timeout: 20000 });
    await humanPause(2000, 4000);

    return { ok: true, url: page.url() };
  } catch (err) {
    return { error: `${String(err && err.message ? err.message : err)} @ ${page.url()}` };
  }
}

async function postVkCommunity(page, params, target) {
  const { content = '', mediaPaths = [] } = params;
  const gid = vkNormalize(target).replace(/^-/, '');
  try {
    await gotoVk(page, `https://vk.com/wall-${gid}`, 4500);

    if (/login/i.test(page.url())) {
      return { error: 'not logged in (session expired) — re-login in the browser', url: page.url() };
    }

    await humanScroll(page, 1).catch(() => {});

    const createBtn = page.getByText('Создать пост', { exact: true }).first();
    await createBtn.waitFor({ state: 'visible', timeout: 25000 });
    await page.waitForTimeout(800);
    await createBtn.click({ timeout: 20000 });

    const composer = page.locator('span[contenteditable="true"][role="textbox"]').first();
    await composer.waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(700);
    await composer.click();
    await humanPause(500, 1200);
    await humanType(page, content);
    await humanPause();

    if (mediaPaths.length > 0) {
      for (const p of mediaPaths) {
        await page.locator('input[type="file"]').first().setInputFiles(p).catch(() => {});
        await humanPause(1500, 3000);
      }
    }

    const nextBtn = page.getByText('Далее', { exact: true }).first();
    await nextBtn.waitFor({ state: 'visible', timeout: 20000 });
    await nextBtn.click({ timeout: 20000 });
    await humanPause(1500, 3000);

    const publishBtn = page.getByText('Опубликовать', { exact: true }).first();
    await publishBtn.waitFor({ state: 'visible', timeout: 20000 });
    await publishBtn.click({ timeout: 20000 });
    await humanPause(2500, 4500);

    return { ok: true, url: page.url(), target: `-${gid}` };
  } catch (err) {
    return { error: `${String(err && err.message ? err.message : err)} @ ${page.url()}`, target: `-${gid}` };
  }
}

async function postOk(page, params) {
  const { content = '', mediaPaths = [] } = params;
  try {
    await page.goto('https://ok.ru/post', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(6000);

    if (/login|vkid|account\/login/i.test(page.url())) {
      return { error: 'not logged in (session expired) — re-login in the browser', url: page.url() };
    }

    const editor = page.locator('.posting_itx').first();
    await editor.waitFor({ state: 'visible', timeout: 30000 });

    await editor.click();
    await humanPause(400, 1000);
    await humanType(page, content);
    await humanPause();

    if (mediaPaths.length > 0) {
      for (const p of mediaPaths) {
        await page.locator('input[type="file"]').first().setInputFiles(p).catch(() => {});
        await humanPause(2000, 4000);
      }
    }

    const shareBtn = page.getByText('Поделиться', { exact: true }).first();
    await shareBtn.waitFor({ state: 'visible', timeout: 20000 });
    await shareBtn.click({ timeout: 20000 });
    await humanPause(2500, 4500);

    return { ok: true, url: page.url() };
  } catch (err) {
    return { error: `${String(err && err.message ? err.message : err)} @ ${page.url()}` };
  }
}

// --- Main loop (readline on stdin) ---

const handlers = {
  ping: cmdPing,
  action: cmdAction,
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;

  let req;
  try {
    req = JSON.parse(line);
  } catch {
    send({ id: null, ok: false, error: 'bad json' });
    return;
  }

  const handler = handlers[req.cmd];
  if (!handler) {
    send({ id: req.id, ok: false, error: `unknown cmd: ${req.cmd}` });
    return;
  }

  try {
    const data = await handler(req);
    send({ id: req.id, ok: true, data });
  } catch (err) {
    send({ id: req.id, ok: false, error: String(err && err.message ? err.message : err) });
  }
});

// Announce readiness (Rust side waits for this before sending requests).
send({ id: null, ok: true, data: { ready: true, mode: 'cdp', cdpUrl: CDP_URL } });
