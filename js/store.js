/**
 * store.js — IndexedDB.
 *
 * This is the archive. Not a cache of something on a server — the records
 * here are authoritative, and the app is fully usable with no network and no
 * account for as long as you like.
 *
 * Kept deliberately thin: the logic worth getting right lives in oplog.js and
 * merge.js as pure functions with tests. What remains here is plumbing, which
 * is verified against real IndexedDB by test/browser.html rather than against
 * a shim that might not share IndexedDB's actual semantics.
 */

import { ENTITIES, ENTITY_NAMES, entityDef } from './entities.js';
import { applyOp } from './oplog.js';
import { newDeviceId } from './ids.js';

const DB_NAME = 'residuum';
const DB_VERSION = 2;

/**
 * Pending operations waiting to be pushed, and the sync cursor, live in their
 * own stores rather than inside the records.
 *
 * That separation is deliberate. If the record write is the thing that failed,
 * a flag stored inside that record goes down with it, and the app forgets it
 * has unsaved work.
 */
const OUTBOX = 'outbox';
const META = 'meta';

/**
 * Blob bytes, and which of them still need uploading.
 *
 * Bytes live here rather than travelling through the oplog: a photo is large,
 * immutable, and content-addressed, so it has no version to conflict over and
 * nothing to merge. The oplog carries only the small Document record that
 * points at a hash.
 *
 * THUMBS is derived and deliberately never synced. Each device regenerates
 * its own, which costs a moment once and saves maintaining a second copy of
 * every image that could fall out of step with the first.
 */
const BLOBS = 'blobs';
const UPLOADS = 'uploads';
const THUMBS = 'thumbs';

let dbPromise = null;

export function openDb(name = DB_NAME) {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);

    req.onupgradeneeded = ev => {
      const db = req.result;

      for (const [entity, def] of Object.entries(ENTITIES)) {
        if (db.objectStoreNames.contains(def.store)) continue;
        const store = db.createObjectStore(def.store, { keyPath: def.pk });
        for (const field of def.indexes) store.createIndex(field, field, { unique: false });
      }

      if (!db.objectStoreNames.contains(OUTBOX)) {
        // keyPath is the client op id, which is also what makes a retried
        // push idempotent on the server.
        db.createObjectStore(OUTBOX, { keyPath: 'client_op_id' });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: 'key' });
      }
      for (const name of [BLOBS, UPLOADS, THUMBS]) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'sha256' });
        }
      }
      void ev;
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(
      'Another tab is holding an older version of the database open. Close it and reload.'));
  });
  return dbPromise;
}

/** For tests and for switching databases; drops the memoised handle. */
export function resetDbHandle() { dbPromise = null; }

// ── Promise wrappers ────────────────────────────────────────────────────────
// IndexedDB predates promises. These three adapters are the only place the
// request/event style appears.

const wrap = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

async function tx(stores, mode, fn) {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const result = await fn(t);
  await done(t);
  return result;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function get(entity, id) {
  const def = entityDef(entity);
  return tx([def.store], 'readonly', t => wrap(t.objectStore(def.store).get(id)));
}

export async function getMany(entity, ids) {
  const def = entityDef(entity);
  return tx([def.store], 'readonly', async t => {
    const store = t.objectStore(def.store);
    const out = await Promise.all(ids.map(id => wrap(store.get(id))));
    return out.filter(Boolean);
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.index]  an indexed field to query
 * @param {*}      [opts.value]  the value to match on that index
 * @param {boolean} [opts.includeTombstoned]  default false
 */
export async function list(entity, { index, value, includeTombstoned = false } = {}) {
  const def = entityDef(entity);
  const rows = await tx([def.store], 'readonly', t => {
    const store = t.objectStore(def.store);
    if (index) {
      if (!def.indexes.includes(index)) {
        throw new Error(`list(${entity}): "${index}" is not an index`);
      }
      return wrap(store.index(index).getAll(value));
    }
    return wrap(store.getAll());
  });
  if (includeTombstoned) return rows;
  return rows.filter(r => r.tombstoned_at == null);
}

/**
 * Traverse relationships. Both directions cost the same — from_id and to_id
 * are both indexed, which is what makes "what does this breaker feed" and
 * "what powers this HVAC" the same query shape.
 */
export async function edges({ from, to, kind } = {}) {
  let rows;
  if (from) rows = await list('relationship', { index: 'from_id', value: from.id });
  else if (to) rows = await list('relationship', { index: 'to_id', value: to.id });
  else rows = await list('relationship');

  return rows.filter(r =>
    (!from || r.from_type === from.type) &&
    (!to || r.to_type === to.type) &&
    (!kind || r.kind === kind));
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Apply locally-made operations and queue them for sync, in one transaction.
 *
 * Record and outbox entry commit together. If they could commit separately,
 * a crash between them would leave either a change that never syncs or a
 * queued push for a change that was never made.
 */
export async function applyLocal(ops) {
  if (!ops.length) return;
  const stores = [...new Set(ops.map(o => entityDef(o.entity).store))];

  return tx([...stores, OUTBOX], 'readwrite', async t => {
    for (const op of ops) {
      const def = entityDef(op.entity);
      const store = t.objectStore(def.store);
      const existing = await wrap(store.get(op.entity_id));
      await wrap(store.put(applyOp(existing, op)));
      await wrap(t.objectStore(OUTBOX).put(op));
    }
  });
}

/**
 * Apply operations pulled from the server and advance the cursor.
 *
 * The cursor moves in the same transaction as the records. Advancing it first,
 * or separately, is how a device silently skips everything in a batch it
 * failed to write — and never asks for it again.
 */
export async function applyRemote(ops, head) {
  const stores = [...new Set(ops.map(o => entityDef(o.entity).store))];

  return tx([...stores, META, OUTBOX], 'readwrite', async t => {
    for (const op of ops) {
      const def = entityDef(op.entity);
      const store = t.objectStore(def.store);
      const existing = await wrap(store.get(op.entity_id));
      await wrap(store.put(applyOp(existing, op)));

      // Our own operation coming back means the server has it. Nothing left
      // to push.
      await wrap(t.objectStore(OUTBOX).delete(op.client_op_id));
    }
    if (head != null) {
      await wrap(t.objectStore(META).put({ key: 'cursor', value: head }));
    }
  });
}

// ── Outbox ──────────────────────────────────────────────────────────────────

export async function outbox(limit = 500) {
  const all = await tx([OUTBOX], 'readonly', t => wrap(t.objectStore(OUTBOX).getAll()));
  // Oldest first: operations must reach the server in the order they happened.
  all.sort((a, b) => (a.client_at || 0) - (b.client_at || 0));
  return all.slice(0, limit);
}

export async function outboxCount() {
  return tx([OUTBOX], 'readonly', t => wrap(t.objectStore(OUTBOX).count()));
}

/** Called after the server confirms it has these operations. */
export async function clearOutbox(opIds) {
  if (!opIds.length) return;
  return tx([OUTBOX], 'readwrite', async t => {
    const store = t.objectStore(OUTBOX);
    for (const id of opIds) await wrap(store.delete(id));
  });
}

/**
 * The oldest unsynced change, as a timestamp, or null when everything is
 * pushed. Drives the "unsaved changes going back about two hours" message —
 * a count alone does not tell someone how much is at stake.
 */
export async function oldestPending() {
  const pending = await outbox(1);
  return pending.length ? pending[0].client_at : null;
}

// ── Blobs ───────────────────────────────────────────────────────────────────

export async function putBlob(sha256, blob, { queueUpload = true } = {}) {
  return tx([BLOBS, UPLOADS], 'readwrite', async t => {
    await wrap(t.objectStore(BLOBS).put({
      sha256, blob, mime: blob.type, size: blob.size, at: Date.now(),
    }));
    // Queued in the same transaction as the bytes. Separately, a crash
    // between them leaves either a photo that never uploads or an upload
    // queued for bytes that were never stored.
    if (queueUpload) {
      await wrap(t.objectStore(UPLOADS).put({ sha256, at: Date.now() }));
    }
  });
}

export async function getBlob(sha256) {
  const row = await tx([BLOBS], 'readonly', t => wrap(t.objectStore(BLOBS).get(sha256)));
  return row ? row.blob : null;
}

export async function hasBlob(sha256) {
  const n = await tx([BLOBS], 'readonly', t => wrap(t.objectStore(BLOBS).count(sha256)));
  return n > 0;
}

export async function pendingUploads(limit = 20) {
  const all = await tx([UPLOADS], 'readonly', t => wrap(t.objectStore(UPLOADS).getAll()));
  all.sort((a, b) => (a.at || 0) - (b.at || 0));
  return all.slice(0, limit).map(r => r.sha256);
}

export async function pendingUploadCount() {
  return tx([UPLOADS], 'readonly', t => wrap(t.objectStore(UPLOADS).count()));
}

export async function clearUpload(sha256) {
  return tx([UPLOADS], 'readwrite', t => wrap(t.objectStore(UPLOADS).delete(sha256)));
}

export async function putThumb(sha256, dataUrl) {
  return tx([THUMBS], 'readwrite', t => wrap(t.objectStore(THUMBS).put({ sha256, dataUrl })));
}

export async function getThumb(sha256) {
  const row = await tx([THUMBS], 'readonly', t => wrap(t.objectStore(THUMBS).get(sha256)));
  return row ? row.dataUrl : null;
}

// ── Meta ────────────────────────────────────────────────────────────────────

export async function getMeta(key, fallback = null) {
  const row = await tx([META], 'readonly', t => wrap(t.objectStore(META).get(key)));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  return tx([META], 'readwrite', t => wrap(t.objectStore(META).put({ key, value })));
}

export const getCursor = () => getMeta('cursor', 0);

/** Generated once and kept; it names this device in revision entries. */
export async function deviceId() {
  let id = await getMeta('device_id');
  if (!id) {
    id = newDeviceId();
    await setMeta('device_id', id);
  }
  return id;
}

/**
 * Everything, for export and for handing to a new device.
 *
 * Tombstoned records are included deliberately. A device that receives a
 * snapshot without them holds records it does not know are dead, and
 * resurrects them on its next push.
 */
export async function exportAll() {
  const out = { exported_at: Date.now(), entities: {} };
  for (const entity of ENTITY_NAMES) {
    out.entities[entity] = await list(entity, { includeTombstoned: true });
  }
  return out;
}
