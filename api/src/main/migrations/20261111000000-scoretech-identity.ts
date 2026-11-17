import UserMongoose, { scoretechEmailIndex, scoretechEmailIndexOptions, scoretechIdentityIndex, scoretechIdentityIndexOptions } from '../repositories/mongoose/models/UserMongoose';

export async function migrateScoretechIdentity() {
  await UserMongoose.collection.createIndex(scoretechIdentityIndex, scoretechIdentityIndexOptions);
  await UserMongoose.collection.createIndex(scoretechEmailIndex, scoretechEmailIndexOptions);
}
