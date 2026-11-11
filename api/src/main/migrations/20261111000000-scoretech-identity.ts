import UserMongoose, { scoretechIdentityIndex, scoretechIdentityIndexOptions } from '../repositories/mongoose/models/UserMongoose';

export async function migrateScoretechIdentity() {
  await UserMongoose.collection.createIndex(scoretechIdentityIndex, scoretechIdentityIndexOptions);
}
