import { ServiceRelocationPendingError } from '../services/serviceRelocationState';
import express from 'express';
import container from '../config/container';
import { memberRole, hasPermission } from '../middlewares/AuthMiddleware';
import { SphereAuthError, SphereResourceUnavailableError } from '../services/sphere/errors';
import { SphereCredentialError } from '../services/sphere/credentials';

export default function loadRoutes(app: express.Application) {
  const invoke = (action: string) => async (req: any, res: any) => {
    const organizationId = req.org?.id ?? req.params.organizationId;
    if (!organizationId) return res.status(400).json({ error: 'Organization ID is required' });
    try {
      const sync = container.resolve('sphereSyncService');
      let result;
      if (action === 'preview') result = await sync.preview(req.body, organizationId, req.body?.serviceName);
      else if (action === 'get') result = await sync.get(organizationId, req.params.serviceName);
      else if (action === 'configure') result = await sync.configure(organizationId, req.params.serviceName, req.body);
      else {
        result = await (action === 'resume' ? sync.resume(organizationId, req.params.serviceName) : sync.enqueue(organizationId, req.params.serviceName));
        // Manual requests work even when the periodic worker is disabled.
        const Service = (await import('../repositories/mongoose/models/ServiceMongoose')).default;
        const service = await Service.findOne({ organizationId, name: req.params.serviceName });
        if (service) setImmediate(() => { void sync.synchronize(String(service._id)).catch((error: Error) => console.error(error.message)); });
      }
      return res.status(['run', 'resume'].includes(action) ? 202 : 200).json(result);
    } catch (error) {
      if (error instanceof ServiceRelocationPendingError) return res.status(409).json({ code: error.code, error: error.message });
      if (error instanceof SphereAuthError || error instanceof SphereResourceUnavailableError) {
        const suppliedKey = typeof req.body?.sphereApiKey === 'string' && req.body.sphereApiKey.length > 0;
        return res.status(400).json({
          code: suppliedKey ? 'SPHERE_KEY_REJECTED' : 'SPHERE_ACCESS_REQUIRED',
          error: suppliedKey
            ? 'This SPHERE API key cannot access the pricing. Check the link and the key permissions, then try again.'
            : 'This pricing may be private or unavailable. Provide a SPHERE API key with access to continue.',
        });
      }
      if (error instanceof SphereCredentialError) {
        return res.status(400).json({
          code: 'SPHERE_CREDENTIAL_STORAGE_UNAVAILABLE',
          error: 'SPHERE credentials cannot be used or saved right now. Ask your SPACE administrator to check credential storage.',
        });
      }
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
    app.post(base + '/:serviceName/synchronization/resume', ...write, invoke('resume'));
  }
}
