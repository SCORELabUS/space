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
import {
  PETCLINIC_BASE_VERSION,
  addPetclinicVersion,
  archivePetclinicVersion,
  uploadPetclinicService,
} from './utils/services/petclinicVersions';

/**
 * keepBillingPeriod and the stricter subscription validation.
 *
 * Versions used: `2025-3-26` (stock fixture), `2.0` (adds a private plan
 * `PARTNER` and a private add-on `vipSupport`) and `0.9` (archived).
 */

describe('Novation options and strict subscription validation', function () {
  let app: Server;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let orgKey: string;
  /** Name of the service as stored (routes); `serviceName` is the contract key (lowercase). */
  let storedName: string;
  let serviceName: string;
  let userId: string;

  const subscription = (
    plan = 'GOLD',
    addOns: Record<string, number> = { extraPets: 2 },
    version = PETCLINIC_BASE_VERSION
  ) => ({
    contractedServices: { [serviceName]: version },
    subscriptionPlans: { [serviceName]: plan },
    subscriptionAddOns: { [serviceName]: addOns },
  });

  const create = (body: any, id = uuidv4()) =>
    request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', orgKey)
      .send({ userContact: { userId: id, username: `u-${id.slice(0, 8)}` }, billingPeriod: { renewalDays: 30 }, ...body });
  const novate = (body: any, query = '') =>
    request(app).put(`${baseUrl}/contracts/${userId}${query}`).set('x-api-key', orgKey).send(body);
  const stored = async () => ContractMongoose.findOne({ 'userContact.userId': userId }).lean() as any;
  const codes = (response: request.Response) => (response.body.errors ?? []).map((e: any) => e.code).sort();

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    owner = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    orgKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: orgKey, scope: 'ALL' });

    storedName = (await uploadPetclinicService(app, orgKey)).name;
    serviceName = storedName.toLowerCase();
    await addPetclinicVersion(app, orgKey, storedName, '2.0', '2025-06-01', pricing => {
      pricing.plans.PARTNER = { ...pricing.plans.PLATINUM, price: 1, private: true };
      pricing.addOns.extraPets.availableFor.push('PARTNER');
      pricing.addOns.vipSupport = {
        availableFor: ['BASIC', 'GOLD', 'PLATINUM', 'PARTNER'],
        price: 50,
        private: true,
        features: { highSupportPriority: { value: true } },
      };
    });
    await addPetclinicVersion(app, orgKey, storedName, '0.9', '2024-01-01');

    const created = await create(subscription());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    userId = created.body.userContact.userId;
  });

  afterEach(async function () {
    await ContractMongoose.deleteMany({ organizationId: organization.id });
    await ServiceMongoose.deleteMany({ organizationId: organization.id });
    await deleteTestOrganization(organization.id!);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('keepBillingPeriod', function () {
    it('restarts the billing period by default, as before', async function () {
      const before = await stored();
      await new Promise(resolve => setTimeout(resolve, 20));

      const response = await novate(subscription('PLATINUM'));

      expect(response.status).toBe(200);
      expect(new Date(response.body.billingPeriod.startDate).getTime()).toBeGreaterThan(
        new Date(before.billingPeriod.startDate).getTime()
      );
    });

    it('keeps start and end date with ?keepBillingPeriod=true, still recording the history', async function () {
      const before = await stored();

      const response = await novate(subscription('PLATINUM'), '?keepBillingPeriod=true');

      expect(response.status).toBe(200);
      expect(response.body.subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect(new Date(response.body.billingPeriod.startDate).toISOString()).toBe(
        new Date(before.billingPeriod.startDate).toISOString()
      );
      expect(new Date(response.body.billingPeriod.endDate).toISOString()).toBe(
        new Date(before.billingPeriod.endDate).toISOString()
      );
      const after = await stored();
      expect(after.history).toHaveLength(1);
      expect(after.history[0].subscriptionPlans[serviceName]).toBe('GOLD');
    });

    it('accepts the body field keepBillingPeriod: true and does not store it', async function () {
      const before = await stored();

      const response = await novate({ ...subscription('PLATINUM'), keepBillingPeriod: true });

      expect(response.status).toBe(200);
      expect(new Date(response.body.billingPeriod.endDate).toISOString()).toBe(
        new Date(before.billingPeriod.endDate).toISOString()
      );
      expect((await stored()).keepBillingPeriod).toBeUndefined();
    });

    it('rejects a keepBillingPeriod body field that is not a boolean', async function () {
      const response = await novate({ ...subscription('PLATINUM'), keepBillingPeriod: 'yes' });

      expect(response.status).toBe(422);
    });

    it('applies to group novations', async function () {
      const groupId = `group-${uuidv4()}`;
      const member = await create({ ...subscription(), groupId });
      const before = (await ContractMongoose.findOne({ 'userContact.userId': member.body.userContact.userId }).lean()) as any;

      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}&keepBillingPeriod=true`)
        .set('x-api-key', orgKey)
        .send(subscription('PLATINUM'));

      expect(response.status).toBe(200);
      expect(new Date(response.body[0].billingPeriod.endDate).toISOString()).toBe(
        new Date(before.billingPeriod.endDate).toISOString()
      );
    });
  });

  describe('error codes', function () {
    it('reports every problem with a stable code, service and path', async function () {
      const response = await novate({
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: {
          [serviceName]: { petDashboard: 1, smartClinicReports: 1, extraVisits: 4, nonExisting: 1 },
        },
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/^Invalid subscription: /);
      expect(codes(response)).toEqual(
        [
          'ADDON_NOT_AVAILABLE', // petDashboard is PLATINUM only
          'ADDON_NOT_AVAILABLE', // smartClinicReports is PLATINUM only
          'ADDON_NOT_FOUND',
          'QUANTITY_OUT_OF_RANGE', // extraVisits: min 3, step 3
        ].sort()
      );
      const notFound = response.body.errors.find((e: any) => e.code === 'ADDON_NOT_FOUND');
      expect(notFound).toMatchObject({
        service: serviceName,
        path: `subscriptionAddOns.${serviceName}.nonExisting`,
      });
      expect(typeof notFound.message).toBe('string');
    });

    it('reports PLAN_NOT_FOUND, ADDON_DEPENDENCY_MISSING and ADDON_EXCLUDED', async function () {
      const plan = await novate(subscription('DIAMOND', {}));
      const dependency = await novate(subscription('PLATINUM', { smartClinicReports: 1 }));

      // Only "not found" problems: novations keep answering 404, as before.
      expect(plan.status).toBe(404);
      expect(codes(plan)).toEqual(['PLAN_NOT_FOUND']);
      expect(plan.body.errors[0].path).toBe(`subscriptionPlans.${serviceName}`);
      expect(dependency.status).toBe(400);
      expect(codes(dependency)).toEqual(['ADDON_DEPENDENCY_MISSING']);

      await addPetclinicVersion(app, orgKey, storedName, '3.0', '2025-07-01', pricing => {
        pricing.addOns.petLover.excludes = ['extraPets'];
      });
      const excluded = await novate(subscription('GOLD', { petLover: 1, extraPets: 1 }, '3.0'));
      expect(codes(excluded)).toEqual(['ADDON_EXCLUDED']);
    });

    it('reports VERSION_NOT_FOUND for unknown versions and services', async function () {
      const version = await novate(subscription('GOLD', {}, '9.9.9'));
      const service = await novate({
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION, ghost: '1.0' },
        subscriptionPlans: { [serviceName]: 'GOLD', ghost: 'BASIC' },
        subscriptionAddOns: {},
      });

      expect(version.status).toBe(404);
      expect(codes(version)).toEqual(['VERSION_NOT_FOUND']);
      expect(version.body.errors[0].path).toBe(`contractedServices.${serviceName}`);
      expect(service.status).toBe(404);
      expect(codes(service)).toEqual(['VERSION_NOT_FOUND']);
      expect(service.body.errors[0].service).toBe('ghost');
    });

    it('applies the same codes to new contracts, always with 400 as before', async function () {
      const response = await create(subscription('DIAMOND', {}));

      expect(response.status).toBe(400);
      expect(codes(response)).toEqual(['PLAN_NOT_FOUND']);
    });

    it('does not reject limits below consumption', async function () {
      await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels`)
        .set('x-api-key', orgKey)
        .send({ [serviceName]: { maxPets: 6 } });

      // BASIC allows 2 pets.
      const response = await novate(subscription('BASIC', {}));

      expect(response.status).toBe(200);
    });
  });

  describe('private plans and add-ons', function () {
    it('rejects a private plan or add-on on a new contract', async function () {
      const plan = await create(subscription('PARTNER', {}, '2.0'));
      const addOn = await create(subscription('GOLD', { vipSupport: 1 }, '2.0'));

      expect(plan.status).toBe(400);
      expect(codes(plan)).toEqual(['PRIVATE_PLAN']);
      expect(addOn.status).toBe(400);
      expect(codes(addOn)).toEqual(['PRIVATE_ADDON']);
      expect(addOn.body.errors[0].path).toBe(`subscriptionAddOns.${serviceName}.vipSupport`);
    });

    it('rejects switching to a private plan or adding a private add-on', async function () {
      const plan = await novate(subscription('PARTNER', {}, '2.0'));
      const addOn = await novate(subscription('GOLD', { vipSupport: 1 }, '2.0'));

      expect(codes(plan)).toEqual(['PRIVATE_PLAN']);
      expect(codes(addOn)).toEqual(['PRIVATE_ADDON']);
    });

    it('accepts them with allowPrivate: true, and keeps them on later novations', async function () {
      const assigned = await novate({ ...subscription('PARTNER', { vipSupport: 1 }, '2.0'), allowPrivate: true });
      expect(assigned.status).toBe(200);
      expect((await stored()).allowPrivate).toBeUndefined();

      // A later customer-driven change that keeps the private selection is fine.
      const kept = await novate(subscription('PARTNER', { vipSupport: 1, extraPets: 1 }, '2.0'));
      expect(kept.status).toBe(200);
    });

    it('accepts allowPrivate: true on contract creation', async function () {
      const response = await create({ ...subscription('PARTNER', {}, '2.0'), allowPrivate: true });

      expect(response.status).toBe(201);
      expect(response.body.allowPrivate).toBeUndefined();
    });
  });

  describe('archived versions', function () {
    beforeEach(async function () {
      // Move the contract to 0.9 while it is active, then archive it.
      const moved = await novate(subscription('GOLD', {}, '0.9'));
      expect(moved.status).toBe(200);
      await archivePetclinicVersion(app, orgKey, storedName, '0.9');
    });

    it('lets a contract keep the archived version it already has', async function () {
      const contract = await stored();
      // Archiving with a fallback migrates the contracts on that version; put
      // this one back on 0.9 to model a contract that kept it (e.g. SPHERE new_* policies).
      await ContractMongoose.updateOne(
        { _id: contract._id },
        { $set: { [`contractedServices.${serviceName}`]: '0_9' } }
      );

      const response = await novate(subscription('PLATINUM', {}, '0.9'));

      expect(response.status).toBe(200);
      expect(response.body.contractedServices[serviceName]).toBe('0.9');
    });

    it('rejects changing to an archived version', async function () {
      const response = await novate(subscription('GOLD', {}, '0.9'));

      expect(response.status).toBe(400);
      expect(codes(response)).toEqual(['VERSION_ARCHIVED']);
      expect(response.body.errors[0].path).toBe(`contractedServices.${serviceName}`);
    });

    it('rejects an archived version for a new contract', async function () {
      const response = await create(subscription('GOLD', {}, '0.9'));

      expect(response.status).toBe(400);
      expect(codes(response)).toEqual(['VERSION_ARCHIVED']);
    });
  });
});
