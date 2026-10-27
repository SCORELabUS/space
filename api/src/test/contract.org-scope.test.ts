import path from 'path';
import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/**
 * Contracts are addressed by `userId`, which is chosen by the host application
 * and is not secret. Every route that takes a `userId` must therefore look the
 * contract up inside the caller's organization: the organization of an org API
 * key, or the organization named in the route for user API keys. Outside it the
 * contract does not exist (404), whatever the operation.
 *
 * Both organizations upload the same pricing (same service name and version) so
 * that a lookup that ignored the organization would find everything it needs to
 * succeed: the tests fail on the scoping, not on a missing pricing.
 */

const PETCLINIC_PRICING_PATH = path.resolve(__dirname, './data/pricings/petclinic-2025.yml');

describe('Contract organization scoping', function () {
  let app: Server;
  let adminUser: LeanUser;
  let ownerA: LeanUser;
  let ownerB: LeanUser;
  let orgA: LeanOrganization;
  let orgB: LeanOrganization;
  let keyA: string;
  let keyB: string;
  let serviceName: string;
  let pricingVersion: string;
  let userId: string;

  const subscription = () => ({
    contractedServices: { [serviceName]: pricingVersion },
    subscriptionPlans: { [serviceName]: 'GOLD' },
    subscriptionAddOns: { [serviceName]: { extraPets: 2 } },
  });

  const storedContract = async () =>
    ContractMongoose.findOne({ 'userContact.userId': userId }).lean() as any;

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    adminUser = await createTestUser('ADMIN');
    ownerA = await createTestUser('USER');
    ownerB = await createTestUser('USER');
    orgA = await createTestOrganization(ownerA.username);
    orgB = await createTestOrganization(ownerB.username);
    keyA = generateOrganizationApiKey();
    keyB = generateOrganizationApiKey();
    await addApiKeyToOrganization(orgA.id!, { key: keyA, scope: 'ALL' });
    await addApiKeyToOrganization(orgB.id!, { key: keyB, scope: 'ALL' });

    for (const org of [orgA, orgB]) {
      const upload = await request(app)
        .post(`${baseUrl}/organizations/${org.id}/services`)
        .set('x-api-key', adminUser.apiKey)
        .attach('pricing', PETCLINIC_PRICING_PATH);
      expect(upload.status).toBe(201);
      // Contracts store service keys in lowercase.
      serviceName = upload.body.name.toLowerCase();
      pricingVersion = Object.keys(upload.body.activePricings)[0];
    }

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', keyA)
      .send({
        userContact: { userId, username: 'scoped-user' },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        ...subscription(),
      });
    expect(created.status).toBe(201);
  });

  afterEach(async function () {
    await ContractMongoose.deleteMany({ organizationId: { $in: [orgA.id, orgB.id] } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: [orgA.id, orgB.id] } });
    await deleteTestOrganization(orgA.id!);
    await deleteTestOrganization(orgB.id!);
    for (const user of [adminUser, ownerA, ownerB]) await deleteTestUser(user.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('organization API key of another organization', function () {
    it('cannot read the contract', async function () {
      const response = await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', keyB);

      expect(response.status).toBe(404);
      expect(response.body.userContact).toBeUndefined();
    });

    it('answers exactly as for a userId that does not exist', async function () {
      const foreign = await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', keyB);
      const missing = await request(app)
        .get(`${baseUrl}/contracts/does-not-exist-${uuidv4()}`)
        .set('x-api-key', keyB);

      expect(foreign.status).toBe(missing.status);
      expect(foreign.body.error.replace(userId, '<id>')).toBe(
        missing.body.error.replace(/does-not-exist-[\w-]+/, '<id>')
      );
    });

    it('cannot novate the contract', async function () {
      const before = await storedContract();
      const response = await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', keyB)
        .send({ ...subscription(), subscriptionPlans: { [serviceName]: 'PLATINUM' } });

      expect(response.status).toBe(404);
      const after = await storedContract();
      expect(after.subscriptionPlans[serviceName]).toBe('GOLD');
      expect(after.history).toHaveLength(before.history.length);
    });

    it('cannot delete the contract', async function () {
      const response = await request(app).delete(`${baseUrl}/contracts/${userId}`).set('x-api-key', keyB);

      expect(response.status).toBe(404);
      expect(await storedContract()).not.toBeNull();
    });

    it('cannot change the billing period, user contact or usage levels', async function () {
      const before = await storedContract();

      const billing = await request(app)
        .put(`${baseUrl}/contracts/${userId}/billingPeriod`)
        .set('x-api-key', keyB)
        .send({ autoRenew: false });
      const contact = await request(app)
        .put(`${baseUrl}/contracts/${userId}/userContact`)
        .set('x-api-key', keyB)
        .send({ username: 'renamed' });
      const usage = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels`)
        .set('x-api-key', keyB)
        .send({ [serviceName]: { maxPets: 3 } });
      const reset = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels?reset=true`)
        .set('x-api-key', keyB)
        .send({});

      expect([billing.status, contact.status, usage.status, reset.status]).toEqual([404, 404, 404, 404]);
      const after = await storedContract();
      expect(after.billingPeriod.autoRenew).toBe(true);
      expect(after.userContact.username).toBe('scoped-user');
      expect(after.usageLevels[serviceName].maxPets.consumed).toBe(
        before.usageLevels[serviceName].maxPets.consumed
      );
    });

    it('cannot evaluate the features of the contract', async function () {
      const all = await request(app).post(`${baseUrl}/features/${userId}`).set('x-api-key', keyB);
      const one = await request(app)
        .post(`${baseUrl}/features/${userId}/${serviceName}-pets`)
        .set('x-api-key', keyB);

      expect(all.status).toBe(404);
      expect(one.status).toBe(404);
    });

    it('cannot consume the usage limits of the contract', async function () {
      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/${serviceName}-pets`)
        .set('x-api-key', keyB)
        .send({ [`${serviceName}-maxPets`]: 1 });

      expect(response.status).toBe(404);
      expect((await storedContract()).usageLevels[serviceName].maxPets.consumed).toBe(0);
    });

    it('cannot obtain a pricing token for the contract, even one already cached', async function () {
      const own = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', keyA);
      expect(own.status).toBe(200);

      const foreign = await request(app)
        .post(`${baseUrl}/features/${userId}/pricing-token`)
        .set('x-api-key', keyB);

      expect(foreign.status).toBe(404);
      expect(foreign.body.pricingToken).toBeUndefined();
    });
  });

  describe('organization API key of the owning organization', function () {
    it('still reads, evaluates and novates the contract', async function () {
      const read = await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', keyA);
      const evaluation = await request(app).post(`${baseUrl}/features/${userId}`).set('x-api-key', keyA);
      const novation = await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', keyA)
        .send({ ...subscription(), subscriptionPlans: { [serviceName]: 'PLATINUM' } });

      expect(read.status).toBe(200);
      expect(evaluation.status).toBe(200);
      expect(novation.status).toBe(200);
      expect(novation.body.subscriptionPlans[serviceName]).toBe('PLATINUM');
    });
  });

  describe('user API key on organization-scoped routes', function () {
    it('cannot reach a contract of another organization through its own organization', async function () {
      const base = `${baseUrl}/organizations/${orgB.id}/contracts/${userId}`;

      const read = await request(app).get(base).set('x-api-key', ownerB.apiKey);
      const novate = await request(app).put(base).set('x-api-key', ownerB.apiKey).send(subscription());
      const remove = await request(app).delete(base).set('x-api-key', ownerB.apiKey);

      expect([read.status, novate.status, remove.status]).toEqual([404, 404, 404]);
      expect(await storedContract()).not.toBeNull();
    });

    it('is scoped to the route organization even for a platform ADMIN', async function () {
      const response = await request(app)
        .get(`${baseUrl}/organizations/${orgB.id}/contracts/${userId}`)
        .set('x-api-key', adminUser.apiKey);

      expect(response.status).toBe(404);
    });

    it('still reaches the contract through the owning organization', async function () {
      const response = await request(app)
        .get(`${baseUrl}/organizations/${orgA.id}/contracts/${userId}`)
        .set('x-api-key', ownerA.apiKey);

      expect(response.status).toBe(200);
    });
  });

  describe('platform ADMIN on the direct routes', function () {
    it('keeps its cross-organization access', async function () {
      const response = await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', adminUser.apiKey);

      expect(response.status).toBe(200);
      expect(response.body.organizationId).toBe(orgA.id);
    });
  });
});
