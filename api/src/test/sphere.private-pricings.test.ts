import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import nock from 'nock';
import mongoose from 'mongoose';
import { Server } from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import container from '../main/config/container';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import Pricing from '../main/repositories/mongoose/models/PricingMongoose';
import { functionalHash } from '../main/services/sphere/SphereClient';

/**
 * Private SPHERE pricings: a linked service may hold a SPHERE API key
 * (write-only, encrypted at rest) that SPACE sends as `x-api-key`, so that
 * SPHERE (H11) also lists and serves the private versions the key may read.
 * SPHERE is mocked with nock.
 */

const origin = 'https://sphere.score.us.es';
const pricingId = '777777777777777777777777';
const publicId = '888888888888888888888888';
const privateId = '999999999999999999999999';
const permanentUrl = `${origin}/p/${pricingId}`;
const SPHERE_KEY = 'sk-sphere-private-0123456789abcdef';

const pricingYaml = (version: string, createdAt: string) =>
  `saasName: Secret\nversion: '${version}'\ncreatedAt: '${createdAt}'\nsyntaxVersion: '3.1'\ncurrency: USD\n` +
  `features:\n  enabled:\n    valueType: BOOLEAN\n    defaultValue: true\n    type: DOMAIN\n` +
  `plans:\n  basic:\n    price: 0\n    unit: /month\n    features:\n      enabled: true\n`;
const publicText = pricingYaml('1.0', '2024-01-01');
const privateText = pricingYaml('2.0', '2025-01-01');
const publicVersion = { versionId: publicId, version: '1.0', createdAt: '2024-01-01T00:00:00.000Z', contentHash: functionalHash(publicText) };
const privateVersion = { versionId: privateId, version: '2.0', createdAt: '2025-01-01T00:00:00.000Z', contentHash: functionalHash(privateText), private: true };

const manifest = (withPrivate: boolean) => {
  const versions = withPrivate ? [publicVersion, privateVersion] : [publicVersion];
  return { pricingId, name: 'Secret', permanentUrl, latestVersionId: versions[versions.length - 1].versionId, versions };
};

/** SPHERE as H11 specifies it: the key unlocks private versions; anonymous callers only see public ones. */
// `withYaml`: also serve the YAML of the newest visible version (imports); configuration only reads the manifest.
const sphereWithKey = (withYaml = false) => {
  const scope = nock(origin, { reqheaders: { 'x-api-key': SPHERE_KEY } });
  scope.get(`/api/v1/public/pricings/${pricingId}`).reply(200, manifest(true));
  if (withYaml) scope.get(`/api/v1/public/pricings/${pricingId}/versions/${privateId}/yaml`).reply(200, privateText);
  return scope;
};
const sphereAnonymous = (withYaml = false) => {
  const scope = nock(origin, { badheaders: ['x-api-key'] });
  scope.get(`/api/v1/public/pricings/${pricingId}`).reply(200, manifest(false));
  if (withYaml) scope.get(`/api/v1/public/pricings/${pricingId}/versions/${publicId}/yaml`).reply(200, publicText);
  return scope;
};

describe('Private SPHERE pricings (sphereApiKey)', () => {
  let app: Server;
  let owner: any;
  let organization: any;
  let allKey: string;
  let serviceName: string;
  const previousEncryptionKey = process.env.SPHERE_KEY_ENCRYPTION_KEY;

  const linkService = async () => {
    const _id = new mongoose.Types.ObjectId();
    await Service.collection.insertOne({
      _id, name: serviceName, organizationId: organization.id, source: 'sphere', disabled: false,
      activePricings: { '1_0': { id: new mongoose.Types.ObjectId() } }, archivedPricings: {},
      sphere: { permanentUrl, pricingId, name: 'Secret', policy: 'new_last', pollIntervalMinutes: 5, revision: 1,
        target: publicVersion, status: 'ready' },
    });
    return String(_id);
  };
  const configure = (body: any) =>
    request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
      .send({ permanentUrl, policy: 'new_last', ...body });
  const stored = async () => (await Service.collection.findOne({ name: serviceName, organizationId: organization.id })) as any;

  beforeAll(async () => {
    app = await getApp();
    process.env.SPHERE_PUBLIC_URL = origin;
    process.env.SPHERE_API_URL = `${origin}/api/v1`;
  });

  beforeEach(async () => {
    nock.cleanAll();
    process.env.SPHERE_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    serviceName = `secret_${Date.now()}`;
    owner = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    allKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id, { key: allKey, scope: 'ALL' });
  });

  afterEach(async () => {
    for (const copy of await Pricing.find({ _organizationId: organization.id }).lean() as any[]) {
      if (copy.yamlPath?.startsWith('/static/pricings/sphere/')) {
        fs.rmSync(path.dirname(path.resolve('public', `.${copy.yamlPath}`)), { recursive: true, force: true });
      }
    }
    await Pricing.deleteMany({ _organizationId: organization.id });
    await Service.deleteMany({ organizationId: organization.id });
    await deleteTestOrganization(organization.id);
    await deleteTestUser(owner.username);
    nock.cleanAll();
  });

  afterAll(async () => {
    if (previousEncryptionKey === undefined) delete process.env.SPHERE_KEY_ENCRYPTION_KEY;
    else process.env.SPHERE_KEY_ENCRYPTION_KEY = previousEncryptionKey;
    await shutdownApp();
  });

  describe('PUT /services/:serviceName/synchronization', () => {
    it('stores the key encrypted and never returns it', async () => {
      await linkService();
      const sphere = sphereWithKey();

      const response = await configure({ sphereApiKey: SPHERE_KEY });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(sphere.isDone()).toBe(true);
      expect(response.body.configuration.hasApiKey).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain(SPHERE_KEY);
      expect(response.body.configuration).not.toHaveProperty('encryptedApiKey');
      expect(response.body.configuration).not.toHaveProperty('sphereApiKey');

      const document = await stored();
      expect(document.sphere.encryptedApiKey).toMatchObject({ v: 1 });
      expect(JSON.stringify(document)).not.toContain(SPHERE_KEY);
    });

    it('accepts a policy that picks a private version when the key can read it', async () => {
      await linkService();
      sphereWithKey();

      const response = await configure({ policy: 'new_pick', selectedVersionId: privateId, sphereApiKey: SPHERE_KEY });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.configuration.selectedVersionId).toBe(privateId);
    });

    it('keeps the stored key when the field is omitted and removes it with null', async () => {
      await linkService();
      sphereWithKey();
      await configure({ sphereApiKey: SPHERE_KEY });

      // Omitted: the stored key is used to validate the policy against SPHERE.
      const keeps = sphereWithKey();
      const kept = await configure({ pollIntervalMinutes: 15 });
      expect(kept.status).toBe(200);
      expect(keeps.isDone()).toBe(true);
      expect(kept.body.configuration.hasApiKey).toBe(true);

      // null: removed, and SPHERE is called anonymously.
      const anonymous = sphereAnonymous();
      const removed = await configure({ sphereApiKey: null });
      expect(removed.status, JSON.stringify(removed.body)).toBe(200);
      expect(anonymous.isDone()).toBe(true);
      expect(removed.body.configuration.hasApiKey).toBe(false);
      expect((await stored()).sphere).not.toHaveProperty('encryptedApiKey');
    });

    it('is rejected with 400 when SPHERE_KEY_ENCRYPTION_KEY is not set, storing nothing', async () => {
      await linkService();
      delete process.env.SPHERE_KEY_ENCRYPTION_KEY;

      const response = await configure({ sphereApiKey: SPHERE_KEY });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('SPHERE_KEY_ENCRYPTION_KEY');
      expect(response.body.error).not.toContain(SPHERE_KEY);
      const document = await stored();
      expect(document.sphere).not.toHaveProperty('encryptedApiKey');
      expect(document.sphere.revision).toBe(1);
    });

    it('is rejected with 400 when SPHERE refuses the key, storing nothing', async () => {
      await linkService();
      nock(origin).get(`/api/v1/public/pricings/${pricingId}`).reply(401, { error: 'invalid key' });

      const response = await configure({ sphereApiKey: SPHERE_KEY });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('SPHERE rejected the API key');
      expect((await stored()).sphere).not.toHaveProperty('encryptedApiKey');
    });

    it('rejects a malformed key', async () => {
      await linkService();

      for (const sphereApiKey of ['', 'has spaces', 42]) {
        const response = await configure({ sphereApiKey });
        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Invalid sphereApiKey');
      }
    });
  });

  describe('reading the service', () => {
    it('shows sphere.hasApiKey on GET of the service, the list and the synchronization state', async () => {
      await linkService();
      sphereWithKey();
      await configure({ sphereApiKey: SPHERE_KEY });

      const one = await request(app).get(`${baseUrl}/services/${serviceName}`).set('x-api-key', allKey);
      const list = await request(app).get(`${baseUrl}/services`).set('x-api-key', allKey);
      const state = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey);

      expect(one.status).toBe(200);
      expect(one.body.sphere.hasApiKey).toBe(true);
      expect(one.body.sphere).not.toHaveProperty('encryptedApiKey');
      expect(list.body.find((s: any) => s.name === serviceName).sphere.hasApiKey).toBe(true);
      expect(state.body.configuration.hasApiKey).toBe(true);
      for (const response of [one, list, state]) {
        expect(JSON.stringify(response.body)).not.toContain(SPHERE_KEY);
        expect(JSON.stringify(response.body)).not.toContain('encryptedApiKey');
      }
    });

    it('shows hasApiKey: false for a linked service without a key', async () => {
      await linkService();

      const one = await request(app).get(`${baseUrl}/services/${serviceName}`).set('x-api-key', allKey);

      expect(one.status).toBe(200);
      expect(one.body.sphere.hasApiKey).toBe(false);
    });
  });

  describe('synchronization', () => {
    it('sends the key to SPHERE and imports the private version', async () => {
      const id = await linkService();
      sphereWithKey();
      await configure({ sphereApiKey: SPHERE_KEY });
      const sphere = sphereWithKey(true);

      await container.resolve('sphereSyncService').synchronize(id);

      expect(sphere.isDone()).toBe(true);
      const document = await stored();
      expect(document.sphere.status, document.sphere.error).toBe('ready');
      expect(document.sphere.target.versionId).toBe(privateId);
      const imported: any = await Pricing.findOne({ 'sphere.serviceId': id, 'sphere.versionId': privateId }).lean();
      expect(imported?.sphere.private).toBe(true);
    });

    it('stays on public versions without a key', async () => {
      const id = await linkService();
      const sphere = sphereAnonymous(true);

      await container.resolve('sphereSyncService').synchronize(id);

      expect(sphere.isDone()).toBe(true);
      expect((await stored()).sphere.target.versionId).toBe(publicId);
    });

    it('marks the service degraded, without the key in the error, when the key cannot be decrypted', async () => {
      const id = await linkService();
      sphereWithKey();
      await configure({ sphereApiKey: SPHERE_KEY });
      process.env.SPHERE_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');

      await container.resolve('sphereSyncService').synchronize(id);

      const document = await stored();
      expect(document.sphere.status).toBe('degraded');
      expect(document.sphere.error).toContain('cannot be decrypted');
      expect(document.sphere.error).not.toContain(SPHERE_KEY);
    });
  });

  describe('POST /services/sphere/preview and POST /services (source: sphere)', () => {
    it('previews private versions with a key without storing it', async () => {
      const sphere = sphereWithKey(true);

      const response = await request(app).post(`${baseUrl}/services/sphere/preview`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last', sphereApiKey: SPHERE_KEY });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(sphere.isDone()).toBe(true);
      expect(response.body.versions.find((v: any) => v.versionId === privateId).private).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain(SPHERE_KEY);
    });

    it('creates a linked service on a private version and stores the key encrypted', async () => {
      // Preview (manifest + YAML) and import (YAML) inside create.
      const scope = nock(origin, { reqheaders: { 'x-api-key': SPHERE_KEY } });
      scope.get(`/api/v1/public/pricings/${pricingId}`).reply(200, manifest(true));
      scope.get(`/api/v1/public/pricings/${pricingId}/versions/${privateId}/yaml`).times(2).reply(200, privateText);

      const response = await request(app).post(`${baseUrl}/services`).set('x-api-key', allKey)
        .send({ source: 'sphere', permanentUrl, policy: 'new_last', sphereApiKey: SPHERE_KEY });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(scope.isDone()).toBe(true);
      expect(response.body.sphere.hasApiKey).toBe(true);
      expect(response.body.sphere.target.versionId).toBe(privateId);
      expect(JSON.stringify(response.body)).not.toContain(SPHERE_KEY);
      expect(JSON.stringify(response.body)).not.toContain('encryptedApiKey');
      serviceName = 'secret';
      expect((await stored()).sphere.encryptedApiKey).toMatchObject({ v: 1 });
    });

    it('refuses to create with a key when SPHERE_KEY_ENCRYPTION_KEY is not set', async () => {
      delete process.env.SPHERE_KEY_ENCRYPTION_KEY;
      sphereWithKey();

      const response = await request(app).post(`${baseUrl}/services`).set('x-api-key', allKey)
        .send({ source: 'sphere', permanentUrl, policy: 'new_last', sphereApiKey: SPHERE_KEY });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('SPHERE_KEY_ENCRYPTION_KEY');
      expect(await Service.countDocuments({ organizationId: organization.id })).toBe(0);
      expect(await Pricing.countDocuments({ _organizationId: organization.id })).toBe(0);
    });
  });
});
