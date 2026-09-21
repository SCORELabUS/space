import express from 'express';
import container from '../config/container';
import { memberRole, hasPermission } from '../middlewares/AuthMiddleware';

export default function loadRoutes(app: express.Application) {
  const invoke = (action: string) => async (req: any, res: any) => {
    const organizationId = req.org?.id ?? req.params.organizationId;
    if (!organizationId) return res.status(400).json({ error: 'Organization ID is required' });
    try {
      const sync = container.resolve('sphereSyncService');
      let result;
      if (action === 'preview') result = await sync.preview(req.body);
      else if (action === 'get') result = await sync.get(organizationId, req.params.serviceName);
      else if (action === 'configure') result = await sync.configure(organizationId, req.params.serviceName, req.body);
      else {
        result = await sync.enqueue(organizationId, req.params.serviceName);
        // Manual requests work even when the periodic worker is disabled.
        const Service = (await import('../repositories/mongoose/models/ServiceMongoose')).default;
        const service = await Service.findOne({ organizationId, name: req.params.serviceName });
        if (service) setImmediate(() => { void sync.synchronize(String(service._id)).catch((error: Error) => console.error(error.message)); });
      }
      return res.status(action === 'run' ? 202 : 200).json(result);
    } catch (error) {
      const message = (error as Error).message;
      res.status(/not found/i.test(message) ? 404 : /busy|applying|lock/i.test(message) ? 409 : 400).json({ error: message });
    }
  };
  for (const scoped of [false, true]) {
    const base = '/api/v1' + (scoped ? '/organizations/:organizationId/services' : '/services');
    const read = scoped ? [memberRole, hasPermission(['OWNER', 'ADMIN', 'MANAGER', 'EVALUATOR'])] : [];
    const write = scoped ? [memberRole, hasPermission(['OWNER', 'ADMIN', 'MANAGER'])] : [];
    app.post(base + '/sphere/preview', ...write, invoke('preview'));
    app.get(base + '/:serviceName/synchronization', ...read, invoke('get'));
    app.put(base + '/:serviceName/synchronization', ...write, invoke('configure'));
    app.post(base + '/:serviceName/synchronization/run', ...write, invoke('run'));
  }
}
