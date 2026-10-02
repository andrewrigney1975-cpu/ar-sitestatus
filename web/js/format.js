export const fmtMs = ms => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 2)} s` : `${Math.round(ms)} ms`);

export const fmtPct = r => {
  if (r == null) return '—';
  const p = r * 100;
  return `${p === 100 || p === 0 ? String(p) : p >= 99.95 ? '99.9' : p.toFixed(p >= 10 ? 1 : 2)}%`;
};

export function fmtInterval(sec) {
  if (sec < 60) return `${sec} s`;
  return `${sec / 60} min`;
}

const localFmt = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
});
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const fmtLocal = iso => localFmt.format(new Date(iso));
export const fmtTime = date => timeFmt.format(date);
export const fmtUtc = iso => new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

export function fmtAgo(count, intervalSec) {
  const sec = count * intervalSec;
  if (sec < 120) return `${sec} s ago`;
  if (sec < 7200) return `${Math.round(sec / 60)} min ago`;
  if (sec < 172_800) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86_400)} days ago`;
}

export const hostOf = url => { try { return new URL(url).host; } catch { return url; } };

/** Creates an <svg class="icon"><use href="#id"/></svg> element. */
export function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

/** Tiny element helper: el('p', { class: 'x', text: 'hi' }, child...) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter(c => c != null));
  return node;
}
