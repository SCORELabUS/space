import mongoose, { Schema } from 'mongoose';

/**
 * Durable request identity and recovery progress. An unfinished operation has
 * no TTL: losing a worker lease must not erase its plan or permit repetition.
 * Only completed responses expire, after their configured replay window.
 */
const idempotencyKeySchema = new Schema(
  {
    // Authenticated organization, or user:<username> for a platform ADMIN's direct route.
    organizationId: { type: String, required: true },
    key: { type: String, required: true },
    fingerprint: { type: String, required: true },
    operationId: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed'], required: true },
    owner: String,
    lockedUntil: Date,
    plan: { type: Schema.Types.Mixed, default: undefined },
    steps: { type: Schema.Types.Mixed, default: undefined },
    result: { type: Schema.Types.Mixed, default: undefined },
    response: {
      status: Number,
      headers: Schema.Types.Mixed,
      body: String,
    },
    createdAt: { type: Date, required: true },
    expiresAt: Date,
  },
  { versionKey: false }
);

idempotencyKeySchema.index({ organizationId: 1, key: 1 }, { unique: true });
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IdempotencyKeyMongoose = mongoose.model('IdempotencyKey', idempotencyKeySchema, 'idempotencyKeys');

export default IdempotencyKeyMongoose;
