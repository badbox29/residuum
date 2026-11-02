/**
 * merge.js — the merge rules.
 *
 * Runs only here, on the client. The Worker stores an append-only log and
 * never reconstructs state, so there is exactly one implementation of these
 * rules and nothing to keep in step with anything else.
 *
 * Rules:
 *   events         union by id; contents immutable, so conflict is impossible
 *   relationships  union; add wins over remove
 *   documents      union; blob content immutable by construction
 *   everything else  last updated_at wins, tie to lower id
 *                    — EXCEPT revisions, which union by entry id
 *
 * That exception is the important one. Without it, two devices editing the
 * same asset offline means the loser's revision entries are discarded along
 * with its field values — history destruction in the one place it can least
 * be afforded.
 */

import { entityDef } from './entities.js';

export const REVISION_CAP = 200;
const TRUNCATION_ID = '__truncated__';

/**
 * Merge two versions of the same record. Either may be null. Returns the
 * winner — a new object, never a mutated input.
 *
 * `local` is the incumbent, `incoming` the candidate. Ties go to local: a tie
 * means neither side is demonstrably newer, and preferring what is already
 * committed is the choice that cannot lose work.
 */
export function mergeRecord(entity, local, incoming) {
  if (!local) return incoming ? { ...incoming } : null;
  if (!incoming) return { ...local };

  const def = entityDef(entity);

  switch (def.strategy) {
    case 'immutable': return mergeImmutable(def, local, incoming);
    case 'union':     return mergeUnion(local, incoming);
    case 'lww':       return mergeLww(def, local, incoming);
    default:
      // A strategy nobody has decided on keeps the incumbent and says so.
      // Silence here is how a field starts quietly taking the remote value.
      console.warn(`[merge] no strategy for entity "${entity}" — keeping local`);
      return { ...local };
  }
}

/**
 * Events. Written once, contents final — except fields explicitly declared
 * mutable, which is only `superseded_by`.
 */
function mergeImmutable(def, local, incoming) {
  const out = { ...local };
  for (const field of def.mutableFields || []) {
    // Set-once. Two devices correcting the same event independently is a real
    // possibility, and the first correction wins rather than the last one
    // silently reassigning it.
    if (out[field] == null && incoming[field] != null) out[field] = incoming[field];
  }
  return out;
}

/**
 * Relationships and documents. Presence unions; removal loses to addition.
 *
 * A stale edge shows a connection that no longer exists — visible, one click
 * to fix. A lost edge hides one that does, silently. The asymmetry is the
 * whole reason for the rule.
 */
function mergeUnion(local, incoming) {
  const out = { ...local };
  for (const [k, v] of Object.entries(incoming)) if (v !== undefined) out[k] = v;
  const liveOnEitherSide = local.tombstoned_at == null || incoming.tombstoned_at == null;
  out.tombstoned_at = liveOnEitherSide
    ? null
    : Math.max(local.tombstoned_at, incoming.tombstoned_at);
  return out;
}

/** Mutable records: newest updated_at wins wholesale, then revisions union back in. */
function mergeLww(def, local, incoming) {
  const out = { ...pickLww(def, local, incoming) };
  if (def.hasRevisions) {
    out.revisions = mergeRevisions(local.revisions, incoming.revisions);
  }
  return out;
}

function pickLww(def, local, incoming) {
  const lt = local.updated_at || 0;
  const it = incoming.updated_at || 0;
  if (lt !== it) return it > lt ? incoming : local;

  // Equal timestamps. Two devices writing in the same millisecond is rare but
  // not impossible across decades and many records. Break the tie on id so
  // every device independently reaches the same answer — an arbitrary rule
  // applied consistently beats a sensible rule applied differently per device.
  const lid = String(local[def.pk] ?? '');
  const iid = String(incoming[def.pk] ?? '');
  if (lid !== iid) return iid < lid ? incoming : local;
  return local;
}

/**
 * Union revision entries by id, newest first, capped.
 *
 * The cap keeps an asset edited weekly for twenty years from carrying a
 * thousand entries in every sync payload. How many were dropped rides in a
 * sentinel entry, because a plain array cannot hold a property through JSON.
 * Always read a revisions array with splitRevisions() rather than touching
 * the sentinel directly.
 */
export function mergeRevisions(a, b) {
  const left = splitRevisions(a);
  const right = splitRevisions(b);
  const priorDropped = Math.max(left.truncated, right.truncated);

  const byId = new Map();
  for (const entry of [...left.entries, ...right.entries]) {
    if (!entry || typeof entry !== 'object' || !entry.id) continue;
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const merged = [...byId.values()].sort((x, y) => (y.at || 0) - (x.at || 0));

  if (merged.length <= REVISION_CAP) {
    return priorDropped ? [...merged, marker(priorDropped)] : merged;
  }
  return [
    ...merged.slice(0, REVISION_CAP),
    marker(priorDropped + (merged.length - REVISION_CAP)),
  ];
}

const marker = n => ({ id: TRUNCATION_ID, truncated: n });

/**
 * Split a stored revisions array into real entries and the count previously
 * dropped by the cap. One function reads the sentinel, so the filter-versus-
 * find confusion this shape invites cannot recur.
 */
export function splitRevisions(list) {
  if (!Array.isArray(list)) return { entries: [], truncated: 0 };
  let truncated = 0;
  const entries = [];
  for (const entry of list) {
    if (entry && entry.id === TRUNCATION_ID) {
      truncated = Math.max(truncated, entry.truncated || 0);
      continue;
    }
    entries.push(entry);
  }
  return { entries, truncated };
}

/**
 * Build a revision entry from a before/after pair. Returns null when nothing
 * changed, so a no-op save does not manufacture history.
 *
 * Records both by_device and by_account. Today they are redundant — one
 * account is one person. If sharing ever arrives, "who logged this repair" is
 * answerable without a schema change.
 */
export function buildRevision({ id, before, after, at, byDevice, byAccount, fields }) {
  const changes = {};
  const keys = fields || new Set([
    ...Object.keys(before || {}), ...Object.keys(after || {}),
  ]);
  for (const k of keys) {
    if (k === 'revisions' || k === 'updated_at' || k === 'updated_by') continue;
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
    changes[k] = [b ?? null, a ?? null];
  }
  if (!Object.keys(changes).length) return null;
  return { id, at, by_device: byDevice || null, by_account: byAccount || null, changes };
}
