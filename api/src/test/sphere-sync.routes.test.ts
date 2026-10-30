import request from 'supertest';
import nock from 'nock';
import mongoose from 'mongoose';
import { Server } from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, addMemberToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import Contract from '../main/repositories/mongoose/models/ContractMongoose';
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
    await Contract.deleteMany({ organizationId: { $in: [organization.id, otherOrganization.id] } });
    vi.restoreAllMocks();
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
      expect(response.body.contractCounts).toEqual([]);
    });

    it('counts current bindings per version without including history, prefix siblings or other organizations', async () => {
      await createLinkedService();
      await Contract.collection.insertMany([
        { organizationId: organization.id, userContact: { userId: 'counts-old-1' }, contractedServices: { [serviceName]: '1_0' } },
        { organizationId: organization.id, userContact: { userId: 'counts-old-2' }, contractedServices: { [serviceName]: '1_0' }, billingPeriod: { endDate: new Date('2020-01-01') } },
        { organizationId: organization.id, userContact: { userId: 'counts-new' }, contractedServices: { [serviceName]: '2_0' }, history: [{ contractedServices: { [serviceName]: '1_0' } }] },
        { organizationId: organization.id, userContact: { userId: 'counts-sibling' }, contractedServices: { [`${serviceName}pro`]: '1_0' }, history: [{ contractedServices: { [serviceName]: '1_0' } }] },
        { organizationId: otherOrganization.id, userContact: { userId: 'counts-other-org' }, contractedServices: { [serviceName]: '1_0' } },
      ]);
      const response = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', evaluationKey);
      expect(response.status).toBe(200);
      expect(response.body.contractCounts).toEqual([{ version: '1.0', count: 2 }, { version: '2.0', count: 1 }]);
      expect(JSON.stringify(response.body.contractCounts)).not.toContain('counts-old');
      // A policy for new contracts can retain old bindings even without a remote manifest or local pricing copy.
      expect(response.body.retainedVersions).toEqual([]);
      const scoped = await request(app).get(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization`).set('x-api-key', evaluatorUser.apiKey);
      expect(scoped.status).toBe(200);
      expect(scoped.body.contractCounts).toEqual(response.body.contractCounts);
    });

    it('refreshes counts after a binding changes or a contract is deleted', async () => {
      await createLinkedService();
      const contract = await Contract.collection.insertOne({ organizationId: organization.id, userContact: { userId: 'counts-changing' }, contractedServices: { [serviceName]: '1_0' } });
      const get = () => request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey);
      expect((await get()).body.contractCounts).toEqual([{ version: '1.0', count: 1 }]);
      await Contract.collection.updateOne({ _id: contract.insertedId }, { $set: { [`contractedServices.${serviceName}`]: '2_0' } });
      expect((await get()).body.contractCounts).toEqual([{ version: '2.0', count: 1 }]);
      await Contract.collection.deleteOne({ _id: contract.insertedId });
      expect((await get()).body.contractCounts).toEqual([]);
    });

    it('reports a manually created service as manual with no configuration', async () => {
      await createLinkedService({ service: { source: 'manual' }, sphere: undefined });
      await Service.collection.updateOne({ name: serviceName, organizationId: organization.id }, { $unset: { sphere: '' } });

      const response = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', allKey);

      expect(response.status).toBe(200);
      expect(response.body.source).toBe('manual');
      expect(response.body.configuration).toBeNull();
      expect(response.body.contractCounts).toEqual([]);
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

  describe('POST /services/:serviceName/synchronization/resume', () => {
    beforeEach(() => {
      // This route schedules background synchronization; policy execution is covered by integration tests.
      vi.spyOn(container.resolve('sphereSyncService'), 'synchronize').mockResolvedValue(undefined);
    });

    it('reactivates and queues a paused linked service and accepts repeat requests', async () => {
      await createLinkedService({ service: { disabled: true } });
      const activated = vi.spyOn(container.resolve('eventService'), 'emitPricingActivedMessage');
      const before = await Service.findOne({ name: serviceName, organizationId: organization.id }).lean() as any;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/resume`).set('x-api-key', allKey);
        expect(response.status, JSON.stringify(response.body)).toBe(202);
        expect(response.body.disabled).toBe(false);
        expect(response.body.configuration.status).toBe('queued');
        expect(response.body.configuration.policy).toBe(before.sphere.policy);
        expect(response.body.configuration.target).toEqual(before.sphere.target);
      }
      const after = await Service.findOne({ name: serviceName, organizationId: organization.id }).lean() as any;
      expect(after.disabled).toBe(false);
      expect(after.activePricings).toEqual(before.activePricings);
      expect(after.archivedPricings).toEqual(before.archivedPricings);
      expect(after.sphere.revision).toBe(before.sphere.revision);
      expect(activated).toHaveBeenCalledTimes(1);
    });

    it('allows the organization owner to reactivate through the scoped route', async () => {
      await createLinkedService({ service: { disabled: true } });
      const response = await request(app).post(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization/resume`)
        .set('x-api-key', ownerUser.apiKey).send({ organizationId: otherOrganization.id });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      expect(response.body.disabled).toBe(false);
      expect((await Service.findOne({ name: serviceName, organizationId: organization.id }).lean())?.disabled).toBe(false);
      expect(await Service.countDocuments({ organizationId: otherOrganization.id })).toBe(0);
    });

    it('rejects an EVALUATION organization key without reactivating', async () => {
      await createLinkedService({ service: { disabled: true } });
      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/resume`).set('x-api-key', evaluationKey);
      expect(response.status).toBe(403);
      expect((await Service.findOne({ name: serviceName, organizationId: organization.id }).lean())?.disabled).toBe(true);
    });

    it.each(['outsider', 'evaluator'])('rejects a scoped %s user without reactivating', async actor => {
      await createLinkedService({ service: { disabled: true } });
      const response = await request(app).post(`${baseUrl}/organizations/${organization.id}/services/${serviceName}/synchronization/resume`)
        .set('x-api-key', actor === 'outsider' ? outsiderUser.apiKey : evaluatorUser.apiKey);
      expect(response.status).toBe(403);
      expect((await Service.findOne({ name: serviceName, organizationId: organization.id }).lean())?.disabled).toBe(true);
    });

    it('cannot reactivate another organization service through its own key', async () => {
      await createLinkedService({ service: { disabled: true } });
      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/resume`).set('x-api-key', otherOrgKey);
      expect(response.status).toBe(404);
      expect((await Service.findOne({ name: serviceName, organizationId: organization.id }).lean())?.disabled).toBe(true);
    });

    it('returns 404 for a manual service', async () => {
      await createLinkedService({ service: { source: 'manual', disabled: true } });
      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/resume`).set('x-api-key', allKey);
      expect(response.status).toBe(404);
    });

    it('returns 409 while a synchronization is applying and leaves it disabled', async () => {
      await createLinkedService({ service: { disabled: true }, sphere: { status: 'applying' } });
      const response = await request(app).post(`${baseUrl}/services/${serviceName}/synchronization/resume`).set('x-api-key', allKey);
      expect(response.status).toBe(409);
      expect((await Service.findOne({ name: serviceName, organizationId: organization.id }).lean())?.disabled).toBe(true);
    });
  });

  describe('discovering disabled services', () => {
    it('lists paused services through disabled=true without changing the default active list', async () => {
      await createLinkedService({ service: { disabled: true } });
      const paused = await request(app).get(`${baseUrl}/services?disabled=true`).set('x-api-key', allKey);
      const active = await request(app).get(`${baseUrl}/services`).set('x-api-key', allKey);
      const status = await request(app).get(`${baseUrl}/services/${serviceName}/synchronization`).set('x-api-key', evaluationKey);
      expect(status.status).toBe(200);
      expect(status.body.disabled).toBe(true);
      expect(paused.status).toBe(200);
      expect(paused.body.map((entry: any) => entry.name)).toContain(serviceName);
      expect(active.status).toBe(200);
      expect(active.body.map((entry: any) => entry.name)).not.toContain(serviceName);
    });

    it.each(['disabled=maybe', 'disabled[]=true', 'disabled=true&disabled=false'])('rejects an invalid disabled filter (%s)', async query => {
      const response = await request(app).get(`${baseUrl}/services?${query}`).set('x-api-key', allKey);
      expect(response.status).toBe(400);
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
