import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, request as httpRequest, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../main/config/container', () => ({ default: mocks }));
import SphereAuthService from '../../main/services/SphereAuthService';
import { fetchWithOptionalProxy } from '../../main/utils/proxy';

const PROXY_VARIABLES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY',
  'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy'];
const browser = 'b'.repeat(64);
let provider: Server, proxy: Server;
let issuer: string, proxyUrl: string;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let nonce: string, challenge: string;
let providerRequests: string[], proxyRequests: string[];
let proxyStatus: number;

function json(res: ServerResponse, data: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  provider = createServer((req, res) => { void (async () => {
    providerRequests.push(req.url!);
    if (req.url === '/.well-known/openid-configuration') return json(res, { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks' });
    if (req.url === '/jwks') return json(res, { keys: [{ ...await exportJWK(keys.publicKey), kid: 'proxy-test', alg: 'RS256', use: 'sig' }] });
    if (req.url === '/redirect') { res.writeHead(302, { Location: issuer + '/jwks' }); res.end(); return; }
    if (req.url === '/token') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      if (req.method !== 'POST' || form.get('client_secret') !== 'server-only-secret' ||
        createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== challenge) {
        res.statusCode = 400; return json(res, { error: 'invalid_grant' });
      }
      const token = await new SignJWT({ nonce, preferred_username: 'remote-name' }).setProtectedHeader({ alg: 'RS256', kid: 'proxy-test' })
        .setIssuer(issuer).setAudience('space').setSubject('stable-subject').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
      return json(res, { id_token: token });
    }
    res.statusCode = 404; res.end();
  })().catch(() => { res.statusCode = 500; res.end(); }); });
  issuer = await listen(provider);
  proxy = createServer((req, res) => {
    proxyRequests.push(req.url!);
    if (proxyStatus !== 200) { res.statusCode = proxyStatus; res.end(); return; }
    const target = new URL(req.url!);
    if (target.origin !== issuer) { res.statusCode = 403; res.end(); return; }
    const upstream = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, reply => {
      res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res);
    });
    upstream.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(upstream);
  });
  proxyUrl = await listen(proxy);
});
afterAll(async () => { await close(proxy); await close(provider); });
beforeEach(() => {
  providerRequests = []; proxyRequests = []; proxyStatus = 200;
  for (const name of PROXY_VARIABLES) vi.stubEnv(name, '');
  vi.stubEnv('SPHERE_OIDC_ISSUER', issuer); vi.stubEnv('SPHERE_OIDC_CLIENT_ID', 'space');
  vi.stubEnv('SPHERE_OIDC_CLIENT_SECRET', 'server-only-secret'); vi.stubEnv('SPHERE_OIDC_REDIRECT_URI', 'http://127.0.0.1/callback');
  vi.stubEnv('SPACE_FRONTEND_URL', 'http://127.0.0.1/');
  const entries = new Map<string, unknown>();
  const cache = {
    get: async (key: string) => entries.get(key),
    set: async (key: string, value: unknown) => { entries.set(key, value); },
    take: async (key: string) => { const value = entries.get(key); entries.delete(key); return value; },
  };
  mocks.resolve.mockImplementation((name: string) => name === 'cacheService' ? cache : {
    findBySphereIdentity: async () => ({ id: 'local-id', username: 'local-name', role: 'USER', apiKey: 'usr_test' }),
  });
});
afterEach(() => vi.unstubAllEnvs());

async function login() {
  const service = new SphereAuthService();
  const started = await service.start('login', browser);
  const url = new URL(started.authorizationUrl);
  nonce = url.searchParams.get('nonce')!; challenge = url.searchParams.get('code_challenge')!;
  await service.callback({ state: url.searchParams.get('state'), code: 'synthetic-code' }, browser);
  expect(await service.pending(browser)).toMatchObject({ kind: 'login' });
  expect(providerRequests).toEqual(['/.well-known/openid-configuration', '/.well-known/openid-configuration', '/token', '/jwks']);
}

describe('OIDC outbound transport', () => {
  it('completes discovery, code exchange and signature validation without a proxy', async () => {
    await login();
    expect(proxyRequests).toEqual([]);
  });
  it.each(['HTTP_PROXY', 'http_proxy'])('routes all OIDC requests, including JWKS, through %s when configured', async variable => {
    vi.stubEnv(variable, proxyUrl);
    await login();
    expect(proxyRequests.map(value => new URL(value).pathname)).toEqual(providerRequests);
  });
  it.each(['NO_PROXY', 'no_proxy'])('bypasses a configured proxy when %s matches the provider', async variable => {
    vi.stubEnv('HTTP_PROXY', proxyUrl); vi.stubEnv(variable, '127.0.0.1');
    proxyStatus = 502;
    await login();
    expect(proxyRequests).toEqual([]);
  });
  it('fails closed when the configured proxy fails instead of retrying directly', async () => {
    vi.stubEnv('HTTP_PROXY', proxyUrl); proxyStatus = 502;
    await expect(new SphereAuthService().start('login', browser)).rejects.toMatchObject({ status: 503 });
    expect(providerRequests).toEqual([]);
    expect(proxyRequests).toHaveLength(1);
  });
  it('preserves redirect restrictions and abort signals through the proxy', async () => {
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    await expect(fetchWithOptionalProxy(issuer + '/redirect', { redirect: 'error' })).rejects.toThrow();
    expect(providerRequests).toEqual(['/redirect']);
    const controller = new AbortController(); controller.abort();
    await expect(fetchWithOptionalProxy(issuer + '/jwks', { signal: controller.signal })).rejects.toThrow();
    expect(providerRequests).toEqual(['/redirect']);
  });
});
