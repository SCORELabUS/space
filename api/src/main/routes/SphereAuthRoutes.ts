import type { Application } from 'express';
import SphereAuthController from '../controllers/SphereAuthController';

export default function loadSphereAuthRoutes(app: Application) {
  const controller = new SphereAuthController();
  const base = '/api/v1/auth/sphere';
  app.get(base + '/status', controller.handle);
  app.post(base + '/start', controller.handle);
  app.get(base + '/callback', controller.handle);
  app.get(base + '/pending', controller.handle);
  app.post(base + '/complete', controller.handle);
  app.get(base + '/connection', controller.handle);
}
