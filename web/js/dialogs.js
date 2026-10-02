// Manage-sites, import and settings dialogs.
import { store, parseImport, EXAMPLE_SITES } from './store.js';
import { el, icon, hostOf } from './format.js';
import { saveJson, openJson } from './io.js';
import { toast } from './toast.js';

const $ = id => document.getElementById(id);

// Browser extension: per-site host permissions. Requests must happen synchronously inside a
// click/submit handler (user gesture), so callers invoke requestAccess() before any await.
const access = window.siteStatusHost?.access ?? null;
function requestAccess(urls) {
  access?.request(urls).catch(err => toast(`Couldn't request site access: ${err.message}`));
}
async function offerAccessFor(urls) {
  if (!access) return;
  const missing = await access.missing(urls);
  if (missing.length) {
    toast(`${missing.length} site${missing.length === 1 ? '' : 's'} need${missing.length === 1 ? 's' : ''} your permission before they can be checked.`, {
      timeout: 0,
      action: { label: 'Grant access', run: () => requestAccess(missing) },
    });
  }
}

// Native <dialog> close buttons
document.addEventListener('click', e => {
  if (e.target.closest('[data-close]')) e.target.closest('dialog')?.close();
});
// Click on the backdrop closes
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', e => { if (e.target === d) d.close(); });
}

// ---------------------------------------------------------------- Manage sites
let editingId = null;

export function openSites({ focusAdd = false } = {}) {
  renderManageList();
  resetForm();
  $('sites-dialog').showModal();
  if (focusAdd || !store.getSites().length) $('site-name').focus();
}

function resetForm() {
  editingId = null;
  $('site-form').reset();
  $('site-error').textContent = '';
  $('site-submit').querySelector('span').textContent = 'Add';
  $('site-submit').querySelector('use').setAttribute('href', '#i-plus');
  $('site-cancel').hidden = true;
  renderManageList();
}

function startEdit(site) {
  editingId = site.id;
  $('site-name').value = site.name;
  $('site-url').value = site.url;
  $('site-error').textContent = '';
  $('site-submit').querySelector('span').textContent = 'Save';
  $('site-submit').querySelector('use').setAttribute('href', '#i-up');
  $('site-cancel').hidden = false;
  renderManageList();
  $('site-name').focus();
}

function renderManageList() {
  const sites = store.getSites();
  const list = $('manage-list');
  if (!sites.length) {
    list.replaceChildren(el('li', { class: 'manage-empty', text: 'No sites yet. Add one above, or import a JSON file.' }));
    return;
  }
  list.replaceChildren(...sites.map((site, i) => {
    const btn = (iconId, label, onclick, disabled) =>
      el('button', { class: 'btn small icon-only', type: 'button', title: label, 'aria-label': `${label}: ${site.name}`, onclick, disabled }, icon(iconId));
    return el('li', { class: site.id === editingId ? 'editing' : null },
      el('div', { class: 'who' }, el('b', { text: site.name }), el('small', { text: site.url })),
      el('div', { class: 'acts' },
        btn('i-arrow-up', 'Move up', () => { store.moveSite(site.id, -1); renderManageList(); }, i === 0),
        btn('i-arrow-down', 'Move down', () => { store.moveSite(site.id, 1); renderManageList(); }, i === sites.length - 1),
        btn('i-edit', 'Edit', () => startEdit(site)),
        btn('i-trash', 'Delete', () => {
          const undo = store.removeSite(site.id);
          if (editingId === site.id) resetForm(); else renderManageList();
          toast(`Removed "${site.name}"`, { action: { label: 'Undo', run: () => { undo(); renderManageList(); } } });
        })));
  }));
  if (access) markMissingAccess(sites);
}

/** Extension: adds a "Grant access" button to sites the extension may not check yet. */
async function markMissingAccess(sites) {
  const missing = new Set(await access.missing(sites.map(s => s.url)));
  const items = $('manage-list').children;
  sites.forEach((site, i) => {
    if (!missing.has(site.url) || !items[i]) return;
    items[i].querySelector('.who').append(el('span', { class: 'need-access' }, icon('i-warn'), 'Needs permission'));
    items[i].querySelector('.acts').prepend(el('button', {
      class: 'btn small', type: 'button', text: 'Grant',
      title: `Allow Site Status to check ${hostOf(site.url)}`,
      onclick: () => requestAccess([site.url]),
    }));
  });
}

$('site-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('site-name').value;
  const url = $('site-url').value;
  try {
    if (editingId) {
      store.updateSite(editingId, { name, url });
      requestAccess([store.getSite(editingId).url]);
    } else {
      const site = store.addSite({ name, url });
      requestAccess([site.url]);
      toast(`Added "${site.name}"`);
    }
    resetForm();
    $('site-name').focus();
  } catch (err) {
    $('site-error').textContent = err.message;
  }
});
$('site-cancel').addEventListener('click', resetForm);
$('site-url').addEventListener('blur', () => {
  // Suggest a name from the host if none was typed
  if (!$('site-name').value.trim() && $('site-url').value.trim()) {
    try { $('site-name').value = hostOf(new URL(/^https?:\/\//i.test($('site-url').value) ? $('site-url').value : 'https://' + $('site-url').value).href).replace(/^www\./, ''); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------- Import / export
export async function exportSites() {
  const data = store.exportSites();
  if (!data.sites.length) return toast('There are no sites to export.');
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    const saved = await saveJson(`site-status-${stamp}.json`, data);
    if (saved !== false) toast(`Exported ${data.sites.length} site${data.sites.length === 1 ? '' : 's'}.`);
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
}

export async function importSites() {
  let text;
  try { text = await openJson($('import-file')); } catch (err) { return toast(`Couldn't read the file: ${err.message}`); }
  if (text == null) return;

  let parsed;
  try { parsed = parseImport(text); } catch (err) { return toast(err.message, { timeout: 8000 }); }

  let mode = 'merge';
  if (store.getSites().length) {
    const n = parsed.sites.length;
    $('import-summary').textContent =
      `The file contains ${n} site${n === 1 ? '' : 's'}${parsed.invalid ? ` (${parsed.invalid} invalid entr${parsed.invalid === 1 ? 'y' : 'ies'} skipped)` : ''}. `
      + 'Merge them with your current list (duplicates are skipped), or replace your list entirely?';
    const dlg = $('import-dialog');
    dlg.returnValue = 'cancel';
    dlg.showModal();
    mode = await new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue), { once: true }));
    if (mode !== 'merge' && mode !== 'replace') return;
  }
  const { added, skipped } = store.importSites(parsed.sites, mode);
  renderManageList();
  toast(`Imported ${added} site${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} duplicate${skipped === 1 ? '' : 's'}` : ''}.`);
  // The file picker's change event isn't a user gesture, so access is offered via a toast button
  offerAccessFor(store.getSites().map(s => s.url));
}

export function addExamples() {
  const { added } = store.importSites(EXAMPLE_SITES, 'merge');
  requestAccess(EXAMPLE_SITES.map(s => s.url));
  toast(`Added ${added} example site${added === 1 ? '' : 's'}.`);
}

$('import').addEventListener('click', importSites);
$('export').addEventListener('click', exportSites);

// ---------------------------------------------------------------- Settings
export function openSettings({ transports, version }) {
  const s = store.getSettings();
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === s.theme;
  $('slow-ms').value = s.slowMs;
  $('api-base').value = s.apiBase;
  // The API setting is irrelevant when a native probe is in use
  $('api-field').hidden = transports.isNative;
  $('access-field').hidden = !access;
  const host = window.siteStatusHost;
  $('notify-field').hidden = !host?.notifications;
  $('notify').checked = s.notify !== false;
  if (host?.minBackgroundSec) {
    $('background-hint').textContent = 'While the sidebar is closed, sites are still checked in the background, '
      + `at most every ${host.minBackgroundSec} s (a browser limit).`;
  }

  const t = transports.current;
  const about = [
    ['Version', version],
    ['Checks run by', t ? t.label : '—'],
    ['Storage', host ? 'Saved in the browser extension\'s storage'
      : store.storageOk ? 'Saved in this browser (localStorage)' : 'Unavailable: changes last only for this session'],
  ];
  $('about').replaceChildren(...about.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('settings-dialog').showModal();
}

export function wireSettings({ transports }) {
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.addEventListener('change', () => store.setSettings({ theme: r.value }));
  }
  $('slow-ms').addEventListener('change', () => {
    const v = Math.round(Number($('slow-ms').value));
    if (v >= 100 && v <= 30000) store.setSettings({ slowMs: v });
    else $('slow-ms').value = store.getSettings().slowMs;
  });
  $('api-base').addEventListener('change', () => {
    const v = $('api-base').value.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) { toast('The API URL must start with http:// or https://'); return; }
    store.setSettings({ apiBase: v });
  });
  $('api-test').addEventListener('click', async () => {
    const btn = $('api-test');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    const ok = await transports.testApi($('api-base').value.trim().replace(/\/+$/, ''));
    btn.disabled = false;
    btn.textContent = 'Test';
    toast(ok ? 'API server is reachable.' : 'Couldn\'t reach the API server at that address.');
  });
  $('notify').addEventListener('change', () => store.setSettings({ notify: $('notify').checked }));
  $('access-all').addEventListener('click', () => {
    access?.requestAll().then(ok => toast(ok ? 'Site Status can now check any site.' : 'Access to all sites wasn\'t granted.'));
  });
  $('clear-history').addEventListener('click', () => {
    store.clearHistory();
    toast('Check history cleared.');
  });
}

// Extension: refresh the "Needs permission" markers when access is granted elsewhere
addEventListener('sitestatus:access', () => { if ($('sites-dialog').open) renderManageList(); });
