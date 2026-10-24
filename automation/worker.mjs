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
  const visibleText = async (page) =>
    page
      .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200))
      .catch(() => '');

  const cfg = {
    vk: {
      url: 'https://vk.com/',
      async loggedIn(page, ctx) {
        if (/login/i.test(page.url())) return false;

        const cookies = await ctx.cookies();
        const hasAuth = cookies.some((c) => c.name === 'remixsid' && c.value);
        if (!hasAuth) return false;

        const txt = await visibleText(page);
        // Guest pages show login/registration prompts.
        if (/Войти|Зарегистрироваться/.test(txt)) return false;

        if (/(^|\/)(feed|al_feed)(\?|$)/.test(page.url()) || /vk\.com\/id\d+/.test(page.url())) {
          return true;
        }
        return true;
      },
    },
    ok: {
      url: 'https://ok.ru/',
      async loggedIn(page, ctx) {
        if (/\/feed|st\.cmd=userMain|my\.ok\.ru/i.test(page.url())) return true;

        const cookies = await ctx.cookies();
        // OK keeps the real session token in AUTHCODE; `remixsid` exists for guests too.
        const hasAuthCode = cookies.some((c) => c.name === 'AUTHCODE' && c.value);

        const txt = await visibleText(page);
        const guestMarkers =
          /Зарегистрироваться|Войти по QR-коду|Телефон или почта|Не получается войти/i.test(txt);
        if (guestMarkers) return false;

        if (hasAuthCode) return true;
        // Fallback: authenticated UI markers.
        return /Что у вас нового|Мои друзья|Сообщения/i.test(txt);
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
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  try {
    if (action === 'get_url') {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const url = page.url();
      const loggedIn = await cfg.loggedIn(page, ctx).catch(() => false);
      return { url, loggedIn };
    }

    if (action === 'resolve_target') {
      if (platform === 'vk') return await resolveVkTarget(page, params.query || '');
      return { error: `resolve_target not implemented for ${platform}` };
    }

    if (action === 'parse_members') {
      if (platform === 'vk') return await parseVkMembers(page, params);
      return { error: `parse_members not implemented for ${platform}` };
    }

    if (action === 'friend_requests') {
      if (platform === 'vk') return await sendVkFriendRequests(page, params);
      return { error: `friend_requests not implemented for ${platform}` };
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
// m.vk.com/new_post → span[contenteditable] → «Далее» → «Опубликовать».
async function postVk(page, params) {
  const target = String(params.targetId || '').trim();
  if (target) return await postVkCommunity(page, params, target);

  const { content = '', mediaPaths = [] } = params;
  try {
    await page.goto('https://m.vk.com/new_post', { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(4000);

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

    const nextBtn = page.getByText('Далее', { exact: true }).first();
    await nextBtn.waitFor({ state: 'visible', timeout: 20000 });
    await nextBtn.click({ timeout: 20000 });
    await humanPause(1500, 3000);

    const publishBtn = page.getByText('Опубликовать', { exact: true }).first();
    await publishBtn.waitFor({ state: 'visible', timeout: 20000 });
    await publishBtn.click({ timeout: 20000 });
    await humanPause(2000, 4000);

    return { ok: true, url: page.url() };
  } catch (err) {
    return { error: `${String(err && err.message ? err.message : err)} @ ${page.url()}` };
  }
}

// Normalize a community reference: URL / @name / name / id -> bare token.
function vkNormalize(target) {
  return String(target || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?(m\.)?vk\.(com|ru)\//i, '')
    .replace(/^@/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

// Resolve a community to "-<gid>" plus its title, in the browser (no API token).
async function resolveVkTarget(page, query) {
  const q = vkNormalize(query);
  if (!q) return { error: 'empty community reference' };

  if (/^-?\d+$/.test(q)) {
    const gid = q.replace(/^-/, '');
    return { targetId: `-${gid}`, targetTitle: `Сообщество ${gid}` };
  }

  await page.goto(`https://vk.com/${encodeURIComponent(q)}`, { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(4500);

  if (/login/i.test(page.url())) {
    return { error: 'not logged in (session expired) — re-login in the browser', url: page.url() };
  }

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

  const rawTitle = await page
    .evaluate(() => {
      const og = document.querySelector('meta[property="og:title"]');
      if (og && og.getAttribute('content')) return og.getAttribute('content');
      return document.title || '';
    })
    .catch(() => '');

  const title = String(rawTitle)
    .replace(/\s*[|—]\s*ВКонтакте\s*$/i, '')
    .replace(/:\s*записи сообщества\s*$/i, '')
    .trim();

  return { targetId: `-${gid}`, targetTitle: title || `Сообщество ${gid}`, screenName: q };
}

// Non-profile links found in the mobile VK nav (excluded from parsing).
const VK_NAV = new Set([
  '/feed',
  '/im',
  '/mail',
  '/friends',
  '/groups',
  '/clips',
  '/audio',
  '/music',
  '/video',
  '/videos',
  '/services',
  '/market',
  '/orders',
  '/bookmarks',
  '/docs',
  '/files',
  '/games',
  '/apps',
  '/search',
  '/settings',
  '/help',
  '/support',
  '/pay',
  '/store',
  '/notes',
  '/calls',
  '/reactions',
  '/ads',
  '/vk',
  '/',
]);

function isVkProfileHref(href) {
  if (!href || VK_NAV.has(href)) return false;
  if (!/^\/[A-Za-z0-9_.]{2,32}$/.test(href)) return false;
  // Media/utility namespaces that are not user profiles.
  if (/^\/(photos|audios|videos|albums|board|topic|wall|away|login|join|share|dev|faq|about)/.test(href)) {
    return false;
  }
  return true;
}

// Parse community subscribers from the mobile members page.
async function parseVkMembers(page, params) {
  const q = vkNormalize(params.query || params.targetId || '');
  const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 300);
  if (!q) return { error: 'empty community reference' };

  const name = q.replace(/^-/, '').replace(/^(club|public)/, '');
  try {
    await page.goto(`https://m.vk.com/${encodeURIComponent(name)}?act=members`, {
      waitUntil: 'load',
    });
    await page.waitForTimeout(4000);

    if (/login/i.test(page.url())) {
      return { error: 'not logged in (session expired) — re-login in the browser', url: page.url() };
    }

    const collect = () =>
      page.evaluate(
        ({ navArr }) => {
          const nav = new Set(navArr);
          const anchors = Array.from(document.querySelectorAll('a[href]'));
          const rows = [];
          let own = '';
          for (const a of anchors) {
            const href = a.getAttribute('href') || '';
            const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
            if (!text) continue;
            if (!/^\/[A-Za-z0-9_.]{2,32}$/.test(href)) continue;
            if (nav.has(href)) continue;
            if (
              /^\/(photos|audios|videos|albums|board|topic|wall|away|login|join|share|dev|faq|about)/.test(
                href
              )
            ) {
              continue;
            }
            // The first profile-ish link in the mobile nav is the logged-in user.
            if (!own) own = href;
            rows.push({ href, name: text.slice(0, 80) });
          }
          return { own, rows };
        },
        { navArr: Array.from(VK_NAV) }
      );

    const seen = new Map();
    let own = '';
    let stagnant = 0;
    let prev = 0;

    for (let i = 0; i < 20 && seen.size < limit; i++) {
      const { own: ownHref, rows } = await collect();
      if (ownHref) own = ownHref;

      for (const r of rows) {
        if (r.href === own) continue;
        if (!seen.has(r.href)) seen.set(r.href, r);
        if (seen.size >= limit) break;
      }

      if (seen.size === prev) stagnant += 1;
      else stagnant = 0;
      prev = seen.size;

      if (stagnant >= 2) break;
      await humanScroll(page, 1).catch(() => {});
      await humanPause(1200, 2600);
    }

    const members = Array.from(seen.values()).slice(0, limit);
    return {
      ok: true,
      url: page.url(),
      community: name,
      count: members.length,
      members,
    };
  } catch (err) {
    return { error: `${String(err && err.message ? err.message : err)} @ ${page.url()}` };
  }
}

// Send friend requests from the given profile hrefs, slowly (one by one).
async function sendVkFriendRequests(page, params) {
  const hrefs = Array.isArray(params.hrefs) ? params.hrefs : [];
  const minDelay = Math.max(Number(params.minDelayMs) || 45000, 15000);
  const maxDelay = Math.max(Number(params.maxDelayMs) || 95000, minDelay + 5000);

  if (hrefs.length === 0) return { error: 'no profile hrefs given' };

  const results = [];

  for (let i = 0; i < hrefs.length; i++) {
    const href = hrefs[i];
    try {
      await page.goto(`https://m.vk.com${href}`, { waitUntil: 'load' }).catch(() => {});
      await page.waitForTimeout(3500);

      if (/login/i.test(page.url())) {
        return { error: 'not logged in (session expired) — re-login in the browser', results };
      }

      await humanScroll(page, 1).catch(() => {});
      await humanPause(800, 2200);

      const bodyText = await page.evaluate(() =>
        document.body.innerText.replace(/\s+/g, ' ')
      );

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
      const afterText = await page.evaluate(() =>
        document.body.innerText.replace(/\s+/g, ' ')
      );
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

// Community wall post on the desktop UI (verified flow):
// vk.com/wall-<gid> → «Создать пост» → composer → «Далее» → «Опубликовать».
async function postVkCommunity(page, params, target) {
  const { content = '', mediaPaths = [] } = params;
  const gid = vkNormalize(target).replace(/^-/, '');
  try {
    await page.goto(`https://vk.com/wall-${gid}`, { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(4500);

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
    return {
      error: `${String(err && err.message ? err.message : err)} @ ${page.url()}`,
      target: `-${gid}`,
    };
  }
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
