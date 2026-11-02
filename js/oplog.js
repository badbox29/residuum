/**
 * oplog.js — building and applying operations.
 *
 * Every change to the archive is an operation: a full snapshot of a record,
 * or a tombstone. Operations are what sync moves between devices, and they
 * are the only way a record changes — there is no "update the field" path
 * that bypasses this.
 *
 * Deliberately free of storage: these are pure functions over plain objects,
 * so the logic that is easy to get subtly wrong can be tested directly,
 * while store.js stays thin enough to verify by reading it.
 */

import { entityDef, pick } from './entities.js';
import { mergeRecord, buildRevision } from './merge.js';
import { uuidv7 } from './ids.js';

/**
 * Build an operation for a local change.
 *
 * `before` is the record as it currently stands, or null for a new one. It is
 * used to compute the revision entry, so passing it matters: without it the
 * change is recorded but not *what* changed.
 *
 * @returns {{op: object, record: object}} the operation to enqueue, and the
 *          record to write locally — already carrying its new revision entry.
 */
export function buildPut(entity, draft, { before = null, deviceId = null, accountId = null, now = Date.now() } = {}) {
  const def = entityDef(entity);
  const id = draft[def.pk] || before?.[def.pk] || uuidv7();

  const record = { ...pick(entity, draft), [def.pk]: id };

  if (def.fields.includes('updated_at')) record.updated_at = now;
  if (def.fields.includes('updated_by') && deviceId) record.updated_by = deviceId;
  if (def.fields.includes('created_at') && !before) record.created_at = now;

  if (def.hasRevisions) {
    const entry = buildRevision({
      id: uuidv7(),
      before: before ? pick(entity, before) : null,
      after: record,
      at: now,
      byDevice: deviceId,
      byAccount: accountId,
    });
    // Null when nothing actually changed — a no-op save should not
    // manufacture history.
    const prior = Array.isArray(before?.revisions) ? before.revisions : [];
    record.revisions = entry ? [entry, ...prior] : prior;
  }

  return {
    record,
    op: {
      client_op_id: uuidv7(),
      entity,
      entity_id: id,
      op: 'put',
      payload: record,
      client_at: now,
      device_id: deviceId,
    },
  };
}

/**
 * Build a tombstone operation.
 *
 * Events cannot be tombstoned: the archive does not erase what happened. A
 * mistaken event is superseded by a correction instead (see buildCorrection).
 */
export function buildTombstone(entity, id, { deviceId = null, now = Date.now() } = {}) {
  const def = entityDef(entity);
  if (!def.fields.includes('tombstoned_at')) {
    throw new Error(`${entity} records cannot be deleted — supersede instead`);
  }
  return {
    op: {
      client_op_id: uuidv7(),
      entity,
      entity_id: id,
      op: 'tombstone',
      payload: null,
      client_at: now,
      device_id: deviceId,
    },
  };
}

/**
 * Correct an event.
 *
 * Produces two operations: the new event carrying the corrected values, and a
 * put against the original setting `superseded_by`. The original keeps its
 * values — the timeline renders the correction and leaves the original
 * reachable behind it.
 */
export function buildCorrection(original, changes, { deviceId = null, accountId = null, now = Date.now() } = {}) {
  const corrected = buildPut('event', {
    ...pick('event', original),
    ...changes,
    event_id: uuidv7(),
    supersedes: original.event_id,
    superseded_by: null,
  }, { deviceId, accountId, now });

  const marked = buildPut('event', {
    ...pick('event', original),
    superseded_by: corrected.record.event_id,
  }, { before: original, deviceId, accountId, now });

  return { ops: [corrected.op, marked.op], records: [corrected.record, marked.record] };
}

/**
 * Fold an operation into whatever the store currently holds for that record.
 *
 * This is the single point where incoming data meets local data, whether the
 * operation came from this device a moment ago or from another device via
 * sync. Both paths go through the same merge rules, so a record cannot end up
 * in a state that only one path can produce.
 */
export function applyOp(existing, op, { now = Date.now() } = {}) {
  validateOp(op);
  const def = entityDef(op.entity);

  if (op.op === 'tombstone') {
    if (!def.fields.includes('tombstoned_at')) {
      throw new Error(`${op.entity} records cannot be tombstoned`);
    }
    const base = existing || { [def.pk]: op.entity_id };
    const out = { ...base, tombstoned_at: op.client_at || now };
    if (def.fields.includes('updated_at')) out.updated_at = op.client_at || now;
    return out;
  }

  // Reduce to declared fields and force the id to match the operation's, so a
  // malformed payload cannot write a record under a different key than the
  // one the operation claims to address.
  const incoming = { ...pick(op.entity, op.payload), [def.pk]: op.entity_id };
  if (def.fields.includes('updated_at') && !incoming.updated_at) {
    incoming.updated_at = op.client_at || now;
  }
  return mergeRecord(op.entity, existing, incoming);
}

export function validateOp(op) {
  if (!op || typeof op !== 'object') throw new Error('op must be an object');
  if (!op.client_op_id) throw new Error('op.client_op_id is required for idempotent retry');
  if (!op.entity_id) throw new Error('op.entity_id is required');
  entityDef(op.entity); // throws on an unknown entity
  if (op.op !== 'put' && op.op !== 'tombstone') {
    throw new Error(`op.op "${op.op}" must be 'put' or 'tombstone'`);
  }
  if (op.op === 'put' && (!op.payload || typeof op.payload !== 'object')) {
    throw new Error("op.op 'put' requires a payload object");
  }
  return true;
}
