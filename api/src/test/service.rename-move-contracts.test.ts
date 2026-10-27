import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { v4 as uuidv4 } from 'uuid';
import { io, Socket } from 'socket.io-client';
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
import { PETCLINIC_BASE_VERSION, uploadPetclinicService, writePetclinicVariant } from './utils/services/petclinicVersions';

/**
 * Renaming a service (`PUT /services/{serviceName}` with `name`) renames it in
 * every contract of the organization; moving it (`organizationId`) moves the
 * contracts that only have it and removes it from the others. Every contract
 * is handled (not a page), with conditional targeted writes, contract events
 * in the organizations concerned and cache invalidation.
 */

const A = 'petclinic';
const B = 'vetclinic';
const RENAMED = 'vetcare';
const MAPS = ['contractedServices', 'subscriptionPlans', 'subscriptionAddOns', 'usageLevels'] as const;

type ContractEvent = {
  code: string;
  details: { userId: string; organizationId: string; contractVersion: string | null; services: string[] };
};

describe('Renaming and moving services: contracts', function () {
  let app: Server;
  let url: string;
  let owner: LeanUser;
  let source: LeanOrganization;
  let target: LeanOrganization;
  let sourceKey: string;
  let targetKey: string;
  let userId: string;
  const sockets: Socket[] = [];

  const vetclinicFile = (saasName = 'Vetclinic', version = '1.0') =>
    writePetclinicVariant(version, '2025-01-01', pricing => {
      pricing.saasName = saasName;
    });

  const stored = async (id: string, organizationId = source.id) =>
    ContractMongoose.findOne({ organizationId, 'userContact.userId': id }).lean() as any;
  const keysOf = (contract: any, field: string) => Object.keys(contract?.[field] ?? {}).map(key => key.toLowerCase());
  const update = (body: any, name = 'Vetclinic', key = sourceKey) =>
    request(app).put(`${baseUrl}/services/${name}`).set('x-api-key', key).send(body);
  const contractEvents = (spy: any) =>
    spy.mock.calls.map(([code, contract]: any[]) => ({
      code,
      userId: contract.userContact.userId,
      organizationId: String(contract.organizationId),
      services: Object.keys(contract.contractedServices ?? {}),
    }));

  /** Contracts inserted directly (as many as needed, beyond the first page of 20). */
  const insertContracts = async (
    count: number,
    services: Record<string, string>,
    organizationId = source.id,
    prefix = 'bulk'
  ) => {
    const now = Date.now();
    const docs = Array.from({ length: count }, (_, i) => ({
      userContact: { userId: `${prefix}-${i}-${uuidv4()}`, username: `${prefix}${String(i).padStart(3, '0')}` },
      billingPeriod: { startDate: new Date(now - 86_400_000), endDate: new Date(now + 29 * 86_400_000), autoRenew: true, renewalDays: 30 },
      organizationId,
      contractedServices: services,
      subscriptionPlans: Object.fromEntries(Object.keys(services).map(service => [service, 'GOLD'])),
      subscriptionAddOns: Object.fromEntries(Object.keys(services).map(service => [service, { extraPets: 1 }])),
      usageLevels: Object.fromEntries(Object.keys(services).map(service => [service, { maxPets: { consumed: i } }])),
      history: [],
    }));
    await ContractMongoose.insertMany(docs);
    return docs.map(doc => doc.userContact.userId);
  };

  /**
   * Make a change land between the read of a contract and its write: after the
   * first read of `id` (whichever repository method the service uses), apply
   * `change` to the stored contract and hand back the stale read.
   */
  const changeAfterRead = (id: string, change: Record<string, any>) => {
    const repository = container.resolve('contractRepository');
    let pending = true;
    const inject = async () => {
      if (!pending) return;
      pending = false;
      await ContractMongoose.updateOne({ organizationId: source.id, 'userContact.userId': id }, change);
    };
    const byUserId = repository.findByUserId.bind(repository);
    vi.spyOn(repository, 'findByUserId').mockImplementation(async (...args: any[]) => {
      const [requested, organizationId] = args as [string, string];
      const read = await byUserId(requested, organizationId);
      if (requested === id && organizationId === source.id) await inject();
      return read;
    });
    const byFilters = repository.findByFilters.bind(repository);
    vi.spyOn(repository, 'findByFilters').mockImplementation(async (...args: any[]) => {
      const read = await byFilters(args[0]);
      if (read.some((contract: any) => contract.userContact.userId === id)) await inject();
      return read;
    });
    return () => pending;
  };

  const connect = (apiKey: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(`${url}/contracts`, {
        path: '/events',
        transports: ['websocket'],
        auth: { apiKey },
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('connection timeout')), 3000);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });
  const collect = (socket: Socket) => {
    const events: ContractEvent[] = [];
    socket.on('message', (event: ContractEvent) => events.push(event));
    return events;
  };
  const waitFor = async (events: ContractEvent[], predicate: (event: ContractEvent) => boolean, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`event not received; got ${JSON.stringify(events)}`);
  };

  beforeAll(async function () {
    app = await getApp();
    url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });

  beforeEach(async function () {
    owner = await createTestUser('USER', `owner_${uuidv4()}`);
    source = await createTestOrganization(owner.username);
    target = await createTestOrganization(owner.username);
    sourceKey = generateOrganizationApiKey();
    targetKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(source.id!, { key: sourceKey, scope: 'ALL' });
    await addApiKeyToOrganization(target.id!, { key: targetKey, scope: 'ALL' });
    await uploadPetclinicService(app, sourceKey);
    await uploadPetclinicService(app, sourceKey, vetclinicFile());

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', sourceKey)
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
    for (const socket of sockets.splice(0)) socket.close();
    for (const organization of [source, target]) {
      await ContractMongoose.deleteMany({ organizationId: organization.id });
      await PricingMongoose.deleteMany({ _organizationId: organization.id });
      await ServiceMongoose.deleteMany({ organizationId: organization.id });
      await deleteTestOrganization(organization.id!);
    }
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('rename', function () {
    it('renames the service in every contract of the organization, beyond the first page, whatever its case', async function () {
      const both = await insertContracts(23, { [A]: PETCLINIC_BASE_VERSION, [B]: '1_0' });
      const mixedCase = await insertContracts(2, { [A]: PETCLINIC_BASE_VERSION, VetClinic: '1_0' }, source.id, 'mixed');
      const all = [userId, ...both, ...mixedCase];
      const before = new Map<string, any>();
      for (const id of all) before.set(id, await stored(id));
      const events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');

      const response = await update({ name: 'Vetcare' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.name).toBe('Vetcare');
      for (const id of all) {
        const previous = before.get(id);
        const contract = await stored(id);
        for (const field of MAPS) {
          expect(keysOf(contract, field), `${field} of ${id}`).not.toContain(B);
          const previousKey = Object.keys(previous[field] ?? {}).find(key => key.toLowerCase() === B);
          if (previousKey) expect(contract[field][RENAMED], `${field} of ${id}`).toEqual(previous[field][previousKey]);
        }
        expect(contract.contractedServices[A]).toBe(PETCLINIC_BASE_VERSION.replace(/\./g, '_'));
        expect(contract.history.length).toBe(previous.history.length);
        expect(contract.billingPeriod).toEqual(previous.billingPeriod);
        expect(computeContractVersion(contract)).not.toBe(computeContractVersion(previous));
      }
      const announced = contractEvents(events);
      expect(announced.every((event: any) => event.code === 'CONTRACT_NOVATED' && event.organizationId === source.id)).toBe(true);
      expect(announced.map((event: any) => event.userId).sort()).toEqual([...all].sort());
      expect(announced.every((event: any) => event.services.includes(RENAMED) && !event.services.includes(B))).toBe(true);
    });

    it('drops the cached contract, evaluations and token of a contract beyond the first page, which then evaluates under the new name', async function () {
      const bulk = await insertContracts(24, { [A]: PETCLINIC_BASE_VERSION, [B]: '1_0' });
      const last = bulk.at(-1)!;
      const cacheService = container.resolve('cacheService');
      expect((await request(app).get(`${baseUrl}/contracts/${last}`).set('x-api-key', sourceKey)).status).toBe(200);
      expect((await request(app).post(`${baseUrl}/features/${last}/${B}-vetSelection`).set('x-api-key', sourceKey)).body.eval).toBe(true);
      expect((await request(app).post(`${baseUrl}/features/${last}/pricing-token`).set('x-api-key', sourceKey)).status).toBe(200);
      expect(await cacheService.get(contractCacheKey(source.id!, last))).not.toBeNull();
      expect(await cacheService.get(featuresCacheKey(source.id!, last, `eval.${B}-vetSelection`))).not.toBeNull();
      expect(await cacheService.get(featuresCacheKey(source.id!, last, 'pricingToken'))).not.toBeNull();

      expect((await update({ name: 'Vetcare' })).status).toBe(200);

      expect(await cacheService.get(contractCacheKey(source.id!, last))).toBeNull();
      expect(await cacheService.get(featuresCacheKey(source.id!, last, `eval.${B}-vetSelection`))).toBeNull();
      expect(await cacheService.get(featuresCacheKey(source.id!, last, 'pricingToken'))).toBeNull();
      const evaluation = await request(app).post(`${baseUrl}/features/${last}?details=true`).set('x-api-key', sourceKey);
      expect(evaluation.status, JSON.stringify(evaluation.body)).toBe(200);
      expect(Object.keys(evaluation.body).some(id => id.startsWith(`${B}-`))).toBe(false);
      expect(evaluation.body[`${RENAMED}-vetSelection`].eval).toBe(true);
      expect(evaluation.body[`${RENAMED}-pets`].used[`${RENAMED}-maxPets`]).toBe(23);
    });

    it('lists the pricings of the service under its new name', async function () {
      expect((await update({ name: 'Vetcare' })).status).toBe(200);

      const pricings = await request(app).get(`${baseUrl}/services/Vetcare/pricings`).set('x-api-key', sourceKey);

      expect(pricings.status).toBe(200);
      expect(pricings.body.map((pricing: any) => pricing.version)).toEqual(['1.0']);
    });

    it('refuses a name that a disabled service of the organization has, and changes nothing', async function () {
      await uploadPetclinicService(app, sourceKey, vetclinicFile('Vetcare'));
      expect((await request(app).delete(`${baseUrl}/services/Vetcare`).set('x-api-key', sourceKey)).status).toBe(204);
      const before = await stored(userId);

      const response = await update({ name: 'vetcare' });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error).toContain('Vetcare');
      expect(await stored(userId)).toEqual(before);
      expect(await ServiceMongoose.exists({ organizationId: source.id, name: 'Vetclinic' })).not.toBeNull();
    });

    it('refuses a rename that would merge two subscriptions of a contract, before writing anything', async function () {
      const bulk = await insertContracts(21, { [A]: PETCLINIC_BASE_VERSION, [B]: '1_0' });
      const [clash] = await insertContracts(1, { [B]: '1_0', [RENAMED]: '1_0' }, source.id, 'zz-clash');
      const events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');

      const response = await update({ name: 'Vetcare' });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error).toContain(clash);
      for (const id of [userId, ...bulk]) expect(keysOf(await stored(id), 'contractedServices')).toContain(B);
      expect(events).not.toHaveBeenCalled();
      expect(await ServiceMongoose.exists({ organizationId: source.id, name: 'Vetclinic' })).not.toBeNull();
    });

    it('does not write over a novation that lands after the contract was read, and still renames it', async function () {
      const pending = changeAfterRead(userId, {
        $set: { [`subscriptionPlans.${A}`]: 'PLATINUM' },
        $push: { history: { startDate: new Date(), endDate: new Date() } },
      });

      expect((await update({ name: 'Vetcare' })).status).toBe(200);

      expect(pending()).toBe(false);
      const contract = await stored(userId);
      expect(contract.subscriptionPlans[A]).toBe('PLATINUM');
      expect(contract.subscriptionPlans[RENAMED]).toBe('GOLD');
      expect(keysOf(contract, 'contractedServices').sort()).toEqual([A, RENAMED]);
    });
  });

  describe('move to another organization', function () {
    it('moves every contract that only has the service and removes it from the others, beyond the first page', async function () {
      const onlyB = await insertContracts(22, { [B]: '1_0' }, source.id, 'only');
      const onlyMixed = await insertContracts(1, { VetClinic: '1_0' }, source.id, 'only-mixed');
      const both = await insertContracts(22, { [A]: PETCLINIC_BASE_VERSION, [B]: '1_0' });
      const bothMixed = await insertContracts(1, { [A]: PETCLINIC_BASE_VERSION, VetClinic: '1_0' }, source.id, 'mixed');
      const moved = [...onlyB, ...onlyMixed];
      const kept = [userId, ...both, ...bothMixed];
      const before = new Map<string, any>();
      for (const id of [...moved, ...kept]) before.set(id, await stored(id));
      const events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');

      const response = await update({ organizationId: target.id });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.organizationId).toBe(target.id);
      for (const id of moved) {
        expect(await stored(id), id).toBeNull();
        const contract = await stored(id, target.id);
        const previous = before.get(id);
        for (const field of MAPS) expect(contract[field], `${field} of ${id}`).toEqual(previous[field]);
        expect(contract.history).toEqual(previous.history);
        expect(computeContractVersion(contract)).toBe(computeContractVersion(previous));
      }
      for (const id of kept) {
        const contract = await stored(id);
        for (const field of MAPS) expect(keysOf(contract, field), `${field} of ${id}`).not.toContain(B);
        expect(keysOf(contract, 'contractedServices')).toEqual([A]);
        expect(contract.history.length).toBe(before.get(id).history.length + 1);
        expect(keysOf(contract.history.at(-1), 'contractedServices')).toContain(B);
        expect(contract.billingPeriod.autoRenew).toBe(true);
      }

      const announced = contractEvents(events);
      for (const id of moved) {
        expect(announced.filter((event: any) => event.userId === id).map((event: any) => [event.code, event.organizationId])).toEqual([
          ['CONTRACT_DELETED', source.id],
          ['CONTRACT_CREATED', target.id],
        ]);
      }
      for (const id of kept) {
        expect(announced.filter((event: any) => event.userId === id).map((event: any) => [event.code, event.organizationId])).toEqual([
          ['CONTRACT_NOVATED', source.id],
        ]);
      }
    });

    it('announces the move to the consumers of both organizations', async function () {
      const [single] = await insertContracts(1, { [B]: '1_0' }, source.id, 'single');
      const sourceEvents = collect(await connect(sourceKey));
      const targetEvents = collect(await connect(targetKey));

      expect((await update({ organizationId: target.id })).status).toBe(200);

      const deleted = await waitFor(sourceEvents, event => event.code === 'CONTRACT_DELETED' && event.details.userId === single);
      expect(deleted.details).toEqual({ userId: single, organizationId: source.id, contractVersion: null, services: [B] });
      const novated = await waitFor(sourceEvents, event => event.code === 'CONTRACT_NOVATED' && event.details.userId === userId);
      expect(novated.details.services).toEqual([A]);
      const created = await waitFor(targetEvents, event => event.code === 'CONTRACT_CREATED' && event.details.userId === single);
      const inTarget = await request(app).get(`${baseUrl}/contracts/${single}`).set('x-api-key', targetKey);
      expect(inTarget.status).toBe(200);
      expect(created.details).toEqual({
        userId: single,
        organizationId: target.id,
        contractVersion: inTarget.body.contractVersion,
        services: [B],
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(targetEvents.filter(event => event.details.userId === userId)).toEqual([]);
      expect(targetEvents.every(event => event.details.organizationId === target.id)).toBe(true);
      expect(sourceEvents.every(event => event.details.organizationId === source.id)).toBe(true);
    });

    it('drops the cached contracts, evaluations and service of the organization it leaves', async function () {
      const [single] = await insertContracts(1, { [B]: '1_0' }, source.id, 'single');
      const cacheService = container.resolve('cacheService');
      expect((await request(app).get(`${baseUrl}/services/Vetclinic`).set('x-api-key', sourceKey)).status).toBe(200);
      expect((await request(app).get(`${baseUrl}/contracts/${single}`).set('x-api-key', sourceKey)).status).toBe(200);
      expect((await request(app).post(`${baseUrl}/features/${single}/${B}-pets`).set('x-api-key', sourceKey)).body.eval).toBe(true);
      expect((await request(app).post(`${baseUrl}/features/${userId}/${B}-pets`).set('x-api-key', sourceKey)).body.eval).toBe(true);

      expect((await update({ organizationId: target.id })).status).toBe(200);

      expect(await cacheService.get(contractCacheKey(source.id!, single))).toBeNull();
      expect(await cacheService.get(featuresCacheKey(source.id!, single, `eval.${B}-pets`))).toBeNull();
      expect(await cacheService.get(featuresCacheKey(source.id!, userId, `eval.${B}-pets`))).toBeNull();
      expect((await request(app).get(`${baseUrl}/services/Vetclinic`).set('x-api-key', sourceKey)).status).toBe(404);
      expect((await request(app).get(`${baseUrl}/contracts/${single}`).set('x-api-key', sourceKey)).status).toBe(404);
      const evaluation = await request(app).post(`${baseUrl}/features/${single}/${B}-pets`).set('x-api-key', targetKey);
      expect(evaluation.status, JSON.stringify(evaluation.body)).toBe(200);
      expect(evaluation.body.eval).toBe(true);
      const remaining = await request(app).post(`${baseUrl}/features/${userId}/${B}-pets`).set('x-api-key', sourceKey);
      expect(remaining.body.eval).toBe(false);
    });

    it('refuses with 409 when any contract it would move, beyond the first page, has a userId the target organization uses', async function () {
      const onlyB = await insertContracts(25, { [B]: '1_0' }, source.id, 'only');
      const taken = onlyB[23];
      await ContractMongoose.insertMany([
        {
          userContact: { userId: taken, username: 'already-in-target' },
          billingPeriod: { startDate: new Date(), endDate: new Date(Date.now() + 86_400_000), autoRenew: false, renewalDays: 30 },
          organizationId: target.id,
          contractedServices: {},
          subscriptionPlans: {},
          subscriptionAddOns: {},
          usageLevels: {},
          history: [],
        },
      ]);
      const before = new Map<string, any>();
      for (const id of [userId, ...onlyB]) before.set(id, await stored(id));
      const events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');

      const response = await update({ organizationId: target.id });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error).toContain(taken);
      for (const id of [userId, ...onlyB]) expect(await stored(id), id).toEqual(before.get(id));
      expect((await stored(taken, target.id)).userContact.username).toBe('already-in-target');
      expect(await ServiceMongoose.exists({ organizationId: source.id, name: 'Vetclinic' })).not.toBeNull();
      expect(events).not.toHaveBeenCalled();
    });

    it('refuses with 409 when the target organization has a service with that name, even disabled, and changes nothing', async function () {
      await uploadPetclinicService(app, targetKey, vetclinicFile('VETCLINIC'));
      expect((await request(app).delete(`${baseUrl}/services/VETCLINIC`).set('x-api-key', targetKey)).status).toBe(204);
      const before = await stored(userId);

      const response = await update({ organizationId: target.id });

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await stored(userId)).toEqual(before);
      expect(await ServiceMongoose.exists({ organizationId: source.id, name: 'Vetclinic' })).not.toBeNull();
    });

    it('renames and moves at once', async function () {
      const onlyB = await insertContracts(21, { [B]: '1_0' }, source.id, 'only');

      const response = await update({ name: 'Vetcare', organizationId: target.id });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      for (const id of onlyB) {
        const contract = await stored(id, target.id);
        for (const field of MAPS) {
          expect(keysOf(contract, field), `${field} of ${id}`).toEqual([RENAMED]);
        }
      }
      const kept = await stored(userId);
      for (const field of MAPS) {
        expect(keysOf(kept, field)).not.toContain(B);
        expect(keysOf(kept, field)).not.toContain(RENAMED);
      }
      const pricings = await request(app).get(`${baseUrl}/services/Vetcare/pricings`).set('x-api-key', targetKey);
      expect(pricings.body.map((pricing: any) => pricing.version)).toEqual(['1.0']);
    });

    it('keeps consumption recorded after the contract was read', async function () {
      const [single] = await insertContracts(1, { [B]: '1_0' }, source.id, 'single');
      const pending = changeAfterRead(single, { $inc: { [`usageLevels.${B}.maxPets.consumed`]: 5 } });

      expect((await update({ organizationId: target.id })).status).toBe(200);

      expect(pending()).toBe(false);
      expect((await stored(single, target.id)).usageLevels[B].maxPets.consumed).toBe(5);
    });

    it('lists the pricings of the service in the target organization (organization-scoped route)', async function () {
      const response = await request(app)
        .put(`${baseUrl}/organizations/${source.id}/services/Vetclinic`)
        .set('x-api-key', owner.apiKey)
        .send({ organizationId: target.id });
      expect(response.status, JSON.stringify(response.body)).toBe(200);

      const pricings = await request(app)
        .get(`${baseUrl}/organizations/${target.id}/services/Vetclinic/pricings`)
        .set('x-api-key', owner.apiKey);

      expect(pricings.status).toBe(200);
      expect(pricings.body.map((pricing: any) => pricing.version)).toEqual(['1.0']);
    });

    it('also handles a contract created while the request runs', async function () {
      const serviceRepository = container.resolve('serviceRepository');
      const original = serviceRepository.update.bind(serviceRepository);
      let late: string | undefined;
      vi.spyOn(serviceRepository, 'update').mockImplementation(async (...args: any[]) => {
        if (!late) [late] = await insertContracts(1, { [B]: '1_0' }, source.id, 'late');
        return (original as any)(...args);
      });

      expect((await update({ organizationId: target.id })).status).toBe(200);

      expect(late).toBeDefined();
      expect(await stored(late!)).toBeNull();
      expect(keysOf(await stored(late!, target.id), 'contractedServices')).toEqual([B]);
    });
  });
});
