// Debug helper: open a persistent profile with Playwright and dump candidate DOM
// elements + a screenshot. Usage:
//   PROFILE=<userDataDir> URL=https://vk.com/feed node automation/inspect.mjs
import { chromium } from 'playwright';

const profile = process.env.PROFILE;
const url = process.env.URL || 'https://vk.com/feed';
const headed = process.env.HEADED === '1';
const shot = process.env.SHOT || './automation/debug_page.png';

if (!profile) {
  console.error('PROFILE env is required (userDataDir)');
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(profile, {
  headless: !headed,
  args: headed ? ['--window-position=-2400,-2400', '--window-size=1280,900'] : [],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => console.log('goto err', e.message));
await page.waitForTimeout(6000);
await page.mouse.wheel(0, 600).catch(() => {});
await page.waitForTimeout(3000);

if (process.env.CLICK) {
  const t = process.env.CLICK;
  await page
    .getByText(t, { exact: false })
    .first()
    .click({ timeout: 15000 })
    .catch((e) => console.log('click err', e.message));
  await page.waitForTimeout(3000);
}

if (process.env.TYPE) {
  const composer = page.locator('span[contenteditable="true"][role="textbox"]').first();
  await composer.click({ timeout: 15000 }).catch((e) => console.log('composer click err', e.message));
  await page.keyboard.type(process.env.TYPE, { delay: 30 }).catch((e) => console.log('type err', e.message));
  await page.waitForTimeout(1500);
}

if (process.env.CLICK2) {
  await page
    .getByText(process.env.CLICK2, { exact: false })
    .first()
    .click({ timeout: 15000 })
    .catch((e) => console.log('click2 err', e.message));
  await page.waitForTimeout(3000);
}

const info = await page.evaluate(() => {
  const pick = (el) => ({
    tag: el.tagName,
    id: el.id || undefined,
    cls: (el.className || '').toString().slice(0, 90),
    ph: el.getAttribute ? el.getAttribute('placeholder') : undefined,
    txt: (el.textContent || '').trim().slice(0, 60),
  });
  const ce = Array.from(document.querySelectorAll('[contenteditable="true"]')).slice(0, 20).map(pick);
  const ta = Array.from(document.querySelectorAll('textarea')).slice(0, 20).map(pick);
  const inputs = Array.from(document.querySelectorAll('input')).slice(0, 20).map(pick);
  const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
    .map((e) => (e.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 60);
  const ceAny = Array.from(document.querySelectorAll('[contenteditable]'))
    .slice(0, 20)
    .map((e) => ({ ce: e.getAttribute('contenteditable'), ...pick(e) }));
  const roleTextbox = Array.from(document.querySelectorAll('[role="textbox"]')).slice(0, 20).map(pick);
  const ariaLabels = Array.from(document.querySelectorAll('[aria-label]'))
    .map((e) => e.getAttribute('aria-label'))
    .filter(Boolean)
    .slice(0, 80);
  return {
    url: location.href,
    title: document.title,
    bodyText: (document.body.innerText || '').slice(0, 600),
    links: Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href')).filter(Boolean).slice(0, 80),
    counts: { div: document.querySelectorAll('div').length, a: document.querySelectorAll('a').length, input: document.querySelectorAll('input').length },
    contenteditables: ce,
    contenteditablesAny: ceAny,
    roleTextbox,
    ariaLabels,
    textareas: ta,
    inputs,
    buttons: btns,
  };
});

console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: shot }).catch((e) => console.log('shot err', e.message));
console.log('SCREENSHOT:', shot);

await ctx.close();
