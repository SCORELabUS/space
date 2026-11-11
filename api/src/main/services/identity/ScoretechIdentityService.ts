import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import container from '../../config/container';
import { fetchWithOptionalProxy } from '../../utils/proxy';
import { identityConfig } from './config';
import type { LeanUser } from '../../types/models/User';
import type UserRepository from '../../repositories/mongoose/UserRepository';

const random = () => randomBytes(32).toString('hex');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const namespace = 'sso:scoretech:';
const SESSION_TTL = 12 * 60 * 60;
const FLOW_TTL = 10 * 60;

interface Flow {
  browserHash: string;
  verifier: string;
  nonce: string;
  link?: { userId: string; sessionHash: string };
}

interface Session {
  userId: string;
  issuer: string;
  subject: string;
  refreshToken: string;
  verifiedUntil: number;
  expiresAt: number;
}

interface LegacySession {
  userId: string;
  credential: string;
  expiresAt: number;
}

interface Metadata {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export class IdentityError extends Error {
  constructor(
    readonly reason: 'invalid' | 'unlinked' | 'unavailable' | 'conflict',
    readonly linking = false,
  ) {
    super(reason);
  }
}

export class ScoretechIdentityService {
  private readonly refreshes = new Map<string, Promise<Session | null>>();
  private discovery?: { issuer: string; expires: number; data: Promise<Metadata> };
  private jwks?: { url: string; keys: ReturnType<typeof createRemoteJWKSet> };

  private get cache() { return container.resolve('cacheService'); }
  private get users(): UserRepository { return container.resolve('userRepository'); }

  private metadata(issuer: string): Promise<Metadata> {
    if (this.discovery?.issuer === issuer && this.discovery.expires > Date.now()) return this.discovery.data;
    const data = this.discover(issuer).catch(error => {
      if (this.discovery?.data === data) this.discovery = undefined;
      throw error;
    });
    this.discovery = { issuer, expires: Date.now() + 300_000, data };
    return data;
  }

  private async discover(issuer: string): Promise<Metadata> {
    const response = await fetchWithOptionalProxy(issuer + '/.well-known/openid-configuration', {
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new IdentityError('unavailable');
    const data = await response.json() as Record<string, unknown>;
    if (data.issuer !== issuer) throw new IdentityError('unavailable');
    const endpoint = (key: string) => {
      const value = data[key];
      if (typeof value !== 'string') throw new IdentityError('unavailable');
      const url = new URL(value);
      // The public realm is fixed by the operator. Discovery cannot move secrets to another realm or host.
      if (!url.href.startsWith(issuer + '/') || url.username || url.password || url.hash || url.search) {
        throw new IdentityError('unavailable');
      }
      return url.href;
    };
    return {
      authorization_endpoint: endpoint('authorization_endpoint'),
      token_endpoint: endpoint('token_endpoint'),
      jwks_uri: endpoint('jwks_uri'),
      revocation_endpoint: data.revocation_endpoint ? endpoint('revocation_endpoint') : undefined,
    };
  }

  async start(browser: string, link?: { session: string; password: string }) {
    const config = identityConfig();
    const account = link ? await this.legacyAccount(link.session, link.password) : null;
    if (link && !account) throw new IdentityError('invalid', true);
    const metadata = await this.metadata(config.issuer);
    const state = random();
    const flow: Flow = { browserHash: digest(browser), verifier: random(), nonce: random() };
    if (link && account) flow.link = { userId: account.user.id, sessionHash: digest(link.session) };
    await this.cache.set(namespace + 'flow:' + state, flow, FLOW_TTL);
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.callback, response_type: 'code', scope: 'openid',
      state, nonce: flow.nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
    }).toString();
    if (link) url.searchParams.set('prompt', 'login');
    return url.href;
  }

  private async exchange(parameters: Record<string, string>, expected: { nonce?: string; subject?: string }) {
    const config = identityConfig();
    const metadata = await this.metadata(config.issuer);
    const response = await fetchWithOptionalProxy(metadata.token_endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parameters, client_id: config.clientId, client_secret: config.clientSecret }),
    });
    if (!response.ok) {
      const error = (response.status === 400 ? await response.json().catch(() => null) : null) as { error?: string } | null;
      throw new IdentityError(error?.error === 'invalid_grant' ? 'invalid' : 'unavailable');
    }
    const tokens = await response.json() as { id_token?: unknown; refresh_token?: unknown };
    if (typeof tokens.id_token !== 'string' || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
      throw new IdentityError('unavailable');
    }
    if (this.jwks?.url !== metadata.jwks_uri) {
      this.jwks = {
        url: metadata.jwks_uri,
        keys: createRemoteJWKSet(new URL(metadata.jwks_uri), { timeoutDuration: 5000, [customFetch]: fetchWithOptionalProxy }),
      };
    }
    const { payload } = await jwtVerify(tokens.id_token, this.jwks.keys, {
      issuer: config.issuer, audience: config.clientId, algorithms: ['RS256'],
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    if (typeof payload.sub !== 'string' || !payload.sub ||
      (expected.nonce !== undefined && payload.nonce !== expected.nonce) ||
      (expected.subject !== undefined && payload.sub !== expected.subject) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId)) {
      throw new IdentityError('invalid');
    }
    return {
      subject: payload.sub,
      refreshToken: tokens.refresh_token,
      verifiedUntil: Math.min(payload.exp! * 1000, Date.now() + 60_000),
    };
  }

  async callback(query: Record<string, unknown>, browser: string, current = '') {
    const { state, code } = query;
    if (!browser || typeof state !== 'string' || !/^[a-f0-9]{64}$/.test(state)) throw new IdentityError('invalid');
    const key = namespace + 'flow:' + state;
    const pending: Flow | null = await this.cache.get(key);
    if (!pending || pending.browserHash !== digest(browser) || !await this.cache.take(key)) {
      throw new IdentityError('invalid');
    }
    const linking = Boolean(pending.link);
    try {
      if (query.error || typeof code !== 'string' || !code || code.length > 2048) throw new IdentityError('invalid');
      if (pending.link && (!current || digest(current) !== pending.link.sessionHash)) throw new IdentityError('invalid');

      const config = identityConfig();
      const verified = await this.exchange({
        grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: config.callback,
      }, { nonce: pending.nonce });
      if (pending.link) {
        const account = await this.legacyAccount(current);
        if (account?.user.id !== pending.link.userId) throw new IdentityError('invalid');
        const existing = await this.users.findByScoretechIdentity(config.issuer, verified.subject);
        if (existing) throw new IdentityError('conflict');
        const linked = await this.users.linkScoretechIdentity(
          account.user.id, account.passwordHash, config.issuer, verified.subject,
        ).catch((error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 11000) throw new IdentityError('conflict');
          throw error;
        });
        if (!linked) throw new IdentityError('conflict');
        const session = await this.openIdentitySession(account.user, config.issuer, verified);
        return { ...session, linked: true };
      }
      const account = await this.users.findByScoretechIdentity(config.issuer, verified.subject);
      if (!account) {
        await this.revoke(verified.refreshToken);
        throw new IdentityError('unlinked');
      }
      const session = await this.openIdentitySession(account, config.issuer, verified);
      return { ...session, linked: false };
    } catch (error) {
      if (linking) throw new IdentityError(error instanceof IdentityError ? error.reason : 'unavailable', true);
      throw error;
    }
  }

  private async openIdentitySession(account: LeanUser, issuer: string, verified: Pick<Session, 'subject' | 'refreshToken' | 'verifiedUntil'>) {
    const id = random();
    const session: Session = { ...verified, issuer, userId: account.id, expiresAt: Date.now() + SESSION_TTL * 1000 };
    await this.cache.set(this.sessionKey(id), session, SESSION_TTL);
    return { id, maxAge: SESSION_TTL * 1000 };
  }

  async legacyLogin(username: string, password: string) {
    if (!identityConfig().legacyPasswordLogin) throw new IdentityError('invalid');
    const account = await this.users.legacyPasswordAccount({ username }, password);
    if (!account) throw new IdentityError('invalid');
    const id = random();
    const ttl = 8 * 60 * 60;
    const session: LegacySession = {
      userId: account.user.id, credential: digest(account.passwordHash), expiresAt: Date.now() + ttl * 1000,
    };
    await this.cache.set(this.legacyKey(id), session, ttl);
    return { id, maxAge: ttl * 1000, username: account.user.username, role: account.user.role };
  }

  private legacyKey(id: string) { return namespace + 'legacy:' + digest(id); }

  private async legacyAccount(id: string, password?: string) {
    if (!id || !identityConfig().legacyPasswordLogin) return null;
    const session: LegacySession | null = await this.cache.get(this.legacyKey(id));
    if (!session || session.expiresAt <= Date.now()) return null;
    const account = await this.users.legacyPasswordAccount({ _id: session.userId }, password);
    return account && digest(account.passwordHash) === session.credential ? account : null;
  }

  async connection(id: string) {
    if (!id) return null;
    if (await this.legacyAccount(id)) return { linked: false, canLink: true };
    return await this.identityAccount(id) ? { linked: true, canLink: false } : null;
  }

  private sessionKey(id: string) { return namespace + 'session:' + digest(id); }

  async authenticate(id: string) {
    return await this.identityAccount(id) ?? (await this.legacyAccount(id))?.user ?? null;
  }

  private async identityAccount(id: string) {
    const key = this.sessionKey(id);
    let session: Session | null = await this.cache.get(key);
    if (!session || session.issuer !== identityConfig().issuer || session.expiresAt <= Date.now()) return null;
    if (session.verifiedUntil <= Date.now()) {
      let refresh = this.refreshes.get(key);
      if (!refresh) {
        refresh = this.refresh(key, session).finally(() => this.refreshes.delete(key));
        this.refreshes.set(key, refresh);
      }
      session = await refresh;
      if (!session) return null;
    }
    const account = await this.users.findByScoretechIdentity(session.issuer, session.subject);
    return account?.id === session.userId ? account : null;
  }

  private async refresh(key: string, previous: Session): Promise<Session | null> {
    const lock = key + ':refresh';
    const owner = random();
    if (!await this.cache.setIfAbsent(lock, owner, 30)) {
      const current: Session | null = await this.cache.get(key);
      if (!current || current.verifiedUntil > Date.now()) return current;
      throw new IdentityError('unavailable');
    }
    try {
      const current: Session | null = await this.cache.get(key);
      if (!current || current.verifiedUntil > Date.now()) return current;
      previous = current;
      const verified = await this.exchange({
        grant_type: 'refresh_token', refresh_token: previous.refreshToken,
      }, { subject: previous.subject });
      const session = { ...previous, ...verified };
      const seconds = Math.ceil((session.expiresAt - Date.now()) / 1000);
      if (seconds <= 0 || !await this.cache.replaceIfCurrent(key, previous, { value: session, seconds })) {
        await this.revoke(verified.refreshToken);
        return null;
      }
      return session;
    } catch (error) {
      if (error instanceof IdentityError && error.reason === 'invalid') {
        await this.cache.replaceIfCurrent(key, previous);
        return null;
      }
      throw error;
    } finally {
      await this.cache.replaceIfCurrent(lock, owner);
    }
  }

  async logout(id: string) {
    if (!id) return;
    await this.cache.del(this.legacyKey(id));
    const session: Session | null = await this.cache.take(this.sessionKey(id));
    if (session) await this.revoke(session.refreshToken);
  }

  private async revoke(refreshToken: string) {
    try {
      const { issuer, clientId, clientSecret } = identityConfig();
      const endpoint = (await this.metadata(issuer)).revocation_endpoint;
      if (!endpoint) return;
      await fetchWithOptionalProxy(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId, client_secret: clientSecret, token: refreshToken, token_type_hint: 'refresh_token',
        }),
      });
    } catch {
      // SPACE already removed the session. Provider availability cannot keep it alive.
    }
  }
}
