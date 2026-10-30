import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
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
import UsageConsumptionMongoose from '../main/repositories/mongoose/models/UsageConsumptionMongoose';
import {
  PETCLINIC_BASE_VERSION,
  uploadPetclinicService,
  writePetclinicVariant,
} from './utils/services/petclinicVersions';

/**
 * Consumption records (`consumptionId`) and disabled services.
 *
 * A disabled service is dormant in the contracts that have it: its features
 * are not available, nothing of it is consumed, and its usage levels are kept
 * as they are until it is enabled again; a revert on it answers
 * `409 SERVICE_DISABLED`. That holds for consumptions applied through a
 * consumption record too: nothing is consumed or recorded on a dormant
 * service, a recorded consumption made before the service was disabled is not
 * reverted while it is dormant (by id or not), and the same revert applies
 * exactly once the service is enabled again.
 *
 * Petclinic and "Vetclinic" (the same pricing under another saasName), both
 * GOLD: maxPets 4 (+1 per extraPets).
 */
const A = 'petclinic';
const B = 'vetclinic';

describe('Consumption records on disabled services', function () {
  let app: Server;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let orgKey: string;
  let userId: string;

  const vetclinicFile = (version = '1.0', createdAt = '2025-01-01') =>
    writePetclinicVariant(version, createdAt, pricing => {
      pricing.saasName = 'Vetclinic';
    });

  const consume = (featureId: string, body: Record<string, number>) =>
    request(app).post(`${baseUrl}/features/${userId}/${featureId}`).set('x-api-key', orgKey).send(body);
  const revert = (featureId: string, query = '') =>
    request(app).post(`${baseUrl}/features/${userId}/${featureId}?revert=true${query}`).set('x-api-key', orgKey);
  const disable = () => request(app).delete(`${baseUrl}/services/Vetclinic`).set('x-api-key', orgKey);
  const reenable = () =>
    request(app).post(`${baseUrl}/services`).set('x-api-key', orgKey).attach('pricing', vetclinicFile('2.0', '2025-06-01'));

  /** Usage level as stored, never a cached copy. */
  const consumed = async (service: string, limit = 'maxPets') => {
    const stored: any = await ContractMongoose.findOne({
      organizationId: organization.id,
      'userContact.userId': userId,
    }).lean();
    return stored.usageLevels[service][limit].consumed;
  };
  const records = () => UsageConsumptionMongoose.find({ organizationId: organization.id, userId }).lean();

  /** Consume `amount` pets of `service` and return the consumptionId. */
  const consumePets = async (service: string, amount: number) => {
    const response = await consume(`${service}-pets`, { [`${service}-maxPets`]: amount });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.eval).toBe(true);
    expect(typeof response.body.consumptionId).toBe('string');
    return response.body.consumptionId as string;
  };

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    owner = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    orgKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: orgKey, scope: 'ALL' });
    await uploadPetclinicService(app, orgKey);
    await uploadPetclinicService(app, orgKey, vetclinicFile());

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', orgKey)
      .send({
        userContact: { userId, username: 'two-services' },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: { [A]: PETCLINIC_BASE_VERSION, [B]: '1.0' },
        subscriptionPlans: { [A]: 'GOLD', [B]: 'GOLD' },
        subscriptionAddOns: {},
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  afterEach(async function () {
    vi.restoreAllMocks();
    await UsageConsumptionMongoose.deleteMany({ organizationId: organization.id });
    await ContractMongoose.deleteMany({ organizationId: organization.id });
    await PricingMongoose.deleteMany({ _organizationId: organization.id });
    await ServiceMongoose.deleteMany({ organizationId: organization.id });
    await deleteTestOrganization(organization.id!);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  it('consumes nothing and records no consumption on a feature of a disabled service', async function () {
    expect((await disable()).status).toBe(204);

    const response = await consume(`${B}-pets`, { [`${B}-maxPets`]: 1 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.eval).toBe(false);
    expect(response.body.error?.code).toBe('SERVICE_DISABLED');
    expect(response.body.consumptionId).toBeUndefined();
    expect(await consumed(B)).toBe(0);
    expect(await records()).toEqual([]);

    // The other service of the contract consumes and records as usual.
    await consumePets(A, 1);
    expect(await consumed(A)).toBe(1);
    expect((await records()).map(record => record.featureId)).toEqual([`${A}-pets`]);
  });

  it('refuses to revert by consumptionId a consumption made before the service was disabled', async function () {
    const consumptionId = await consumePets(B, 2);
    expect((await disable()).status).toBe(204);

    const response = await revert(`${B}-pets`, `&consumptionId=${consumptionId}`);

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe('SERVICE_DISABLED');
    expect(response.body.service).toBe(B);
    // Nothing changed, and the consumption is still there to revert.
    expect(await consumed(B)).toBe(2);
    const [record] = await records();
    expect(record._id).toBe(consumptionId);
    expect(record.revertedAt).toBeUndefined();
  });

  it('refuses the legacy revert of a recent consumption made before the service was disabled', async function () {
    await consumePets(B, 2);
    expect((await disable()).status).toBe(204);

    const response = await revert(`${B}-pets`, '&latest=true');

    expect(response.status, JSON.stringify(response.body)).toBe(409);
    expect(response.body.code).toBe('SERVICE_DISABLED');
    expect(await consumed(B)).toBe(2);
    expect((await records())[0].revertedAt).toBeUndefined();
  });

  it('reverts exactly that consumption once the service is enabled again', async function () {
    const first = await consumePets(B, 2);
    await consumePets(B, 1);
    expect((await disable()).status).toBe(204);
    expect((await revert(`${B}-pets`, `&consumptionId=${first}`)).status).toBe(409);

    const enabled = await reenable();
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(201);
    const reverted = await revert(`${B}-pets`, `&consumptionId=${first}`);
    const again = await revert(`${B}-pets`, `&consumptionId=${first}`);

    expect(reverted.status, JSON.stringify(reverted.body)).toBe(204);
    expect(again.status, JSON.stringify(again.body)).toBe(204);
    // 2 + 1 consumed, the first one (2) taken back once.
    expect(await consumed(B)).toBe(1);
  });

  it('does not write the usage levels of a disabled service when resetting usage levels', async function () {
    await consumePets(A, 1);
    await consumePets(B, 2);
    expect((await disable()).status).toBe(204);
    const contractRepository = container.resolve('contractRepository');
    const setUsageLevels = vi.spyOn(contractRepository, 'setUsageLevels');

    const reset = await request(app)
      .put(`${baseUrl}/contracts/${userId}/usageLevels?reset=true&renewableOnly=false`)
      .set('x-api-key', orgKey);
    const byLimit = await request(app)
      .put(`${baseUrl}/contracts/${userId}/usageLevels?usageLimit=maxPets`)
      .set('x-api-key', orgKey);

    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(byLimit.status, JSON.stringify(byLimit.body)).toBe(200);
    const written = setUsageLevels.mock.calls.flatMap(([, , levels]) => Object.keys(levels as object));
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter(path => path.toLowerCase().startsWith(`${B}.`))).toEqual([]);
    expect(await consumed(A)).toBe(0);
    expect(await consumed(B)).toBe(2);
  });
});
