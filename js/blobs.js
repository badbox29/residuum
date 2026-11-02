/**
 * blobs.js — photos, manuals, receipts.
 *
 * Files are addressed by the SHA-256 of their contents, not by a generated
 * id. That buys several things at once: the same manual attached to two
 * properties is stored once, re-adding a file is harmless rather than a
 * duplicate, and sync needs no merge rule because a blob either exists at
 * that hash or does not. There is no version to conflict over.
 *
 * Bytes are stored locally first and uploaded afterwards. Photographing a
 * serial plate in a crawlspace with no signal has to work, and it does: the
 * photo is saved and attached immediately, and the upload waits in a queue.
 */

import * as store from './store.js';
import { buildPut } from './oplog.js';

/** Long edge, in pixels, for a stored photo. */
const MAX_EDGE = 2000;
const THUMB_EDGE = 320;
const JPEG_QUALITY = 0.85;
const MAX_BYTES = 20 * 1024 * 1024;

export async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Shrink a photo before storing it.
 *
 * A phone photo is 3–12 MB, and nothing in this archive needs that: a serial
 * plate is legible at a fraction of it. Storing the original would mean
 * uploading it, syncing it to every device, and keeping it for decades, for
 * detail nobody will look at.
 *
 * Anything that is not an image passes through untouched — a PDF manual must
 * not be re-encoded.
 */
export async function prepare(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    if (file.size > MAX_BYTES) throw new Error(`${file.name} is too large (max 20 MB).`);
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 2_000_000) {
      bitmap.close();
      return file;
    }
    const out = await draw(bitmap, scale, JPEG_QUALITY);
    bitmap.close();
    return new File([out], renameToJpeg(file.name), { type: 'image/jpeg' });
  } catch {
    // A format the browser cannot decode is still worth keeping as-is.
    if (file.size > MAX_BYTES) throw new Error(`${file.name} is too large (max 20 MB).`);
    return file;
  }
}

async function draw(bitmap, scale, quality) {
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
}

const renameToJpeg = name => name.replace(/\.[^.]+$/, '') + '.jpg';

/**
 * Store a file and attach it to a record.
 *
 * Returns the operation for the Document record, which syncs through the
 * oplog like anything else. The bytes travel separately.
 */
export async function attach(file, { attachedToType, attachedToId, kind, caption }, ctx) {
  const prepared = await prepare(file);
  const hash = await sha256(prepared);

  // Content-addressed, so storing the same bytes twice is a no-op rather than
  // a duplicate. Only queue an upload if this device has not already got it.
  if (!(await store.hasBlob(hash))) {
    await store.putBlob(hash, prepared);
  }
  await makeThumb(hash, prepared);

  const { op } = buildPut('document', {
    sha256: hash,
    filename: file.name,
    mime_type: prepared.type,
    byte_size: prepared.size,
    kind: kind || guessKind(prepared),
    caption: caption || '',
    attached_to_type: attachedToType,
    attached_to_id: attachedToId,
  }, ctx);

  return op;
}

function guessKind(file) {
  if (file.type.startsWith('image/')) return 'photo';
  if (file.type === 'application/pdf') return 'manual';
  return 'file';
}

async function makeThumb(hash, blob) {
  if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return;
  if (await store.getThumb(hash)) return;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
    const small = await draw(bitmap, scale, 0.7);
    bitmap.close();
    await store.putThumb(hash, await toDataUrl(small));
  } catch {
    // A missing thumbnail costs a placeholder, nothing more.
  }
}

const toDataUrl = blob => new Promise(res => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.readAsDataURL(blob);
});

/**
 * Get a file's bytes, fetching from the Worker only if this device does not
 * already have them.
 *
 * Each blob downloads once per device and is then permanent. That is the
 * local-first behaviour and it is also what makes R2's free tier comfortable:
 * reads are one-per-blob-per-device forever, not one per view.
 */
export async function bytesFor(sha) {
  const local = await store.getBlob(sha);
  if (local) return local;

  const sync = await import('./sync.js');
  const blob = await sync.downloadBlob(sha);
  if (!blob) return null;

  // Verify what came back. Content addressing is only a guarantee if someone
  // checks, and a silently wrong file in an archive is worse than a missing
  // one — you would not know to go looking.
  const actual = await sha256(blob);
  if (actual !== sha) throw new Error('that file did not match its checksum and was not kept');

  await store.putBlob(sha, blob, { queueUpload: false });
  await makeThumb(sha, blob);
  return blob;
}

/** A thumbnail if one exists, otherwise built from the bytes on demand. */
export async function thumbFor(sha) {
  const cached = await store.getThumb(sha);
  if (cached) return cached;
  const blob = await store.getBlob(sha);
  if (!blob) return null;
  await makeThumb(sha, blob);
  return store.getThumb(sha);
}

/** An object URL for display. Callers revoke it when finished. */
export async function urlFor(sha) {
  const blob = await bytesFor(sha);
  return blob ? URL.createObjectURL(blob) : null;
}

export const humanSize = bytes =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB`
  : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB`
  : `${bytes} bytes`;
