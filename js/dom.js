/**
 * dom.js — the whole of the view layer's machinery.
 *
 * No framework, because there is no build step and because the app's state is
 * small enough that a framework would be more code than it saves.
 */

/** el('button.quiet', { onclick }, 'Save') */
export function el(spec, props = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }

  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node).append(...children.flat().filter(Boolean));
  return node;
}

/** A definition list; skips rows with no value so empty fields stay invisible. */
export function facts(pairs) {
  return el('dl.facts', {},
    pairs.filter(([, v]) => v != null && v !== '')
      .map(([k, v, mono]) => el('div', {},
        el('dt', {}, k),
        el('dd', { class: mono ? 'ident' : null }, v))));
}

/** Relative time, for "oldest unsynced change" and timeline entries. */
export function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `about ${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
