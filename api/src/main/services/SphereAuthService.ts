import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import container from '../config/container';
import CacheService from './CacheService';
import UserRepository from '../repositories/mongoose/UserRepository';
import UserService from './UserService';
import type { LeanUser } from '../types/models/User';

const secret = () => randomBytes(32).toString('hex');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const prefix = 'sso:sphere:';
export class SphereAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
interface Transaction { browserHash: string; verifier: string; nonce: string; userId?: string }
interface Identity { issuer: string; subject: string; suggestedUsername: string }
interface Result { kind: 'login' | 'signup' | 'link' | 'error'; identity?: Identity; userId?: string; error?: string }

export function trustedUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('SPHERE authentication URLs must use HTTPS (HTTP loopback is allowed locally)');
  }
  return url;
}
export default class SphereAuthService {
  private get cache(): CacheService { return container.resolve('cacheService'); }
  private get repo(): UserRepository { return container.resolve('userRepository'); }
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private jwksUrl?: string;
  available() {
    return Boolean(process.env.SPHERE_OIDC_ISSUER && process.env.SPHERE_OIDC_CLIENT_ID && process.env.SPHERE_OIDC_CLIENT_SECRET &&
      process.env.SPHERE_OIDC_REDIRECT_URI && process.env.SPACE_FRONTEND_URL);
  }
  config() {
    if (!this.available()) throw new SphereAuthError(503, 'SPHERE sign-in is not configured');
    const issuer = trustedUrl(process.env.SPHERE_OIDC_ISSUER!);
    if (issuer.pathname !== '/' || issuer.search) throw new Error('SPHERE issuer must be an origin');
    return { issuer: issuer.origin, clientId: process.env.SPHERE_OIDC_CLIENT_ID!, clientSecret: process.env.SPHERE_OIDC_CLIENT_SECRET!,
      redirectUri: trustedUrl(process.env.SPHERE_OIDC_REDIRECT_URI!).href,
      frontend: trustedUrl(process.env.SPACE_FRONTEND_URL!) };
  }
  assertOrigin(origin?: string) {
    if (origin !== this.config().frontend.origin) throw new SphereAuthError(403, 'Start this action from SPACE');
  }
  private async metadata() {
    const config = this.config();
    const response = await fetch(config.issuer + '/.well-known/openid-configuration', { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw new SphereAuthError(503, 'SPHERE is unavailable. Try again later.');
    const metadata = await response.json() as Record<string, unknown>;
    if (metadata.issuer !== config.issuer) throw new Error('SPHERE issuer mismatch');
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof metadata[key] !== 'string' || trustedUrl(metadata[key] as string).origin !== config.issuer) throw new Error('Invalid SPHERE endpoint');
    }
    return metadata as Record<string, string>;
  }
  async start(mode: unknown, browser: string, user?: LeanUser) {
    if (!['login', 'link'].includes(String(mode))) throw new SphereAuthError(400, 'Invalid sign-in mode');
    if (mode === 'link' && !user) throw new SphereAuthError(401, 'Sign in to your existing SPACE account before connecting SPHERE');
    const config = this.config();
    const metadata = await this.metadata();
    const state = secret(), verifier = secret(), nonce = secret();
    await this.cache.set(prefix + 'state:' + state, { browserHash: hash(browser), verifier, nonce,
      ...(mode === 'link' ? { userId: user!.id } : {}) } satisfies Transaction, 600);
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
      scope: 'openid profile', state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    return { authorizationUrl: url.href };
  }
  private browserKey(browser: string) {
    if (!/^[a-f0-9]{64}$/.test(browser)) throw new SphereAuthError(400, 'Sign-in expired. Start again from SPACE.');
    return prefix + 'result:' + hash(browser);
  }
  async callback(query: Record<string, unknown>, browser: string) {
    const resultKey = this.browserKey(browser);
    const state = query.state;
    if (typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) throw new SphereAuthError(400, 'Invalid sign-in state');
    const key = prefix + 'state:' + state;
    const pending: Transaction | null = await this.cache.get(key);
    if (!pending || pending.browserHash !== hash(browser)) throw new SphereAuthError(400, 'Sign-in belongs to a different browser or has expired');
    if (!await this.cache.take(key)) throw new SphereAuthError(400, 'Sign-in callback already used');
    let result: Result;
    try {
      if (query.error) throw new SphereAuthError(400, 'SPHERE sign-in was cancelled. You can try again.');
      if (typeof query.code !== 'string' || query.code.length > 512) throw new SphereAuthError(400, 'Missing authorization code');
      const config = this.config();
      const metadata = await this.metadata();
      const response = await fetch(metadata.token_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
          code: query.code, code_verifier: pending.verifier }) });
      if (!response.ok) throw new Error('SPHERE code exchange rejected');
      const tokens = await response.json() as { id_token?: string };
      if (typeof tokens.id_token !== 'string') throw new Error('Missing identity token');
      if (!this.jwks || this.jwksUrl !== metadata.jwks_uri) {
        this.jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 5000 });
        this.jwksUrl = metadata.jwks_uri;
      }
      const { payload } = await jwtVerify(tokens.id_token, this.jwks, { issuer: config.issuer, audience: config.clientId,
        algorithms: ['RS256'], requiredClaims: ['sub', 'iat', 'exp', 'nonce'], maxTokenAge: '5m' });
      if (payload.nonce !== pending.nonce || typeof payload.sub !== 'string' || !payload.sub ||
        (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)) throw new Error('Invalid identity binding');
      const suggested = typeof payload.preferred_username === 'string'
        ? payload.preferred_username.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) : '';
      const identity: Identity = { issuer: config.issuer, subject: payload.sub, suggestedUsername: suggested.length >= 3 ? suggested : 'sphere-user' };
      const existing = await this.repo.findBySphereIdentity(identity.issuer, identity.subject);
      result = pending.userId ? { kind: 'link', identity, userId: pending.userId }
        : existing ? { kind: 'login', identity, userId: existing.id } : { kind: 'signup', identity };
    } catch (error) {
      if (!(error instanceof SphereAuthError)) console.error('SPHERE identity validation failed', error);
      result = { kind: 'error', error: error instanceof SphereAuthError ? error.message : 'SPHERE sign-in could not be verified. Start again.' };
    }
    await this.cache.set(resultKey, result, 600);
    return new URL('auth/sphere', this.config().frontend.href.replace(/\/?$/, '/')).href;
  }
  private async result(browser: string): Promise<Result> {
    const result = await this.cache.get(this.browserKey(browser));
    if (!result) throw new SphereAuthError(400, 'Sign-in expired. Start again from SPACE.');
    return result;
  }
  async pending(browser: string) {
    const result = await this.result(browser);
    return { kind: result.kind, suggestedUsername: result.kind === 'signup' ? result.identity?.suggestedUsername : undefined, error: result.error };
  }
  async complete(browser: string, username: unknown, user?: LeanUser) {
    const key = this.browserKey(browser);
    if (!await this.cache.setIfAbsent(key + ':lock', true, 600)) throw new SphereAuthError(409, 'This sign-in is already being completed');
    try {
      const result = await this.result(browser);
      if (!result.identity || result.kind === 'error') throw new SphereAuthError(400, result.error || 'Invalid sign-in');
      const { issuer, subject } = result.identity;
      let account = await this.repo.findBySphereIdentity(issuer, subject);
      if (result.kind === 'link') {
        if (!user || user.id !== result.userId) throw new SphereAuthError(401, 'Sign in with the SPACE account that started this connection');
        if (account && account.id !== user.id) throw new SphereAuthError(409, 'This SPHERE identity is already connected to another SPACE account');
        if (!account && !await this.repo.linkSphereIdentity(user.id, issuer, subject)) throw new SphereAuthError(409, 'This SPACE account already has a SPHERE identity');
        await this.cache.del(key);
        return { linked: true };
      }
      if (result.kind === 'signup') {
        if (account) throw new SphereAuthError(409, 'This identity was just registered. Start sign-in again.');
        if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{3,30}$/.test(username)) {
          throw new SphereAuthError(400, 'Choose 3–30 letters, digits, underscores or hyphens');
        }
        if (await this.repo.findByUsername(username)) throw new SphereAuthError(409, 'Username is already taken. Choose another, or sign in to your existing account and connect SPHERE in Settings.');
        account = await (container.resolve('userService') as UserService).createFederated(username, issuer, subject);
      }
      if (!account || (result.userId && result.userId !== account.id)) throw new SphereAuthError(401, 'Account is no longer available');
      await this.cache.del(key);
      return { username: account.username, apiKey: account.apiKey, role: account.role };
    } catch (error: any) {
      if (error?.code === 11000) throw new SphereAuthError(409, 'Username or SPHERE identity is already taken. Choose another username or start sign-in again.');
      throw error;
    } finally { await this.cache.del(key + ':lock'); }
  }
  async connection(user?: LeanUser) {
    if (!user) throw new SphereAuthError(401, 'A SPACE user session is required');
    return this.repo.sphereConnection(user.id);
  }
}
