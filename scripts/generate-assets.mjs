// Generates every icon / splash asset for the PWA, Electron and Capacitor builds
// from a single parametric SVG glyph. Run with: npm run assets
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Brand palette (kept in sync with web/css tokens)
const NAVY_A = '#0E1A2B';
const NAVY_B = '#1A3557';
const PULSE_A = '#3DDC97';
const PULSE_B = '#2BC4E8';
const UP = '#3DDC97';
const WARN = '#F5B83D';
const LIGHT_BG = '#F4F6FA';

// Heartbeat line, drawn in a 1024 x 1024 design space
const PULSE = '176,450 360,450 420,360 500,610 590,230 668,500 712,450 848,450';
const BARS = [UP, UP, UP, UP, WARN, UP, UP];

/** The glyph: pulse line + a row of status-page bars. `simple` drops detail for tiny sizes. */
function glyph({ scale = 1, simple = false, mono = null } = {}) {
  const stroke = mono ?? 'url(#pulse)';
  const t = `translate(512 512) scale(${scale}) translate(-512 -512)`;
  if (simple) {
    // Re-centre the pulse vertically when the bars are omitted
    return `<g transform="${t} translate(0 70)">
      <polyline points="${PULSE}" fill="none" stroke="${stroke}" stroke-width="96"
        stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }
  const bars = BARS.map((c, i) =>
    `<rect x="${326 + i * 56}" y="720" width="36" height="64" rx="10" fill="${mono ?? c}"/>`).join('');
  const glow = mono ? '' : `<polyline points="${PULSE}" fill="none" stroke="${PULSE_A}" stroke-opacity=".55"
      stroke-width="60" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>`;
  return `<g transform="${t}">${glow}
    <polyline points="${PULSE}" fill="none" stroke="${stroke}" stroke-width="60"
      stroke-linecap="round" stroke-linejoin="round"/>${bars}</g>`;
}

const defs = `<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${NAVY_B}"/><stop offset="1" stop-color="${NAVY_A}"/></linearGradient>
  <linearGradient id="pulse" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${PULSE_A}"/><stop offset="1" stop-color="${PULSE_B}"/></linearGradient>
  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
</defs>`;

/**
 * shape: 'rounded' (rounded square with optional inset), 'full' (full-bleed square), 'none' (transparent)
 */
function iconSvg({ shape = 'rounded', inset = 0, radius = 230, scale = 1, simple = false, mono = null } = {}) {
  const s = 1024 - inset * 2;
  const r = radius * (s / 1024);
  let bg = '';
  if (shape === 'rounded') bg = `<rect x="${inset}" y="${inset}" width="${s}" height="${s}" rx="${r}" fill="url(#bg)"/>`;
  if (shape === 'full') bg = `<rect width="1024" height="1024" fill="url(#bg)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
${defs}${bg}${glyph({ scale: scale * (s / 1024), simple, mono })}</svg>`;
}

function splashSvg({ dark }) {
  const size = 2732, logo = 640, off = (size - logo) / 2;
  const icon = iconSvg().replace('<svg ', `<svg x="${off}" y="${off}" width="${logo}" height="${logo}" `)
    .replace(/ width="1024" height="1024"/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${dark ? NAVY_A : LIGHT_BG}"/>${icon}</svg>`;
}

// Theme-aware favicon: transparent background, pulse adapts to the browser's color scheme
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<style>polyline{stroke:#12805C}@media (prefers-color-scheme:dark){polyline{stroke:${PULSE_A}}}</style>
<polyline points="${PULSE}" transform="translate(0 70)" fill="none" stroke-width="110"
  stroke-linecap="round" stroke-linejoin="round"/></svg>`;

async function out(rel, data) {
  const p = join(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, data);
  console.log('  ' + rel);
}

const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * (size / 1024) * 4 })
  .resize(size, size).png({ compressionLevel: 9 }).toBuffer();

/** Minimal ICO writer: embeds PNG frames directly (supported since Windows Vista). */
function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, buf }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(buf.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, ...frames.map(f => f.buf)]);
}

async function icoFrom(svgFor, sizes) {
  return ico(await Promise.all(sizes.map(async size => ({ size, buf: await png(svgFor(size), size) }))));
}

const appIcon = iconSvg({ inset: 24 });                         // Windows / Linux / PWA "any"
const macIcon = iconSvg({ inset: 100, radius: 225 });           // macOS grid: 824px squircle-ish body
const maskable = iconSvg({ shape: 'full', scale: 0.82 });       // PWA maskable: 80% safe circle
const smallIcon = size => iconSvg({ inset: size <= 32 ? 0 : 24, radius: 200, simple: size <= 48 });

console.log('Source SVGs');
await out('assets/source/icon.svg', appIcon);
await out('assets/source/icon-macos.svg', macIcon);
await out('assets/source/icon-maskable.svg', maskable);
await out('assets/source/icon-monochrome.svg', iconSvg({ shape: 'none', mono: '#000' }));
await out('assets/source/splash-light.svg', splashSvg({ dark: false }));
await out('assets/source/splash-dark.svg', splashSvg({ dark: true }));

console.log('PWA (web/)');
await out('web/favicon.svg', faviconSvg);
await out('web/favicon.ico', await icoFrom(smallIcon, [16, 32, 48]));
for (const s of [192, 512]) {
  await out(`web/icons/icon-${s}.png`, await png(appIcon, s));
  await out(`web/icons/maskable-${s}.png`, await png(maskable, s));
}
await out('web/icons/apple-touch-icon.png', await png(iconSvg({ shape: 'full' }), 180)); // iOS applies its own mask
await out('web/icons/monochrome-512.png', await png(iconSvg({ shape: 'none', mono: '#000' }), 512));

console.log('Electron (desktop/build/)');
await out('desktop/build/icon.png', await png(appIcon, 1024));               // Linux .deb + fallback
await out('desktop/build/icon.ico', await icoFrom(s => s <= 48 ? smallIcon(s) : appIcon, [16, 24, 32, 48, 64, 128, 256]));
await out('desktop/build/icon-macos.png', await png(macIcon, 1024));          // electron-builder -> .icns
for (const s of [16, 32, 48, 64, 128, 256, 512]) {
  await out(`desktop/build/icons/${s}x${s}.png`, await png(s <= 48 ? smallIcon(s) : appIcon, s)); // Linux hicolor set
}

console.log('Capacitor (mobile/assets/) — consumed by `npx @capacitor/assets generate --android`');
await out('mobile/assets/icon-only.png', await png(iconSvg({ shape: 'full', scale: 0.9 }), 1024));
await out('mobile/assets/icon-background.png', await png(iconSvg({ shape: 'full' }).replace(/<g transform[\s\S]*<\/g><\/svg>$/, '</svg>'), 1024));
// @capacitor/assets insets the foreground by 16.7%, so this canvas maps to the visible 72dp;
// 0.9 also keeps the glyph inside the Android 12 splash icon's 2/3 circle.
await out('mobile/assets/icon-foreground.png', await png(iconSvg({ shape: 'none', scale: 0.9 }), 1024));
await out('mobile/assets/splash.png', await sharp(Buffer.from(splashSvg({ dark: false }))).png().toBuffer());
await out('mobile/assets/splash-dark.png', await sharp(Buffer.from(splashSvg({ dark: true }))).png().toBuffer());

console.log('Done.');
