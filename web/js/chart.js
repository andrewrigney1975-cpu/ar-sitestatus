// Renders the site rows: header (name, current state, uptime) and the status-page bar strip.
// Hover, tap and keyboard all drive the same popover.
import { store, HISTORY_LEN } from './store.js';
import { STATES, classify, uptime } from './classify.js';
import { el, icon, fmtMs, fmtPct, hostOf } from './format.js';
import { Popover, detailsFor } from './popover.js';

const MIN_BAR = 5;
const GAP = 2;

function relTime(iso) {
  const sec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (sec < 90) return `${Math.round(sec)} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  if (sec < 129_600) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86_400)} days ago`;
}

export class SiteList {
  #ul;
  #popover;
  #barCount = HISTORY_LEN;
  #rows = new Map();          // siteId -> { li, pill, uptime, strip, axisLeft }
  #active = null;             // { id, index } for keyboard navigation
  #shown = null;              // { id, index } of the bar the popover points at

  constructor(ul, popoverNode) {
    this.#ul = ul;
    this.#popover = new Popover(popoverNode);

    new ResizeObserver(() => {
      const width = this.#ul.clientWidth - 40;
      const count = Math.max(20, Math.min(HISTORY_LEN, Math.floor((width + GAP) / (MIN_BAR + GAP))));
      if (count !== this.#barCount) { this.#barCount = count; this.updateAll(); }
    }).observe(ul);

    this.#wireInteractions();
  }

  /** Full rebuild: used when sites are added, removed, renamed or reordered. */
  render() {
    this.#popover.hide();
    this.#rows.clear();
    const items = store.getSites().map(site => this.#buildRow(site));
    this.#ul.replaceChildren(...items);
    this.updateAll();
  }

  updateAll() { for (const id of this.#rows.keys()) this.update(id); }

  /** Re-renders one row's current state, uptime and strip. */
  update(id) {
    const row = this.#rows.get(id);
    const site = store.getSite(id);
    if (!row || !site) return;
    const { slowMs } = store.getSettings();
    const history = store.getHistory(id);
    const latest = history.at(-1);
    const state = classify(latest, slowMs);

    row.pill.className = `pill st-${state}`;
    row.pill.replaceChildren(icon(STATES[state]?.icon ?? 'i-none'), el('span', { class: 'num', text: pillText(latest, state) }));
    row.pill.title = STATES[state]?.label ?? 'Waiting for first check';

    const visible = history.slice(-this.#barCount);
    const up = uptime(visible, slowMs);
    row.uptime.replaceChildren(el('b', { class: 'num', text: fmtPct(up) }), ' uptime');
    row.uptime.title = up == null ? 'Uptime needs HTTP status codes, which browser-only checks can\'t see' : `Over the last ${visible.length} checks`;

    const pad = this.#barCount - visible.length;
    const bars = [];
    for (let i = 0; i < this.#barCount; i++) {
      const r = i < pad ? null : visible[i - pad];
      const st = r ? classify(r, slowMs) : 'none';
      bars.push(el('span', { class: `bar b-${st}`, 'data-i': i }));
    }
    row.strip.replaceChildren(...bars);
    row.strip.setAttribute('aria-label',
      `${site.name}: ${STATES[state]?.label ?? 'no checks yet'}. Check history, ${visible.length} checks. Use arrow keys to inspect.`);
    row.axisLeft.textContent = visible.length ? relTime(visible[0].checkedAt) : 'No checks yet';

    // Keep an open popover on the same slot after the bars were replaced
    if (this.#shown?.id === id && this.#popover.anchor) this.#showFor(id, Math.min(this.#shown.index, this.#barCount - 1));
  }

  currentStates() {
    const { slowMs } = store.getSettings();
    return store.getSites().map(s => classify(store.getHistory(s.id).at(-1), slowMs));
  }

  #buildRow(site) {
    const pill = el('span', { class: 'pill st-none' });
    const upt = el('span', { class: 'uptime' });
    const strip = el('div', { class: 'strip', tabindex: '0', role: 'group', 'data-id': site.id });
    const axisLeft = el('span');
    const li = el('li', { class: 'site', 'data-id': site.id },
      el('div', { class: 'site-head' },
        el('div', { class: 'site-id' },
          favicon(site.url),
          el('h3', { class: 'site-name', text: site.name }),
          el('a', { class: 'site-host', href: site.url, target: '_blank', rel: 'noopener noreferrer', text: hostOf(site.url) })),
        el('div', { class: 'site-now' }, pill, upt)),
      strip,
      el('div', { class: 'strip-axis', 'aria-hidden': 'true' }, axisLeft, el('span', { class: 'line' }), el('span', { text: 'Now' })));
    this.#rows.set(site.id, { li, pill, uptime: upt, strip, axisLeft });
    return li;
  }

  #resultAt(id, index) {
    const history = store.getHistory(id);
    const visible = history.slice(-this.#barCount);
    const pad = this.#barCount - visible.length;
    return index < pad ? null : visible[index - pad];
  }

  #showFor(id, index) {
    const row = this.#rows.get(id);
    const bar = row?.strip.children[index];
    if (!bar) return;
    this.#shown = { id, index };
    const site = store.getSite(id);
    row.strip.querySelectorAll('.is-active').forEach(b => b.classList.remove('is-active'));
    if (this.#active) { bar.classList.add('is-active'); row.strip.classList.add('has-active'); }
    this.#popover.show(bar, detailsFor(site, this.#resultAt(id, index), store.getSettings().slowMs));
  }

  #clearActive() {
    if (this.#active) {
      const strip = this.#rows.get(this.#active.id)?.strip;
      strip?.classList.remove('has-active');
      strip?.querySelectorAll('.is-active').forEach(b => b.classList.remove('is-active'));
    }
    this.#active = null;
  }

  #wireInteractions() {
    const ul = this.#ul;
    const barInfo = target => {
      const bar = target.closest?.('.bar');
      const strip = bar?.closest('.strip');
      return bar && strip ? { id: strip.dataset.id, index: Number(bar.dataset.i) } : null;
    };

    // Mouse / pen: hover
    ul.addEventListener('pointerover', e => {
      if (e.pointerType === 'touch') return;
      const info = barInfo(e.target);
      if (info) { this.#clearActive(); this.#showFor(info.id, info.index); }
    });
    ul.addEventListener('pointerout', e => {
      if (e.pointerType === 'touch' || this.#active) return;
      if (!e.relatedTarget?.closest?.('.bar')) this.#popover.hide();
    });

    // Touch: tap a bar to show, tap anywhere else to dismiss
    document.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const info = barInfo(e.target);
      if (info) { this.#clearActive(); this.#showFor(info.id, info.index); }
      else this.#popover.hide();
    });

    // Keyboard: each strip is one tab stop; arrows move between checks
    ul.addEventListener('focusin', e => {
      const strip = e.target.closest?.('.strip');
      if (!strip || e.target !== strip) return;
      this.#active = { id: strip.dataset.id, index: this.#barCount - 1 };
      if (strip.matches(':focus-visible')) this.#showFor(this.#active.id, this.#active.index);
    });
    ul.addEventListener('focusout', e => {
      if (e.target.closest?.('.strip')) { this.#clearActive(); this.#popover.hide(); }
    });
    ul.addEventListener('keydown', e => {
      const strip = e.target.closest?.('.strip');
      if (!strip || !this.#active) return;
      const max = this.#barCount - 1;
      const moves = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity, PageUp: -10, PageDown: 10 };
      if (e.key === 'Escape') { this.#popover.hide(); strip.classList.remove('has-active'); return; }
      if (!(e.key in moves)) return;
      e.preventDefault();
      this.#active.index = Math.max(0, Math.min(max, this.#active.index + moves[e.key]));
      this.#showFor(this.#active.id, this.#active.index);
    });
  }
}

/** The site's /favicon.ico, falling back to its initial when there isn't one. */
function favicon(url) {
  const letter = (hostOf(url).replace(/^www\./, '')[0] ?? '?').toUpperCase();
  const fallback = () => el('span', { class: 'site-favicon fallback', 'aria-hidden': 'true', text: letter });
  let src;
  try { src = new URL('/favicon.ico', url).href; } catch { return fallback(); }
  const img = el('img', { class: 'site-favicon', src, alt: '', width: 16, height: 16, loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function pillText(r, state) {
  if (!r) return 'Waiting…';
  switch (state) {
    case 'up': case 'slow': case 'warn': return `${r.status} · ${fmtMs(r.timings?.total)}`;
    case 'down': return r.status != null ? `${r.status} · ${fmtMs(r.timings?.total)}` : (r.error === 'Timed out' ? 'Timed out' : 'Down');
    case 'opaque': return `Reachable · ${fmtMs(r.timings?.total)}`;
    case 'blocked': return 'Not checkable';
    default: return '—';
  }
}
