import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getApp, shutdownApp } from './utils/testApp';
import User from '../main/repositories/mongoose/models/UserMongoose';
import Organization from '../main/repositories/mongoose/models/OrganizationMongoose';
import container from '../main/config/container';

if (process.env.DATABASE_NAME !== 'space_identity_scratch' || !process.env.MONGO_URI?.startsWith('mongodb://127.0.0.1:27018/space_identity_scratch') || process.env.REDIS_URL !== 'redis://127.0.0.1:6378') {
  throw new Error('Use space_identity_scratch on Mongo 27018 and Redis 6378');
}
describe('SPACE federated account persistence and HTTP boundaries', () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  const usernames: string[] = [];
  const cacheKeys: string[] = [];
  const origin = 'http://127.0.0.1:5184';
  const base = '/api/v1/auth/sphere';
  const freshName = () => { const name = 'identity_' + randomBytes(6).toString('hex'); usernames.push(name); return name; };
  beforeAll(async () => {
    vi.stubEnv('SPHERE_OIDC_ISSUER', 'http://127.0.0.1:5183'); vi.stubEnv('SPHERE_OIDC_CLIENT_ID', 'space'); vi.stubEnv('SPHERE_OIDC_CLIENT_SECRET', 'secret');
    vi.stubEnv('SPHERE_OIDC_REDIRECT_URI', origin + base + '/callback'); vi.stubEnv('SPACE_FRONTEND_URL', origin + '/');
    app = await getApp(); await User.createIndexes();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Organization.deleteMany({ owner: { $in: usernames } }); await User.deleteMany({ username: { $in: usernames } });
    for (const key of cacheKeys) await container.resolve('cacheService').del(key);
    await shutdownApp(); vi.unstubAllEnvs();
  });
  async function pending(kind = 'signup', subject = randomBytes(10).toString('hex'), userId?: string) {
    const browser = randomBytes(32).toString('hex');
    const key = 'sso:sphere:result:' + createHash('sha256').update(browser).digest('hex'); cacheKeys.push(key);
    await container.resolve('cacheService').set(key, { kind, identity: { issuer: 'http://127.0.0.1:5183', subject, suggestedUsername: 'suggested' }, userId }, 600);
    return { browser, subject };
  }
  const complete = (browser: string, username?: string, apiKey?: string, from = origin) => {
    const req = request(app).post(base + '/complete').set('Origin', from).set('Cookie', 'space_sphere_login=' + browser);
    if (apiKey) req.set('x-api-key', apiKey);
    return req.send({ username });
  };
  async function local() {
    const username = freshName();
    const response = await request(app).post('/api/v1/users').send({ username, password: 'password123' }).expect(201);
    return response.body;
  }
  it('requires browser binding and the exact frontend Origin', async () => {
    const state = await pending();
    await complete('bad', freshName()).expect(400);
    await complete(state.browser, freshName(), undefined, 'https://attacker.example').expect(403);
    await complete(state.browser, freshName()).expect(200);
    await complete(state.browser, freshName()).expect(400);
  });
  it('creates a passwordless USER, generates its API key and personal organization, and preserves local login', async () => {
    const state = await pending(); const username = freshName();
    const created = await complete(state.browser, username).expect(200);
    expect(created.body.role).toBe('USER'); expect(created.body.apiKey).toMatch(/^usr_/);
    expect(created.body.password).toBeUndefined(); expect(created.body.sphereIdentity).toBeUndefined();
    const account = await User.findOne({ username }).select('+sphereIdentity');
    expect(account?.password).toBeUndefined(); expect(account?.sphereIdentity?.subject).toBe(state.subject);
    expect(await Organization.countDocuments({ owner: username, default: true })).toBe(1);
    await request(app).get('/api/v1/users/me').set('x-api-key', created.body.apiKey).expect(200);
    await request(app).post('/api/v1/users/authenticate').send({ username, password: 'anything' }).expect(401);
    const existing = await local();
    const login = await request(app).post('/api/v1/users/authenticate').send({ username: existing.username, password: 'password123' }).expect(200);
    expect(login.body.apiKey).toBe(existing.apiKey);
  });
  it('does not claim an existing username; a collision leaves the choice retryable', async () => {
    const existing = await local(); const state = await pending();
    await complete(state.browser, existing.username).expect(409);
    const original = await User.findOne({ username: existing.username }).select('+sphereIdentity');
    expect(original?.sphereIdentity).toBeUndefined();
    await complete(state.browser, freshName()).expect(200);
  });
  it('uses the unique partial identity index to resolve simultaneous first access', async () => {
    const subject = randomBytes(10).toString('hex');
    const a = await pending('signup', subject), b = await pending('signup', subject);
    const responses = await Promise.all([complete(a.browser, freshName()), complete(b.browser, freshName())]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(await User.countDocuments({ 'sphereIdentity.subject': subject })).toBe(1);
  });
  it('rolls back an incomplete account if its personal organization cannot be created', async () => {
    const state = await pending(); const username = freshName();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(container.resolve('organizationService'), 'create').mockRejectedValueOnce(new Error('simulated database failure'));
    await complete(state.browser, username).expect(503);
    expect(await User.countDocuments({ username })).toBe(0);
    await complete(state.browser, username).expect(200);
  });
  it('requires the originating user for explicit linking and keeps the local password', async () => {
    const owner = await local(), other = await local();
    const user = await User.findOne({ username: owner.username });
    const state = await pending('link', undefined, user!.id);
    await complete(state.browser, undefined, other.apiKey).expect(401);
    await complete(state.browser, undefined).expect(401);
    await complete(state.browser, undefined, owner.apiKey).expect(200, { linked: true });
    const connection = await request(app).get(base + '/connection').set('x-api-key', owner.apiKey).expect(200);
    expect(connection.body).toEqual({ linked: true, hasPassword: true });
    await request(app).post('/api/v1/users/authenticate').send({ username: owner.username, password: 'password123' }).expect(200);
    const thief = await User.findOne({ username: other.username });
    const stolen = await pending('link', state.subject, thief!.id);
    await complete(stolen.browser, undefined, other.apiKey).expect(409);
  });
  it('does not accept identity injection through ordinary user creation or update', async () => {
    const username = freshName();
    const created = await request(app).post('/api/v1/users').send({ username, password: 'password123', sphereIdentity: { issuer: 'http://127.0.0.1:5183', subject: 'forged' } }).expect(201);
    await request(app).put('/api/v1/users/' + username).set('x-api-key', created.body.apiKey).send({ sphereIdentity: { issuer: 'http://127.0.0.1:5183', subject: 'forged' } }).expect(200);
    expect((await User.findOne({ username }).select('+sphereIdentity'))?.sphereIdentity).toBeUndefined();
    await request(app).get('/api/v1/cache').set('x-api-key', created.body.apiKey).query({ key: 'sso:sphere:state:forged' }).expect(403);
  });
});
