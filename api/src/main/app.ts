import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { Application } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import container from './config/container';
import { disconnectMongoose, initMongoose } from './config/mongoose';
import { initRedis } from './config/redis';
import { seedDatabase } from './database/seeders/mongo/seeder';
import loadGlobalMiddlewares from './middlewares/GlobalMiddlewaresLoader';
import routes from './routes/index';
import { seedDefaultAdmin } from './database/seeders/common/userSeeder';

const green = '\x1b[32m';
const blue = '\x1b[36m';
const reset = '\x1b[0m';
const bold = '\x1b[1m';

const initializeApp = async (seedDatabase: boolean = true) => {
  // Root scripts start this package from `api/`, while the shared development
  // configuration lives at the workspace root. Load it before the local file
  // so existing API-only values may still fill any missing setting.
  const workspaceEnv = resolve(process.cwd(), '..', '.env');
  // Preserve variables supplied by CI/test runners. The workspace .env only
  // fills values that are not already present in the process environment.
  if (existsSync(workspaceEnv)) dotenv.config({ path: workspaceEnv });
  dotenv.config();
  const app: Application = express();
  loadGlobalMiddlewares(app);
  await routes(app);
  await initializeDatabase(seedDatabase);
  const redisClient = await initRedis();
  // Redis is shared locally; CacheService scopes cleanup to SPACE's prefix.
  container.resolve('cacheService').setRedisClient(redisClient);
  // await postInitializeDatabase(app)
  return app;
};

const initializeServer = async (
  seedDatabase: boolean = true
): Promise<{
  server: Server;
  app: Application;
}> => {
  const app: Application = await initializeApp(seedDatabase);
  const port = Number(process.env.SERVER_PORT ?? 3000);

  // Using a promise to ensure the server is started before returning it
  const server: Server = await new Promise((resolve, reject) => {
    const server = app.listen(port, (err?: Error) => {
      if (err) return reject(err);
      resolve(server);
    });
  });

  const addressInfo: AddressInfo = server.address() as AddressInfo;

  // Inicializar el servicio de eventos con el servidor HTTP
  await container.resolve('eventService').initialize(server);
  container.resolve('sphereSyncService').start();
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const closed = server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve();
    await container.resolve('sphereSyncService').stop();
    await container.resolve('eventService').close();
    await closed;
    await container.resolve('cacheService').close();
    await mongoose.disconnect();
  };
  const onSignal = () => { void shutdown().catch(error => console.error('Shutdown failed', error)); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  server.on('close', () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    void container.resolve('sphereSyncService').stop();
  });

  console.log(
    `  ${green}➜${reset}  ${bold}API:${reset}     ${blue}http://localhost${addressInfo.port !== 80 ? `:${bold}${addressInfo.port}${reset}` : ''}`
  );
  console.log(
    `  ${green}➜${reset}  ${bold}WebSockets:${reset} ${blue}ws://localhost${addressInfo.port !== 80 ? `:${bold}${addressInfo.port}${reset}/events/pricings` : '/events/pricings'}`
  );

  if (['development', 'testing'].includes(process.env.ENVIRONMENT ?? '')) {
    console.log(`${green}➜${reset}  ${bold}Loaded Routes:${reset}`);
    app._router.stack
      .filter((layer: any) => layer.route)
      .forEach((layer: any) => {
        console.log(`  ${blue}${layer.route.path}${reset}`);
      });
  }

  return { server, app };
};

const initializeDatabase = async (seedDatabaseFlag: boolean = true) => {
  let connection;
  try {
    switch (process.env.DATABASE_TECHNOLOGY ?? 'mongoDB') {
      case 'mongoDB':
        connection = await initMongoose();
        if (['development'].includes(process.env.ENVIRONMENT ?? '')) {
          if (seedDatabaseFlag && process.env.SEED_ON_STARTUP === 'true') {
            await seedDatabase();
          }
        } else {
          if (seedDatabaseFlag) {
            await seedDefaultAdmin();
          }
        }
        break;
      default:
        throw new Error('Unsupported database technology');
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
  return connection;
};

const disconnectDatabase = async () => {
  await container.resolve('sphereSyncService').stop();
  await container.resolve('eventService').close();
  await container.resolve('cacheService').close();
  try {
    switch (process.env.DATABASE_TECHNOLOGY ?? 'mongoDB') {
      case 'mongoDB':
        await disconnectMongoose();
        break;
      default:
        throw new Error('Unsupported database technology');
    }
  } catch (error) {
    console.error(error);
  }
};

export { disconnectDatabase, initializeServer };
