/**
 * Residuum sync Worker — single file, paste into the Cloudflare dashboard.
 *
 * No imports, no build step. That is deliberate: it means you can run your own
 * sync without connecting a repository to your Cloudflare account, without CI,
 * and without a local toolchain.
 *
 * ── What this does ──────────────────────────────────────────────────────────
 *
 * Stores an append-only log of operations and hands back operations after a
 * given sequence number. It never merges, never reconstructs current state,
 * and never answers a question about the archive — every device already holds
 * the whole thing locally.
 *
 * What it provides that a client cannot is a monotonic sequence. AUTOINCREMENT
 * on a single SQLite primary gives a total order every device agrees on, so
 * sync is "everything after N" rather than a timestamp comparison that has to
 * reason about clock skew.
 *
 * ── Bindings and settings ───────────────────────────────────────────────────
 *
 *   DB               D1 database (run schema.sql once)
 *   KV               KV namespace — write keys and rate limiting
 *   BLOBS            R2 bucket — photos, manuals, receipts
 *   GOOGLE_CLIENT_ID variable, optional — enables Google sign-in
 *   ALLOWED_ORIGINS  variable, optional — comma-separated, restricts CORS
 */

/**
 * Shared with the client (js/sync.js). Both sides must derive identically or
 * no signature ever verifies.
 *
 * Not a secret, and does not need to be: an HKDF salt is public by design,
 * and the write key it is applied to is already 256 bits of CSPRNG output.
 * The secret here is the write key, which is generated server-side, stored in
 * KV, and handed to a device once over HTTPS.
 */
const HMAC_SALT = 'residuum-hmac-v1';
const HMAC_INFO = 'residuum-request-v1';

const MAX_BODY = 1_048_576;        // 1 MB of operations per push
const MAX_BLOB = 20 * 1024 * 1024; // 20 MB per uploaded file
const MAX_OPS = 500;
const MAX_PULL = 500;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const AUTH_RATE_LIMIT = 30;        // per IP per hour on /auth/*

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    try {
      const res = await route(request, env, url);
      for (const [k, v] of Object.entries(corsHeaders(origin, env))) {
        res.headers.set(k, v);
      }
      return res;
    } catch (err) {
      return withCors(json({ error: String((err && err.message) || err) }, 500), origin, env);
    }
  },
};

async function route(request, env, url) {
  const p = url.pathname;
  const m = request.method;

  if (p === '/config' && m === 'GET') return handleConfig(env);
  if (p === '/health' && m === 'GET') return json({ ok: true, now: Date.now() });

  if (p.startsWith('/auth/')) {
    const limited = await rateLimit(request, env);
    if (limited) return limited;
    if (p === '/auth/token' && m === 'POST') return handleNewToken(env);
    if (p === '/auth/google' && m === 'POST') return handleGoogle(request, env);
    if (p === '/auth/writekey' && m === 'POST') return handleWriteKey(request, env);
    return json({ error: 'not found' }, 404);
  }

  // Everything below requires a signed request.
  const auth = await authenticate(request, env, url);
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  if (p === '/sync' && m === 'GET') return handlePull(request, env, url, auth);
  if (p === '/sync' && m === 'POST') return handlePush(request, env, auth);
  if (p === '/blob/check' && m === 'POST') return handleBlobCheck(request, env, auth);
  if (p.startsWith('/blob/')) {
    const sha = p.slice('/blob/'.length);
    if (m === 'PUT') return handleBlobPut(request, env, auth, sha);
    if (m === 'GET') return handleBlobGet(env, auth, sha);
  }

  return json({ error: 'not found' }, 404);
}

// ── CORS ────────────────────────────────────────────────────────────────────
//
// Permissive by default, and that is a considered choice rather than an
// oversight. Authentication here is a signature in a request header, never a
// cookie, so there is no ambient credential a third-party page could ride on:
// a malicious site can send requests, but cannot sign them, because the write
// key sits in localStorage scoped to the app's own origin.
//
// Set ALLOWED_ORIGINS to tighten it anyway if you host the client at a known
// address — defence in depth costs nothing here.

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(origin, env) {
  const list = allowedOrigins(env);
  const allow = list.length === 0 ? (origin || '*')
    : (list.includes(origin) ? origin : list[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Account, X-Timestamp, X-Signature, X-Device, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function withCors(res, origin, env) {
  for (const [k, v] of Object.entries(corsHeaders(origin, env))) res.headers.set(k, v);
  return res;
}

// ── Config ──────────────────────────────────────────────────────────────────

/**
 * Tells the client how this Worker wants to be talked to.
 *
 * The client ships with no server URL, client id, or project reference baked
 * in — someone points it at their own Worker and it asks what to do. That is
 * what keeps the repository free of anyone's deployment.
 */
function handleConfig(env) {
  return json({
    service: 'residuum',
    version: 1,
    auth: {
      token: true,                                   // always available
      google: Boolean(env.GOOGLE_CLIENT_ID),
      google_client_id: env.GOOGLE_CLIENT_ID || null,
    },
    blobs: Boolean(env.BLOBS),
    limits: { max_ops: MAX_OPS, max_pull: MAX_PULL, max_blob_bytes: MAX_BLOB },
  });
}

// ── Rate limiting ───────────────────────────────────────────────────────────

async function rateLimit(request, env) {
  if (!env.KV) return null;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `rl:${ip}:${hour}`;
  const current = parseInt(await env.KV.get(key) || '0', 10);
  if (current >= AUTH_RATE_LIMIT) {
    return json({ error: 'too many attempts; try again later' }, 429);
  }
  // Read-then-write races under concurrency, which is acceptable: this exists
  // to blunt brute force, not to be an exact counter.
  await env.KV.put(key, String(current + 1), { expirationTtl: 7200 });
  return null;
}

// ── Accounts and write keys ─────────────────────────────────────────────────
//
// Google sessions expire after an hour. Signing every write with a credential
// that dies mid-edit is how people lose work, so Google only ever establishes
// *identity*. Writes are signed with a long-lived write key minted here, which
// does not expire — the session ending never costs you an edit in progress.
//
// The key is random, not derived from the account id. An id is public; a key
// derived from one would be guessable by anyone who knows it.

const wkKey = accountId => `wk:${accountId}`;

async function mintWriteKey(env, accountId) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = hex(bytes);
  await env.KV.put(wkKey(accountId), key);
  return key;
}

async function getWriteKey(env, accountId) {
  return env.KV.get(wkKey(accountId));
}

/**
 * A self-hosted account with no third party involved.
 *
 * For one household running its own Worker, Google adds a familiar login
 * screen but no identity that is actually needed. This path means sync works
 * without creating a Google Cloud project — paste the code on the second
 * device and it is done.
 */
async function handleNewToken(env) {
  if (!env.KV) return json({ error: 'KV is not bound' }, 503);
  const accountId = `token:${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  const writeKey = await mintWriteKey(env, accountId);
  return json({ account_id: accountId, write_key: writeKey });
}

async function handleGoogle(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Google sign-in is not configured' }, 400);
  if (!env.KV) return json({ error: 'KV is not bound' }, 503);

  const { credential } = await readJson(request);
  if (!credential) return json({ error: 'credential is required' }, 400);

  const claims = await verifyGoogleToken(credential, env.GOOGLE_CLIENT_ID);
  if (!claims) return json({ error: 'invalid credential' }, 401);

  const accountId = `google:${claims.sub}`;
  const writeKey = (await getWriteKey(env, accountId)) || (await mintWriteKey(env, accountId));
  return json({ account_id: accountId, write_key: writeKey, email: claims.email || null });
}

/** Re-fetch the write key for an existing Google account on a new device. */
async function handleWriteKey(request, env) {
  return handleGoogle(request, env);
}

// ── Google token verification ───────────────────────────────────────────────

let jwksCache = { keys: null, at: 0 };

async function googleKeys() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) return null;
  const body = await res.json();
  jwksCache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

async function verifyGoogleToken(jwt, clientId) {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;

  const header = JSON.parse(b64urlToText(parts[0]));
  const claims = JSON.parse(b64urlToText(parts[1]));

  const keys = await googleKeys();
  if (!keys) return null;
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) return null;
  if (claims.aud !== clientId) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return null;

  return claims;
}

// ── Request signing ─────────────────────────────────────────────────────────
//
// The signed message includes the PATH. Refectory omitted it safely because it
// wrote to exactly one key; with per-record routes, a signature for one path
// would otherwise be replayable against another inside the clock-skew window.

async function signingKey(writeKey) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(writeKey), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new TextEncoder().encode(HMAC_SALT),
      info: new TextEncoder().encode(HMAC_INFO),
    },
    base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function authenticate(request, env, url) {
  if (!env.KV) return { ok: false, status: 503, error: 'KV is not bound' };

  const accountId = request.headers.get('X-Account');
  const timestamp = request.headers.get('X-Timestamp');
  const signature = request.headers.get('X-Signature');
  const deviceId = request.headers.get('X-Device');

  if (!accountId || !timestamp || !signature) {
    return { ok: false, status: 401, error: 'missing signature headers' };
  }

  const skew = Math.abs(Date.now() - parseInt(timestamp, 10));
  if (!Number.isFinite(skew) || skew > CLOCK_SKEW_MS) {
    return { ok: false, status: 401, error: 'timestamp outside the accepted window' };
  }

  const writeKey = await getWriteKey(env, accountId);
  if (!writeKey) return { ok: false, status: 401, error: 'unknown account' };

  // Read the body once, as BYTES, and hand it on; a Request body cannot be
  // read twice.
  //
  // Bytes rather than text because an uploaded photo is not valid UTF-8:
  // decoding it would replace invalid sequences and hash something other than
  // what was sent, so no binary upload could ever verify. The client hashes
  // the same bytes — for JSON that is the UTF-8 encoding of the string, which
  // is exactly what arrives here.
  const bytes = request.method === 'GET'
    ? new Uint8Array(0)
    : new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BLOB) return { ok: false, status: 413, error: 'body too large' };

  const message = [request.method, url.pathname, accountId, timestamp, await sha256Bytes(bytes)].join(':');
  const key = await signingKey(writeKey);
  const valid = await crypto.subtle.verify(
    'HMAC', key, hexToBytes(signature), new TextEncoder().encode(message));

  if (!valid) return { ok: false, status: 401, error: 'bad signature' };
  return {
    ok: true, accountId, deviceId, bytes,
    // Decoded only when a handler asks, so a 20 MB upload is never turned
    // into a 20 MB string on its way past.
    text: () => new TextDecoder().decode(bytes),
  };
}

// ── Sync ────────────────────────────────────────────────────────────────────

async function handlePull(request, env, url, auth) {
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '', 10) || MAX_PULL, MAX_PULL);

  const { results } = await env.DB.prepare(
    `SELECT seq, entity, entity_id, op, payload, device_id, client_op_id, client_at, server_at
       FROM oplog WHERE account_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
  ).bind(auth.accountId, since, limit + 1).all();

  const rows = results || [];
  const more = rows.length > limit;
  const ops = (more ? rows.slice(0, limit) : rows).map(r => ({
    seq: r.seq,
    entity: r.entity,
    entity_id: r.entity_id,
    op: r.op,
    payload: r.payload ? JSON.parse(r.payload) : null,
    device_id: r.device_id,
    client_op_id: r.client_op_id,
    client_at: r.client_at,
    server_at: r.server_at,
  }));

  return json({ ops, head: ops.length ? ops[ops.length - 1].seq : since, more });
}

/**
 * Append operations.
 *
 * Never rejects on a stale cursor. There is no base_seq check and no 409: an
 * offline-first archive must always accept an append, and the client pulls
 * afterwards and merges. Refusing a write because a device is behind is
 * exactly what loses the photo taken in a crawlspace with no signal.
 *
 * Idempotent on client_op_id, so a push whose response was lost can be retried
 * and gets back the sequence originally assigned. A duplicated event in an
 * archive is a quiet corruption, not a visible error.
 */
async function handlePush(request, env, auth) {
  if (auth.bytes.byteLength > MAX_BODY) return json({ error: 'body too large' }, 413);
  const body = parseJson(auth.text());
  const ops = body && body.ops;
  if (!Array.isArray(ops)) return json({ error: 'ops must be an array' }, 400);
  if (ops.length > MAX_OPS) return json({ error: `at most ${MAX_OPS} ops per push` }, 413);
  if (!ops.length) return json({ assigned: [], head: await head(env, auth.accountId) });

  for (const op of ops) {
    if (!op || !op.client_op_id || !op.entity || !op.entity_id) {
      return json({ error: 'each op needs client_op_id, entity and entity_id' }, 400);
    }
    if (op.op !== 'put' && op.op !== 'tombstone') {
      return json({ error: "op must be 'put' or 'tombstone'" }, 400);
    }
  }

  const seen = await seenOpIds(env, auth.accountId, ops.map(o => o.client_op_id));
  const fresh = ops.filter(o => !seen.has(o.client_op_id));
  const assigned = ops
    .filter(o => seen.has(o.client_op_id))
    .map(o => ({ client_op_id: o.client_op_id, seq: seen.get(o.client_op_id), duplicate: true }));

  if (fresh.length) {
    const now = Date.now();
    await env.DB.batch(fresh.map(op => env.DB.prepare(
      `INSERT INTO oplog
         (account_id, entity, entity_id, op, payload, device_id, client_op_id, client_at, server_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      auth.accountId, op.entity, op.entity_id, op.op,
      op.payload ? JSON.stringify(op.payload) : null,
      auth.deviceId || op.device_id || null,
      op.client_op_id, op.client_at || null, now,
    )));

    const now2 = await seenOpIds(env, auth.accountId, fresh.map(o => o.client_op_id));
    for (const op of fresh) {
      assigned.push({ client_op_id: op.client_op_id, seq: now2.get(op.client_op_id) ?? null });
    }
  }

  return json({ assigned, head: await head(env, auth.accountId) });
}

async function head(env, accountId) {
  const row = await env.DB.prepare('SELECT MAX(seq) AS head FROM oplog WHERE account_id = ?')
    .bind(accountId).first();
  return row?.head || 0;
}

async function seenOpIds(env, accountId, opIds) {
  const map = new Map();
  for (let i = 0; i < opIds.length; i += 90) {   // stay under D1's bound-parameter cap
    const slice = opIds.slice(i, i + 90);
    const holes = slice.map(() => '?').join(',');
    const { results } = await env.DB.prepare(
      `SELECT client_op_id, seq FROM oplog WHERE account_id = ? AND client_op_id IN (${holes})`
    ).bind(accountId, ...slice).all();
    for (const r of results || []) map.set(r.client_op_id, r.seq);
  }
  return map;
}

// ── Blobs ───────────────────────────────────────────────────────────────────
//
// Content-addressed: the key is the SHA-256 of the bytes. The same manual
// attached to two properties is stored once, re-uploading is idempotent, and
// sync needs no merge rule because a blob either exists at that key or does
// not. There is no version to conflict over.

const blobKey = (accountId, sha) => `${accountId}/blob/${sha}`;

/** Ask which hashes are already stored, so known files are never re-uploaded. */
async function handleBlobCheck(request, env, auth) {
  if (!env.BLOBS) return json({ error: 'no R2 bucket bound' }, 503);
  const body = parseJson(auth.text());
  const hashes = (body && body.hashes) || [];
  if (!Array.isArray(hashes)) return json({ error: 'hashes must be an array' }, 400);

  const have = [];
  for (const sha of hashes.slice(0, 200)) {
    if (!isSha256(sha)) continue;
    if (await env.BLOBS.head(blobKey(auth.accountId, sha))) have.push(sha);
  }
  return json({ have });
}

async function handleBlobPut(request, env, auth, sha) {
  if (!env.BLOBS) return json({ error: 'no R2 bucket bound' }, 503);
  if (!isSha256(sha)) return json({ error: 'key must be a sha256 hex digest' }, 400);

  const bytes = auth.bytes;
  if (!bytes.byteLength) return json({ error: 'empty body' }, 400);

  // Verify the content actually hashes to the key it is being stored under.
  // Without this a buggy or hostile client can poison the address space, and
  // every future deduplication against that hash returns the wrong bytes.
  const actual = await sha256Bytes(bytes);
  if (actual !== sha.toLowerCase()) {
    return json({ error: 'content does not match the hash in the key' }, 400);
  }

  await env.BLOBS.put(blobKey(auth.accountId, sha), bytes, {
    httpMetadata: { contentType: request.headers.get('Content-Type') || 'application/octet-stream' },
  });
  return json({ ok: true, sha256: sha, bytes: bytes.byteLength });
}

async function handleBlobGet(env, auth, sha) {
  if (!env.BLOBS) return json({ error: 'no R2 bucket bound' }, 503);
  if (!isSha256(sha)) return json({ error: 'key must be a sha256 hex digest' }, 400);

  const obj = await env.BLOBS.get(blobKey(auth.accountId, sha));
  if (!obj) return json({ error: 'not found' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      // Content-addressed, so the bytes behind a key can never change.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const isSha256 = s => typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

function hexToBytes(s) {
  const clean = String(s).trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

async function sha256Bytes(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlToText = s => new TextDecoder().decode(b64urlToBytes(s));

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
