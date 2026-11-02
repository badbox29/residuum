/**
 * app.js — the shell: hash routing, the sync status band, and boot.
 *
 * Boot order matters and is the one thing here worth reading carefully. The
 * database opens and the UI renders before any network call is attempted, so
 * the archive is on screen and usable whether or not sync is configured,
 * reachable, or working.
 */

import { el, mount, ago } from './dom.js';
import * as store from './store.js';
import * as sync from './sync.js';
import { renderSettings } from './settings.js';
import { renderAssets, renderAsset, renderAssetForm, renderEventForm } from './assets.js';
import { renderVendors, renderVendor, renderVendorForm } from './vendors.js';

const NAV = [['assets', 'Things'], ['vendors', 'Contacts'], ['settings', 'Settings']];

/**
 * Hash routing, so the app is a static file with no server rewrites needed —
 * it works from GitHub Pages, from a local folder, or from a USB stick.
 */
function resolve(hash) {
  const [head, a, b, c] = hash.split('/');

  if (head === 'asset' && a && b === 'edit')  return { nav: 'assets', render: r => renderAssetForm(r, a) };
  // With a third segment this is a correction to that entry, not a new one.
  if (head === 'asset' && a && b === 'event') return { nav: 'assets', render: r => renderEventForm(r, a, c || null) };
  if (head === 'asset' && a)                  return { nav: 'assets', render: r => renderAsset(r, a) };
  if (head === 'new')                         return { nav: 'assets', render: r => renderAssetForm(r) };

  if (head === 'vendor' && a && b === 'edit') return { nav: 'vendors', render: r => renderVendorForm(r, a) };
  if (head === 'vendor' && a)                 return { nav: 'vendors', render: r => renderVendor(r, a) };
  if (head === 'vendor-new')                  return { nav: 'vendors', render: r => renderVendorForm(r) };
  if (head === 'vendors')                     return { nav: 'vendors', render: renderVendors };

  if (head === 'settings')                    return { nav: 'settings', render: renderSettings };
  return { nav: 'assets', render: renderAssets };
}

let statusBand;
let outlet;

async function boot() {
  const app = document.getElementById('app');

  // 1. Open the archive first. Nothing else can usefully happen before this,
  //    and if it fails the person needs to know immediately rather than after
  //    a sync attempt times out.
  try {
    await store.openDb();
  } catch (err) {
    mount(app, el('div.column', {},
      el('section', {},
        el('h2', {}, 'Cannot open the archive'),
        el('p.lede', {},
          'This browser would not open its local database. Private browsing ' +
          'windows often block it, and so does having the app open in another ' +
          'tab mid-upgrade.'),
        el('p.note.bad', {}, String(err && err.message || err)))));
    return;
  }

  // 2. Build the shell.
  statusBand = el('div.status', { hidden: true, role: 'status' });
  outlet = el('main');
  mount(app,
    el('header.masthead', {},
      el('h1.wordmark', {}, 'Residuum'),
      el('p.tagline', {}, 'What you have, and what has happened to it')),
    el('nav.nav', {}, NAV.map(([hash, label]) =>
      el('a', { href: `#${hash}`, 'data-route': hash }, label))),
    statusBand,
    outlet);

  sync.subscribe(renderStatus);
  addEventListener('hashchange', renderRoute);
  await renderRoute();

  // 3. Only now reach for the network. Sync starting is the last step, never
  //    a precondition for the app being usable.
  if (await sync.isConfigured()) sync.start();
}

async function renderRoute() {
  const route = resolve(location.hash.replace(/^#/, ''));

  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === route.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  try {
    await route.render(outlet);
  } catch (err) {
    // A view that throws should not leave a blank page with the answer only
    // in the console.
    console.error(err);
    mount(outlet, el('div.column', {}, el('section', {},
      el('h2', {}, 'That page did not load'),
      el('p.note.bad', {}, String((err && err.message) || err)))));
  }
  scrollTo(0, 0);
}

/**
 * The sync band.
 *
 * Hidden entirely when sync is off, because a permanent "not syncing" notice
 * on an app that is working exactly as intended is just noise. It appears
 * when there is something to say.
 */
async function renderStatus({ state, error }) {
  if (!statusBand) return;

  if (state === sync.SyncState.OFF) {
    statusBand.hidden = true;
    return;
  }

  const pending = await sync.pendingSummary();
  const parts = [];
  if (pending.count) {
    parts.push(`${pending.count} change${pending.count === 1 ? '' : 's'} waiting, oldest ${ago(pending.oldest)}`);
  }
  if (pending.files) {
    parts.push(`${pending.files} file${pending.files === 1 ? '' : 's'} still uploading`);
  }
  const waiting = parts.join(' · ') || null;

  const headline = {
    [sync.SyncState.SYNCING]: 'Syncing',
    [sync.SyncState.SYNCED]: 'Everything is synced',
    [sync.SyncState.IDLE]: 'Ready to sync',
    [sync.SyncState.OFFLINE]: 'Offline',
    [sync.SyncState.FAILED]: 'Sync is not working',
    [sync.SyncState.AUTH_REQUIRED]: 'Sync needs to be set up again',
  }[state] || state;

  statusBand.hidden = false;
  statusBand.dataset.state = state;
  mount(statusBand,
    el('span.status-dot'),
    el('span', {}, headline),
    (error || waiting) && el('span.status-detail', {}, error || waiting));
}

boot();
