import mongoose, { Schema } from 'mongoose';
const lease = new Schema({ _id: String, owner: String, expiresAt: Date });
export const SphereLease = mongoose.model('SphereLease', lease, 'sphereLeases');
const run = new Schema({
  serviceId: { type: Schema.Types.ObjectId, required: true, index: true }, organizationId: String,
  revision: Number, status: String, candidate: Schema.Types.Mixed,
  migrated: { type: Number, default: 0 }, replaced: { type: Number, default: 0 },
  error: String, startedAt: { type: Date, default: Date.now }, finishedAt: Date,
});
export const SphereRun = mongoose.model('SphereRun', run, 'sphereRuns');
