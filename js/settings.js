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
import { toSvg, ECC } from './qr.js';

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

    // Joining comes first: the second device is the common case, and someone
    // who taps "Set up sync" here by mistake ends up with a second, empty
    // archive and no obvious way back.
    el('h2', { style: 'margin-top:2rem' }, 'Already using Residuum elsewhere'),
    el('p.lede', {},
      'On the device that already has your records, open Settings and choose ' +
      'Show pairing details.'),
    el('div.field', {}, el('label', { for: 'sync-code' }, 'Account'), codeInput),
    el('div.field', {}, el('label', { for: 'write-key' }, 'Write key'), keyInput),
    el('div.actions', {}, joinBtn),

    el('h2', { style: 'margin-top:2.5rem' }, 'Starting fresh'),
    el('p.lede', {}, 'Only if this is your first device, or you want a separate archive.'),
    el('div.actions', {}, startBtn),
    note,
  );
}

/**
 * Landing from a pairing link.
 *
 * Shown before anything is adopted so someone who was sent a link knows what
 * it will do, and so a wrong link is a dismissible screen rather than a
 * silently switched archive.
 */
export async function renderPair(root, payload) {
  const creds = sync.readPairingPayload(payload);
  const note = el('p.note', { hidden: true });

  if (!creds) {
    mount(root, el('div.column', {}, el('section', {},
      el('h2', {}, 'That link did not make sense'),
      el('p.lede', {}, 'It may have been cut short in transit. Try copying it again, ' +
        'or enter the details by hand.'),
      el('div.actions', {},
        el('button', { onclick: () => { location.hash = 'settings'; } }, 'Open settings')))));
    return;
  }

  const confirmBtn = el('button', {}, 'Connect this device');
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Connecting…';
    try {
      await sync.pairFrom(creds);
      location.hash = 'assets';
    } catch (err) {
      note.textContent = err.message || String(err);
      note.className = 'note bad';
      note.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Connect this device';
    }
  };

  const existing = await store.list('asset', { includeTombstoned: true });

  mount(root, el('div.column', {}, el('section', {},
    el('h2', {}, 'Connect to an existing archive'),
    facts([['Worker', creds.url], ['Account', creds.accountId, true]]),
    existing.length
      ? el('p.note', {},
          `This browser already has ${existing.length} record${existing.length === 1 ? '' : 's'}. ` +
          'They will be merged into that archive, not replaced.')
      : null,
    el('div.actions', {},
      confirmBtn,
      el('button.quiet', { onclick: () => { location.hash = 'settings'; } }, 'Not now')),
    note)));
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
        'Worth saving in a password manager. You can also see them again any time ' +
        'under Settings → Your other devices, so losing this screen is not a problem.'),
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

  return el('div', {},
    el('section', {},
      el('h2', {}, 'Sync'),
      facts([
        ['Worker', cfg.url],
        ['Account', cfg.accountId, true],
        ['Waiting to upload', !pending.count && !pending.files
          ? 'Nothing'
          : [pending.count && `${pending.count} change${pending.count === 1 ? '' : 's'}`,
             pending.files && `${pending.files} file${pending.files === 1 ? '' : 's'}`]
            .filter(Boolean).join(', ')],
      ]),
      el('div.actions', {}, syncBtn, offBtn)),
    await pairingSection(cfg),
  );
}

/**
 * Adding another device.
 *
 * The credentials are shown again here on purpose. They appeared once when
 * the account was created, which is no help to someone standing in front of
 * a phone three days later — and they are sitting in this browser's database
 * regardless, so hiding them bought nothing but a dead end.
 *
 * Behind a click, so a write key is not simply on screen whenever settings
 * are open.
 */
async function pairingSection(cfg) {
  const body = el('div');
  let shown = false;

  const reveal = el('button.quiet', {}, 'Show pairing details');
  reveal.onclick = async () => {
    shown = !shown;
    reveal.textContent = shown ? 'Hide pairing details' : 'Show pairing details';
    if (!shown) { mount(body); return; }

    const link = await sync.pairingLink();
    mount(body,
      el('p.note.bad', {},
        'Anyone holding these can read and change your whole archive — including ' +
        'anyone who photographs this code. Treat it like a password.'),

      el('div.field', {},
        el('label', {}, 'Point the other device at this'),
        // Level M: enough redundancy to survive a camera at an angle on a
        // slightly dirty screen, without pushing the symbol big enough to be
        // hard to frame.
        el('div.qr', { html: toSvg(link, { ecc: ECC.M, size: 260, label: 'Pairing code' }) }),
        el('p.hint', {}, 'Open the camera on your phone and hold it up. No app needed.')),

      el('details.more', {},
        el('summary', {}, 'Or send yourself a link'),
        el('code.code-block', {}, link),
        el('p.hint', {},
          'The secret part sits after the #, which browsers never transmit — so ' +
          'mailing this to yourself does not hand the key to whoever hosts the page.'),
        copyRow(link, 'Copy link')),

      el('details.more', {},
        el('summary', {}, 'Or type them in by hand'),
        el('p.hint', {}, 'Account'),
        el('code.code-block', {}, cfg.accountId),
        el('p.hint', {}, 'Write key'),
        el('code.code-block', {}, cfg.writeKey),
        copyRow(cfg.writeKey, 'Copy write key')));
  };

  return el('section', {},
    el('h2', {}, 'Your other devices'),
    el('p.lede', {},
      'A phone or a second computer reaches the same archive with these. ' +
      'Nothing is tied to one browser.'),
    el('div.actions', {}, reveal),
    body);
}

function copyRow(text, label) {
  const btn = el('button.quiet', {}, label);
  btn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label; }, 1500);
    } catch {
      // Clipboard access is refused in plenty of ordinary situations. The
      // text is on screen and selectable, so say that rather than fail.
      btn.textContent = 'Select the text above instead';
      setTimeout(() => { btn.textContent = label; }, 2500);
    }
  };
  return el('div.actions', {}, btn);
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
