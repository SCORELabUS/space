import { authProvider } from '../services/identity/config';
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import container from '../config/container';
import SphereAuthService, { SphereAuthError } from '../services/SphereAuthService';

const cookieName = 'space_sphere_login';
const cookiePath = '/api/v1/auth/sphere';
const browserCookie = (req: Request) => req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
export default class SphereAuthController {
  handle = async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (authProvider() === 'scoretech') {
      if (req.path.replace(/\/$/, '').toLowerCase().endsWith('/status')) return res.json({ available: false });
      return res.status(404).json({ error: 'SPHERE sign-in is disabled' });
    }
    const service: SphereAuthService = container.resolve('sphereAuthService');
    try {
      if (req.path.endsWith('/status')) return res.json({ available: service.available() });
      if (req.method === 'POST' || req.path.endsWith('/callback')) {
        const count = await container.resolve('cacheService').incrementWindow('sso:sphere:rate:' + req.ip, 60);
        if (count > 30) return res.status(429).json({ error: 'Too many sign-in requests. Try again in a minute.' });
      }
      const options = { httpOnly: true, secure: new URL(service.config().redirectUri).protocol === 'https:', sameSite: 'lax' as const, path: cookiePath };
      if (req.path.endsWith('/start')) {
        service.assertOrigin(req.headers.origin);
        const browser = randomBytes(32).toString('hex');
        const result = await service.start(req.body.mode ?? 'login', browser, req.user);
        res.cookie(cookieName, browser, { ...options, maxAge: 600000 });
        return res.json(result);
      }
      if (req.path.endsWith('/connection')) return res.json(await service.connection(req.user));
      const browser = browserCookie(req);
      if (req.path.endsWith('/callback')) return res.redirect(await service.callback(req.query, browser));
      if (req.path.endsWith('/pending')) return res.json(await service.pending(browser));
      service.assertOrigin(req.headers.origin);
      const result = await service.complete(browser, req.body.username, req.user);
      res.clearCookie(cookieName, options);
      return res.json(result);
    } catch (error) {
      if (error instanceof SphereAuthError) return res.status(error.status).json({ error: error.message });
      console.error('SPHERE authentication request failed', error);
      return res.status(503).json({ error: 'SPHERE sign-in is temporarily unavailable. Try again.' });
    }
  };
}
