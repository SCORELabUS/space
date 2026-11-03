import UserMongoose from '../repositories/mongoose/models/UserMongoose';

/** Additive and idempotent; legacy local accounts are outside the partial index. */
export async function migrateSphereIdentity() {
  await UserMongoose.collection.createIndex({ 'sphereIdentity.issuer': 1, 'sphereIdentity.subject': 1 }, {
    name: 'unique_sphere_identity', unique: true,
    partialFilterExpression: { 'sphereIdentity.issuer': { $type: 'string' }, 'sphereIdentity.subject': { $type: 'string' } },
  });
}
