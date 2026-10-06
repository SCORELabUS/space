import request from 'supertest';
import nock from 'nock';
import mongoose from 'mongoose';
import { Server } from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, addMemberToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import { functionalHash } from '../main/services/sphere/SphereClient';

const origin = 'https://sphere.score.us.es';
const pricingId = '111111111111111111111111';
const versionOne = '222222222222222222222222';
const versionTwo = '333333333333333333333333';
const permanentUrl = `${origin}/p/${pricingId}`;

const yaml = `saasName: Demo\nversion: '1.0'\ncreatedAt: '2024-01-01'\nsyntaxVersion: '3.1'\ncurrency: USD\nfeatures:\n  enabled:\n    valueType: BOOLEAN\n    defaultValue: true\n    type: DOMAIN\nplans:\n  basic:\n    price: 0\n    unit: /month\n    features:\n      enabled: true\n`;
const version = (versionId: string, name: string, createdAt: string) => ({ versionId, version: name, createdAt, contentHash: functionalHash(yaml) });
const manifest = (versions = [version(versionOne, '1.0', '2024-01-01T00:00:00.000Z')]) => ({
  pricingId, name: 'Demo', permanentUrl, latestVersionId: versions[versions.length - 1].versionId, versions,
});
const mockManifest = (body: any = manifest(), times = 1) =>
  nock(origin).get(`/api/v1/public/pricings/${pricingId}`).times(times).reply(200, body);

describe('SPHERE synchronization API routes', () => {
  let app: Server;
  let adminUser: any;
  let ownerUser: any;
  let outsiderUser: any;
  let evaluatorUser: any;
  let organization: any;
  let otherOrganization: any;
  let allKey: string;
  let evaluationKey: string;
  let otherOrgKey: string;
  let serviceName: string;

  const linkedSphereState = (overrides: any = {}) => ({
    permanentUrl, pricingId, name: 'Demo', policy: 'new_last', pollIntervalMinutes: 5, revision: 1,
    target: version(versionOne, '1.0', '2024-01-01T00:00:00.000Z'), status: 'ready', ...overrides,
  });

  const createLinkedService = async (overrides: any = {}, org = organization) => {
    const name = overrides.name ?? serviceName;
    await Service.collection.insertOne({
      name, organizationId: org.id, source: 'sphere', disabled: false,
      activePricings: { '1_0': { id: new mongoose.Types.ObjectId() } }, archivedPricings: {},
      sphere: linkedSphereState(overrides.sphere),
      ...(overrides.service ?? {}),
    });
  };

  beforeAll(async () => {
    app = await getApp();
    // Set after the app boots: loading it applies the .env values.
    process.env.SPHERE_PUBLIC_URL = origin;
    process.env.SPHERE_API_URL = `${origin}/api/v1`;
  });

  beforeEach(async () => {
    nock.cleanAll();
    serviceName = `sphere_route_${Date.now()}`;
    adminUser = await createTestUser('ADMIN');
    ownerUser = await createTestUser('USER');
    outsiderUser = await createTestUser('USER');
    evaluatorUser = await createTestUser('USER');
    organization = await createTestOrganization(ownerUser.username);
    otherOrganization = await createTestOrganization(ownerUser.username);
    await addMemberToOrganization(organization.id, { username: evaluatorUser.username, role: 'EVALUATOR' });
    allKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    otherOrgKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id, { key: allKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id, { key: evaluationKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id, { key: otherOrgKey, scope: 'ALL' });
  });

  afterEach(async () => {
    await Service.deleteMany({ organizationId: { $in: [organization.id, otherOrganization.id] } });
    await deleteTestOrganization(organization.id);
    await deleteTestOrganization(otherOrganization.id);
    for (const user of [adminUser, ownerUser, outsiderUser, evaluatorUser]) await deleteTestUser(user.username);
    nock.cleanAll();
  });

  afterAll(async () => {
    nock.cleanAll();
    await shutdownApp();
  });

  describe('POST /services/sphere/preview', () => {
    it('returns 200 with the manifest of a public SPHERE pricing', async () => {
      mockManifest();
      nock(origin).get(`/api/v1/public/pricings/${pricingId}/versions/${versionOne}/yaml`).reply(200, yaml);

      const response = await request(app).post(`${baseUrl}/services/sphere/preview`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(200);
      expect(response.body.pricingId).toBe(pricingId);
      expect(response.body.name).toBe('Demo');
      expect(response.body.versions).toHaveLength(1);
    });

    it('returns 400 when the link does not belong to the configured SPHERE origin', async () => {
      const response = await request(app).post(`${baseUrl}/services/sphere/preview`).set('x-api-key', allKey)
        .send({ permanentUrl: `https://evil.example.com/p/${pricingId}`, policy: 'new_last' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid SPHERE pricing permanent link');
    });

    it('returns 400 when the link is not a valid permanent link', async () => {
      const response = await request(app).post(`${baseUrl}/services/sphere/preview`).set('x-api-key', allKey)
        .send({ permanentUrl: `${origin}/p/not-an-id`, policy: 'new_last' });

      expect(response.status).toBe(400);
    });

    it('returns 400 when SPHERE answers with an error', async () => {
      nock(origin).get(`/api/v1/public/pricings/${pricingId}`).reply(500);

      const response = await request(app).post(`${baseUrl}/services/sphere/preview`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('SPHERE unavailable');
    });

    it('returns 403 for an organization API key without management scope', async () => {
      const response = await request(app).post(`${baseUrl}/services/sphere/preview`).set('x-api-key', evaluationKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(403);
    });

    it('returns 401 without an API key', async () => {
      const response = await request(app).post(`${baseUrl}/services/sphere/preview`).send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(401);
    });

    it('is available to a regular user through the organization-scoped route', async () => {
      mockManifest();
      nock(origin).get(`/api/v1/public/pricings/${pricingId}/versions/${versionOne}/yaml`).reply(200, yaml);

      const response = await request(app)
        .post(`${baseUrl}/organizations/${organization.id}/services/sphere/preview`)
        .set('x-api-key', ownerUser.apiKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(200);
      expect(response.body.pricingId).toBe(pricingId);
    });
  });

  describe('GET /services/:serviceName/synchronization', () => {
    it('returns the synchronization state of a linked service', async () => {
      await createLinkedService();

      const response = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey);

      expect(response.status).toBe(200);
      expect(response.body.source).toBe('sphere');
      expect(response.body.configuration.pricingId).toBe(pricingId);
      expect(response.body.configuration.policy).toBe('new_last');
      expect(response.body.retainedVersions).toEqual([]);
    });

    it('reports a manually created service as manual with no configuration', async () => {
      await createLinkedService({ service: { source: 'manual' }, sphere: undefined });
      await Service.collection.updateOne({ name: serviceName, organizationId: organization.id }, { $unset: { sphere: '' } });

      const response = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey);

      expect(response.status).toBe(200);
      expect(response.body.source).toBe('manual');
      expect(response.body.configuration).toBeNull();
    });

    it('is readable with an evaluation-scoped organization key', async () => {
      await createLinkedService();

      const response = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', evaluationKey);

      expect(response.status).toBe(200);
    });

    it('returns 404 when the service does not exist', async () => {
      const response = await request(app).get(`${baseUrl}/services/missing_service/synchronization`).set('x-api-key', allKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('does not leak services from another organization', async () => {
      await createLinkedService({}, otherOrganization);

      const response = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey);

      expect(response.status).toBe(404);
    });

    it('returns 401 without an API key', async () => {
      await createLinkedService();

      const response = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`);

      expect(response.status).toBe(401);
    });

    describe('organization-scoped route', () => {
      it('returns 200 for a member of the organization', async () => {
        await createLinkedService();

        const response = await request(app)
          .get(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization`)
          .set('x-api-key', evaluatorUser.apiKey);

        expect(response.status).toBe(200);
        expect(response.body.source).toBe('sphere');
      });

      it('returns 403 for a user who is not a member of the organization', async () => {
        await createLinkedService();

        const response = await request(app)
          .get(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization`)
          .set('x-api-key', outsiderUser.apiKey);

        expect(response.status).toBe(403);
      });

      it('returns 200 for a SPACE admin even if not a member', async () => {
        await createLinkedService();

        const response = await request(app)
          .get(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization`)
          .set('x-api-key', adminUser.apiKey);

        expect(response.status).toBe(200);
      });
    });
  });

  describe('PUT /services/:serviceName/synchronization', () => {
    it('updates the policy and polling interval and queues a new check', async () => {
      await createLinkedService();
      mockManifest();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'all_pick', selectedVersionId: versionOne, pollIntervalMinutes: 15 });

      expect(response.status).toBe(200);
      expect(response.body.configuration.policy).toBe('all_pick');
      expect(response.body.configuration.selectedVersionId).toBe(versionOne);
      expect(response.body.configuration.pollIntervalMinutes).toBe(15);
      expect(response.body.configuration.status).toBe('queued');
      expect(response.body.configuration.revision).toBe(2);
    });

    it('drops the selected version when switching to a *_last policy', async () => {
      await createLinkedService({ sphere: { policy: 'new_pick', selectedVersionId: versionOne } });
      mockManifest();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'all_last' });

      expect(response.status).toBe(200);
      expect(response.body.configuration.policy).toBe('all_last');
      expect(response.body.configuration.selectedVersionId ?? null).toBeNull();
    });

    it('returns 400 for an unknown policy', async () => {
      await createLinkedService();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'whenever' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid synchronization policy');
    });

    it('returns 400 for an unsupported polling interval', async () => {
      await createLinkedService();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last', pollIntervalMinutes: 3 });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid polling interval');
    });

    it('returns 400 when a *_pick policy has no valid selected version', async () => {
      await createLinkedService();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_pick', selectedVersionId: 'nope' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid selected version');
    });

    it('returns 400 when the selected version is no longer public in SPHERE', async () => {
      await createLinkedService();
      mockManifest();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_pick', selectedVersionId: versionTwo });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('no longer public');
    });

    it('returns 400 when trying to change the linked pricing identity', async () => {
      await createLinkedService();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl: `${origin}/p/999999999999999999999999`, policy: 'new_last' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Changing pricing identity is not supported');
    });

    it('returns 409 while a synchronization is being applied', async () => {
      await createLinkedService({ sphere: { status: 'applying' } });

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(409);
      expect(response.body.error).toContain('applying');
    });

    it('returns 404 for a service that is not linked to SPHERE', async () => {
      await createLinkedService({ service: { source: 'manual' } });

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(404);
    });

    it('returns 404 for a disabled linked service', async () => {
      await createLinkedService({ service: { disabled: true } });

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(404);
    });

    it('returns 403 for an evaluation-scoped organization key', async () => {
      await createLinkedService();

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', evaluationKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(403);
    });

    it('cannot modify a service of another organization', async () => {
      await createLinkedService({}, otherOrganization);

      const response = await request(app).put(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey)
        .send({ permanentUrl, policy: 'new_last' });

      expect(response.status).toBe(404);
      const untouched = await Service.findOne({ name: serviceName, organizationId: otherOrganization.id }).lean() as any;
      expect(untouched.sphere.revision).toBe(1);
    });

    describe('organization-scoped route', () => {
      it('is denied to an EVALUATOR member', async () => {
        await createLinkedService();

        const response = await request(app)
          .put(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization`)
          .set('x-api-key', evaluatorUser.apiKey)
          .send({ permanentUrl, policy: 'new_last' });

        expect(response.status).toBe(403);
      });

      it('is allowed to the organization owner', async () => {
        await createLinkedService();
        mockManifest();

        const response = await request(app)
          .put(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization`)
          .set('x-api-key', ownerUser.apiKey)
          .send({ permanentUrl, policy: 'all_last', pollIntervalMinutes: 1 });

        expect(response.status).toBe(200);
        expect(response.body.configuration.pollIntervalMinutes).toBe(1);
      });
    });
  });

  describe('POST /services/:serviceName/synchronization/run', () => {
    beforeEach(() => {
      // The run is executed in the background; let it fail fast and quietly if it reaches SPHERE.
      nock(origin).persist().get(/.*/).reply(503);
    });

    it('returns 202 and queues the linked service', async () => {
      await createLinkedService();

      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/run`).set('x-api-key', allKey);

      expect(response.status).toBe(202);
      expect(response.body.source).toBe('sphere');
      expect(['queued', 'checking', 'applying', 'degraded', 'ready']).toContain(response.body.configuration.status);
    });

    it('returns 404 when the service is not linked to SPHERE', async () => {
      await createLinkedService({ service: { source: 'manual' } });

      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/run`).set('x-api-key', allKey);

      expect(response.status).toBe(404);
    });

    it('returns 403 for an evaluation-scoped organization key', async () => {
      await createLinkedService();

      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/run`).set('x-api-key', evaluationKey);

      expect(response.status).toBe(403);
    });

    it('returns 401 without an API key', async () => {
      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/run`);

      expect(response.status).toBe(401);
    });

    it('is denied to a non-member through the organization-scoped route', async () => {
      await createLinkedService();

      const response = await request(app)
        .post(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization/run`)
        .set('x-api-key', outsiderUser.apiKey);

      expect(response.status).toBe(403);
    });
  });
});
