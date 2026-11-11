import { createHash, randomBytes } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import container from '../config/container';
import { authProvider, FLOW_COOKIE, identityConfig, readCookie, SESSION_COOKIE } from '../services/identity/config';
import { IdentityError } from '../services/identity/ScoretechIdentityService';

function cookieOptions(secure: boolean, path: string): CookieOptions {
  return { httpOnly: true, secure, sameSite: 'lax', path };
}

export default class ScoretechIdentityController {
  config = (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const provider = authProvider();
    if (provider === 'local') return res.json({ provider });
    const { accountUrl, legacyPasswordLogin } = identityConfig();
    return res.json({ provider, accountUrl, legacyPasswordLogin });
  };

  start = (req: Request, res: Response) => this.handle(req, res, 'start');
  callback = (req: Request, res: Response) => this.handle(req, res, 'callback');
  logout = (req: Request, res: Response) => this.handle(req, res, 'logout');
  legacy = (req: Request, res: Response) => this.handle(req, res, 'legacy');
  connection = (req: Request, res: Response) => this.handle(req, res, 'connection');

  private async handle(req: Request, res: Response, action: 'start' | 'callback' | 'logout' | 'legacy' | 'connection') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (authProvider() !== 'scoretech') return res.status(404).json({ error: 'SCORETech sign-in is disabled' });
    const config = identityConfig();
    const originRequired = action === 'start' || action === 'logout' || action === 'legacy';
    if (action !== 'callback' && (originRequired || req.headers.origin) && req.headers.origin !== config.frontend.origin) {
      return res.status(403).json({ error: 'Start this action from SPACE' });
    }
    const flowCookie = cookieOptions(config.secure, config.apiPath + '/auth/identity');
    const sessionCookie = cookieOptions(config.secure, config.apiPath);
    const service = container.resolve('scoretechIdentityService');
    const current = readCookie(req.headers.cookie, SESSION_COOKIE);
    try {
      if (action === 'connection') {
        const connection = await service.connection(current);
        return connection ? res.json(connection) : res.status(401).json({ error: 'A SPACE browser session is required' });
      }
      if (action === 'legacy' && !config.legacyPasswordLogin) {
        return res.status(404).json({ error: 'Legacy password login is disabled' });
      }
      if (action !== 'logout') {
        const count = await container.resolve('cacheService').incrementWindow('sso:scoretech:rate:' + req.ip, 60);
        if (count > 30) return res.status(429).json({ error: 'Too many sign-in requests. Try again in a minute.' });
      }
      if (action === 'legacy') {
        const { username, password } = req.body ?? {};
        if (typeof username !== 'string' || !username || username.length > 128 || !validPassword(password)) {
          return res.status(401).json({ error: 'Check your SPACE credentials or sign in with SCORETech Identity.' });
        }
        if (await passwordLimited(username)) return res.status(429).json({ error: 'Too many attempts. Try again in five minutes.' });
        const session = await service.legacyLogin(username, password);
        if (current) await service.logout(current);
        res.cookie(SESSION_COOKIE, session.id, { ...sessionCookie, maxAge: session.maxAge });
        return res.json({ username: session.username, role: session.role });
      }
      if (action === 'start') {
        const password: unknown = req.body?.password;
        if (password !== undefined && (!current || !validPassword(password))) {
          return res.status(401).json({ error: 'Confirm your current SPACE password.' });
        }
        if (typeof password === 'string' && await passwordLimited(current)) {
          return res.status(429).json({ error: 'Too many attempts. Try again in five minutes.' });
        }
        const browser = randomBytes(32).toString('hex');
        const authorizationUrl = await service.start(browser,
          typeof password === 'string' ? { session: current, password } : undefined);
        res.cookie(FLOW_COOKIE, browser, { ...flowCookie, maxAge: 600_000 });
        return res.json({ authorizationUrl });
      }
      if (action === 'logout') {
        await service.logout(current);
        res.clearCookie(SESSION_COOKIE, sessionCookie);
        res.clearCookie(FLOW_COOKIE, flowCookie);
        return res.sendStatus(204);
      }
      const browser = readCookie(req.headers.cookie, FLOW_COOKIE);
      res.clearCookie(FLOW_COOKIE, flowCookie);
      const session = await service.callback(req.query, browser, current);
      if (current) await service.logout(current);
      res.cookie(SESSION_COOKIE, session.id, { ...sessionCookie, maxAge: session.maxAge });
      if (!session.linked) return res.redirect(303, config.frontend.href);
      return res.redirect(303, new URL('settings?identityLinked=1', config.frontend).href);
    } catch (error) {
      if (action === 'callback') {
        const target = new URL(error instanceof IdentityError && error.linking ? 'settings' : '', config.frontend);
        target.searchParams.set('identityError', error instanceof IdentityError ? error.reason : 'unavailable');
        return res.redirect(303, target.href);
      }
      if (error instanceof IdentityError && error.reason === 'invalid') {
        return res.status(401).json({ error: action === 'legacy'
          ? 'Check your SPACE credentials or sign in with SCORETech Identity.'
          : 'Confirm your current SPACE password and try again.' });
      }
      return res.status(503).json({ error: 'SCORETech sign-in is temporarily unavailable. Try again.' });
    }
  }
}

function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024;
}

async function passwordLimited(value: string) {
  const key = createHash('sha256').update(value).digest('hex');
  const count = await container.resolve('cacheService').incrementWindow('sso:scoretech:password:' + key, 300);
  return count > 10;
}
