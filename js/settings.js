/**
 * The sync settings screen.
 *
 * Sync is off until someone deliberately turns it on, and this is where that
 * happens. The copy's job is to make clear that connecting a Worker moves
 * records between devices rather than deciding where they live — they live
 * in this browser either way.
 */

import { el, mount, facts } from './dom.js';
import * as sync from './sync.js';
import * as store from './store.js';

export async function renderSettings(root) {
  const cfg = await sync.getConfig();
  mount(root, el('div.column', {},
    cfg.url && cfg.accountId ? await connectedView(root, cfg) : connectView(root),
    await storageSection(),
  ));
}

// ── Not connected ───────────────────────────────────────────────────────────

function connectView(root) {
  const note = el('p.note', { hidden: true });
  const urlInput = el('input', {
    type: 'url', id: 'worker-url', placeholder: 'https://residuum.yourname.workers.dev',
  });
  const codeInput = el('input', { type: 'text', id: 'sync-code', placeholder: 'token:…' });
  const keyInput = el('input', { type: 'text', id: 'write-key', placeholder: 'write key' });

  const say = (msg, kind = '') => {
    note.className = `note ${kind}`.trim();
    note.textContent = msg;
    note.hidden = !msg;
  };

  const busy = (btn, fn) => async () => {
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';
    say('');
    try {
      await fn();
    } catch (err) {
      say(err.message || String(err), 'bad');
    } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
  };

  const startBtn = el('button', {}, 'Set up sync');
  startBtn.onclick = busy(startBtn, async () => {
    const { accountId, writeKey } = await sync.signInWithCode(urlInput.value);
    showNewCode(root, accountId, writeKey);
  });

  const joinBtn = el('button.quiet', {}, 'Connect');
  joinBtn.onclick = busy(joinBtn, async () => {
    await sync.signInWithExistingCode(urlInput.value, codeInput.value.trim(), keyInput.value.trim());
    sync.start();
    renderSettings(root);
  });

  return el('section', {},
    el('h2', {}, 'Sync'),
    el('p.lede', {},
      'Your records are saved in this browser and work without an account. ' +
      'Connect a Worker to keep the same archive on more than one device.'),

    el('div.field', {},
      el('label', { for: 'worker-url' }, 'Worker address'),
      urlInput,
      el('p.hint', {}, 'The Worker you deployed. Setup is in worker/README.md.')),

    el('div.actions', {}, startBtn),
    el('p.hint', {}, 'Starts a new archive on that Worker and gives you a code for your other devices.'),

    el('h2', { style: 'margin-top:2.5rem' }, 'Already have a code'),
    el('div.field', {}, el('label', { for: 'sync-code' }, 'Account'), codeInput),
    el('div.field', {}, el('label', { for: 'write-key' }, 'Write key'), keyInput),
    el('div.actions', {}, joinBtn),
    note,
  );
}

/**
 * Shown once, immediately after an account is created.
 *
 * The write key cannot be recovered from the Worker without signing in again,
 * so this is the moment to say so plainly rather than let someone close the
 * tab and discover it when they pick up their phone.
 */
function showNewCode(root, accountId, writeKey) {
  mount(root, el('div.column', {},
    el('section', {},
      el('h2', {}, 'Sync is on'),
      el('p.lede', {}, 'Enter these on your other devices to reach the same archive.'),
      el('div.field', {}, el('label', {}, 'Account'), el('code.code-block', {}, accountId)),
      el('div.field', {}, el('label', {}, 'Write key'), el('code.code-block', {}, writeKey)),
      el('p.note.good', {},
        'Save both somewhere safe now — a password manager is ideal. This device keeps ' +
        'them, but a new device has nowhere else to get them from.'),
      el('div.actions', {},
        el('button', { onclick: () => { sync.start(); renderSettings(root); } }, 'Saved, continue')),
    )));
}

// ── Connected ───────────────────────────────────────────────────────────────

async function connectedView(root, cfg) {
  const pending = await sync.pendingSummary();

  const syncBtn = el('button', {}, 'Sync now');
  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    await sync.syncOnce({ force: true });
    renderSettings(root);
  };

  const offBtn = el('button.danger', {}, 'Disconnect');
  offBtn.onclick = async () => {
    // Say exactly what survives. "Are you sure?" alone tells nobody whether
    // twelve years of records are about to disappear.
    const ok = confirm(
      'Stop syncing with this Worker?\n\n' +
      'Your records stay in this browser, and nothing is removed from the Worker. ' +
      'You can reconnect later with the same code.');
    if (!ok) return;
    await sync.clearCredentials();
    renderSettings(root);
  };

  return el('section', {},
    el('h2', {}, 'Sync'),
    facts([
      ['Worker', cfg.url],
      ['Account', cfg.accountId, true],
      ['Waiting to upload', pending.count === 0
        ? 'Nothing'
        : `${pending.count} change${pending.count === 1 ? '' : 's'}`],
    ]),
    el('div.actions', {}, syncBtn, offBtn),
  );
}

// ── Storage ─────────────────────────────────────────────────────────────────

async function storageSection() {
  const kinds = ['asset', 'event', 'document', 'vendor'];
  const counts = await Promise.all(kinds.map(async e => (await store.list(e)).length));
  const total = counts.reduce((a, b) => a + b, 0);

  const exportBtn = el('button.quiet', {}, 'Download a copy');
  exportBtn.onclick = async () => {
    const dump = await store.exportAll();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }));
    const a = el('a', {
      href: url,
      download: `residuum-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(url);
  };

  return el('section', {},
    el('h2', {}, 'This device'),
    el('p.lede', {}, total === 0
      ? 'Nothing recorded yet.'
      : 'Everything here is stored in this browser.'),
    facts([
      ['Assets', counts[0]],
      ['Events', counts[1]],
      ['Documents', counts[2]],
      ['Vendors', counts[3]],
      ['Device', await store.deviceId(), true],
    ]),
    el('div.actions', {}, exportBtn),
    el('p.hint', {}, 'A full JSON copy, including anything you have deleted.'),
  );
}
