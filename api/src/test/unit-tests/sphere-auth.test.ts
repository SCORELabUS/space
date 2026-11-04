import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../main/config/container', () => ({ default: mocks }));
import SphereAuthService from '../../main/services/SphereAuthService';

const browser = 'b'.repeat(64);
const user = { id: 'local-id', username: 'local-name', apiKey: 'usr_local', role: 'USER' as const };
let entries: Map<string, any>;
let repo: any, userService: any, cache: any, service: SphereAuthService;
let nonce: string;
let tokenOptions: { nonce?: string; issuer?: string; audience?: string; expired?: boolean; subject?: string };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeEach(async () => {
  for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY',
    'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy']) vi.stubEnv(name, '');
  entries = new Map(); tokenOptions = {};
  cache = { get: vi.fn(async (key: string) => entries.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { entries.set(key, value); }),
    del: vi.fn(async (key: string) => { entries.delete(key); }),
    take: vi.fn(async (key: string) => { const value = entries.get(key); entries.delete(key); return value; }),
    setIfAbsent: vi.fn(async (key: string, value: unknown) => { if (entries.has(key)) return false; entries.set(key, value); return true; }) };
  repo = { findBySphereIdentity: vi.fn(async () => null), findByUsername: vi.fn(async () => null), linkSphereIdentity: vi.fn(async () => user) };
  userService = { createFederated: vi.fn(async (username: string) => ({ ...user, username })) };
  mocks.resolve.mockImplementation((name: string) => ({ cacheService: cache, userRepository: repo, userService })[name as 'cacheService']);
  vi.stubEnv('SPHERE_OIDC_ISSUER', 'https://sphere.example'); vi.stubEnv('SPHERE_OIDC_CLIENT_ID', 'space');
  vi.stubEnv('SPHERE_OIDC_CLIENT_SECRET', 'secret'); vi.stubEnv('SPHERE_OIDC_REDIRECT_URI', 'https://space.example/api/v1/auth/sphere/callback');
  vi.stubEnv('SPACE_FRONTEND_URL', 'https://space.example/');
  keys = await generateKeyPair('RS256', { extractable: true });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://sphere.example', authorization_endpoint: 'https://sphere.example/authorize', token_endpoint: 'https://sphere.example/token', jwks_uri: 'https://sphere.example/jwks' });
    if (url.endsWith('/jwks')) return Response.json({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256', use: 'sig' }] });
    const token = await new SignJWT({ nonce: tokenOptions.nonce ?? nonce, preferred_username: 'sphere-name' }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject(tokenOptions.subject ?? 'stable-sphere-id').setIssuer(tokenOptions.issuer ?? 'https://sphere.example')
      .setAudience(tokenOptions.audience ?? 'space').setIssuedAt().setExpirationTime(tokenOptions.expired ? '-1m' : '5m').sign(keys.privateKey);
    return Response.json({ id_token: token });
  }));
  service = new SphereAuthService();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
async function verified(mode = 'login', actor?: typeof user) {
  const started = await service.start(mode, browser, actor);
  const url = new URL(started.authorizationUrl);
  const state = url.searchParams.get('state')!; nonce = url.searchParams.get('nonce')!;
  await service.callback({ state, code: 'code' }, browser);
  return state;
}
describe('SPACE SPHERE identity binding', () => {
  it('requires SPACE origin and an authenticated user to initiate linking', async () => {
    expect(() => service.assertOrigin('https://attacker.example')).toThrow('Start this action from SPACE');
    await expect(service.start('link', browser)).rejects.toMatchObject({ status: 401 });
  });
  it('binds the callback to its browser and consumes state once', async () => {
    const started = await service.start('login', browser);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    nonce = new URL(started.authorizationUrl).searchParams.get('nonce')!;
    await expect(service.callback({ state, code: 'code' }, 'c'.repeat(64))).rejects.toMatchObject({ status: 400 });
    await service.callback({ state, code: 'code' }, browser);
    await expect(service.callback({ state, code: 'code' }, browser)).rejects.toMatchObject({ status: 400 });
  });
  it.each([{ nonce: 'wrong' }, { issuer: 'https://attacker.example' }, { audience: 'other-client' }, { expired: true }])('rejects invalid identity claims %j', async options => {
    tokenOptions = options;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await verified();
    expect((await service.pending(browser)).kind).toBe('error');
    await expect(service.complete(browser, 'new-user')).rejects.toMatchObject({ status: 400 });
    expect(userService.createFederated).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('offers a suggested username, reports collision and allows a different choice without linking', async () => {
    await verified();
    expect(await service.pending(browser)).toMatchObject({ kind: 'signup', suggestedUsername: 'sphere-name' });
    repo.findByUsername.mockResolvedValueOnce(user);
    await expect(service.complete(browser, 'local-name')).rejects.toMatchObject({ status: 409 });
    expect(repo.linkSphereIdentity).not.toHaveBeenCalled(); expect(userService.createFederated).not.toHaveBeenCalled();
    const session = await service.complete(browser, 'chosen-name');
    expect(session).toEqual({ username: 'chosen-name', apiKey: user.apiKey, role: user.role });
    expect(userService.createFederated).toHaveBeenCalledWith('chosen-name', 'https://sphere.example', 'stable-sphere-id');
    await expect(service.complete(browser, 'another')).rejects.toMatchObject({ status: 400 });
  });
  it('uses stable identity for returning users and preserves their local username', async () => {
    repo.findBySphereIdentity.mockResolvedValue(user);
    await verified();
    expect((await service.pending(browser)).kind).toBe('login');
    expect(await service.complete(browser, 'sphere-renamed')).toEqual({ username: user.username, role: user.role, apiKey: user.apiKey });
    expect(userService.createFederated).not.toHaveBeenCalled();
  });
  it('requires the original SPACE user at confirmation and links without renaming', async () => {
    await verified('link', user);
    await expect(service.complete(browser, undefined, { ...user, id: 'another' })).rejects.toMatchObject({ status: 401 });
    expect(await service.complete(browser, undefined, user)).toEqual({ linked: true });
    expect(repo.linkSphereIdentity).toHaveBeenCalledWith(user.id, 'https://sphere.example', 'stable-sphere-id');
    expect(userService.createFederated).not.toHaveBeenCalled();
  });
  it('refuses an identity already linked to another account', async () => {
    repo.findBySphereIdentity.mockResolvedValue({ ...user, id: 'other-owner' });
    await verified('link', user);
    await expect(service.complete(browser, undefined, user)).rejects.toMatchObject({ status: 409 });
    expect(repo.linkSphereIdentity).not.toHaveBeenCalled();
  });
  it('reports unique-index races as a conflict and permits retry', async () => {
    await verified();
    userService.createFederated.mockRejectedValueOnce({ code: 11000 });
    await expect(service.complete(browser, 'raced-name')).rejects.toMatchObject({ status: 409 });
    expect(await service.complete(browser, 'free-name')).toMatchObject({ username: 'free-name' });
  });
});
