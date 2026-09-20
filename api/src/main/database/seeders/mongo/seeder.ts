import { Seeder } from 'mongo-seeding';
import path from 'path';
import { fileURLToPath } from 'url';
import { getMongoDBConnectionURI } from '../../../config/mongoose';
import ServiceModel from '../../../repositories/mongoose/models/ServiceMongoose';
import ContractModel from '../../../repositories/mongoose/models/ContractMongoose';
import PricingModel from '../../../repositories/mongoose/models/PricingMongoose';
import UserModel from '../../../repositories/mongoose/models/UserMongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  database: getMongoDBConnectionURI(),
  dropDatabase: false
};

const seeder = new Seeder(config);

const collections = seeder.readCollectionsFromPath(path.resolve(__dirname));

export const seedDatabase = async () => {
  try {
    if (process.env.SEED_RESET_DATABASE === 'true') {
      const mongoose = (await import('mongoose')).default;
      if (mongoose.connection.db) await mongoose.connection.db.dropDatabase();
    }
    await seeder.import(collections);
    // Ensure indexes for all mongoose models after seeding
    await Promise.all([
      ServiceModel.syncIndexes(),
      ContractModel.syncIndexes(),
      PricingModel.syncIndexes(),
      UserModel.syncIndexes(),
    ]);
    console.log('All indexes have been (re)built after seeding.');
  } catch (err) {
    console.error(`Seeding error: ${err}`);
  }
};
