import type { Application } from 'express';
import ScoretechIdentityController from '../controllers/ScoretechIdentityController';
import { AUTH_PATH } from '../services/identity/config';

export default function loadScoretechIdentityRoutes(app: Application) {
  const controller = new ScoretechIdentityController();
  app.get('/api/v1/auth/config', controller.config);
  app.post(AUTH_PATH + '/legacy', controller.legacy);
  app.get(AUTH_PATH + '/connection', controller.connection);
  app.post(AUTH_PATH + '/start', controller.start);
  app.get(AUTH_PATH + '/callback', controller.callback);
  app.post(AUTH_PATH + '/logout', controller.logout);
}
