/**
 * actions.js — how a change gets written.
 *
 * Every view goes through here so there is one answer to "what happens when
 * someone saves something", rather than each view growing its own slightly
 * different version.
 */

import * as store from './store.js';

/** Who is making the change — recorded on every revision entry. */
export async function context() {
  return {
    deviceId: await store.deviceId(),
    accountId: await store.getMeta('account_id'),
  };
}

/**
 * Write operations locally, then try to sync.
 *
 * The local write is the one that matters and has already succeeded by the
 * time sync is attempted. If sync is off, offline, or broken, the operations
 * sit in the outbox and nothing is lost — which is why the sync call is
 * deliberately unawaited and its failure deliberately swallowed. The status
 * band is where a sync problem gets reported, not here.
 *
 * Imported dynamically because sync.js reads the store and the store is read
 * by the views that call this; a static import would close the loop.
 */
export async function writeOps(ops) {
  if (!ops || !ops.length) return;
  await store.applyLocal(ops);
  import('./sync.js').then(s => s.syncOnce()).catch(() => {});
}
