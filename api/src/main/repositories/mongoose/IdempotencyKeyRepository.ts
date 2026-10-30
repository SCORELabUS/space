import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import IdempotencyKeyMongoose from './models/IdempotencyKeyMongoose';

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface IdempotencyRecord {
  organizationId: string;
  key: string;
  fingerprint: string;
  operationId: string;
  state: 'in_progress' | 'completed';
  owner?: string;
  lockedUntil?: Date;
  plan?: any;
  steps?: Record<string, any>;
  result?: any;
  response?: StoredResponse;
  createdAt: Date;
  expiresAt?: Date;
}

export type Reservation =
  | { reserved: true; owner: string; record: IdempotencyRecord }
  | { reserved: false; existing: IdempotencyRecord };

export class IdempotencyOwnershipError extends Error {
  readonly code = 'IDEMPOTENCY_OWNERSHIP_LOST';
  constructor() {
    super('Idempotency operation ownership was lost; retry with the same key');
    this.name = 'IdempotencyOwnershipError';
  }
}

const isDuplicateKey = (error: any): boolean => error?.code === 11000;
const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`INTERNAL ERROR: idempotency requires ${field}`);
  return value;
};
const scope = (organizationId: string, key: string) => ({
  organizationId: required(organizationId, 'organization'), key: required(key, 'key'),
});
const owned = (organizationId: string, key: string, owner: string) => ({
  ...scope(organizationId, key), owner: required(owner, 'owner'), state: 'in_progress',
  $expr: { $gt: [{ $ifNull: ['$lockedUntil', new Date(0)] }, '$$NOW'] },
});
const milliseconds = (seconds: number): number => {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('INTERNAL ERROR: idempotency duration must be positive');
  return seconds * 1000;
};
const configuredTtl = (): number => {
  const seconds = Number(process.env.IDEMPOTENCY_KEY_TTL_SECONDS);
  return Number.isFinite(seconds) && seconds >= 1 ? Math.floor(seconds) : 24 * 3600;
};
const toRecord = (doc: any): IdempotencyRecord => ({
  organizationId: doc.organizationId,
  key: doc.key,
  fingerprint: doc.fingerprint,
  operationId: doc.operationId ?? String(doc._id),
  state: doc.state,
  owner: doc.owner ?? undefined,
  lockedUntil: doc.lockedUntil ?? undefined,
  ...(doc.plan !== undefined ? { plan: doc.plan } : {}),
  ...(doc.steps !== undefined ? { steps: doc.steps } : {}),
  ...(doc.result !== undefined ? { result: doc.result } : {}),
  response: doc.response?.status !== undefined ? doc.response : undefined,
  createdAt: doc.createdAt,
  expiresAt: doc.expiresAt ?? undefined,
});

/**
 * Durable request journal, scoped to its authenticated organization and key.
 * Lease ownership and expiry are checked against MongoDB's clock. Takeover
 * changes only the worker lease; the operation identity and progress survive.
 */
class IdempotencyKeyRepository {
  private initialized?: Promise<void>;

  initialize(): Promise<void> {
    this.initialized ??= this.initializeStorage().catch(error => {
      this.initialized = undefined;
      throw error;
    });
    return this.initialized;
  }

  private async initializeStorage(): Promise<void> {
    await IdempotencyKeyMongoose.createCollection();
    // Preserve legacy unfinished operations instead of letting the TTL monitor
    // remove them. An old Mongo _id is already a stable operation identity.
    await IdempotencyKeyMongoose.updateMany({}, [{ $set: {
      operationId: { $ifNull: ['$operationId', { $toString: '$_id' }] },
      expiresAt: { $cond: [{ $eq: ['$state', 'in_progress'] }, '$$REMOVE', '$expiresAt'] },
    } }]);
    await IdempotencyKeyMongoose.createIndexes();
  }

  async reserve(
    organizationId: string,
    key: string,
    fingerprint: string,
    options: { ttlSeconds: number; lockSeconds: number }
  ): Promise<Reservation> {
    const identity = scope(organizationId, key);
    required(fingerprint, 'fingerprint');
    const lockMilliseconds = milliseconds(options.lockSeconds);
    await this.initialize();
    for (let attempt = 0; attempt < 5; attempt++) {
      const owner = randomUUID(), operationId = randomUUID();
      try {
        // A fresh _id forces an insert. The organization/key unique index
        // arbitrates simultaneous reservations; timestamps use the DB clock.
        const inserted = await IdempotencyKeyMongoose.findOneAndUpdate(
          { _id: new Types.ObjectId() },
          [{ $set: {
            organizationId: { $literal: identity.organizationId }, key: { $literal: identity.key },
            fingerprint: { $literal: fingerprint }, operationId: { $literal: operationId },
            owner: { $literal: owner }, state: 'in_progress', createdAt: '$$NOW',
            lockedUntil: { $add: ['$$NOW', lockMilliseconds] },
          } }],
          { upsert: true, new: true, setDefaultsOnInsert: false }
        ).lean();
        if (!inserted) throw new Error('Could not reserve the idempotency key; retry');
        return { reserved: true, owner, record: toRecord(inserted) };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }

      const doc: any = await IdempotencyKeyMongoose.findOne(identity).lean();
      if (!doc) continue;
      if (doc.state === 'completed') {
        const deleted = await IdempotencyKeyMongoose.deleteOne({
          _id: doc._id, state: 'completed',
          $expr: { $lte: [{ $ifNull: ['$expiresAt', new Date(0)] }, '$$NOW'] },
        });
        if (deleted.deletedCount) continue;
        // The replay window remains live, or another request replaced the row.
        const current: any = await IdempotencyKeyMongoose.findOne({ _id: doc._id, ...identity }).lean();
        if (!current) continue;
        return { reserved: false, existing: toRecord(current) };
      }

      // A different request never inherits an unfinished operation, even when
      // its former worker's lease expired.
      if (doc.fingerprint !== fingerprint) return { reserved: false, existing: toRecord(doc) };
      const taken = await IdempotencyKeyMongoose.findOneAndUpdate(
        {
          _id: doc._id, ...identity, fingerprint, state: 'in_progress',
          $expr: { $lte: [{ $ifNull: ['$lockedUntil', new Date(0)] }, '$$NOW'] },
        },
        [{ $set: { owner: { $literal: owner }, lockedUntil: { $add: ['$$NOW', lockMilliseconds] },
          operationId: { $ifNull: ['$operationId', { $toString: '$_id' }] } } }, { $unset: 'expiresAt' }],
        { new: true }
      ).lean();
      if (taken) return { reserved: true, owner, record: toRecord(taken) };
      const current: any = await IdempotencyKeyMongoose.findOne(identity).lean();
      if (current) return { reserved: false, existing: toRecord(current) };
    }
    throw new Error('Could not reserve the idempotency key; retry');
  }

  async find(organizationId: string, key: string): Promise<IdempotencyRecord | null> {
    await this.initialize();
    const doc = await IdempotencyKeyMongoose.findOne({
      ...scope(organizationId, key),
      $or: [{ state: 'in_progress' }, { state: 'completed', $expr: { $gt: ['$expiresAt', '$$NOW'] } }],
    }).lean();
    return doc ? toRecord(doc) : null;
  }

  async recoverAppliedStep(organizationId: string, key: string, operationId: string, step: string, result: any, allowLiveOwner = false): Promise<boolean> {
    // Only acknowledge an already persisted business write, never execute a
    // remaining action under another caller's authority. An expired owner is
    // fenced at MongoDB; a live successor makes this conditional update fail.
    const updated = await IdempotencyKeyMongoose.updateOne({ ...scope(organizationId, key), operationId,
      state: 'in_progress', plan: { $exists: true }, ...(allowLiveOwner ? {} : { $expr: { $lte: ['$lockedUntil', '$$NOW'] } }) },
      [{ $set: { steps: { $mergeObjects: [{ $ifNull: ['$steps', {}] }, { $literal: { [step]: { result } } }] } } }]);
    return updated.matchedCount > 0;
  }

  async renew(organizationId: string, key: string, owner: string, lockSeconds: number): Promise<IdempotencyRecord | null> {
    const doc = await IdempotencyKeyMongoose.findOneAndUpdate(
      owned(organizationId, key, owner),
      [{ $set: { lockedUntil: { $add: ['$$NOW', milliseconds(lockSeconds)] } } }],
      { new: true }
    ).lean();
    return doc ? toRecord(doc) : null;
  }

  async assertOwned(organizationId: string, key: string, owner: string): Promise<IdempotencyRecord> {
    const doc = await IdempotencyKeyMongoose.findOne(owned(organizationId, key, owner)).lean();
    if (!doc) throw new IdempotencyOwnershipError();
    return toRecord(doc);
  }

  async prepare(organizationId: string, key: string, owner: string, plan: any): Promise<IdempotencyRecord> {
    if (plan === undefined) throw new Error('INTERNAL ERROR: idempotency requires a recovery plan');
    const doc = await IdempotencyKeyMongoose.findOneAndUpdate(
      { ...owned(organizationId, key, owner), plan: { $exists: false } },
      [{ $set: { plan: { $literal: plan } } }],
      { new: true }
    ).lean();
    // An existing plan is immutable, but a caller must still own the lease.
    return doc ? toRecord(doc) : this.assertOwned(organizationId, key, owner);
  }

  async checkpoint(organizationId: string, key: string, owner: string, step: string, result: any): Promise<void> {
    required(step, 'step');
    const updated = await IdempotencyKeyMongoose.updateOne(owned(organizationId, key, owner), [{ $set: {
      steps: { $mergeObjects: [{ $ifNull: ['$steps', {}] }, { $literal: { [step]: result ?? null } }] },
    } }]);
    if (!updated.matchedCount) throw new IdempotencyOwnershipError();
  }

  async saveResult(organizationId: string, key: string, owner: string, result: any): Promise<void> {
    const updated = await IdempotencyKeyMongoose.updateOne(
      owned(organizationId, key, owner), [{ $set: { result: { $literal: result ?? null } } }]
    );
    if (!updated.matchedCount) throw new IdempotencyOwnershipError();
  }

  async resetUnappliedPlan(organizationId: string, key: string, owner: string): Promise<void> {
    const record = await this.assertOwned(organizationId, key, owner);
    if (Object.values(record.steps ?? {}).some((step: any) => step.result)) throw new Error('An applied idempotency plan cannot be reset');
    const result = await IdempotencyKeyMongoose.updateOne(owned(organizationId, key, owner), { $unset: { plan: '', steps: '', result: '' } });
    if (!result.matchedCount) throw new IdempotencyOwnershipError();
  }

  async yieldLease(organizationId: string, key: string, owner: string): Promise<void> {
    const result = await IdempotencyKeyMongoose.updateOne(owned(organizationId, key, owner), [{ $set: { lockedUntil: '$$NOW' } }]);
    if (!result.matchedCount) throw new IdempotencyOwnershipError();
  }

  async complete(organizationId: string, key: string, owner: string, response: StoredResponse, ttlSeconds = configuredTtl()): Promise<boolean> {
    const updated = await IdempotencyKeyMongoose.updateOne(owned(organizationId, key, owner), [
      { $set: { state: 'completed', response: { $literal: response }, expiresAt: { $add: ['$$NOW', milliseconds(ttlSeconds)] } } },
      { $unset: ['owner', 'lockedUntil'] },
    ]);
    return updated.matchedCount > 0;
  }

  async release(organizationId: string, key: string, owner: string): Promise<boolean> {
    const deleted = await IdempotencyKeyMongoose.deleteOne({ ...owned(organizationId, key, owner), plan: { $exists: false } });
    return deleted.deletedCount > 0;
  }
}

export default IdempotencyKeyRepository;
