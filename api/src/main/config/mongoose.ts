import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

// const getMongoDBConnectionURI = () => {
//   const databaseProtocol = process.env.MONGO_PROTOCOL;
//   const databaseHost = process.env.MONGO_HOST;
//   const databasePort = process.env.MONGO_PORT ? `:${process.env.MONGO_PORT}` : ':27017';
//   const databaseUsername = process.env.DATABASE_USERNAME;
//   const databasePassword = process.env.DATABASE_PASSWORD;
//   const databaseName = process.env.DATABASE_NAME;
//   const dbCredentials =
//     databaseUsername && databasePassword ? databaseUsername + ':' + databasePassword + '@' : '';
//   const authSource = databaseProtocol === 'mongodb+srv' ? '' : `?authSource=${databaseName}`;
//   const mongoDbConnectionURI = `${databaseProtocol}://${dbCredentials}${databaseHost}${databasePort}/${databaseName}${authSource}`;
//   return mongoDbConnectionURI;
// };

const getMongoDBConnectionURI = () => {
  const databaseName = process.env.DATABASE_NAME ?? "space_db";
  const databaseUsername = process.env.DATABASE_USERNAME ?? "mongoUser";
  const databasePassword = process.env.DATABASE_PASSWORD ?? "mongoPassword";
  const dbCredentials =
    databaseUsername && databasePassword ? databaseUsername + ':' + databasePassword + '@' : '';

    
  const authSource = process.env.MONGO_AUTH_SOURCE ?? databaseName;
  const wholeUri = process.env.MONGO_URI || `mongodb://${dbCredentials}localhost:27017/${databaseName}?authSource=${authSource}`;

  console.log("Using MongoDB URI: ", wholeUri);

  return wholeUri;
}

const initMongoose = () => {
  const mongoDbConnectionURI = getMongoDBConnectionURI();
  console.log(`Trying to connect to ${mongoDbConnectionURI}`);
  mongoose.set('strictQuery', false); // removes a deprecation warning
  // mongoose.set('debug', true)
  return mongoose.connect(mongoDbConnectionURI);
};

const disconnectMongoose = async () => {
  console.log('Disconnecting from MongoDB');
  // The local MongoDB instance is shared. Never erase it on API shutdown.
  return mongoose.disconnect();
};

export { disconnectMongoose,getMongoDBConnectionURI, initMongoose };
