/**
 * Organization API keys with the EVALUATION scope.
 *
 * The scope exists for the host application's evaluation calls: "read-only
 * access to services/pricings and feature evaluation" in the OpenAPI document,
 * whose three evaluation routes say "Org Key with any scope". They have to be
 * able to evaluate every feature of a user, one feature (with the expected
 * consumption that evaluation records, and its revert) and get a pricing
 * token, and nothing else that writes: contracts, usage levels set directly,
 * services and pricings stay with ALL and MANAGEMENT.
 */
import request from 'supertest';
import path from 'path';
import { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { jwtVerify } from 'jose';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { cleanupAuthResources } from './utils/auth';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import {
  addApiKeyToOrganization,
  createTestOrganization,
  deleteTestOrganization,
} from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { encryptJWTSecret } from '../main/utils/jwt';
import { LeanUser } from '../main/types/models/User';
import { LeanOrganization } from '../main/types/models/Organization';
import { LeanService } from '../main/types/models/Service';

const PETCLINIC_PRICING_PATH = path.resolve(__dirname, './data/pricings/petclinic-2025.yml');

describe('EVALUATION-scoped organization API keys', function () {
  let app: Server;
  let adminUser: LeanUser;
  let ownerUser: LeanUser;
  let organization: LeanOrganization;
  let allKey: string;
  let evaluationKey: string;
  let service: LeanService;
  let pricingVersion: string;

  beforeAll(async function () {
    app = await getApp();
    adminUser = await createTestUser('ADMIN');
    ownerUser = await createTestUser('USER');
    organization = await createTestOrganization(ownerUser.username);

    allKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: allKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id!, { key: evaluationKey, scope: 'EVALUATION' });

    const response = await request(app)
      .post(`${baseUrl}/organizations/${organization.id}/services`)
      .set('x-api-key', adminUser.apiKey)
      .attach('pricing', PETCLINIC_PRICING_PATH);

    expect(response.status).toEqual(201);
    service = response.body;
    pricingVersion = Object.keys(service.activePricings)[0];
  });

  afterAll(async function () {
    if (organization?.id) {
      await deleteTestOrganization(organization.id);
    }
    if (ownerUser?.username) {
      await deleteTestUser(ownerUser.username);
    }
    if (adminUser?.username) {
      await deleteTestUser(adminUser.username);
    }
    await cleanupAuthResources();
    await shutdownApp();
  });

  /** A GOLD contract, created with the ALL key (EVALUATION cannot create one). */
  async function createContract(userId = uuidv4()): Promise<string> {
    const response = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', allKey)
      .send({
        userContact: { userId, username: 'evalKeyUser' },
        billingPeriod: { autoRenew: true, renewalDays: 365 },
        contractedServices: { [service.name]: pricingVersion },
        subscriptionPlans: { [service.name]: 'GOLD' },
        subscriptionAddOns: {
          [service.name]: { petAdoptionCentre: 1, extraPets: 2, extraVisits: 6 },
        },
      });

    expect(response.status).toEqual(201);
    return userId;
  }

  /** Consumed amount of `petclinic.maxVisits`, read with the ALL key. */
  async function consumedVisits(userId: string): Promise<number> {
    const response = await request(app)
      .get(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', allKey);

    expect(response.status).toEqual(200);
    return response.body.usageLevels.petclinic.maxVisits.consumed;
  }

  describe('can evaluate', function () {
    it('lists the features (GET /features)', async function () {
      const response = await request(app)
        .get(`${baseUrl}/features`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('evaluates every feature of a user (POST /features/{userId})', async function () {
      const userId = await createContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${userId}`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(200);
      expect(response.body['petclinic-pets']).toBe(true);
      expect(response.body['petclinic-consultations']).toBe(false);
    });

    it('evaluates every feature of a user with details (POST /features/{userId}?details=true)', async function () {
      const userId = await createContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${userId}?details=true`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(200);
      expect(response.body['petclinic-visits']).toEqual({
        eval: true,
        used: { 'petclinic-maxVisits': 0 },
        limit: { 'petclinic-maxVisits': 9 },
        error: null,
      });
    });

    it('evaluates one feature (POST /features/{userId}/{featureId})', async function () {
      const userId = await createContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/petclinic-visits`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(200);
      expect(response.body).toEqual({
        eval: true,
        used: { 'petclinic-maxVisits': 0 },
        limit: { 'petclinic-maxVisits': 9 },
        error: null,
      });
      expect(await consumedVisits(userId)).toEqual(0);
    });

    it('evaluates one feature with an expected consumption, which is recorded', async function () {
      const userId = await createContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/petclinic-visits`)
        .set('x-api-key', evaluationKey)
        .send({ 'petclinic-maxVisits': 2 });

      expect(response.status).toEqual(200);
      expect(response.body.eval).toBe(true);
      expect(response.body.used).toEqual({ 'petclinic-maxVisits': 2 });
      expect(await consumedVisits(userId)).toEqual(2);
    });

    it('reverts its last expected consumption (?revert=true)', async function () {
      const userId = await createContract();

      const consume = await request(app)
        .post(`${baseUrl}/features/${userId}/petclinic-visits`)
        .set('x-api-key', evaluationKey)
        .send({ 'petclinic-maxVisits': 3 });
      expect(consume.status).toEqual(200);
      expect(await consumedVisits(userId)).toEqual(3);

      const revert = await request(app)
        .post(`${baseUrl}/features/${userId}/petclinic-visits?revert=true`)
        .set('x-api-key', evaluationKey);

      expect(revert.status).toEqual(204);
      expect(await consumedVisits(userId)).toEqual(0);
    });

    it('gets a pricing token (POST /features/{userId}/pricing-token)', async function () {
      const userId = await createContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/pricing-token`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(200);
      const { payload } = await jwtVerify(
        response.body.pricingToken,
        encryptJWTSecret(process.env.JWT_SECRET!),
        { algorithms: ['HS256'], issuer: process.env.JWT_ISSUER || 'space', audience: organization.id! }
      );
      expect(payload.sub).toEqual(`urn:space:${organization.id}:${encodeURIComponent(userId)}`);
      expect(payload.userId).toEqual(userId);
      expect(payload.organizationId).toEqual(organization.id);
      expect((payload.features as any)['petclinic-pets'].eval).toBe(true);
    });

    it('answers 404, not 403, for a user without a contract', async function () {
      const response = await request(app)
        .post(`${baseUrl}/features/${uuidv4()}`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(404);
    });

    it('evaluates a user whose id is "evaluate" like any other user', async function () {
      // There is no `/features/evaluate` route: that path is the all-features
      // evaluation of the user "evaluate". It used to have a rule of its own.
      await createContract('evaluate');

      const response = await request(app)
        .post(`${baseUrl}/features/evaluate`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(200);
      expect(response.body['petclinic-pets']).toBe(true);
    });
  });

  describe('cannot write anything else', function () {
    let userId: string;

    beforeAll(async function () {
      userId = await createContract();
    });

    it('cannot create contracts (POST /contracts)', async function () {
      const response = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', evaluationKey)
        .send({
          userContact: { userId: uuidv4(), username: 'nope' },
          contractedServices: { [service.name]: pricingVersion },
          subscriptionPlans: { [service.name]: 'BASIC' },
          subscriptionAddOns: {},
        });

      expect(response.status).toEqual(403);
    });

    it('cannot novate a contract (PUT /contracts/{userId})', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', evaluationKey)
        .send({
          contractedServices: { [service.name]: pricingVersion },
          subscriptionPlans: { [service.name]: 'BASIC' },
          subscriptionAddOns: {},
        });

      expect(response.status).toEqual(403);
    });

    it('cannot set usage levels directly (PUT /contracts/{userId}/usageLevels)', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels`)
        .set('x-api-key', evaluationKey)
        .send({ petclinic: { maxVisits: 5 } });

      expect(response.status).toEqual(403);
      expect(await consumedVisits(userId)).toEqual(0);
    });

    it('cannot reset usage levels (PUT /contracts/{userId}/usageLevels?reset=true)', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels?reset=true`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toEqual(403);
    });

    it('cannot change the billing period (PATCH /contracts/{userId}/billingPeriod)', async function () {
      const response = await request(app)
        .patch(`${baseUrl}/contracts/${userId}/billingPeriod`)
        .set('x-api-key', evaluationKey)
        .send({ autoRenew: false });

      expect(response.status).toEqual(403);
    });

    it('cannot delete contracts (DELETE /contracts/{userId}, DELETE /contracts)', async function () {
      const one = await request(app)
        .delete(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', evaluationKey);
      const all = await request(app)
        .delete(`${baseUrl}/contracts`)
        .set('x-api-key', evaluationKey);

      expect(one.status).toEqual(403);
      expect(all.status).toEqual(403);

      const stillThere = await request(app)
        .get(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', allKey);
      expect(stillThere.status).toEqual(200);
    });

    it('cannot create, change or delete services', async function () {
      const create = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', evaluationKey)
        .attach('pricing', PETCLINIC_PRICING_PATH);
      const update = await request(app)
        .put(`${baseUrl}/services/${service.name}`)
        .set('x-api-key', evaluationKey)
        .send({ name: 'renamed' });
      const disable = await request(app)
        .delete(`${baseUrl}/services/${service.name}`)
        .set('x-api-key', evaluationKey);
      const prune = await request(app)
        .delete(`${baseUrl}/services`)
        .set('x-api-key', evaluationKey);

      expect(create.status).toEqual(403);
      expect(update.status).toEqual(403);
      expect(disable.status).toEqual(403);
      expect(prune.status).toEqual(403);
    });

    it('cannot add, archive or delete pricings', async function () {
      const add = await request(app)
        .post(`${baseUrl}/services/${service.name}/pricings`)
        .set('x-api-key', evaluationKey)
        .attach('pricing', PETCLINIC_PRICING_PATH);
      const archive = await request(app)
        .put(`${baseUrl}/services/${service.name}/pricings/${pricingVersion}?availability=archived`)
        .set('x-api-key', evaluationKey);
      const remove = await request(app)
        .delete(`${baseUrl}/services/${service.name}/pricings/${pricingVersion}`)
        .set('x-api-key', evaluationKey);

      expect(add.status).toEqual(403);
      expect(archive.status).toEqual(403);
      expect(remove.status).toEqual(403);

      const serviceAfter = await request(app)
        .get(`${baseUrl}/services/${service.name}`)
        .set('x-api-key', allKey);
      expect(serviceAfter.status).toEqual(200);
      expect(Object.keys(serviceAfter.body.activePricings)).toContain(pricingVersion);
    });

    it('cannot use other methods or deeper paths under /features', async function () {
      const put = await request(app)
        .put(`${baseUrl}/features/${userId}`)
        .set('x-api-key', evaluationKey);
      const patch = await request(app)
        .patch(`${baseUrl}/features/${userId}/petclinic-visits`)
        .set('x-api-key', evaluationKey);
      const del = await request(app)
        .delete(`${baseUrl}/features/${userId}`)
        .set('x-api-key', evaluationKey);
      const deeper = await request(app)
        .post(`${baseUrl}/features/${userId}/petclinic-visits/extra`)
        .set('x-api-key', evaluationKey);

      expect(put.status).toEqual(403);
      expect(patch.status).toEqual(403);
      expect(del.status).toEqual(403);
      expect(deeper.status).toEqual(403);
    });
  });

  describe('other keys are unchanged', function () {
    it('user API keys still cannot evaluate (Org Key only)', async function () {
      const userId = await createContract();

      const all = await request(app)
        .post(`${baseUrl}/features/${userId}`)
        .set('x-api-key', adminUser.apiKey);
      const one = await request(app)
        .post(`${baseUrl}/features/${userId}/petclinic-visits`)
        .set('x-api-key', ownerUser.apiKey);
      const token = await request(app)
        .post(`${baseUrl}/features/${userId}/pricing-token`)
        .set('x-api-key', ownerUser.apiKey);

      expect(all.status).toEqual(403);
      expect(one.status).toEqual(403);
      expect(token.status).toEqual(403);
    });

    it('ALL keys still evaluate', async function () {
      const userId = await createContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/petclinic-visits`)
        .set('x-api-key', allKey)
        .send({ 'petclinic-maxVisits': 1 });

      expect(response.status).toEqual(200);
      expect(response.body.used).toEqual({ 'petclinic-maxVisits': 1 });
    });
  });
});
