// A single, reused popover for check details. Uses the native Popover API (top layer, escapes
// overflow) with a class-based fallback; positioned in JS and flipped at viewport edges.
// An interactive popover (the outage alert) takes clicks and closes on an outside press, Escape
// or when focus leaves it.
import { STATES, classify } from './classify.js';
import { el, icon, fmtLocal, fmtUtc, fmtMs, fmtTime } from './format.js';

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

  constructor(node, { interactive = false } = {}) {
    this.#el = node;
    addEventListener('scroll', () => this.#anchor && this.#place(), { passive: true, capture: true });
    addEventListener('resize', () => this.hide());
    if (!interactive) return;
    node.classList.add('interactive');
    document.addEventListener('pointerdown', e => {
      if (this.#anchor && !node.contains(e.target) && !this.#anchor.contains(e.target)) this.hide();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !this.#anchor) return;
      const anchor = this.#anchor;
      const refocus = node.contains(document.activeElement);
      this.hide();
      if (refocus) anchor.focus();
    });
    node.addEventListener('focusout', e => {
      if (this.#anchor && !node.contains(e.relatedTarget) && !this.#anchor.contains(e.relatedTarget)) this.hide();
    });
  }

  get anchor() { return this.#anchor; }

  contains(node) { return this.#el.contains(node); }

  focusFirst() { this.#el.querySelector('button, [href], [tabindex]')?.focus({ preventScroll: true }); }

  show(anchor, content) {
    if (this.#anchor !== anchor) this.#expanded(false);
    this.#anchor = anchor;
    this.#expanded(true);
    this.#el.replaceChildren(...content);
    if (supportsPopover) { if (!this.#el.matches(':popover-open')) this.#el.showPopover(); }
    else this.#el.classList.add('is-open');
    this.#place();
  }

  hide() {
    if (!this.#anchor) return;
    this.#expanded(false);
    this.#anchor = null;
    if (supportsPopover) { if (this.#el.matches(':popover-open')) this.#el.hidePopover(); }
    else this.#el.classList.remove('is-open');
  }

  #expanded(value) {
    if (this.#anchor?.hasAttribute('aria-expanded')) this.#anchor.ariaExpanded = String(value);
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

const causeOf = r => r?.error ?? (r?.status != null ? `HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}` : STATES.down.label);

/** Builds the outage alert popover body; onClear runs when the Clear button is pressed. */
export function alertDetailsFor(site, alert, onClear) {
  const ongoing = !alert.recoveredAt;
  const dl = el('dl');
  const row = (k, v, cls) => dl.append(el('dt', { text: k }), el('dd', { class: cls, text: v }));
  row('Started', fmtLocal(alert.startedAt));
  row('UTC', fmtUtc(alert.startedAt));
  row('Cause', causeOf(alert.first), 'error');
  if (alert.downChecks > 1) {
    row('Failed checks', String(alert.downChecks));
    row('Last failure', fmtLocal(alert.latest.checkedAt));
    if (causeOf(alert.latest) !== causeOf(alert.first)) row('Latest error', causeOf(alert.latest), 'error');
  }
  if (!ongoing) row('Recovered', fmtLocal(alert.recoveredAt));

  return [
    el('h4', { text: `Outage: ${site.name}` }),
    el('div', { class: 'url', text: site.url }),
    ongoing
      ? el('div', { class: 'status st-down' }, icon('i-down'), el('span', { text: 'Still down' }))
      : el('div', { class: 'status st-up' }, icon('i-up'), el('span', { text: `Recovered at ${fmtTime(new Date(alert.recoveredAt))}` })),
    dl,
    el('div', { class: 'popover-actions' },
      el('button', { class: 'btn small primary', type: 'button', 'data-clear-alert': true, onclick: onClear, text: 'Clear alert' })),
  ];
}
