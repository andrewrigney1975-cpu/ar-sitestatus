import { el } from './format.js';

const region = () => document.getElementById('toasts');

/** Shows a toast; `action` = { label, run } adds a button (e.g. Undo). */
export function toast(message, { action, timeout = 5000 } = {}) {
  const node = el('div', { class: 'toast', role: 'status' }, el('p', { text: message }));
  const close = () => node.remove();
  if (action) node.append(el('button', { type: 'button', text: action.label, onclick: () => { action.run(); close(); } }));
  region().append(node);
  while (region().children.length > 3) region().firstElementChild.remove();
  if (timeout) setTimeout(close, timeout);
  return close;
}
