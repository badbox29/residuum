/**
 * sync.js — talking to a Worker, if there is one.
 *
 * Sync is optional and always has been. Nothing in this file runs until
 * someone points the app at their own Worker, and the archive is complete
 * and usable without it. Everything here is about moving operations between
 * devices, never about where the truth lives — that is always IndexedDB.
 *
 * The state machine is the important part. A sync that fails quietly is worse
 * than one that fails loudly, because the person keeps working and keeps
 * believing their edits are somewhere other than this one browser.
 */

import * as store from './store.js';

export const SyncState = {
  OFF: 'off',               // no Worker configured — the default
  IDLE: 'idle',             // configured, nothing pending
  SYNCING: 'syncing',
  SYNCED: 'synced',
  OFFLINE: 'offline',       // network unreachable; changes are queued
  FAILED: 'failed',         // server reachable but refusing; needs attention
  AUTH_REQUIRED: 'auth-required',
};

// Shared with the Worker. Both sides must derive identically or no signature
// verifies. Not a secret — an HKDF salt is public by design, and the write key
// it is applied to is already 256 bits of randomness.
const HMAC_SALT = 'residuum-hmac-v1';
const HMAC_INFO = 'residuum-request-v1';
const PUSH_BATCH = 500;
const PULL_BATCH = 500;

let state = SyncState.OFF;
let lastError = null;
let timer = null;
const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  fn(status());
  return () => listeners.delete(fn);
}

export function status() {
  return { state, error: lastError };
}

function setState(next, error = null) {
  if (state === next && lastError === error) return;
  state = next;
  lastError = error;
  const snapshot = status();
  for (const fn of listeners) {
    try { fn(snapshot); } catch (err) { console.error('[sync] listener threw', err); }
  }
}

// ── Configuration ───────────────────────────────────────────────────────────
//
// Credentials live in the IndexedDB meta store rather than localStorage.
// localStorage is shared across everything on an origin, which is how two
// unrelated apps on the same host end up fighting over a key; a named
// IndexedDB database cannot collide that way.

export async function getConfig() {
  return {
    url: await store.getMeta('worker_url'),
    accountId: await store.getMeta('account_id'),
    writeKey: await store.getMeta('write_key'),
    capabilities: await store.getMeta('worker_config'),
  };
}

export async function isConfigured() {
  const c = await getConfig();
  return Boolean(c.url && c.accountId && c.writeKey);
}

/**
 * Ask a Worker what it supports. Does not sign in — this is the step that
 * lets the client stay free of any particular deployment's details.
 */
export async function probe(workerUrl) {
  const url = normalizeUrl(workerUrl);
  const res = await fetch(`${url}/config`);
  if (!res.ok) throw new Error(`that URL answered ${res.status}; is it a Residuum Worker?`);
  const cfg = await res.json();
  if (cfg.service !== 'residuum') throw new Error('that URL is not a Residuum Worker');
  return { url, config: cfg };
}

/** Create a fresh self-hosted account. Returns the sync code to save. */
export async function signInWithCode(workerUrl) {
  const { url } = await probe(workerUrl);
  const res = await fetch(`${url}/auth/token`, { method: 'POST' });
  if (!res.ok) throw new Error(await errorText(res));
  const { account_id, write_key } = await res.json();
  await saveCredentials(url, account_id, write_key);
  return { accountId: account_id, writeKey: write_key };
}

/** Use a sync code from another device. */
export async function signInWithExistingCode(workerUrl, accountId, writeKey) {
  const { url } = await probe(workerUrl);
  await saveCredentials(url, accountId, writeKey);
  // Prove the credentials work before reporting success, rather than failing
  // later during a background sync when nobody is watching.
  const res = await apiFetch('GET', '/sync?since=0&limit=1');
  if (!res.ok) {
    await clearCredentials();
    throw new Error('that sync code was not accepted by this Worker');
  }
  return { accountId };
}

export async function signInWithGoogle(workerUrl, credential) {
  const { url } = await probe(workerUrl);
  const res = await fetch(`${url}/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  const { account_id, write_key, email } = await res.json();
  await saveCredentials(url, account_id, write_key);
  return { accountId: account_id, email };
}

async function saveCredentials(url, accountId, writeKey) {
  await store.setMeta('worker_url', url);
  await store.setMeta('account_id', accountId);
  await store.setMeta('write_key', writeKey);
  setState(SyncState.IDLE);
}

/**
 * Stop syncing. Records stay — this disconnects a Worker, it does not delete
 * an archive, and the distinction should be obvious in the UI too.
 */
export async function clearCredentials() {
  await store.setMeta('worker_url', null);
  await store.setMeta('account_id', null);
  await store.setMeta('write_key', null);
  stop();
  setState(SyncState.OFF);
}

// ── Pairing ─────────────────────────────────────────────────────────────────

/**
 * Pack this device's credentials into a link another device can open.
 *
 * The payload rides in the URL fragment, which browsers never send to a
 * server — so even though the link passes through mail or a messaging app,
 * the write key is not handed to whoever hosts the page it points at.
 *
 * It is still a secret in plain sight: anyone holding this link has full
 * access to the archive. The UI says so.
 */
export async function pairingLink(origin = location.href) {
  const { url, accountId, writeKey } = await getConfig();
  if (!url) return null;
  const payload = b64url(JSON.stringify({ u: url, a: accountId, k: writeKey }));
  return `${origin.split('#')[0]}#pair/${payload}`;
}

export function readPairingPayload(encoded) {
  try {
    const { u, a, k } = JSON.parse(unb64url(encoded));
    if (!u || !a || !k) return null;
    return { url: u, accountId: a, writeKey: k };
  } catch {
    return null;
  }
}

/** Adopt credentials from a pairing link, after checking they actually work. */
export async function pairFrom({ url, accountId, writeKey }) {
  await probe(url);
  await saveCredentials(normalizeUrl(url), accountId, writeKey);
  const res = await apiFetch('GET', '/sync?since=0&limit=1');
  if (!res.ok) {
    await clearCredentials();
    throw new Error('those credentials were not accepted by that Worker');
  }
  start();
  return { accountId };
}

const b64url = str =>
  btoa(String.fromCharCode(...new TextEncoder().encode(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function unb64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

// ── Request signing ─────────────────────────────────────────────────────────
//
// Writes are signed with the write key, not with a sign-in session. A Google
// session lasts an hour; an edit in progress should not care. The key does not
// expire, so a session ending mid-sentence costs nothing.

async function signingKey(writeKey) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(writeKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new TextEncoder().encode(HMAC_SALT),
      info: new TextEncoder().encode(HMAC_INFO),
    },
    base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function sign(method, path, accountId, writeKey, timestamp, bodyBytes) {
  // Bytes, not text. The Worker hashes the raw request body, and a photo is
  // not valid UTF-8 — decoding it to a string first would hash something
  // other than what was sent, so no upload could ever verify.
  const message = [method, path, accountId, timestamp, await sha256Bytes(bodyBytes)].join(':');
  const key = await signingKey(writeKey);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return hex(new Uint8Array(sig));
}

async function apiFetch(method, path, body = null) {
  const payload = body == null ? null : new TextEncoder().encode(JSON.stringify(body));
  return signedFetch(method, path, payload, body == null ? null : 'application/json');
}

/** The one place a signed request is built, for JSON and binary alike. */
async function signedFetch(method, path, bytes, contentType) {
  const { url, accountId, writeKey } = await getConfig();
  if (!url) throw new Error('no Worker configured');

  const payload = bytes || new Uint8Array(0);
  const timestamp = String(Date.now());
  // Sign the path only, never the query string — the Worker signs
  // url.pathname, and a mismatch here is the hardest kind of bug to find.
  const pathOnly = path.split('?')[0];
  const signature = await sign(method, pathOnly, accountId, writeKey, timestamp, payload);

  const headers = {
    'X-Account': accountId,
    'X-Timestamp': timestamp,
    'X-Signature': signature,
  };
  const deviceId = await store.deviceId();
  if (deviceId) headers['X-Device'] = deviceId;
  if (contentType) headers['Content-Type'] = contentType;

  return fetch(`${url}${path}`, {
    method,
    headers,
    body: payload.byteLength ? payload : undefined,
  });
}

// ── The loop ────────────────────────────────────────────────────────────────

/**
 * Push everything queued, then pull everything new.
 *
 * Push first, deliberately. Pulling first would merge remote changes into
 * records this device is about to push anyway, doing the same work twice; and
 * if the process dies between the two, unsent local work is the thing you
 * want already safe on the server.
 */
export async function syncOnce({ force = false } = {}) {
  if (!(await isConfigured())) { setState(SyncState.OFF); return false; }
  if (state === SyncState.SYNCING) return false;

  const pending = await store.outboxCount();
  if (!force && pending === 0 && state === SyncState.SYNCED) return false;

  setState(SyncState.SYNCING);
  try {
    await pushPending();
    await pushBlobs();
    await pullNew();
    setState(SyncState.SYNCED);
    return true;
  } catch (err) {
    setState(classify(err), describe(err));
    return false;
  }
}

async function pushPending() {
  for (;;) {
    const ops = await store.outbox(PUSH_BATCH);
    if (!ops.length) return;

    const res = await apiFetch('POST', '/sync', { ops });
    if (!res.ok) throw await httpError(res);

    const { assigned } = await res.json();
    // Clear only what the server confirmed. Anything it did not acknowledge
    // stays queued and is retried, rather than being dropped on the
    // assumption the push worked.
    const confirmed = (assigned || []).filter(a => a.seq != null).map(a => a.client_op_id);
    await store.clearOutbox(confirmed);

    if (ops.length < PUSH_BATCH) return;
    if (!confirmed.length) throw new Error('the server accepted nothing; stopping to avoid a loop');
  }
}

/**
 * Upload any files this device holds that the Worker does not.
 *
 * Asks first. Content addressing means another device may already have
 * uploaded the identical bytes, and a photo is worth far more than the
 * request it takes to check.
 *
 * A failure here is not allowed to fail the whole sync: the record pointing
 * at the file has already synced, and the bytes catching up later is a much
 * smaller problem than a sync that stops because one photo would not upload.
 */
async function pushBlobs() {
  const pending = await store.pendingUploads(20);
  if (!pending.length) return;

  let have = new Set();
  try {
    const res = await apiFetch('POST', '/blob/check', { hashes: pending });
    if (res.ok) have = new Set((await res.json()).have || []);
  } catch {
    // Fall through and attempt the uploads anyway.
  }

  for (const sha of pending) {
    if (have.has(sha)) { await store.clearUpload(sha); continue; }

    const blob = await store.getBlob(sha);
    if (!blob) { await store.clearUpload(sha); continue; }

    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const res = await signedFetch('PUT', `/blob/${sha}`, bytes,
        blob.type || 'application/octet-stream');
      if (res.ok) await store.clearUpload(sha);
      else if (res.status === 413 || res.status === 400) {
        // The Worker will never accept this one; leaving it queued would
        // retry it forever. The bytes stay on this device either way.
        console.warn(`[sync] ${sha} rejected by the Worker, giving up on uploading it`);
        await store.clearUpload(sha);
      } else {
        return;   // transient — stop and try again next time
      }
    } catch {
      return;
    }
  }
}

/** Fetch one file's bytes. Used by blobs.js when a device lacks them. */
export async function downloadBlob(sha) {
  if (!(await isConfigured())) return null;
  const res = await apiFetch('GET', `/blob/${sha}`);
  if (!res.ok) return null;
  return res.blob();
}

async function pullNew() {
  for (;;) {
    const since = await store.getCursor();
    const res = await apiFetch('GET', `/sync?since=${since}&limit=${PULL_BATCH}`);
    if (!res.ok) throw await httpError(res);

    const { ops, head, more } = await res.json();
    if (!ops.length) return;

    // The cursor advances inside the same transaction as the records, in
    // store.applyRemote. Advancing it here, after the fact, is how a device
    // skips a batch it failed to write and never asks for it again.
    await store.applyRemote(ops, head);
    if (!more) return;
  }
}

function classify(err) {
  if (err && err.status === 401) return SyncState.AUTH_REQUIRED;
  if (err instanceof TypeError || !navigator.onLine) return SyncState.OFFLINE;
  return SyncState.FAILED;
}

function describe(err) {
  if (err && err.status === 401) return 'This device is no longer authorised to sync.';
  if (err instanceof TypeError || !navigator.onLine) {
    return 'Offline. Your changes are saved here and will sync when you reconnect.';
  }
  return (err && err.message) || 'Sync failed.';
}

// ── Scheduling ──────────────────────────────────────────────────────────────

export function start({ intervalMs = 60_000 } = {}) {
  stop();
  timer = setInterval(() => { syncOnce().catch(() => {}); }, intervalMs);

  // Coming back online, or returning to the tab, are the two moments a stuck
  // sync is most likely to succeed and most likely to matter.
  addEventListener('online', onWake);
  addEventListener('visibilitychange', onVisible);
  syncOnce({ force: true }).catch(() => {});
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  removeEventListener('online', onWake);
  removeEventListener('visibilitychange', onVisible);
}

const onWake = () => { syncOnce({ force: true }).catch(() => {}); };
const onVisible = () => {
  if (document.visibilityState === 'visible') syncOnce().catch(() => {});
};

/**
 * How much unsynced work exists, and how old it is.
 *
 * "12 changes, oldest about two hours ago" tells someone what is at stake in
 * a way a bare count does not.
 */
export async function pendingSummary() {
  const count = await store.outboxCount();
  const files = await store.pendingUploadCount();
  const oldest = await store.oldestPending();
  return { count, files, oldest, ageMs: oldest ? Date.now() - oldest : 0 };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeUrl(u) {
  const trimmed = String(u || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('the Worker URL must start with https://');
  return trimmed;
}

async function httpError(res) {
  const err = new Error(await errorText(res));
  err.status = res.status;
  return err;
}

async function errorText(res) {
  try {
    const body = await res.json();
    return body.error || `server returned ${res.status}`;
  } catch {
    return `server returned ${res.status}`;
  }
}

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

async function sha256Bytes(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
