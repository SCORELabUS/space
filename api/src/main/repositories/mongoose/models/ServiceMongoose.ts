import { assertOrganizationLease } from '../../../services/sphere/lock';
import mongoose, { Schema } from 'mongoose';

const pricingDataSchema = new Schema(
  {
    id: { 
      type: Schema.Types.ObjectId,
      ref: 'Pricing'
    },
    url: { type: String },
  }
);

const serviceSchema = new Schema(
  {
    name: { type: String, required: true },
    organizationId: { type: String, ref: "Organization", required: true },
    source: { type: String, enum: ['manual', 'sphere'], default: 'manual' },
    sphere: { type: Schema.Types.Mixed },
    disabled: { type: Boolean, default: false },
    activePricings: {type: Map, of: pricingDataSchema},
    archivedPricings: {type: Map, of: pricingDataSchema}
  },
  {
    toObject: {
      virtuals: true,
      transform: function (doc, resultObject, options) {
        delete resultObject._id;
        delete resultObject.__v;
        return resultObject;
      },
    },
  }
);

// Middleware to ensure activePricings has at least one value
serviceSchema.pre('save', function (next) {
  if (!this.activePricings || Object.keys(this.activePricings).length === 0) {
    return next(new Error('activePricings must have at least one value.'));
  }
  next();
});

// Adding unique index for [name, owner, version]
serviceSchema.index({ name: 1, organizationId: 1 }, { unique: true });

// Binding changes and synchronization share a renewable organization lease.
for (const operation of ['save', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  serviceSchema.pre(operation, async function () { await assertOrganizationLease(); });
}

const serviceModel = mongoose.model('Service', serviceSchema, 'services');

export default serviceModel;
