// Prepares the browser-automation runtime for packaging.
//
// Copies the Playwright worker scripts, a trimmed `playwright-core` package and
// (when available) the Node.js binary into `src-tauri/resources/automation/`,
// which `tauri.conf.json` bundles as app resources. Playwright browsers are NOT
// copied: the worker prefers an already installed Edge/Chrome (channel) and only
// falls back to a Playwright-managed Chromium.
//
// Node.js: `node.exe` sitting next to the worker is used by `browser_worker.rs`
// before falling back to `node` on PATH. Copying it makes the installer
// self-contained, so end users do not need Node installed. Set
// SMM_SKIP_NODE_BUNDLE=1 to keep the installer small and require Node on PATH.
//
// Usage: node scripts/prepare-automation.mjs [--clean]

import { cp, mkdir, readdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const automationDir = join(root, 'automation');
const outDir = join(root, 'src-tauri', 'resources', 'automation');
const outNodeModules = join(outDir, 'node_modules', 'playwright-core');

// Only these entries are needed at runtime. `types/` and docs are dropped to keep
// the installer small.
const PLAYWRIGHT_ENTRIES = [
  'index.js',
  'index.mjs',
  'package.json',
  'browsers.json',
  'LICENSE',
  'NOTICE',
  'bin',
  'lib',
];

function log(msg) {
  console.log(`[prepare-automation] ${msg}`);
}

async function resolvePlaywrightCore() {
  const candidates = [];

  // pnpm layout first, then a hoisted node_modules layout.
  const pnpmDir = join(root, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const entry of await readdir(pnpmDir)) {
      if (entry.startsWith('playwright-core@')) {
        candidates.push(join(pnpmDir, entry, 'node_modules', 'playwright-core'));
      }
    }
  }
  candidates.push(join(root, 'node_modules', 'playwright-core'));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }

  throw new Error(
    'playwright-core is not installed. Run `pnpm install` (or `pnpm add -D playwright`) first.'
  );
}

async function copyPlaywrightCore(source) {
  await mkdir(outNodeModules, { recursive: true });

  for (const entry of PLAYWRIGHT_ENTRIES) {
    const from = join(source, entry);
    if (!existsSync(from)) {
      if (entry === 'LICENSE' || entry === 'NOTICE') continue;
      throw new Error(`playwright-core is missing required entry: ${entry}`);
    }
    await cp(from, join(outNodeModules, entry), { recursive: true });
  }

  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  log(`playwright-core ${pkg.version} packaged`);
  return pkg.version;
}

async function copyWorkerScripts() {
  await mkdir(outDir, { recursive: true });

  for (const entry of await readdir(automationDir)) {
    // Debug helpers and editor leftovers stay out of the installer.
    if (entry === 'inspect.mjs' || entry.startsWith('_')) continue;
    const from = join(automationDir, entry);
    const info = await stat(from);
    if (!info.isFile()) continue;
    await cp(from, join(outDir, entry));
  }
}

// `browser_worker.rs::resolve_node` looks for `node.exe` next to the worker
// script first, so bundling the running Node binary removes the external
// dependency entirely. Only Windows/macOS/Linux x64 binaries are meaningful here;
// anything unusual falls back to Node on PATH.
async function copyNodeBinary() {
  if (process.env.SMM_SKIP_NODE_BUNDLE === '1') {
    log('node bundling skipped (SMM_SKIP_NODE_BUNDLE=1) — Node on PATH will be required');
    return null;
  }

  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  if (!existsSync(process.execPath)) {
    log(`node binary not found at ${process.execPath} — Node on PATH will be required`);
    return null;
  }

  const target = join(outDir, exe);
  await cp(process.execPath, target);

  // Redistributing node.exe requires its license text. Official Windows/macOS
  // archives ship it next to the binary; when it is absent (package manager
  // installs) a pointer is written so the obligation is still documented.
  const licenseCandidates = [
    join(dirname(process.execPath), 'LICENSE'),
    join(dirname(process.execPath), '..', 'LICENSE'),
  ];
  const license = licenseCandidates.find((candidate) => existsSync(candidate));
  if (license) {
    await cp(license, join(outDir, `LICENSE.node.txt`));
  } else {
    await writeFile(
      join(outDir, 'LICENSE.node.txt'),
      `Node.js ${process.version} is bundled with this application.\n` +
        'Node.js is licensed under the MIT license and bundles third-party\n' +
        'components listed at https://github.com/nodejs/node/blob/main/LICENSE\n'
    );
  }

  const info = await stat(target);
  log(`node ${process.version} packaged (${(info.size / 1024 / 1024).toFixed(1)} MiB)`);
  return process.version;
}

async function main() {
  if (process.argv.includes('--clean')) {
    await rm(outDir, { recursive: true, force: true });
    log('cleaned');
    return;
  }

  const source = await resolvePlaywrightCore();
  await rm(outDir, { recursive: true, force: true });
  await copyWorkerScripts();
  const version = await copyPlaywrightCore(source);
  const nodeVersion = await copyNodeBinary();

  // A marker file lets the Rust side explain exactly what is packaged.
  await writeFile(
    join(outDir, 'runtime.json'),
    JSON.stringify(
      {
        playwrightCoreVersion: version,
        node: nodeVersion ? `bundled ${nodeVersion}` : 'system',
        preparedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  log(`ready at ${outDir}`);
}

main().catch((err) => {
  console.error(`[prepare-automation] FAILED: ${err.message}`);
  process.exit(1);
});
