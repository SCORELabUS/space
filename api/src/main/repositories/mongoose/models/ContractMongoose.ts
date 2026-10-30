import { assertOrganizationLease } from '../../../services/sphere/lock';
import mongoose, { Schema } from 'mongoose';

const usageLevelSchema = new Schema(
  {
    resetTimeStamp: { type: Date },
    consumed: { type: Number, required: true },
  },
  { _id: false }
);

const contractSchema = new Schema(
  {
    userContact: {
      userId: { type: String, required: true },
      username: { type: String, required: true },
      firstName: { type: String},
      lastName: { type: String},
      email: { type: String},
      phone: { type: String},
    },
    billingPeriod: {
      startDate: { type: Date, required: true },
      endDate: { type: Date, required: true },
      autoRenew: { type: Boolean, default: false },
      renewalDays: { type: Number, default: 30 },
    },
    usageLevels: {type: Map, of: {type: Map, of: usageLevelSchema}},
    organizationId: { type: String, ref: "Organization", required: true },
    groupId: { type: String },
    usageConsumptionReceipts: { type: Map, of: Date, select: false, default: undefined },
    idempotencyReceipt: { type: Schema.Types.Mixed, select: false, default: undefined },
    usageRevertReceipts: { type: Map, of: Date, select: false, default: undefined },
    serviceRelocationOperationId: { type: String, select: false },
    contractedServices: {type: Map, of: String},
    subscriptionPlans: { type: Map, of: String },
    subscriptionAddOns: { type: Map, of: {type: Map, of: Number} },
    synchronizationHistory: { type: [Schema.Types.Mixed], default: [] },
    history: [{
      startDate: { type: Date, required: true },
      endDate: { type: Date, required: true },
      contractedServices: {type: Map, of: String},
      subscriptionPlans: { type: Map, of: String },
      subscriptionAddOns: { type: Map, of: {type: Map, of: Number} },
    }]
  },
  {
    toJSON: {
      virtuals: true,
      transform: function (doc, resultObject, options) {
        delete resultObject._id;
        delete resultObject.__v;
        delete resultObject.serviceRelocationOperationId;
        delete resultObject.usageRevertReceipts;
        delete resultObject.idempotencyReceipt;
        delete resultObject.usageConsumptionReceipts;
        return resultObject;
      },
    },
  }
);

// A userId is chosen by each host application: unique within an organization,
// not across the server. Existing databases still have the former global
// index { 'userContact.userId': 1 }; it is replaced at startup by
// database/migrations/contractUserIdPerOrganization.ts.
contractSchema.index({ organizationId: 1, 'userContact.userId': 1 }, { unique: true });

// Binding changes and synchronization share a renewable organization lease.
for (const operation of ['save', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  contractSchema.pre(operation, async function () { await assertOrganizationLease(); });
}

// Deleting a contract must not erase the only proof of a persisted operation.
// Checkpoint that proof first, so retrying its key cannot recreate a deleted
// contract or apply an old delta to a new contract with the same userId.
for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  contractSchema.pre(operation, async function (this: any) {
    const documents: any[] = await this.model.find({ $and: [this.getFilter(), { 'idempotencyReceipt.acknowledged': false }] })
      .select('+idempotencyReceipt').lean();
    for (const document of documents) {
      const receipt = document.idempotencyReceipt;
      if (!receipt?.key) continue;
      const { default: Journal } = await import('../IdempotencyKeyRepository');
      const saved = await new Journal().recoverAppliedStep(receipt.organizationId, receipt.key,
        receipt.operationId, receipt.stepId, receipt.result, true);
      if (!saved) throw new Error('Cannot delete a contract before its pending operation receipt is checkpointed; retry');
    }
  });
}

const contractModel = mongoose.model('Contract', contractSchema, 'contracts');

export default contractModel;