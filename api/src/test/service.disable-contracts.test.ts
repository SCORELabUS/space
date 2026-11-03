import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { decodeJwt } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { contractCacheKey, featuresCacheKey } from '../main/utils/contracts/cacheKeys';
import { computeContractVersion } from '../main/utils/contracts/version';
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
  uploadPetclinicService,
  writePetclinicVariant,
} from './utils/services/petclinicVersions';

/**
 * Disabling a service (DELETE /services/{serviceName}) is reversible: uploading
 * a pricing with the same saasName enables it again. Contracts are therefore
 * left as they are, and every path that reads the services of a contract
 * treats a disabled one as dormant: its features are not available, the rest
 * of the contract works normally, and everything comes back when the service
 * is enabled again.
 *
 * Deleting services for good (DELETE /services, prune) removes them from every
 * contract of the organization.
 */

const A = 'petclinic';
const B = 'vetclinic';

describe('Disabled and deleted services in contracts', function () {
  let app: Server;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let orgKey: string;
  let userId: string;

  const vetclinicFile = (version = '1.0', createdAt = '2025-01-01') =>
    writePetclinicVariant(version, createdAt, pricing => {
      pricing.saasName = 'Vetclinic';
    });

  const contractOf = async (id = userId) => {
    const response = await request(app).get(`${baseUrl}/contracts/${id}`).set('x-api-key', orgKey);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body;
  };
  const stored = async (id = userId) =>
    ContractMongoose.findOne({ organizationId: organization.id, 'userContact.userId': id }).lean() as any;
  const evaluate = (query = '') =>
    request(app).post(`${baseUrl}/features/${userId}${query}`).set('x-api-key', orgKey);
  const evaluateFeature = (featureId: string, body: any = {}, query = '') =>
    request(app).post(`${baseUrl}/features/${userId}/${featureId}${query}`).set('x-api-key', orgKey).send(body);
  const disable = (name = 'Vetclinic') =>
    request(app).delete(`${baseUrl}/services/${name}`).set('x-api-key', orgKey);
  const reenable = (file = vetclinicFile('2.0', '2025-06-01')) =>
    request(app).post(`${baseUrl}/services`).set('x-api-key', orgKey).attach('pricing', file);
  const tokenPayload = async () => {
    const response = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', orgKey);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return decodeJwt(response.body.pricingToken) as any;
  };
  const featuresOf = (evaluation: Record<string, unknown>, service: string) =>
    Object.keys(evaluation).filter(featureId => featureId.startsWith(`${service}-`));

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
        subscriptionAddOns: { [B]: { extraPets: 2 } },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  afterEach(async function () {
    vi.restoreAllMocks();
    await ContractMongoose.deleteMany({ organizationId: organization.id });
    await PricingMongoose.deleteMany({ _organizationId: organization.id });
    await ServiceMongoose.deleteMany({ organizationId: organization.id });
    await deleteTestOrganization(organization.id!);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('disable (reversible): the service is dormant in contracts', function () {
    it('leaves the contract as it is', async function () {
      const before = await contractOf();

      const response = await disable();
      const after = await contractOf();

      expect(response.status).toBe(204);
      expect(after.contractedServices).toEqual(before.contractedServices);
      expect(after.subscriptionPlans).toEqual(before.subscriptionPlans);
      expect(after.subscriptionAddOns).toEqual(before.subscriptionAddOns);
      expect(after.usageLevels).toEqual(before.usageLevels);
      expect(after.contractVersion).toBe(before.contractVersion);
    });

    it('still archives the pricings of the service and announces SERVICE_DISABLED', async function () {
      const events = container.resolve('eventService');
      const spy = vi.spyOn(events, 'emitServiceDisabledMessage');

      expect((await disable()).status).toBe(204);

      const service: any = await ServiceMongoose.findOne({ organizationId: organization.id, name: 'Vetclinic' }).lean();
      expect(service.disabled).toBe(true);
      expect(Object.keys(service.activePricings ?? {})).toEqual([]);
      expect(Object.keys(service.archivedPricings ?? {})).toContain('1_0');
      expect(spy).toHaveBeenCalledWith('Vetclinic');
    });

    it('evaluates the other services of the contract and leaves out the features of the disabled one', async function () {
      const before = await evaluate();
      expect(before.status).toBe(200);
      expect(featuresOf(before.body, B).length).toBeGreaterThan(0);

      await disable();
      const after = await evaluate();
      const detailed = await evaluate('?details=true');

      expect(after.status, JSON.stringify(after.body)).toBe(200);
      expect(featuresOf(after.body, B)).toEqual([]);
      expect(featuresOf(after.body, A)).toEqual(featuresOf(before.body, A));
      for (const featureId of featuresOf(before.body, A)) expect(after.body[featureId]).toBe(before.body[featureId]);
      expect(detailed.status).toBe(200);
      expect(detailed.body[`${A}-pets`].eval).toBe(true);
      expect(featuresOf(detailed.body, B)).toEqual([]);
    });

    it('evaluates a feature of another service normally', async function () {
      await disable();

      const response = await evaluateFeature(`${A}-pets`);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.eval).toBe(true);
      expect(response.body.error).toBeNull();
    });

    it('reports a feature of the disabled service as not available, with the reason', async function () {
      await disable();

      const response = await evaluateFeature(`${B}-pets`);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.eval).toBe(false);
      expect(response.body.error.code).toBe('SERVICE_DISABLED');
      expect(response.body.error.message).toContain(B);
    });

    it('drops cached evaluations when the service is disabled', async function () {
      expect((await evaluateFeature(`${B}-vetSelection`)).body.eval).toBe(true);
      const cacheService = container.resolve('cacheService');
      expect(await cacheService.get(featuresCacheKey(organization.id!, userId, `eval.${B}-vetSelection`))).not.toBeNull();

      await disable();

      expect(await cacheService.get(featuresCacheKey(organization.id!, userId, `eval.${B}-vetSelection`))).toBeNull();
      expect((await evaluateFeature(`${B}-vetSelection`)).body.error.code).toBe('SERVICE_DISABLED');
    });

    it('refuses consumption on a feature of the disabled service and records nothing', async function () {
      await disable();

      const consumed = await evaluateFeature(`${B}-pets`, { [`${B}-maxPets`]: 1 });
      const revert = await evaluateFeature(`${B}-pets`, {}, '?revert=true');
      const increment = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels`)
        .set('x-api-key', orgKey)
        .send({ [B]: { maxPets: 1 } });

      expect(consumed.status).toBe(200);
      expect(consumed.body.eval).toBe(false);
      expect(consumed.body.error.code).toBe('SERVICE_DISABLED');
      expect(revert.status).toBe(409);
      expect(revert.body.code).toBe('SERVICE_DISABLED');
      expect(increment.status).toBe(409);
      expect(increment.body.code).toBe('SERVICE_DISABLED');
      expect((await stored()).usageLevels[B].maxPets.consumed).toBe(0);
    });

    it('keeps consumption and usage level resets working for the other services', async function () {
      await disable();

      const consumed = await evaluateFeature(`${A}-pets`, { [`${A}-maxPets`]: 1 });
      const increment = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels`)
        .set('x-api-key', orgKey)
        .send({ [A]: { maxPets: 1 } });

      expect(consumed.status, JSON.stringify(consumed.body)).toBe(200);
      expect(consumed.body.eval).toBe(true);
      expect(increment.status, JSON.stringify(increment.body)).toBe(200);
      expect((await stored()).usageLevels[A].maxPets.consumed).toBe(2);

      await ContractMongoose.updateOne(
        { organizationId: organization.id, 'userContact.userId': userId },
        { $set: { [`usageLevels.${B}.maxVisits.consumed`]: 2 } }
      );
      await container.resolve('cacheService').del(contractCacheKey(organization.id!, userId));
      const reset = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels?reset=true&renewableOnly=false`)
        .set('x-api-key', orgKey);
      const byLimit = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels?usageLimit=maxVisits`)
        .set('x-api-key', orgKey);

      expect(reset.status, JSON.stringify(reset.body)).toBe(200);
      expect(byLimit.status, JSON.stringify(byLimit.body)).toBe(200);
      const contract = await stored();
      expect(contract.usageLevels[A].maxPets.consumed).toBe(0);
      // The dormant service's usage levels are left as they are.
      expect(contract.usageLevels[B].maxVisits.consumed).toBe(2);
    });

    it('does not fail when a usage level of the disabled service is due for renewal', async function () {
      await disable();
      await ContractMongoose.updateOne(
        { organizationId: organization.id, 'userContact.userId': userId },
        {
          $set: {
            [`usageLevels.${B}.maxVisits.consumed`]: 2,
            [`usageLevels.${B}.maxVisits.resetTimeStamp`]: new Date(Date.now() - 60_000),
          },
        }
      );
      await container.resolve('cacheService').del(contractCacheKey(organization.id!, userId));

      const response = await evaluate();

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((await stored()).usageLevels[B].maxVisits.consumed).toBe(2);
    });

    it('issues a pricing token without the features of the disabled service', async function () {
      await disable();

      const payload = await tokenPayload();

      expect(featuresOf(payload.features, A).length).toBeGreaterThan(0);
      expect(featuresOf(payload.features, B)).toEqual([]);
      expect(payload.dormantServices).toEqual([B]);
      // The subscription claim is the contract, which still has the service.
      expect(payload.subscription.contractedServices).toEqual({ [A]: PETCLINIC_BASE_VERSION, [B]: '1.0' });
      expect(payload.subscription.contractVersion).toBe((await contractOf()).contractVersion);
    });

    it('drops cached pricing tokens when the service is disabled', async function () {
      expect(featuresOf((await tokenPayload()).features, B).length).toBeGreaterThan(0);

      await disable();

      expect(featuresOf((await tokenPayload()).features, B)).toEqual([]);
    });

    it('rejects an active token cached after a concurrent disable invalidated the cache', async function () {
      const cache = container.resolve('cacheService');
      const original = cache.set.bind(cache);
      const tokenKey = featuresCacheKey(organization.id!, userId, 'pricingToken');
      let interleaved = false;
      vi.spyOn(cache, 'set').mockImplementation(async (...args: Parameters<typeof cache.set>) => {
        if (!interleaved && args[0] === tokenKey) {
          interleaved = true;
          expect((await disable()).status).toBe(204);
        }
        return original(...args);
      });

      // This request evaluated before the disable, but stores its token after it.
      const inFlight = await tokenPayload();
      expect(interleaved).toBe(true);
      expect(featuresOf(inFlight.features, B).length).toBeGreaterThan(0);
      const next = await tokenPayload();
      expect(next.dormantServices).toEqual([B]);
      expect(featuresOf(next.features, B)).toEqual([]);
    });

    it('rejects a dormant token cached after a concurrent reactivation invalidated the cache', async function () {
      expect((await disable()).status).toBe(204);
      const cache = container.resolve('cacheService');
      const original = cache.set.bind(cache);
      const tokenKey = featuresCacheKey(organization.id!, userId, 'pricingToken');
      let interleaved = false;
      vi.spyOn(cache, 'set').mockImplementation(async (...args: Parameters<typeof cache.set>) => {
        if (!interleaved && args[0] === tokenKey) {
          interleaved = true;
          const enabled = await reenable();
          expect(enabled.status, JSON.stringify(enabled.body)).toBe(201);
        }
        return original(...args);
      });

      const inFlight = await tokenPayload();
      expect(interleaved).toBe(true);
      expect(inFlight.dormantServices).toEqual([B]);
      const next = await tokenPayload();
      expect(next.dormantServices).toBeUndefined();
      expect(featuresOf(next.features, B).length).toBeGreaterThan(0);
    });

    it('does not reuse an active feature evaluation cached after a concurrent disable', async function () {
      const cache = container.resolve('cacheService');
      const original = cache.set.bind(cache);
      const featureId = `${B}-vetSelection`;
      const evaluationKey = featuresCacheKey(organization.id!, userId, `eval.${featureId}`);
      let interleaved = false;
      vi.spyOn(cache, 'set').mockImplementation(async (...args: Parameters<typeof cache.set>) => {
        if (!interleaved && args[0] === evaluationKey) {
          interleaved = true;
          expect((await disable()).status).toBe(204);
        }
        return original(...args);
      });
      const evaluator = container.resolve('featureEvaluationService');
      const before = await stored();
      // Omitted expected consumption exercises the service's cached read path.
      const inFlight: any = await evaluator.evalFeature(userId, featureId, undefined as any, organization, { server: false });
      expect(interleaved).toBe(true);
      expect(inFlight.eval).toBe(true);
      const next: any = await evaluator.evalFeature(userId, featureId, undefined as any, organization, { server: false });
      expect(next.eval).toBe(false);
      expect(next.error.code).toBe('SERVICE_DISABLED');
      expect((await stored()).usageLevels[B]).toEqual(before.usageLevels[B]);
    });

    it('marks the disabled service in the pricings of the contract', async function () {
      await disable();

      const response = await request(app).get(`${baseUrl}/contracts/${userId}/pricings`).set('x-api-key', orgKey);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.services[A].serviceStatus).toBe('enabled');
      expect(response.body.services[B]).toMatchObject({
        version: '1.0',
        status: 'archived',
        serviceStatus: 'disabled',
        newContractsVersion: null,
        plan: 'GOLD',
        addOns: { extraPets: 2 },
      });
    });

    it('lets a novation keep the disabled service unchanged and novate the rest', async function () {
      await disable();
      const body = {
        contractedServices: { [A]: PETCLINIC_BASE_VERSION, [B]: '1.0' },
        subscriptionPlans: { [A]: 'PLATINUM', [B]: 'GOLD' },
        subscriptionAddOns: { [B]: { extraPets: 2 } },
      };

      const preview = await request(app)
        .post(`${baseUrl}/contracts/${userId}/novation/preview`)
        .set('x-api-key', orgKey)
        .send(body);
      const novated = await request(app).put(`${baseUrl}/contracts/${userId}`).set('x-api-key', orgKey).send(body);

      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect(preview.body.valid).toBe(true);
      expect(preview.body.dormantServices).toEqual([B]);
      expect(novated.status, JSON.stringify(novated.body)).toBe(200);
      expect(novated.body.subscriptionPlans).toEqual({ [A]: 'PLATINUM', [B]: 'GOLD' });
      expect((await stored()).usageLevels[B]).toBeDefined();
    });

    it('refuses novations that change or add a subscription to a disabled service', async function () {
      await disable();
      const changePlan = {
        contractedServices: { [A]: PETCLINIC_BASE_VERSION, [B]: '1.0' },
        subscriptionPlans: { [A]: 'GOLD', [B]: 'PLATINUM' },
        subscriptionAddOns: {},
      };

      const preview = await request(app)
        .post(`${baseUrl}/contracts/${userId}/novation/preview`)
        .set('x-api-key', orgKey)
        .send(changePlan);
      const novated = await request(app).put(`${baseUrl}/contracts/${userId}`).set('x-api-key', orgKey).send(changePlan);
      const created = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', orgKey)
        .send({
          userContact: { userId: uuidv4(), username: 'newcomer' },
          contractedServices: { [B]: '1.0' },
          subscriptionPlans: { [B]: 'GOLD' },
          subscriptionAddOns: {},
        });

      expect(preview.status).toBe(200);
      expect(preview.body.valid).toBe(false);
      expect(preview.body.errors.map((e: any) => [e.code, e.service])).toContainEqual(['VERSION_NOT_FOUND', B]);
      expect(preview.body.errors.find((e: any) => e.service === B).message).toContain('disabled');
      // As before: a novation whose only problems are missing versions is 404, a new contract 400.
      expect(novated.status).toBe(404);
      expect(created.status).toBe(400);
      expect((await contractOf()).subscriptionPlans[B]).toBe('GOLD');
    });

    it('restores everything when the service is enabled again', async function () {
      await evaluateFeature(`${B}-pets`, { [`${B}-maxPets`]: 3 });
      const before = await contractOf();
      expect(before.usageLevels[B].maxPets.consumed).toBe(3);

      await disable();
      expect(featuresOf((await evaluate()).body, B)).toEqual([]);
      const enabled = await reenable();
      expect(enabled.status, JSON.stringify(enabled.body)).toBe(201);

      const after = await contractOf();
      const evaluation = await evaluate('?details=true');
      const feature = await evaluateFeature(`${B}-pets`);
      const token = await tokenPayload();

      expect(after.contractedServices).toEqual(before.contractedServices);
      expect(after.subscriptionPlans).toEqual(before.subscriptionPlans);
      expect(after.subscriptionAddOns).toEqual(before.subscriptionAddOns);
      expect(after.usageLevels[B].maxPets.consumed).toBe(3);
      expect(after.contractVersion).toBe(before.contractVersion);
      expect(evaluation.status, JSON.stringify(evaluation.body)).toBe(200);
      expect(evaluation.body[`${B}-pets`].eval).toBe(true);
      expect(evaluation.body[`${B}-pets`].used).toEqual({ [`${B}-maxPets`]: 3 });
      expect(feature.body.eval).toBe(true);
      expect(token.dormantServices).toBeUndefined();
      expect(featuresOf(token.features, B).length).toBeGreaterThan(0);

      const pricings = await request(app).get(`${baseUrl}/contracts/${userId}/pricings`).set('x-api-key', orgKey);
      expect(pricings.body.services[B]).toMatchObject({ version: '1.0', status: 'archived', serviceStatus: 'enabled', newContractsVersion: '2.0' });
    });

    it('treats a service the organization no longer has as dormant too', async function () {
      // Contracts written before deleting a service removed it from them.
      await ContractMongoose.updateOne(
        { organizationId: organization.id, 'userContact.userId': userId },
        { $set: { 'contractedServices.ghost': '1_0', 'subscriptionPlans.ghost': 'GOLD' } }
      );
      await container.resolve('cacheService').del(contractCacheKey(organization.id!, userId));

      const evaluation = await evaluate();
      const feature = await evaluateFeature('ghost-pets');
      const pricings = await request(app).get(`${baseUrl}/contracts/${userId}/pricings`).set('x-api-key', orgKey);

      expect(evaluation.status, JSON.stringify(evaluation.body)).toBe(200);
      expect(featuresOf(evaluation.body, A).length).toBeGreaterThan(0);
      expect(featuresOf(evaluation.body, 'ghost')).toEqual([]);
      expect(feature.body.error.code).toBe('SERVICE_NOT_FOUND');
      expect(pricings.body.services.ghost.serviceStatus).toBe('not-found');
    });
  });

  describe('deletion (irreversible): the service is removed from every contract', function () {
    const insertContracts = async (count: number, services: Record<string, string>, extra: (i: number) => any = () => ({})) => {
      const now = Date.now();
      const docs = Array.from({ length: count }, (_, i) => ({
        userContact: { userId: `bulk-${i}-${uuidv4()}`, username: `bulk${String(i).padStart(3, '0')}` },
        billingPeriod: { startDate: new Date(now - 86_400_000), endDate: new Date(now + 29 * 86_400_000), autoRenew: true, renewalDays: 30 },
        organizationId: organization.id,
        contractedServices: services,
        subscriptionPlans: Object.fromEntries(Object.keys(services).map(service => [service, 'GOLD'])),
        subscriptionAddOns: Object.fromEntries(Object.keys(services).map(service => [service, { extraPets: 1 }])),
        usageLevels: Object.fromEntries(Object.keys(services).map(service => [service, { maxPets: { consumed: i } }])),
        history: [],
        ...extra(i),
      }));
      await ContractMongoose.insertMany(docs);
      return docs.map(doc => doc.userContact.userId);
    };

    it('removes a deleted service from every contract of the organization, beyond the first page, whatever its case', async function () {
      const both = await insertContracts(23, { [A]: PETCLINIC_BASE_VERSION, [B]: '1_0' });
      const mixedCase = await insertContracts(2, { [A]: PETCLINIC_BASE_VERSION, VetClinic: '1_0' });
      const versions = new Map<string, string>();
      for (const id of [...both, ...mixedCase]) versions.set(id, computeContractVersion(await stored(id)));
      const events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');

      await container.resolve('serviceService').destroy('vetclinic', organization.id!);

      for (const id of [userId, ...both, ...mixedCase]) {
        const contract = await stored(id);
        for (const field of ['contractedServices', 'subscriptionPlans', 'subscriptionAddOns', 'usageLevels']) {
          expect(Object.keys(contract[field] ?? {}).map(key => key.toLowerCase()), `${field} of ${id}`).not.toContain(B);
        }
        expect(Object.keys(contract.contractedServices)).toEqual([A]);
        expect(contract.subscriptionPlans[A]).toBe('GOLD');
        expect(contract.usageLevels[A]).toBeDefined();
        expect(contract.billingPeriod.autoRenew).toBe(true);
        expect(Object.keys(contract.history.at(-1).contractedServices).map(key => key.toLowerCase())).toContain(B);
      }
      for (const id of [...both, ...mixedCase]) {
        expect(computeContractVersion(await stored(id))).not.toBe(versions.get(id));
      }
      const novated = events.mock.calls.filter(([code]) => code === 'CONTRACT_NOVATED').map(([, contract]) => (contract as any).userContact.userId);
      expect(novated.sort()).toEqual([userId, ...both, ...mixedCase].sort());
      expect(await ServiceMongoose.exists({ organizationId: organization.id, name: 'Vetclinic' })).toBeNull();
    });

    it('keeps a contract left without services, emptied and ended, and announces it', async function () {
      const onlyB = await insertContracts(2, { [B]: '1_0' });
      const events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');

      await container.resolve('serviceService').destroy('Vetclinic', organization.id!);

      for (const id of onlyB) {
        const contract = await stored(id);
        expect(contract).not.toBeNull();
        expect(contract.contractedServices ?? {}).toEqual({});
        expect(contract.subscriptionPlans ?? {}).toEqual({});
        expect(contract.subscriptionAddOns ?? {}).toEqual({});
        expect(contract.usageLevels ?? {}).toEqual({});
        expect(contract.billingPeriod.autoRenew).toBe(false);
        expect(new Date(contract.billingPeriod.endDate).getTime()).toBeLessThanOrEqual(Date.now());
        expect(contract.billingPeriod.renewalDays).toBe(30);
        expect(contract.history.at(-1).contractedServices).toEqual({ [B]: '1_0' });
      }
      const codes = events.mock.calls.filter(([, contract]) => onlyB.includes((contract as any).userContact.userId)).map(([code]) => code);
      expect(codes).toEqual(['CONTRACT_NOVATED', 'CONTRACT_NOVATED']);
    });

    it('prunes the services of the organization and removes them from all its contracts', async function () {
      const bulk = await insertContracts(22, { [A]: PETCLINIC_BASE_VERSION, [B]: '1_0' });
      await disable();
      const cacheService = container.resolve('cacheService');
      await evaluateFeature(`${A}-pets`);
      await tokenPayload();
      expect(await cacheService.get(contractCacheKey(organization.id!, userId))).not.toBeNull();
      expect(await cacheService.get(featuresCacheKey(organization.id!, userId, 'pricingToken'))).not.toBeNull();
      const events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');

      const response = await request(app).delete(`${baseUrl}/services`).set('x-api-key', orgKey);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await ServiceMongoose.countDocuments({ organizationId: organization.id })).toBe(0);
      for (const id of [userId, ...bulk]) {
        const contract = await stored(id);
        expect(contract.contractedServices ?? {}).toEqual({});
        expect(contract.usageLevels ?? {}).toEqual({});
        expect(contract.billingPeriod.autoRenew).toBe(false);
      }
      expect(events.mock.calls.filter(([code]) => code === 'CONTRACT_NOVATED')).toHaveLength(bulk.length + 1);
      expect(await cacheService.get(contractCacheKey(organization.id!, userId))).toBeNull();
      expect(await cacheService.get(featuresCacheKey(organization.id!, userId, 'pricingToken'))).toBeNull();
      expect(await cacheService.get(featuresCacheKey(organization.id!, userId, `eval.${A}-pets`))).toBeNull();
      expect((await evaluate()).status).toBe(400);
    });

    it('does not write over a contract that changed after it was read', async function () {
      const repository = container.resolve('contractRepository');
      const read = await stored();
      await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', orgKey)
        .send({
          contractedServices: { [A]: PETCLINIC_BASE_VERSION, [B]: '1.0' },
          subscriptionPlans: { [A]: 'PLATINUM', [B]: 'GOLD' },
          subscriptionAddOns: {},
        });

      const written = await repository.removeServicesFromContract(read, [B]);

      expect(written).toBeNull();
      const contract = await stored();
      expect(contract.contractedServices[B]).toBe('1_0');
      expect(contract.subscriptionPlans[A]).toBe('PLATINUM');
    });

    it('retries a contract that changed meanwhile and still removes the service', async function () {
      const repository = container.resolve('contractRepository');
      const original = repository.removeServicesFromContract.bind(repository);
      let first = true;
      vi.spyOn(repository, 'removeServicesFromContract').mockImplementation(async (contract: any, services: any) => {
        if (first) {
          first = false;
          // A novation lands between the read and the write.
          await ContractMongoose.updateOne(
            { organizationId: contract.organizationId, 'userContact.userId': contract.userContact.userId },
            { $set: { [`subscriptionPlans.${A}`]: 'PLATINUM' }, $push: { history: { startDate: new Date(), endDate: new Date() } } }
          );
        }
        return original(contract, services);
      });

      await container.resolve('serviceService').destroy('Vetclinic', organization.id!);

      const contract = await stored();
      expect(contract.contractedServices[B]).toBeUndefined();
      expect(contract.subscriptionPlans[A]).toBe('PLATINUM');
    });

    it('prunes only the named organization when a platform ADMIN uses the organization route', async function () {
      const admin = await createTestUser('ADMIN', `admin_${uuidv4()}`);
      const otherOwner = await createTestUser('USER', `other_${uuidv4()}`);
      const other = await createTestOrganization(otherOwner.username);
      const otherKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(other.id!, { key: otherKey, scope: 'ALL' });
      await uploadPetclinicService(app, otherKey);
      try {
        const response = await request(app)
          .delete(`${baseUrl}/organizations/${organization.id}/services`)
          .set('x-api-key', admin.apiKey);

        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(await ServiceMongoose.countDocuments({ organizationId: organization.id })).toBe(0);
        expect(await ServiceMongoose.countDocuments({ organizationId: other.id })).toBe(1);
        expect((await stored()).contractedServices ?? {}).toEqual({});
      } finally {
        await PricingMongoose.deleteMany({ _organizationId: other.id });
        await ServiceMongoose.deleteMany({ organizationId: other.id });
        await deleteTestOrganization(other.id!);
        await deleteTestUser(otherOwner.username);
        await deleteTestUser(admin.username);
      }
    });

    it('reports a failure to update contracts and deletes nothing', async function () {
      const repository = container.resolve('contractRepository');
      vi.spyOn(repository, 'removeServicesFromContract').mockRejectedValue(new Error('write failed'));

      const response = await request(app).delete(`${baseUrl}/services`).set('x-api-key', orgKey);

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('write failed');
      expect(await ServiceMongoose.countDocuments({ organizationId: organization.id })).toBe(2);
    });
  });
});
