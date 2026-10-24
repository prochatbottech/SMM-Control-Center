// Human-like interaction helpers for Playwright: randomized pauses, per-character
// typing, smooth mouse movement and scrolls — to look less like a bot.

export function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Random human pause between actions.
export async function humanPause(minMs = 800, maxMs = 2600) {
  await sleep(rand(minMs, maxMs));
}

// Type text one character at a time with human-ish delays and occasional pauses.
export async function humanType(page, text, opts = {}) {
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: opts.delay ?? rand(45, 140) });
    if (Math.random() < 0.03) {
      await sleep(rand(90, 260));
    }
  }
}

// Move the mouse smoothly to an element and click it.
export async function humanClick(page, selector, opts = {}) {
  const el = await page.waitForSelector(selector, {
    timeout: opts.timeout ?? 15000,
    state: 'visible',
  });
  const box = await el.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: rand(8, 18) });
    await sleep(rand(120, 420));
  }
  await page.mouse.down();
  await sleep(rand(60, 170));
  await page.mouse.up();
  await humanPause();
}

// Human-like scroll.
export async function humanScroll(page, times = 1) {
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, rand(300, 900));
    await sleep(rand(400, 1200));
  }
}

// Fill a field by focusing, clearing and typing like a human.
export async function humanFill(page, selector, text, opts = {}) {
  const el = await page.waitForSelector(selector, {
    timeout: opts.timeout ?? 15000,
    state: 'visible',
  });
  const box = await el.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: rand(6, 14) });
    await sleep(rand(100, 300));
  }
  await el.click({ clickCount: opts.clear ? 3 : 1 });
  if (opts.clear) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await sleep(rand(120, 260));
  }
  await humanType(page, text, opts);
}
