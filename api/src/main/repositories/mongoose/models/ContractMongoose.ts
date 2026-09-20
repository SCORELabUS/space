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
        return resultObject;
      },
    },
  }
);

// Adding unique index for [name, owner, version]
contractSchema.index({ 'userContact.userId': 1 }, { unique: true });

// Binding changes and synchronization share a renewable organization lease.
for (const operation of ['save', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  contractSchema.pre(operation, async function () { await assertOrganizationLease(); });
}

const contractModel = mongoose.model('Contract', contractSchema, 'contracts');

export default contractModel;