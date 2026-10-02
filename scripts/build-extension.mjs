// Builds the sidebar browser extension from web/ + extension/:
//   dist/extension/chrome/   (Chrome, Edge, Brave… side panel, MV3)
//   dist/extension/firefox/  (Firefox sidebar, MV3)
//   dist/extension/site-status-{chrome,firefox}-<version>.zip  (store / self-distribution uploads)
// Flags: --test  also writes dist/extension/chrome-test with host access pre-granted, for
//                automated tests that can't click permission prompts.
import { readFile, writeFile, readdir, rm, cp, mkdir } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(root, 'dist', 'extension');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const EXCLUDE = new Set(['sw.js', 'manifest.webmanifest', 'icons/apple-touch-icon.png', 'icons/maskable-192.png', 'icons/maskable-512.png']);

const base = {
  manifest_version: 3,
  name: 'Site Status',
  short_name: 'Site Status',
  version,
  description: 'Heartbeat monitor in your sidebar: up/down, HTTP status and response time for your sites. No server needed.',
  homepage_url: pkg.homepage,
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: { default_title: 'Site Status', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
  permissions: ['storage', 'alarms', 'notifications', 'webRequest'],
  // Granted per site when the user adds it (or all at once from Settings), not at install time
  optional_host_permissions: ['http://*/*', 'https://*/*'],
};

const manifests = {
  chrome: {
    ...base,
    permissions: [...base.permissions, 'sidePanel'],
    minimum_chrome_version: '116',
    side_panel: { default_path: 'index.html' },
    background: { service_worker: 'background.js', type: 'module' },
  },
  firefox: {
    ...base,
    sidebar_action: {
      default_panel: 'index.html',
      default_title: 'Site Status',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
      open_at_install: true,
    },
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: 'site-status@ar-sitestatus',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: {
        strict_min_version: '142.0',
      },
    },
  },
};

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(p));
    else files.push(p);
  }
  return files;
}

async function build(target, manifest) {
  const out = join(outRoot, target);
  await rm(out, { recursive: true, force: true });
  await cp(join(root, 'web'), out, {
    recursive: true,
    filter: src => !EXCLUDE.has(relative(join(root, 'web'), src).split(sep).join('/')),
  });
  await cp(join(root, 'extension', 'src'), out, { recursive: true });
  await cp(join(root, 'extension', 'icons'), join(out, 'icons'), { recursive: true });

  // The sidebar page is the PWA's index.html, booted through the extension host
  let html = await readFile(join(out, 'index.html'), 'utf8');
  html = html.replace('<script type="module" src="js/app.js"></script>', '<script type="module" src="ext/panel.js"></script>')
    .replace(/\s*<link rel="manifest"[^>]*>/, '')
    .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '');
  if (!html.includes('ext/panel.js')) throw new Error('index.html: app.js script tag not found');
  await writeFile(join(out, 'index.html'), html);
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return out;
}

/** Minimal ZIP writer (deflate), so the build needs no dependencies. */
async function zip(dir, file) {
  const entries = [];
  for (const path of (await walk(dir)).sort()) {
    const name = relative(dir, path).split(sep).join('/');
    const data = await readFile(path);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    entries.push({ name: Buffer.from(name), data: deflated, crc: zlib.crc32(data), size: data.length });
  }
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;   // fixed timestamp: reproducible archives
  for (const e of entries) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(e.crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(e.name.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, e.name, e.data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(DOS_DATE, 14);
    c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.data.length, 20); c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, e.name);
    offset += 30 + e.name.length + e.data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  await writeFile(file, Buffer.concat([...chunks, ...central, end]));
  return { count: entries.length, bytes: offset + centralSize + 22 };
}

await mkdir(outRoot, { recursive: true });
for (const [target, manifest] of Object.entries(manifests)) {
  const dir = await build(target, manifest);
  const file = join(outRoot, `site-status-${target}-${version}.zip`);
  const { count, bytes } = await zip(dir, file);
  console.log(`${target}: ${relative(root, dir)}  ->  ${relative(root, file)} (${count} files, ${(bytes / 1024).toFixed(0)} KB)`);
}
if (process.argv.includes('--test')) {
  const dir = await build('chrome-test', { ...manifests.chrome, host_permissions: ['<all_urls>'] });
  console.log(`test build: ${relative(root, dir)}`);
}
