import mongoose, { Schema } from 'mongoose';

/**
 * One `Idempotency-Key` of one organization: the request it was first used
 * for (`fingerprint`) and, once that request finished, what to answer when it
 * is repeated (`response`).
 *
 * While the request runs the record is `in_progress` and held by `owner`
 * until `lockedUntil`; a request that finds it so waits or answers
 * `409 IDEMPOTENCY_IN_PROGRESS`. Records expire at `expiresAt` (TTL index;
 * the middleware also ignores expired records the TTL monitor has not removed
 * yet).
 */
const idempotencyKeySchema = new Schema(
  {
    // The organization of the request, or `user:<username>` for a platform
    // ADMIN on a direct route without organization.
    organizationId: { type: String, required: true },
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed'], required: true },
    owner: { type: String },
    lockedUntil: { type: Date },
    response: {
      status: { type: Number },
      headers: { type: Schema.Types.Mixed },
      body: { type: String },
    },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

idempotencyKeySchema.index({ organizationId: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IdempotencyKeyMongoose = mongoose.model('IdempotencyKey', idempotencyKeySchema, 'idempotencyKeys');

export default IdempotencyKeyMongoose;
