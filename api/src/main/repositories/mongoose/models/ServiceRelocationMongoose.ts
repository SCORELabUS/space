import mongoose, { Schema } from 'mongoose';

export type ServiceRelocationStage = 'prepared' | 'pricings' | 'contracts' | 'service' | 'effects';

/**
 * Private recovery state for one service rename/move. These documents and the
 * contract snapshots below are persistence details, never API responses.
 */
const relocation = new Schema({
  _id: { type: String, required: true },
  serviceId: { type: Schema.Types.ObjectId, required: true },
  sourceOrganizationId: { type: String, required: true },
  sourceName: { type: String, required: true },
  targetOrganizationId: { type: String, required: true },
  targetName: { type: String, required: true },
  request: { type: Schema.Types.Mixed, required: true },
  pricingIds: { type: [Schema.Types.ObjectId], default: [] },
  state: { type: String, enum: ['pending', 'complete'], default: 'pending', required: true },
  stage: { type: String, enum: ['prepared', 'pricings', 'contracts', 'service', 'effects'], default: 'prepared', required: true },
  createdAt: { type: Date, default: Date.now, required: true },
  finishedAt: Date,
  lastError: String,
});
// A new relocation cannot overtake an unfinished relocation of the same
// service. Completed operations remain available for recovery diagnostics.
relocation.index({ serviceId: 1 }, { unique: true, partialFilterExpression: { state: 'pending' } });
relocation.index({ state: 1, sourceOrganizationId: 1 });
relocation.index({ state: 1, targetOrganizationId: 1 });

export const ServiceRelocation = mongoose.model('ServiceRelocation', relocation, 'serviceRelocations');

const step = new Schema({
  _id: { type: String, required: true },
  operationId: { type: String, required: true, index: true },
  contractId: { type: Schema.Types.ObjectId, required: true },
  before: { type: Schema.Types.Mixed, required: true },
  applied: { type: Boolean, default: false, required: true },
  effectsDone: { type: Boolean, default: false, required: true },
});

export const ServiceRelocationStep = mongoose.model('ServiceRelocationStep', step, 'serviceRelocationSteps');
