import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { generateKeyPairSync } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  jwtVerify,
} from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import container from '../main/config/container';
import { featuresCacheKey } from '../main/utils/contracts/cacheKeys';
import { encryptJWTSecret } from '../main/utils/jwt';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import {
  addApiKeyToOrganization,
  createTestOrganization,
  deleteTestOrganization,
} from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { LeanUser } from '../main/types/models/User';
import { LeanOrganization } from '../main/types/models/Organization';
import ContractMongoose from '../main/repositories/mongoose/models/ContractMongoose';
import ServiceMongoose from '../main/repositories/mongoose/models/ServiceMongoose';
import PricingMongoose from '../main/repositories/mongoose/models/PricingMongoose';
import { PETCLINIC_BASE_VERSION, uploadPetclinicService } from './utils/services/petclinicVersions';

/**
 * Pricing tokens are signed with ES256 and the server publishes the public
 * keys at `/.well-known/jwks.json`, without authentication, so any
 * organization can verify a token without a secret that would let it mint
 * tokens for other organizations.
 */

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

describe('Pricing token JWKS', function () {
  let app: Server;
  let jwksUrl: URL;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let orgKey: string;
  let userId: string;

  const issueToken = async () => {
    const response = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', orgKey);
    expect(response.status).toBe(200);
    return response.body.pricingToken as string;
  };

  beforeAll(async function () {
    app = await getApp();
    const { port } = app.address() as AddressInfo;
    jwksUrl = new URL(`http://127.0.0.1:${port}${baseUrl}/.well-known/jwks.json`);
  });

  beforeEach(async function () {
    owner = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    orgKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: orgKey, scope: 'ALL' });
    const serviceName = (await uploadPetclinicService(app, orgKey)).name.toLowerCase();

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', orgKey)
      .send({
        userContact: { userId, username: 'jwks-user' },
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: {},
      });
    expect(created.status).toBe(201);
  });

  afterEach(async function () {
    await ContractMongoose.deleteMany({ organizationId: organization.id });
    await PricingMongoose.deleteMany({ _organizationId: organization.id });
    await ServiceMongoose.deleteMany({ organizationId: organization.id });
    await deleteTestOrganization(organization.id!);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await new Promise(resolve => setTimeout(resolve, 300));
    await shutdownApp();
  });

  describe('GET /.well-known/jwks.json', function () {
    it('is public, cacheable and only holds ES256 public keys', async function () {
      const response = await request(app).get(`${baseUrl}/.well-known/jwks.json`);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/jwk-set\+json/);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.body.keys.length).toBeGreaterThanOrEqual(1);
      for (const key of response.body.keys) {
        expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
        expect(typeof key.kid).toBe('string');
        for (const member of PRIVATE_MEMBERS) expect(key).not.toHaveProperty(member);
      }
    });

    it('is also served at the root of the API server, with the same keys', async function () {
      const prefixed = await request(app).get(`${baseUrl}/.well-known/jwks.json`);
      const root = await request(app).get('/.well-known/jwks.json');

      expect(root.status).toBe(200);
      expect(root.headers['cache-control']).toBe('public, max-age=300');
      expect(root.body).toEqual(prefixed.body);
    });

    it('ignores credentials (an organization key does not change the answer)', async function () {
      const anonymous = await request(app).get(`${baseUrl}/.well-known/jwks.json`);
      const withKey = await request(app).get(`${baseUrl}/.well-known/jwks.json`).set('x-api-key', orgKey);

      expect(withKey.status).toBe(200);
      expect(withKey.body).toEqual(anonymous.body);
    });

    it('advertises the pricing-token-jwks capability', async function () {
      const response = await request(app).get(`${baseUrl}/.well-known/jwks.json`);

      expect(String(response.headers['x-space-capabilities']).split(',')).toContain('pricing-token-jwks');
    });
  });

  describe('pricing token', function () {
    it('is signed with ES256 and names a published kid', async function () {
      const token = await issueToken();
      const header = decodeProtectedHeader(token);
      const jwks = (await request(app).get(`${baseUrl}/.well-known/jwks.json`)).body;

      expect(header.alg).toBe('ES256');
      expect(typeof header.kid).toBe('string');
      expect(jwks.keys.map((k: any) => k.kid)).toContain(header.kid);
    });

    it('verifies with createRemoteJWKSet + jwtVerify against the live endpoint', async function () {
      const token = await issueToken();

      // What the SDK verifiers check: ES256 with a published kid, `iss`, `exp`,
      // `aud` = the organization they serve, and `organizationId` = `aud`.
      const { payload, protectedHeader } = await jwtVerify(token, createRemoteJWKSet(jwksUrl), {
        algorithms: ['ES256'],
        issuer: process.env.JWT_ISSUER || 'space',
        audience: organization.id!,
        requiredClaims: ['exp', 'iss', 'aud'],
      });

      expect(protectedHeader.alg).toBe('ES256');
      expect(typeof protectedHeader.kid).toBe('string');
      expect(payload.sub).toBe(`urn:space:${organization.id}:${encodeURIComponent(userId)}`);
      expect(payload.userId).toBe(userId);
      expect(payload.organizationId).toBe(organization.id);
      expect(payload.aud).toBe(organization.id);
      expect(payload.organizationId).toBe(payload.aud);
      expect(payload.iss).toBe(process.env.JWT_ISSUER || 'space');
      expect(payload.features).toBeDefined();
      expect(payload.exp).toBeGreaterThan(payload.iat!);
    });

    it('does not verify for another organization (aud) or another issuer (iss)', async function () {
      const token = await issueToken();
      const keys = createRemoteJWKSet(jwksUrl);

      await expect(
        jwtVerify(token, keys, {
          algorithms: ['ES256'],
          issuer: process.env.JWT_ISSUER || 'space',
          audience: '65f1c0ffee0000000000000b',
        })
      ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'aud' });
      await expect(
        jwtVerify(token, keys, { algorithms: ['ES256'], issuer: 'another-space', audience: organization.id! })
      ).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', claim: 'iss' });
    });

    it('does not verify with another key, even one published under the same kid', async function () {
      const token = await issueToken();
      const { kid } = decodeProtectedHeader(token);
      const impostor = { ...(await exportJWK(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)), kid, alg: 'ES256' };

      await expect(
        jwtVerify(token, createLocalJWKSet({ keys: [impostor] }), { algorithms: ['ES256'] })
      ).rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
    });

    it('no longer verifies with the shared JWT_SECRET, and a token minted with it is rejected', async function () {
      const token = await issueToken();
      const secret = encryptJWTSecret(process.env.JWT_SECRET!);

      await expect(jwtVerify(token, secret, { algorithms: ['HS256'] })).rejects.toThrow();

      const minted = await new SignJWT({ organizationId: organization.id, features: {} })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secret);
      await expect(jwtVerify(minted, createRemoteJWKSet(jwksUrl), { algorithms: ['ES256'] })).rejects.toThrow();
    });

    it('does not verify once the payload is changed', async function () {
      const token = await issueToken();
      const [header, , signature] = token.split('.');
      const claims = { ...decodeJwt(token), organizationId: 'another-organization' };
      const tampered = [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');

      await expect(jwtVerify(tampered, createRemoteJWKSet(jwksUrl), { algorithms: ['ES256'] })).rejects.toMatchObject({
        code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
      });
    });

    it('replaces a cached token signed with another key (for example HS256 before the upgrade)', async function () {
      const legacy = await new SignJWT({ organizationId: organization.id, features: {} })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(encryptJWTSecret(process.env.JWT_SECRET!));
      await container
        .resolve('cacheService')
        .set(featuresCacheKey(organization.id!, userId, 'pricingToken'), legacy, 3600, true);

      const token = await issueToken();

      expect(token).not.toBe(legacy);
      expect(decodeProtectedHeader(token).alg).toBe('ES256');
      await jwtVerify(token, createRemoteJWKSet(jwksUrl), { algorithms: ['ES256'] });
      // The new token is cached and served again.
      expect(await issueToken()).toBe(token);
    });
  });
});
