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
import { renderSettings } from './views/settings.js';

const ROUTES = {
  '': { label: 'Assets', render: renderAssets },
  'assets': { label: 'Assets', render: renderAssets },
  'settings': { label: 'Settings', render: renderSettings },
};

const NAV = [['assets', 'Assets'], ['settings', 'Settings']];

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
  const hash = location.hash.replace(/^#/, '');
  const route = ROUTES[hash] || ROUTES[''];

  for (const a of document.querySelectorAll('.nav a')) {
    const active = (a.dataset.route === hash) || (hash === '' && a.dataset.route === 'assets');
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  await route.render(outlet);
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
  const waiting = pending.count
    ? `${pending.count} change${pending.count === 1 ? '' : 's'} waiting, oldest ${ago(pending.oldest)}`
    : null;

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

// ── Views ───────────────────────────────────────────────────────────────────

async function renderAssets(root) {
  const assets = await store.list('asset');

  if (!assets.length) {
    mount(root, el('div.column', {},
      el('div.empty', {},
        el('h2', {}, 'Start with one thing you look after'),
        el('p', {},
          'A furnace, a roof, a truck, a well pump. Residuum keeps what it is, ' +
          'what has been done to it, and what that cost — for as long as you own it.'),
        el('p.hint', {}, 'Adding assets lands next.'))));
    return;
  }

  mount(root, el('div.column', {},
    el('section', {},
      el('h2', {}, `${assets.length} asset${assets.length === 1 ? '' : 's'}`),
      el('ul', {}, assets.map(a => el('li', {}, a.name))))));
}

boot();
