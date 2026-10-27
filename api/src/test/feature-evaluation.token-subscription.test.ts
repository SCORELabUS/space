import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { jwtVerify } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
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
import ContractMongoose from '../main/repositories/mongoose/models/ContractMongoose';
import ServiceMongoose from '../main/repositories/mongoose/models/ServiceMongoose';
import PricingMongoose from '../main/repositories/mongoose/models/PricingMongoose';
import {
  PETCLINIC_BASE_VERSION,
  addPetclinicVersion,
  uploadPetclinicService,
} from './utils/services/petclinicVersions';

/**
 * The pricing token carries the subscription it was computed from, so that a
 * browser that only holds the token can render "your plan" and the version of
 * its contract.
 */

describe('Pricing token subscription', function () {
  let app: Server;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let orgKey: string;
  let storedName: string;
  let serviceName: string;
  let userId: string;

  const rawToken = async () => {
    const response = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', orgKey);
    expect(response.status).toBe(200);
    return response.body.pricingToken as string;
  };
  const token = async () => {
    const response = { body: { pricingToken: await rawToken() } };
    const { payload } = await jwtVerify(response.body.pricingToken, encryptJWTSecret(process.env.JWT_SECRET!), {
      algorithms: ['HS256'],
    });
    return payload as any;
  };
  const contractVersion = async () =>
    (await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', orgKey)).body.contractVersion;

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
    await addPetclinicVersion(app, orgKey, storedName, '2.0.1', '2025-06-01');

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', orgKey)
      .send({
        userContact: { userId, username: 'token-user' },
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: { [serviceName]: { extraPets: 2 } },
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
    await shutdownApp();
  });

  it('adds the subscription and keeps the existing claims', async function () {
    const payload = await token();

    expect(payload.subscription).toEqual({
      contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
      subscriptionPlans: { [serviceName]: 'GOLD' },
      subscriptionAddOns: { [serviceName]: { extraPets: 2 } },
      contractVersion: await contractVersion(),
    });
    expect(payload.sub).toBe(userId);
    expect(payload.features).toBeDefined();
    expect(payload.pricingContext).toBeDefined();
    expect(payload.subscriptionContext).toBeDefined();
  });

  it('unescapes dotted pricing versions', async function () {
    await request(app)
      .put(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', orgKey)
      .send({
        contractedServices: { [serviceName]: '2.0.1' },
        subscriptionPlans: { [serviceName]: 'PLATINUM' },
        subscriptionAddOns: {},
      });

    const payload = await token();

    expect(payload.subscription.contractedServices).toEqual({ [serviceName]: '2.0.1' });
    expect(payload.subscription.subscriptionPlans).toEqual({ [serviceName]: 'PLATINUM' });
    expect(payload.subscription.contractVersion).toBe(await contractVersion());
  });

  it('follows novations (the cached token is invalidated)', async function () {
    const first = await token();
    await request(app)
      .put(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', orgKey)
      .send({
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'BASIC' },
        subscriptionAddOns: {},
      });

    const second = await token();

    expect(second.subscription.subscriptionPlans[serviceName]).toBe('BASIC');
    expect(second.subscription.contractVersion).not.toBe(first.subscription.contractVersion);
  });
  it('takes the subscription from the contract the evaluation used, not a later read', async function () {
    const featureEvaluationService = container.resolve('featureEvaluationService');
    const contractService = container.resolve('contractService');
    const originalShow = contractService.show.bind(contractService);
    const originalRetrieve = featureEvaluationService._retrieveContextsByUserId.bind(featureEvaluationService);
    let contextsRead = false;
    const retrieve = vi
      .spyOn(featureEvaluationService, '_retrieveContextsByUserId')
      .mockImplementation(async (...args: any[]) => {
        const contexts = await originalRetrieve(...args);
        contextsRead = true;
        return contexts;
      });
    // A novation that lands after the contexts were read: later reads see another plan.
    const show = vi.spyOn(contractService, 'show').mockImplementation(async (...args: any[]) => {
      const contract: any = await originalShow(...(args as [string, string?]));
      return contextsRead ? { ...contract, subscriptionPlans: { [serviceName]: 'PLATINUM' } } : contract;
    });
    try {
      const payload = await token();

      expect(payload.subscription.subscriptionPlans[serviceName]).toBe('GOLD');
    } finally {
      show.mockRestore();
      retrieve.mockRestore();
    }
  });

  it('follows billing period changes, also of groups (the cached token is invalidated)', async function () {
    const groupId = `group-${uuidv4()}`;
    await ContractMongoose.updateOne({ 'userContact.userId': userId }, { $set: { groupId } });
    await container.resolve('cacheService').del(contractCacheKey(organization.id!, userId));

    const first = await token();
    const single = await request(app)
      .put(`${baseUrl}/contracts/${userId}/billingPeriod`)
      .set('x-api-key', orgKey)
      .send({ renewalDays: 45 });
    expect(single.status).toBe(200);
    const afterSingle = await token();

    const group = await request(app)
      .put(`${baseUrl}/contracts/billingPeriod?groupId=${groupId}`)
      .set('x-api-key', orgKey)
      .send({ renewalDays: 60 });
    expect(group.status).toBe(200);
    const afterGroup = await token();

    expect(afterSingle.subscription.contractVersion).not.toBe(first.subscription.contractVersion);
    expect(afterGroup.subscription.contractVersion).not.toBe(afterSingle.subscription.contractVersion);
    expect(afterGroup.subscription.contractVersion).toBe(await contractVersion());
  });

  it('follows a service rename (the cached token is invalidated)', async function () {
    await token();
    const renamed = `renamed${uuidv4().slice(0, 8)}`;
    const response = await request(app).put(`${baseUrl}/services/${storedName}`).set('x-api-key', orgKey).send({ name: renamed });
    expect(response.status).toBe(200);

    const payload = await token();

    expect(Object.keys(payload.subscription.contractedServices)).toEqual([renamed.toLowerCase()]);
  });

  it('survives a novation preview, which changes nothing', async function () {
    const before = await rawToken();
    const preview = await request(app)
      .post(`${baseUrl}/contracts/${userId}/novation/preview`)
      .set('x-api-key', orgKey)
      .send({
        contractedServices: { [serviceName]: '2.0.1' },
        subscriptionPlans: { [serviceName]: 'PLATINUM' },
        subscriptionAddOns: {},
      });
    expect(preview.status).toBe(200);

    expect(await rawToken()).toBe(before);
  });
});
