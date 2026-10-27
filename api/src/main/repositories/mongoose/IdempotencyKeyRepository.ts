import { randomUUID } from 'node:crypto';
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
  state: 'in_progress' | 'completed';
  owner?: string;
  lockedUntil?: Date;
  response?: StoredResponse;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * What reserving a key came to: this request now holds it (`owner`, to
 * complete or release it), or an earlier request with the same key exists.
 */
export type Reservation = { reserved: true; owner: string } | { reserved: false; existing: IdempotencyRecord };

const isDuplicateKey = (error: any): boolean => error?.code === 11000;

const toRecord = (doc: any): IdempotencyRecord => ({
  organizationId: doc.organizationId,
  key: doc.key,
  fingerprint: doc.fingerprint,
  state: doc.state,
  owner: doc.owner ?? undefined,
  lockedUntil: doc.lockedUntil ?? undefined,
  response: doc.response?.status !== undefined ? doc.response : undefined,
  createdAt: doc.createdAt,
  expiresAt: doc.expiresAt,
});

/**
 * Idempotency keys (collection `idempotencyKeys`, unique on
 * `{ organizationId, key }`). The unique index decides between concurrent
 * requests with the same key: exactly one inserts the record.
 */
class IdempotencyKeyRepository {
  private indexes?: Promise<unknown>;

  /** The unique index must exist before it can decide anything. */
  private async ready(): Promise<void> {
    this.indexes ??= IdempotencyKeyMongoose.init();
    await this.indexes;
  }

  /**
   * Reserve `key` for a request with this fingerprint. An expired record, or
   * one left `in_progress` past its lock by a request that never finished, is
   * taken over (a conditional update, so only one request takes it).
   */
  async reserve(
    organizationId: string,
    key: string,
    fingerprint: string,
    options: { ttlSeconds: number; lockSeconds: number }
  ): Promise<Reservation> {
    await this.ready();
    for (let attempt = 0; attempt < 5; attempt++) {
      const now = new Date();
      const owner = randomUUID();
      const fresh = {
        organizationId,
        key,
        fingerprint,
        state: 'in_progress',
        owner,
        lockedUntil: new Date(now.getTime() + options.lockSeconds * 1000),
        createdAt: now,
        expiresAt: new Date(now.getTime() + options.ttlSeconds * 1000),
      };

      try {
        await IdempotencyKeyMongoose.create(fresh);
        return { reserved: true, owner };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }

      const doc: any = await IdempotencyKeyMongoose.findOne({ organizationId, key }).lean();
      if (!doc) continue; // Expired and removed in between: insert again.

      const expired = doc.expiresAt <= now;
      const abandoned = doc.state === 'in_progress' && (!doc.lockedUntil || doc.lockedUntil <= now);
      if (!expired && !abandoned) {
        return { reserved: false, existing: toRecord(doc) };
      }

      const taken = await IdempotencyKeyMongoose.findOneAndUpdate(
        { _id: doc._id, state: doc.state, owner: doc.owner ?? null, expiresAt: doc.expiresAt },
        { $set: fresh, $unset: { response: '' } },
        { new: true }
      ).lean();
      if (taken) return { reserved: true, owner };
    }
    throw new Error('Could not reserve the idempotency key; retry');
  }

  async find(organizationId: string, key: string): Promise<IdempotencyRecord | null> {
    const doc = await IdempotencyKeyMongoose.findOne({ organizationId, key }).lean();
    return doc && (doc as any).expiresAt > new Date() ? toRecord(doc) : null;
  }

  /** Store the response of the request that holds the key. */
  async complete(organizationId: string, key: string, owner: string, response: StoredResponse): Promise<void> {
    await IdempotencyKeyMongoose.updateOne(
      { organizationId, key, owner, state: 'in_progress' },
      { $set: { state: 'completed', response }, $unset: { owner: '', lockedUntil: '' } }
    );
  }

  /** Give the key back (the request failed in a way that must be retryable). */
  async release(organizationId: string, key: string, owner: string): Promise<void> {
    await IdempotencyKeyMongoose.deleteOne({ organizationId, key, owner, state: 'in_progress' });
  }
}

export default IdempotencyKeyRepository;
