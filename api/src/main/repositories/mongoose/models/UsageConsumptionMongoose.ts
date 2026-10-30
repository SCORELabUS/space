import mongoose, { Schema } from 'mongoose';

/**
 * One applied expected consumption (a single-feature evaluation that
 * incremented usage levels), kept so that it can be reverted by its id.
 *
 * `revertRequestedAt` records intent; `revertedAt` acknowledges completion.
 * The contract stores a private receipt in the same write as its decrement. Records expire at
 * `expiresAt` (TTL index), after which the consumption can no longer be
 * reverted.
 */
const consumedLevelSchema = new Schema(
  {
    serviceName: { type: String, required: true },
    usageLimit: { type: String, required: true },
    amount: { type: Number, required: true },
    // The renewal period the consumption belongs to (null for non-renewable
    // levels): a revert after the level was renewed changes nothing.
    resetTimeStamp: { type: Date, default: null },
  },
  { _id: false }
);

const usageConsumptionSchema = new Schema(
  {
    _id: { type: String, required: true },
    organizationId: { type: String, required: true },
    userId: { type: String, required: true },
    featureId: { type: String, required: true },
    levels: { type: [consumedLevelSchema], required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    contractId: { type: String },
    revertRequestedAt: { type: Date },
    revertedAt: { type: Date },
  },
  { versionKey: false }
);

// Expiry per document (`expiresAt`), so the retention can change without rebuilding the index.
usageConsumptionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// The legacy revert picks the oldest or latest unreverted consumption of a feature.
usageConsumptionSchema.index({ organizationId: 1, userId: 1, featureId: 1, createdAt: 1 });

const UsageConsumptionMongoose = mongoose.model('UsageConsumption', usageConsumptionSchema, 'usageConsumptions');

export default UsageConsumptionMongoose;
