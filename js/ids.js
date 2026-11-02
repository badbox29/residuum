/**
 * ids.js — identifier generation.
 *
 * UUIDv7 rather than v4: the first 48 bits are a millisecond timestamp, so
 * ids sort chronologically as strings. That matters in a few places —
 * IndexedDB keys come back in key order, so "the oldest records" is a range
 * query rather than a scan and sort, and a list of ids is readable in the
 * order things happened.
 *
 * Hand-rolled because the platform does not offer v7 (crypto.randomUUID is
 * v4) and this project has no dependencies.
 */

/**
 * @returns {string} a UUIDv7, e.g. '01927f3a-...'
 */
export function uuidv7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const ts = Date.now();

  // 48-bit big-endian timestamp. Written with division rather than bit shifts
  // because JavaScript's bitwise operators truncate to 32 bits, and this value
  // needs all 48.
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;

  bytes[6] = 0x70 | (bytes[6] & 0x0f);  // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f);  // RFC 4122 variant

  const h = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Recover the creation time from a UUIDv7. Useful for debugging sync order. */
export function uuidv7Time(id) {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return parseInt(hex, 16);
}

/**
 * A stable per-device identifier. Generated once and stored; it names the
 * device in revision entries ("who changed this") and in the oplog, so it
 * must survive across sessions.
 */
export function newDeviceId() {
  return `dev_${uuidv7()}`;
}
