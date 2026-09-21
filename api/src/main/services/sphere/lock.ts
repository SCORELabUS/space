import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { SphereLease } from '../../repositories/mongoose/models/SphereSyncMongoose';

const ownership = new AsyncLocalStorage<() => Promise<void>>();
/** Recheck the lease immediately before each guarded persistence operation. */
export async function assertOrganizationLease() { await ownership.getStore()?.(); }

export async function withOrganizationLock<T>(organizationId: string, work: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const key = `sphere:${organizationId}`;
  try {
    const lock = await SphereLease.findOneAndUpdate({ _id: key, $or: [{ expiresAt: { $lte: new Date() } }, { owner }] },
      { $set: { owner, expiresAt: new Date(Date.now() + 60000) } }, { upsert: true, new: true });
    if (!lock) throw new Error('Synchronization is busy; retry shortly');
  } catch { throw new Error('Synchronization is busy; retry shortly'); }
  let lost = false;
  const assertOwned = async () => {
    if (lost || !await SphereLease.exists({ _id: key, owner, expiresAt: { $gt: new Date() } })) throw new Error('Synchronization lock lost; retry');
  };
  const timer = setInterval(() => {
    SphereLease.updateOne({ _id: key, owner, expiresAt: { $gt: new Date() } }, { $set: { expiresAt: new Date(Date.now() + 60000) } })
      .then(result => { if (!result.matchedCount) lost = true; }).catch(() => { lost = true; });
  }, 15000);
  timer.unref();
  try { return await ownership.run(assertOwned, () => work(assertOwned)); }
  finally { clearInterval(timer); await SphereLease.deleteOne({ _id: key, owner }); }
}
