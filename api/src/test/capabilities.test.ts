import request from 'supertest';
import { Server } from 'http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { SPACE_CAPABILITIES } from '../main/utils/capabilities';

/**
 * Every response advertises the features of the pricing-renderer API design
 * that this server implements (`X-Space-Capabilities`), so that clients can
 * refuse to rely on a guarantee the server does not give.
 */

// Each feature adds its token here and in utils/capabilities.ts.
const EXPECTED = [
  'contract-org-scope',
  'contract-version',
  'keep-billing-period',
  'reject-private',
];

const tokens = (response: request.Response) =>
  String(response.headers['x-space-capabilities'] ?? '').split(',').filter(Boolean);

describe('X-Space-Capabilities', function () {
  let app: Server;

  beforeAll(async function () {
    app = await getApp();
  });

  afterAll(async function () {
    // The analytics middleware records requests asynchronously; let it finish before Redis closes.
    await new Promise(resolve => setTimeout(resolve, 300));
    await shutdownApp();
  });

  it('lists exactly the implemented features, without duplicates', function () {
    expect([...SPACE_CAPABILITIES].sort()).toEqual([...EXPECTED].sort());
    expect(new Set(SPACE_CAPABILITIES).size).toBe(SPACE_CAPABILITIES.length);
  });

  it('is sent on successful public responses', async function () {
    const response = await request(app).get(`${baseUrl}/healthcheck`);

    expect(response.status).toBe(200);
    expect(tokens(response)).toEqual([...SPACE_CAPABILITIES]);
  });

  it('is sent on authentication errors and unknown routes', async function () {
    const unauthorized = await request(app).get(`${baseUrl}/contracts`);
    const unknown = await request(app).get(`${baseUrl}/does-not-exist`).set('x-api-key', 'org_unknown');

    expect(unauthorized.status).toBe(401);
    expect(tokens(unauthorized)).toEqual([...SPACE_CAPABILITIES]);
    expect(tokens(unknown)).toEqual([...SPACE_CAPABILITIES]);
  });

  it('is readable by browser clients (CORS exposed header, preflight included)', async function () {
    const preflight = await request(app)
      .options(`${baseUrl}/contracts`)
      .set('Origin', 'http://localhost:5403')
      .set('Access-Control-Request-Method', 'PUT');
    const actual = await request(app).get(`${baseUrl}/healthcheck`).set('Origin', 'http://localhost:5403');

    expect(tokens(preflight)).toEqual([...SPACE_CAPABILITIES]);
    expect(String(actual.headers['access-control-expose-headers']).toLowerCase()).toContain('x-space-capabilities');
  });
});
