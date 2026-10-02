// System / light / dark theme. 'system' removes the override so CSS media queries take over.
const media = matchMedia('(prefers-color-scheme: dark)');
const ORDER = ['system', 'light', 'dark'];
const ICONS = { system: 'i-system', light: 'i-sun', dark: 'i-moon' };
const LABELS = { system: 'Theme: System', light: 'Theme: Light', dark: 'Theme: Dark' };

let current = 'system';
const listeners = new Set();

export const isDark = () => current === 'dark' || (current === 'system' && media.matches);
export const nextTheme = t => ORDER[(ORDER.indexOf(t) + 1) % ORDER.length];
export const themeIcon = t => ICONS[t];
export const themeLabel = t => LABELS[t];
export const onEffectiveThemeChange = fn => listeners.add(fn);

export function applyTheme(theme) {
  current = ORDER.includes(theme) ? theme : 'system';
  const root = document.documentElement;
  if (current === 'system') delete root.dataset.theme;
  else root.dataset.theme = current;
  notify();
}

function notify() {
  const dark = isDark();
  // An explicit choice must win over the media-scoped theme-color metas
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (current !== 'system') {
    meta ??= document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
    meta.content = dark ? '#151d2b' : '#ffffff';
  } else meta?.remove();
  listeners.forEach(fn => fn({ theme: current, dark }));
}

media.addEventListener('change', () => { if (current === 'system') notify(); });
