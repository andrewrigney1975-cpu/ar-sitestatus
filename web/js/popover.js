// A single, reused popover for check details. Uses the native Popover API (top layer, escapes
// overflow) with a class-based fallback; positioned in JS and flipped at viewport edges.
import { STATES, classify } from './classify.js';
import { el, icon, fmtLocal, fmtUtc, fmtMs } from './format.js';

const TRANSPORT_NAMES = {
  server: 'Server (API)',
  electron: 'Desktop (native)',
  native: 'Android (native)',
  extension: 'Browser extension',
  browser: 'Browser (limited by CORS)',
};

const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

export class Popover {
  #el;
  #anchor = null;

  constructor(node) {
    this.#el = node;
    addEventListener('scroll', () => this.#anchor && this.#place(), { passive: true, capture: true });
    addEventListener('resize', () => this.hide());
  }

  get anchor() { return this.#anchor; }

  show(anchor, content) {
    this.#anchor = anchor;
    this.#el.replaceChildren(...content);
    if (supportsPopover) { if (!this.#el.matches(':popover-open')) this.#el.showPopover(); }
    else this.#el.classList.add('is-open');
    this.#place();
  }

  hide() {
    if (!this.#anchor) return;
    this.#anchor = null;
    if (supportsPopover) { if (this.#el.matches(':popover-open')) this.#el.hidePopover(); }
    else this.#el.classList.remove('is-open');
  }

  #place() {
    const a = this.#anchor.getBoundingClientRect();
    const p = this.#el.getBoundingClientRect();
    const gap = 10, margin = 8;
    let top = a.top - p.height - gap;
    if (top < margin) top = Math.min(a.bottom + gap, innerHeight - p.height - margin);
    let left = a.left + a.width / 2 - p.width / 2;
    left = Math.max(margin, Math.min(left, innerWidth - p.width - margin));
    this.#el.style.top = `${Math.round(top)}px`;
    this.#el.style.left = `${Math.round(left)}px`;
  }
}

/** Builds the popover body for one check. */
export function detailsFor(site, result, slowMs) {
  const nodes = [el('h4', { text: site.name }), el('div', { class: 'url', text: site.url })];
  if (!result) {
    nodes.push(el('div', { class: 'status st-none' }, icon('i-none'), el('span', { text: 'No data for this slot yet' })));
    return nodes;
  }

  const state = classify(result, slowMs);
  const info = STATES[state];
  let statusText = info.label;
  if (result.status != null) statusText += ` · HTTP ${result.status}${result.statusText ? ' ' + result.statusText : ''}`;
  nodes.push(el('div', { class: `status st-${state}` }, icon(info.icon), el('span', { text: statusText })));

  const dl = el('dl');
  const row = (k, v, cls) => dl.append(el('dt', { text: k }), el('dd', { class: cls }, ...(Array.isArray(v) ? v : [v])));
  row('Local', fmtLocal(result.checkedAt));
  row('UTC', fmtUtc(result.checkedAt));
  if (result.error) row('Error', result.error, 'error');
  row('Response', fmtMs(result.timings?.total));
  const t = result.timings ?? {};
  const parts = [['DNS', t.dns], ['Connect', t.connect], ['TLS', t.tls], ['TTFB', t.ttfb]]
    .filter(([, v]) => v != null)
    .map(([k, v]) => el('span', { text: `${k} ${fmtMs(v)}` }));
  if (parts.length) row('Breakdown', el('span', { class: 'breakdown' }, ...parts));
  if (result.method) row('Method', result.method);
  if (result.ip) row('Server IP', result.ip);
  if (result.redirects) row('Redirects', `${result.redirects} → ${result.finalUrl}`);
  row('Checked by', TRANSPORT_NAMES[result.transport] ?? result.transport);
  nodes.push(dl);

  if (state === 'opaque') {
    nodes.push(el('p', { class: 'note', text: 'Browser probe: the site answered, but CORS hides the HTTP status. Timing includes browser overhead. Run the API server for full detail.' }));
  } else if (result.transport === 'browser' && state === 'down') {
    nodes.push(el('p', { class: 'note', text: 'Browser probe: a failed request can also mean the browser or an extension blocked it.' }));
  } else if (result.transport === 'native') {
    nodes.push(el('p', { class: 'note', text: 'Timing measured in the app and includes a few ms of bridge overhead.' }));
  }
  return nodes;
}
