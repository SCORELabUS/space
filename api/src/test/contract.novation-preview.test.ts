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
import PricingMongoose from '../main/repositories/mongoose/models/PricingMongoose';
import {
  PETCLINIC_BASE_VERSION,
  addPetclinicVersion,
  uploadPetclinicService,
} from './utils/services/petclinicVersions';

/**
 * POST /contracts/{userId}/novation/preview runs what a novation runs (SPHERE
 * policy, subscription validation, keepBillingPeriod) and writes nothing.
 */

describe('Novation preview (dry run)', function () {
  let app: Server;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let otherOrganization: LeanOrganization;
  let allKey: string;
  let evaluationKey: string;
  let otherKey: string;
  let storedName: string;
  let serviceName: string;
  let userId: string;

  const subscription = (
    plan = 'GOLD',
    addOns: Record<string, number> = { extraPets: 2 },
    version: string | null = PETCLINIC_BASE_VERSION
  ) => ({
    ...(version === null ? {} : { contractedServices: { [serviceName]: version } }),
    subscriptionPlans: { [serviceName]: plan },
    subscriptionAddOns: { [serviceName]: addOns },
  });
  const preview = (body: any, query = '', key = allKey, id = userId) =>
    request(app).post(`${baseUrl}/contracts/${id}/novation/preview${query}`).set('x-api-key', key).send(body);
  const stored = async () => ContractMongoose.findOne({ 'userContact.userId': userId }).lean() as any;
  const contractVersion = async () =>
    (await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', allKey)).body.contractVersion;

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    owner = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    otherOrganization = await createTestOrganization(owner.username);
    allKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    otherKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: allKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id!, { key: evaluationKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id!, { key: otherKey, scope: 'ALL' });

    storedName = (await uploadPetclinicService(app, allKey)).name;
    serviceName = storedName.toLowerCase();
    await addPetclinicVersion(app, allKey, storedName, '2.0', '2025-06-01', pricing => {
      // 2.0 lowers the BASIC limit to 1 pet and drops extraVisits.
      pricing.plans.BASIC.usageLimits = { maxPets: { value: 1 } };
      delete pricing.addOns.extraVisits;
      pricing.plans.PARTNER = { ...pricing.plans.PLATINUM, price: 1, private: true };
    });

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', allKey)
      .send({ userContact: { userId, username: 'preview-user' }, billingPeriod: { renewalDays: 30 }, ...subscription() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  afterEach(async function () {
    const orgs = [organization.id, otherOrganization.id];
    await ContractMongoose.deleteMany({ organizationId: { $in: orgs } });
    await PricingMongoose.deleteMany({ _organizationId: { $in: orgs } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: orgs } });
    await deleteTestOrganization(organization.id!);
    await deleteTestOrganization(otherOrganization.id!);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  it('previews a valid change without writing anything', async function () {
    const before = await stored();
    const version = await contractVersion();

    const response = await preview(subscription('PLATINUM', { extraPets: 1 }, '2.0'));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      valid: true,
      errors: [],
      effective: {
        contractedServices: { [serviceName]: '2.0' },
        subscriptionPlans: { [serviceName]: 'PLATINUM' },
        subscriptionAddOns: { [serviceName]: { extraPets: 1 } },
      },
      versionChanges: { [serviceName]: { from: PETCLINIC_BASE_VERSION, to: '2.0', reason: 'requested' } },
      usageWarnings: [],
      contractVersion: version,
    });
    expect(response.body.billingPeriod.restarts).toBe(true);
    expect(new Date(response.body.billingPeriod.startDate).getTime()).toBeGreaterThanOrEqual(
      new Date(before.billingPeriod.startDate).getTime()
    );

    const after = await stored();
    expect(after.subscriptionPlans).toEqual(before.subscriptionPlans);
    expect(after.history).toHaveLength(0);
    expect(new Date(after.billingPeriod.startDate).toISOString()).toBe(new Date(before.billingPeriod.startDate).toISOString());
    expect(await contractVersion()).toBe(version);
  });

  it('reports invalid configurations with 200, valid:false and the S8 codes', async function () {
    const response = await preview(subscription('GOLD', { extraVisits: 3, petDashboard: 1 }, '2.0'));

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(false);
    expect(response.body.errors.map((e: any) => e.code).sort()).toEqual(['ADDON_NOT_AVAILABLE', 'ADDON_NOT_FOUND']);
    expect(response.body.errors.find((e: any) => e.code === 'ADDON_NOT_FOUND')).toMatchObject({
      service: serviceName,
      path: `subscriptionAddOns.${serviceName}.extraVisits`,
    });
    expect(response.body.effective.subscriptionPlans[serviceName]).toBe('GOLD');
    expect(response.body.contractVersion).toBe(await contractVersion());
  });

  it('reports private plans (with rejectPrivate), unknown and archived versions', async function () {
    const privatePlan = await preview(subscription('PARTNER', {}, '2.0'), '?rejectPrivate=true');
    const privateAccepted = await preview(subscription('PARTNER', {}, '2.0'));
    const unknown = await preview(subscription('GOLD', {}, '9.9'));

    expect(privatePlan.body.valid).toBe(false);
    expect(privatePlan.body.errors.map((e: any) => e.code)).toEqual(['PRIVATE_PLAN']);
    expect(privateAccepted.body.valid).toBe(true);
    expect(unknown.body.valid).toBe(false);
    expect(unknown.body.errors.map((e: any) => e.code)).toEqual(['VERSION_NOT_FOUND']);
  });

  it('reports limits below the current consumption as usageWarnings, not errors', async function () {
    await request(app)
      .put(`${baseUrl}/contracts/${userId}/usageLevels`)
      .set('x-api-key', allKey)
      .send({ [serviceName]: { maxPets: 3 } });

    const response = await preview(subscription('BASIC', {}, '2.0'));

    expect(response.body.valid).toBe(true);
    expect(response.body.usageWarnings).toEqual([{ service: serviceName, usageLimit: 'maxPets', consumed: 3, newLimit: 1 }]);
  });

  it('counts add-on usage limit extensions in the new limit', async function () {
    await request(app)
      .put(`${baseUrl}/contracts/${userId}/usageLevels`)
      .set('x-api-key', allKey)
      .send({ [serviceName]: { maxPets: 3 } });

    // BASIC 2.0: 1 pet + extraPets x2 = 3, not below 3.
    const response = await preview(subscription('BASIC', { extraPets: 2 }, '2.0'));

    expect(response.body.valid).toBe(true);
    expect(response.body.usageWarnings).toEqual([]);
  });

  it('applies add-ons in pricing order, as feature evaluation does', async function () {
    // petPack (first in the pricing) sets maxPets to 2; extraPets then extends it by 1 per unit.
    await addPetclinicVersion(app, allKey, storedName, '3.0', '2025-07-01', pricing => {
      pricing.plans.BASIC.usageLimits = { maxPets: { value: 1 } };
      pricing.addOns = {
        petPack: { availableFor: ['BASIC', 'GOLD', 'PLATINUM'], price: 5, usageLimits: { maxPets: { value: 2 } } },
        ...pricing.addOns,
      };
    });
    await request(app)
      .put(`${baseUrl}/contracts/${userId}/usageLevels`)
      .set('x-api-key', allKey)
      .send({ [serviceName]: { maxPets: 3 } });

    // Selected in the other order: 2 + 1 = 3 is not below 3.
    const response = await preview(subscription('BASIC', { extraPets: 1, petPack: 1 }, '3.0'));

    expect(response.body.valid, JSON.stringify(response.body.errors)).toBe(true);
    expect(response.body.usageWarnings).toEqual([]);
  });

  it('keeps applying billingPeriod.autoRenew of a novation body, as before', async function () {
    // The contract was created without autoRenew (false); the novation body turns it on.
    expect((await stored()).billingPeriod.autoRenew).toBe(false);
    const body = { ...subscription('PLATINUM'), billingPeriod: { autoRenew: true } };

    const previewed = await preview(body);
    const applied = await request(app).put(`${baseUrl}/contracts/${userId}`).set('x-api-key', allKey).send(body);

    expect(previewed.status).toBe(200);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.billingPeriod.autoRenew).toBe(true);
    expect((await stored()).billingPeriod.autoRenew).toBe(true);
  });

  it('keeps the billing period with keepBillingPeriod (query or body)', async function () {
    const before = await stored();

    const query = await preview(subscription('PLATINUM'), '?keepBillingPeriod=true');
    const body = await preview({ ...subscription('PLATINUM'), keepBillingPeriod: true });

    for (const response of [query, body]) {
      expect(response.body.billingPeriod).toEqual({
        startDate: new Date(before.billingPeriod.startDate).toISOString(),
        endDate: new Date(before.billingPeriod.endDate).toISOString(),
        restarts: false,
      });
    }
  });

  it('keeps the contracted version when contractedServices is omitted', async function () {
    const response = await preview(subscription('PLATINUM', {}, null));

    expect(response.body.valid).toBe(true);
    expect(response.body.effective.contractedServices).toEqual({ [serviceName]: PETCLINIC_BASE_VERSION });
    expect(response.body.versionChanges).toEqual({});
  });

  it('uses the version for new contracts for services the contract does not have yet', async function () {
    const extraName = (
      await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', allKey)
        .attach('pricing', Buffer.from(
          `saasName: Extra\nversion: '1.0'\ncreatedAt: '2025-01-01'\nsyntaxVersion: '3.1'\ncurrency: USD\n` +
          `features:\n  enabled:\n    valueType: BOOLEAN\n    defaultValue: true\n    type: DOMAIN\n` +
          `plans:\n  basic:\n    price: 0\n    unit: /month\n    features:\n      enabled:\n        value: true\n`
        ), 'extra.yaml')
    ).body.name.toLowerCase();

    const response = await preview({
      subscriptionPlans: { [serviceName]: 'GOLD', [extraName]: 'basic' },
      subscriptionAddOns: {},
    });

    expect(response.body.valid, JSON.stringify(response.body.errors)).toBe(true);
    expect(response.body.effective.contractedServices).toEqual({ [serviceName]: PETCLINIC_BASE_VERSION, [extraName]: '1.0' });
    expect(response.body.versionChanges).toEqual({ [extraName]: { from: null, to: '1.0', reason: 'new-contracts-version' } });
  });

  it('reports the SPHERE policy deciding the version', async function () {
    const linkedName = 'linkedpolicy';
    const pricing = await PricingMongoose.create({
      _serviceName: linkedName, _organizationId: organization.id, version: '5_0', currency: 'USD', createdAt: new Date('2025-01-01'),
      features: { enabled: { name: 'enabled', valueType: 'BOOLEAN', defaultValue: true, type: 'DOMAIN' } },
      plans: { basic: { name: 'basic', price: 0, features: { enabled: true } } },
    });
    await ServiceMongoose.collection.insertOne({
      name: linkedName, organizationId: organization.id, source: 'sphere', disabled: false,
      activePricings: { '5_0': { id: pricing._id } }, archivedPricings: {},
      sphere: { permanentUrl: 'https://sphere.score.us.es/p/111111111111111111111111', pricingId: '111111111111111111111111',
        name: 'Linked', policy: 'all_last', revision: 1, status: 'ready',
        target: { versionId: '222222222222222222222222', version: '5.0', createdAt: '2025-01-01T00:00:00.000Z', contentHash: 'a'.repeat(64) } },
    });

    const response = await preview({
      contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION, [linkedName]: '4.0' },
      subscriptionPlans: { [serviceName]: 'GOLD', [linkedName]: 'basic' },
      subscriptionAddOns: {},
    });

    expect(response.body.valid, JSON.stringify(response.body.errors)).toBe(true);
    expect(response.body.effective.contractedServices[linkedName]).toBe('5.0');
    expect(response.body.versionChanges[linkedName]).toEqual({ from: null, to: '5.0', reason: 'policy:all_last' });
    await ServiceMongoose.deleteOne({ name: linkedName, organizationId: organization.id });
    await PricingMongoose.deleteOne({ _id: pricing._id });
  });

  it('applies exactly like the novation it previews', async function () {
    const body = subscription('PLATINUM', { extraPets: 1 }, '2.0');
    const previewed = (await preview(body)).body;

    const applied = await request(app)
      .put(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', allKey)
      .set('If-Match', `"${previewed.contractVersion}"`)
      .send(body);

    expect(applied.status).toBe(200);
    expect(applied.body.contractedServices).toEqual(previewed.effective.contractedServices);
    expect(applied.body.subscriptionPlans).toEqual(previewed.effective.subscriptionPlans);
    expect(applied.body.subscriptionAddOns).toEqual(previewed.effective.subscriptionAddOns);
  });

  it('is scoped and authorized like PUT /contracts/{userId}', async function () {
    const foreign = await preview(subscription(), '', otherKey);
    const evaluation = await preview(subscription(), '', evaluationKey);
    const unknown = await preview(subscription(), '', allKey, uuidv4());
    const scoped = await request(app)
      .post(`${baseUrl}/organizations/${organization.id}/contracts/${userId}/novation/preview`)
      .set('x-api-key', owner.apiKey)
      .send(subscription('PLATINUM'));
    const anonymous = await request(app).post(`${baseUrl}/contracts/${userId}/novation/preview`).send(subscription());

    expect(foreign.status).toBe(404);
    expect(evaluation.status).toBe(403);
    expect(unknown.status).toBe(404);
    expect(scoped.status).toBe(200);
    expect(scoped.body.valid).toBe(true);
    expect(anonymous.status).toBe(401);
  });

  it('rejects malformed bodies like the novation does', async function () {
    const response = await preview({ subscriptionPlans: 'GOLD', subscriptionAddOns: {} });

    expect(response.status).toBe(422);
  });
});
