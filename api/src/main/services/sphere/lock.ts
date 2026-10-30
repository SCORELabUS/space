import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SphereLease } from '../../repositories/mongoose/models/SphereSyncMongoose';

const ownership = new AsyncLocalStorage<Map<string, () => Promise<void>>>();
/** Recheck the lease immediately before each guarded persistence operation. */
export async function assertOrganizationLease() { await Promise.all([...(ownership.getStore()?.values() ?? [])].map(assertOwned => assertOwned())); }

export async function withOrganizationLock<T>(organizationId: string, work: (assertOwned: () => Promise<void>) => Promise<T>, waitMs = 0): Promise<T> {
  if (!organizationId) throw new Error('An organization is required for a binding operation');
  if (ownership.getStore()?.has(organizationId)) { await assertOrganizationLease(); return work(assertOrganizationLease); }
  const owner = randomUUID();
  const key = `sphere:${organizationId}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const lock = await SphereLease.findOneAndUpdate({ _id: key, $or: [{ expiresAt: { $lte: new Date() } }, { owner }] },
        { $set: { owner, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true, new: true });
      if (!lock) throw new Error('busy');
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('Synchronization is busy; retry shortly');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  let lost = false;
  const assertOwned = async () => {
    if (lost || !await SphereLease.exists({ _id: key, owner, expiresAt: { $gt: new Date() } })) throw new Error('Synchronization lock lost; retry');
  };
  const timer = setInterval(() => {
    SphereLease.updateOne({ _id: key, owner, expiresAt: { $gt: new Date() } }, { $set: { expiresAt: new Date(Date.now() + 60000) } })
      .then(result => { if (!result.matchedCount) lost = true; }).catch(() => { lost = true; });
  }, 15000);
  timer.unref();
  const held = new Map(ownership.getStore() ?? []); held.set(organizationId, assertOwned);
  try { return await ownership.run(held, () => work(assertOrganizationLease)); }
  finally { clearInterval(timer); await SphereLease.deleteOne({ _id: key, owner }); }
}

/** Shared ordering prevents source/destination relocation requests from taking opposite leases. */
export async function withOrganizationLocks<T>(organizations: string[], work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  const ordered = [...new Set(organizations)].sort();
  const acquire = (index: number): Promise<T> => index === ordered.length
    ? work(assertOrganizationLease)
    : withOrganizationLock(ordered[index], () => acquire(index + 1));
  return acquire(0);
}
