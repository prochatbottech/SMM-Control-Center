// Browser automation worker (Playwright). Long-lived process driven by the Rust
// backend over newline-delimited JSON on stdin/stdout.
//
// Request:  { "id": number, "cmd": string, ...args }
// Response: { "id": number, "ok": boolean, "data"?: any, "error"?: string }

import { chromium } from 'playwright';
import { join } from 'node:path';
import readline from 'node:readline';
import { humanPause, humanType, humanClick, humanFill, humanScroll } from './human.js';

const PROFILES_DIR = process.env.BROWSER_PROFILES_DIR || join(process.cwd(), '.browser_profiles');
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function platformConfig(platform) {
  const cfg = {
    vk: {
      url: 'https://vk.com/',
      async loggedIn(page, ctx) {
        if (/(^|\/)(feed|al_feed)(\?|$)/.test(page.url()) || /vk\.com\/id\d+/.test(page.url())) {
          return true;
        }
        const cookies = await ctx.cookies();
        return cookies.some((c) => c.name === 'remixsid' && c.value);
      },
    },
    ok: {
      url: 'https://ok.ru/',
      async loggedIn(page, ctx) {
        if (/ok\.ru\/(feed|notifications)(\?|$)/.test(page.url())) {
          return true;
        }
        const cookies = await ctx.cookies();
        return cookies.some((c) => c.name === 'remixsid' && c.value);
      },
    },
  };
  return cfg[platform];
}

async function cmdPing() {
  return { pong: true };
}

// Opens a headed persistent-context browser and waits for the user to log in.
async function cmdLogin(req) {
  const { accountId, platform } = req;
  const cfg = platformConfig(platform);
  if (!cfg) return { error: `unknown platform: ${platform}` };

  const userDataDir = join(PROFILES_DIR, accountId);
  const ctx = await chromium.launchPersistentContext(userDataDir, { headless: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if (await cfg.loggedIn(page, ctx)) {
        await ctx.close();
        return { ok: true, loggedIn: true };
      }
    } catch {
      // page may be navigating; retry
    }
    await sleep(2000);
  }

  await ctx.close().catch(() => {});
  return { error: 'login timeout' };
}

// Headless action using the persisted session.
async function cmdAction(req) {
  const { accountId, platform, action, params = {} } = req;
  const cfg = platformConfig(platform);
  if (!cfg) return { error: `unknown platform: ${platform}` };

  const userDataDir = join(PROFILES_DIR, accountId);
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--window-position=-2400,-2400', '--window-size=1280,900'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    if (action === 'get_url') {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const url = page.url();
      const loggedIn = await cfg.loggedIn(page, ctx).catch(() => false);
      return { url, loggedIn };
    }

    if (action === 'post') {
      if (platform === 'vk') return await postVk(page, params);
      if (platform === 'ok') return await postOk(page, params);
      return { error: `post not implemented for ${platform}` };
    }

    return { error: `action not implemented: ${action}` };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// VK post via the mobile web composer (verified flow):
// feed → «Создать пост» → span[contenteditable] → «Далее» → «Опубликовать».
async function postVk(page, params) {
  const { content = '', mediaPaths = [] } = params;
  await page.goto('https://m.vk.com/feed', { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(5000);
  await humanScroll(page, 1);

  if (/login/i.test(page.url())) {
    return { error: 'not logged in (session expired) — re-login in the browser', url: page.url() };
  }

  // Open composer via the feed button; fall back to the direct new_post page.
  const createBtn = page.getByText('Создать пост', { exact: false }).first();
  let opened = false;
  if ((await createBtn.count()) > 0 && (await createBtn.isVisible().catch(() => false))) {
    await createBtn.click({ timeout: 15000 }).catch(() => {});
    opened = true;
  }
  if (!opened) {
    await page.goto('https://m.vk.com/new_post', { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(4000);
  }

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

  const nextBtn = page.getByText('Далее', { exact: true }).first();
  await nextBtn.waitFor({ state: 'visible', timeout: 20000 });
  await nextBtn.click({ timeout: 20000 });
  await humanPause(1500, 3000);

  const publishBtn = page.getByText('Опубликовать', { exact: true }).first();
  await publishBtn.waitFor({ state: 'visible', timeout: 20000 });
  await publishBtn.click({ timeout: 20000 });
  await humanPause(2000, 4000);

  return { ok: true, url: page.url() };
}

// Best-effort OK status/group post.
async function postOk(page, params) {
  const { content = '', targetUrl } = params;
  const start = targetUrl || 'https://ok.ru/';
  await page.goto(start, { waitUntil: 'domcontentloaded' });
  await humanPause(1500, 3500);

  const composerSelectors = [
    'div[data-module="postingForm"] div[contenteditable="true"]',
    'textarea[placeholder*="поделиться"]',
    'div[contenteditable="true"]',
  ];
  let found = null;
  for (const sel of composerSelectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
      found = sel;
      break;
    }
  }
  if (!found) return { error: 'composer not found', url: page.url() };

  await humanClick(page, found);
  await humanType(page, content);
  await humanPause();

  const publishSelectors = [
    'button[data-l="t,button.submit"]',
    'button:has-text("Поделиться")',
  ];
  for (const sel of publishSelectors) {
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
      await humanClick(page, sel);
      await humanPause(1500, 3000);
      return { ok: true, url: page.url() };
    }
  }
  return { error: 'publish button not found', url: page.url() };
}

const handlers = { ping: cmdPing, login: cmdLogin, action: cmdAction };

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

send({ id: null, ok: true, data: { ready: true } });
