import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authProvider, identityConfig } from '../../main/services/identity/config';
import { scoretechAlias } from '../../main/services/identity/scoretechAlias';
import { ScoretechIdentityService } from '../../main/services/identity/ScoretechIdentityService';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), fetch: vi.fn() }));
vi.mock('../../main/config/container', () => ({ default: { resolve: mocks.resolve } }));
vi.mock('../../main/utils/proxy', () => ({ fetchWithOptionalProxy: mocks.fetch }));

const issuer = 'https://identity.example/identity/auth/realms/score';
const browser = 'a'.repeat(64);
const account = { id: 'local-id', username: 'local-name', role: 'USER' };
const users = { findByScoretechIdentity: vi.fn(), legacyPasswordAccount: vi.fn(), linkScoretechIdentity: vi.fn(), hasScoretechEmailConflict: vi.fn(), syncScoretechUsername: vi.fn() };
const userService = { createScoretechProfile: vi.fn() };
const legacyAccount = { user: account, passwordHash: 'fixture-password-hash' };
const entries = new Map<string, unknown>();
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let service: ScoretechIdentityService;
let nonce: string;
let returnedSubject: string;
let emailClaims: Record<string, unknown>;
let profileClaims: Record<string, unknown>;
let beforeRefresh: (() => Promise<void>) | undefined;

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
});
beforeEach(() => {
  entries.clear();
  users.findByScoretechIdentity.mockReset().mockResolvedValue(account);
  users.legacyPasswordAccount.mockReset().mockImplementation(async (_query, password) => {
    return password === undefined || password === 'valid-password' ? legacyAccount : null;
  });
  users.linkScoretechIdentity.mockReset().mockResolvedValue(true);
  returnedSubject = 'scoretech-subject';
  emailClaims = { email: ' Person@Example.org ', email_verified: true };
  users.hasScoretechEmailConflict.mockReset().mockResolvedValue(false);
  users.syncScoretechUsername.mockReset().mockResolvedValue(undefined);
  userService.createScoretechProfile.mockReset().mockResolvedValue(account);
  beforeRefresh = undefined;
  profileClaims = {};
  vi.stubEnv('AUTH_PROVIDER', undefined);
  vi.stubEnv('SPACE_FRONTEND_URL', 'https://space.example/space/');
  vi.stubEnv('SCORETECH_IDENTITY_ISSUER', issuer);
  vi.stubEnv('SCORETECH_IDENTITY_CLIENT_ID', 'space');
  vi.stubEnv('SCORETECH_IDENTITY_CLIENT_SECRET', 'fixture-only');
  vi.stubEnv('SCORETECH_IDENTITY_CALLBACK_URL', undefined);
  vi.stubEnv('SCORETECH_IDENTITY_ACCOUNT_URL', undefined);
  vi.stubEnv('SCORETECH_LEGACY_PASSWORD_LOGIN', undefined);
  const cache = {
    get: async (key: string) => entries.get(key) ?? null,
    set: async (key: string, value: unknown) => { entries.set(key, value); },
    del: async (key: string) => { entries.delete(key); },
    take: async (key: string) => {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    },
    setIfAbsent: async (key: string, value: unknown) => {
      if (entries.has(key)) return false;
      entries.set(key, value);
      return true;
    },
    replaceIfCurrent: async (key: string, expected: unknown, replacement?: { value: unknown }) => {
      if (entries.get(key) !== expected) return false;
      if (replacement) entries.set(key, replacement.value);
      else entries.delete(key);
      return true;
    },
  };
  mocks.resolve.mockImplementation(name => name === 'cacheService' ? cache : name === 'userService' ? userService : users);
  mocks.fetch.mockReset().mockImplementation(async (input: string | URL, options?: RequestInit) => {
    const url = String(input);
    if (url === issuer + '/.well-known/openid-configuration') return Response.json({
      issuer, authorization_endpoint: issuer + '/auth', token_endpoint: issuer + '/token',
      jwks_uri: issuer + '/jwks', revocation_endpoint: issuer + '/revoke',
    });
    if (url === issuer + '/jwks') return Response.json({
      keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256' }],
    });
    if (url === issuer + '/revoke') return new Response(null, { status: 204 });
    if (url !== issuer + '/token') throw new Error('Unexpected token endpoint');
    const refresh = (options?.body as URLSearchParams).get('grant_type') === 'refresh_token';
    if (refresh) await beforeRefresh?.();
    const idToken = await new SignJWT({ ...emailClaims, ...profileClaims, ...(refresh ? {} : { nonce }) })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
      .setIssuer(issuer).setSubject(returnedSubject).setAudience('space').setIssuedAt().setExpirationTime('5m')
      .sign(keys.privateKey);
    return Response.json({ id_token: idToken, refresh_token: refresh ? 'rotated' : 'initial' });
  });
  service = new ScoretechIdentityService();
});

afterEach(() => vi.unstubAllEnvs());

async function flow(link?: { session: string; password: string }) {
  const authorization = new URL(await service.start(browser, link));
  expect(authorization.searchParams.get('scope')).toBe('openid email profile');
  if (link) expect(authorization.searchParams.get('prompt')).toBe('login');
  nonce = authorization.searchParams.get('nonce')!;
  return { state: authorization.searchParams.get('state'), code: 'test-code' };
}

function expireVerification() {
  const entry = [...entries].find(([key]) => key.startsWith('sso:scoretech:session:'));
  if (!entry) throw new Error('No session');
  const [key, session] = entry;
  entries.set(key, { ...(session as object), verifiedUntil: 0 });
}

describe('SCORETech Identity in SPACE', () => {
  it('defaults to local and uses the public proxy prefix in the callback', () => {
    expect(authProvider()).toBe('local');
    expect(identityConfig().callback).toBe('https://space.example/space/api/v1/auth/identity/callback');
    vi.stubEnv('SCORETECH_IDENTITY_CALLBACK_URL', 'https://other.example/space/api/v1/auth/identity/callback');
    expect(() => identityConfig()).toThrow('public SPACE origin');
  });

  it('binds the single-use flow to the browser and uses the exact issuer and subject link', async () => {
    emailClaims = {};
    const query = await flow();
    await expect(service.callback(query, 'b'.repeat(64))).rejects.toMatchObject({ reason: 'invalid' });
    const session = await service.callback(query, browser);
    expect(users.findByScoretechIdentity).toHaveBeenCalledWith(issuer, returnedSubject);
    expect(await service.authenticate(session.id)).toEqual(account);
    await expect(service.callback(query, browser)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('provisions on first sign-in with a normalized verified email and reuses the profile next time', async () => {
    users.findByScoretechIdentity.mockResolvedValueOnce(null);
    const first = await service.callback(await flow(), browser);
    expect(userService.createScoretechProfile).toHaveBeenCalledWith(issuer, returnedSubject, 'person@example.org');
    expect(await service.authenticate(first.id)).toEqual({ ...account, identityAlias: 'person' });
    await service.callback(await flow(), browser);
    expect(userService.createScoretechProfile).toHaveBeenCalledTimes(1);
  });

  it('synchronizes the current verified username for an existing account without changing its stable reference', async () => {
    const { id } = await service.callback(await flow(), browser);
    expect(await service.authenticate(id)).toMatchObject({ ...account, identityAlias: 'person' });
    expect(users.syncScoretechUsername).toHaveBeenLastCalledWith(account.id, issuer, returnedSubject, 'person@example.org', 'person');

    expireVerification();
    emailClaims = { email: 'new-name@example.org', email_verified: false };
    expect(await service.authenticate(id)).toMatchObject({ ...account, identityAlias: 'person' });
    expect(users.syncScoretechUsername).toHaveBeenCalledTimes(1);

    expireVerification();
    emailClaims.email_verified = true;
    expect(await service.authenticate(id)).toMatchObject({ ...account, identityAlias: 'new-name' });
    expect(users.syncScoretechUsername).toHaveBeenLastCalledWith(account.id, issuer, returnedSubject, 'new-name@example.org', 'new-name');
    expect(userService.createScoretechProfile).not.toHaveBeenCalled();
    expect(users.linkScoretechIdentity).not.toHaveBeenCalled();
  });

  it('refreshes the display name without renaming a previously generated account', async () => {
    const existing = { ...account, username: 'scoretech-1234567890abcdef1234' };
    users.findByScoretechIdentity.mockResolvedValue(existing);
    profileClaims = { scoretech_display_name: 'First name', name: 'Fallback name' };
    const { id } = await service.callback(await flow(), browser);
    expect(await service.authenticate(id)).toEqual({ ...existing, displayName: 'First name', identityAlias: 'person' });

    expireVerification();
    profileClaims.scoretech_display_name = 'New name';
    expect(await service.authenticate(id)).toEqual({ ...existing, displayName: 'New name', identityAlias: 'person' });

    expireVerification();
    profileClaims.scoretech_display_name = '';
    expect(await service.authenticate(id)).toEqual({ ...existing, displayName: 'Fallback name', identityAlias: 'person' });
  });

  it('derives a bounded handle from the local part of the email', () => {
    expect(scoretechAlias('Alejandro.Prueba@example.org')).toBe('alejandro.prueba');
    expect(scoretechAlias('ana+tag@example.org')).toBe('ana-tag');
    expect(scoretechAlias('a@example.org')).toBe('scoretech-a');
    expect(scoretechAlias('x'.repeat(50) + '@example.org')).toHaveLength(30);
  });

  it('refuses a matching email without signing in to or modifying the existing account', async () => {
    users.findByScoretechIdentity.mockResolvedValue(null);
    users.hasScoretechEmailConflict.mockResolvedValue(true);
    await expect(service.callback(await flow(), browser)).rejects.toMatchObject({ reason: 'conflict' });
    expect(userService.createScoretechProfile).not.toHaveBeenCalled();
    expect(users.linkScoretechIdentity).not.toHaveBeenCalled();
    expect(entries.size).toBe(0);
  });

  it('reports an email claimed by another callback during profile creation as a conflict', async () => {
    users.findByScoretechIdentity.mockResolvedValue(null);
    userService.createScoretechProfile.mockRejectedValueOnce({ code: 11000, keyPattern: { scoretechEmail: 1 } });
    await expect(service.callback(await flow(), browser)).rejects.toMatchObject({ reason: 'conflict' });
    expect(entries.size).toBe(0);
  });

  it.each([{}, { email: 'person@example.org', email_verified: false }])(
    'requires a verified email before provisioning a profile (%j)', async claims => {
      emailClaims = claims;
      users.findByScoretechIdentity.mockResolvedValue(null);
      await expect(service.callback(await flow(), browser)).rejects.toMatchObject({ reason: 'email_required' });
      expect(userService.createScoretechProfile).not.toHaveBeenCalled();
      expect(entries.size).toBe(0);
    },
  );

  it('rejects renewal when the provider returns a different subject', async () => {
    const { id } = await service.callback(await flow(), browser);
    expireVerification();
    returnedSubject = 'different-subject';
    expect(await service.authenticate(id)).toBeNull();
    expect(entries.size).toBe(0);
  });

  it('does not recreate a session if logout wins during provider renewal', async () => {
    const { id } = await service.callback(await flow(), browser);
    expireVerification();
    beforeRefresh = () => service.logout(id);
    expect(await service.authenticate(id)).toBeNull();
    expect(entries.size).toBe(0);
    expect(await service.authenticate(id)).toBeNull();
  });

  it('requires fresh password proof and the same browser session before linking', async () => {
    const legacy = await service.legacyLogin(account.username, 'valid-password');
    expect(legacy).not.toHaveProperty('apiKey');
    expect(await service.connection(legacy.id)).toEqual({ linked: false, canLink: true });
    await expect(flow({ session: legacy.id, password: 'incorrect' })).rejects.toMatchObject({ reason: 'invalid' });
    const other = await service.legacyLogin(account.username, 'valid-password');
    const query = await flow({ session: legacy.id, password: 'valid-password' });
    await expect(service.callback(query, browser, other.id)).rejects.toMatchObject({ reason: 'invalid', linking: true });
    expect(users.linkScoretechIdentity).not.toHaveBeenCalled();
  });

  it('links the verified identity to the existing user and expires legacy access after linking', async () => {
    const legacy = await service.legacyLogin(account.username, 'valid-password');
    const query = await flow({ session: legacy.id, password: 'valid-password' });
    users.findByScoretechIdentity.mockResolvedValueOnce(null);
    const result = await service.callback(query, browser, legacy.id);
    expect(users.linkScoretechIdentity).toHaveBeenCalledWith(account.id, legacyAccount.passwordHash, issuer, returnedSubject, 'person@example.org');
    expect(result.linked).toBe(true);
    expect(await service.connection(result.id)).toEqual({ linked: true, canLink: false });
    users.legacyPasswordAccount.mockResolvedValue(null);
    expect(await service.authenticate(legacy.id)).toBeNull();
    await expect(service.legacyLogin(account.username, 'valid-password')).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('leaves the legacy session intact if the identity is already linked or lost a race', async () => {
    const legacy = await service.legacyLogin(account.username, 'valid-password');
    const first = await flow({ session: legacy.id, password: 'valid-password' });
    await expect(service.callback(first, browser, legacy.id)).rejects.toMatchObject({ reason: 'conflict', linking: true });
    expect(users.linkScoretechIdentity).not.toHaveBeenCalled();

    const second = await flow({ session: legacy.id, password: 'valid-password' });
    users.findByScoretechIdentity.mockResolvedValueOnce(null);
    users.linkScoretechIdentity.mockRejectedValueOnce({ code: 11000 });
    await expect(service.callback(second, browser, legacy.id)).rejects.toMatchObject({ reason: 'conflict', linking: true });
    expect(await service.authenticate(legacy.id)).toEqual(account);
  });

  it('keeps the legacy session when the verified email belongs to another profile', async () => {
    const legacy = await service.legacyLogin(account.username, 'valid-password');
    const query = await flow({ session: legacy.id, password: 'valid-password' });
    users.findByScoretechIdentity.mockResolvedValueOnce(null);
    users.hasScoretechEmailConflict.mockResolvedValueOnce(true);
    await expect(service.callback(query, browser, legacy.id)).rejects.toMatchObject({ reason: 'conflict', linking: true });
    expect(users.hasScoretechEmailConflict).toHaveBeenCalledWith('person@example.org', account.id);
    expect(users.linkScoretechIdentity).not.toHaveBeenCalled();
    expect(await service.authenticate(legacy.id)).toEqual(account);
  });

  it('rejects an outstanding link if the initiating legacy session was logged out', async () => {
    const legacy = await service.legacyLogin(account.username, 'valid-password');
    const query = await flow({ session: legacy.id, password: 'valid-password' });
    await service.logout(legacy.id);
    await expect(service.callback(query, browser, legacy.id)).rejects.toMatchObject({ reason: 'invalid' });
    expect(users.linkScoretechIdentity).not.toHaveBeenCalled();
  });
  it('disables legacy login and existing legacy sessions when the fallback is turned off', async () => {
    const legacy = await service.legacyLogin(account.username, 'valid-password');
    vi.stubEnv('SCORETECH_LEGACY_PASSWORD_LOGIN', 'false');
    expect(await service.authenticate(legacy.id)).toBeNull();
    await expect(service.legacyLogin(account.username, 'valid-password')).rejects.toMatchObject({ reason: 'invalid' });
  });

});
