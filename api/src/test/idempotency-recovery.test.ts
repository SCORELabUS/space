import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { LeanUser } from '../main/types/models/User';
import { LeanOrganization } from '../main/types/models/Organization';
import Contract from '../main/repositories/mongoose/models/ContractMongoose';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import Pricing from '../main/repositories/mongoose/models/PricingMongoose';
import UsageConsumption from '../main/repositories/mongoose/models/UsageConsumptionMongoose';
import IdempotencyKey from '../main/repositories/mongoose/models/IdempotencyKeyMongoose';
import { PETCLINIC_BASE_VERSION, uploadPetclinicService } from './utils/services/petclinicVersions';
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';

const SERVICE = 'petclinic', FEATURE = 'petclinic-pets';
describe('Idempotency crash recovery', () => {
  let app: Server, owner: LeanUser, organization: LeanOrganization;
  let apiKey: string, userId: string;
  const body = (id = userId, extra: any = {}) => ({
    userContact: { userId: id, username: 'idempotency-recovery' },
    billingPeriod: { autoRenew: true, renewalDays: 30 },
    contractedServices: { [SERVICE]: PETCLINIC_BASE_VERSION }, subscriptionPlans: { [SERVICE]: 'GOLD' },
    subscriptionAddOns: { [SERVICE]: {} }, ...extra,
  });
  const create = (id = userId, extra: any = {}) => request(app).post(`${baseUrl}/contracts`).set('x-api-key', apiKey).send(body(id, extra));
  const stored = (id = userId) => Contract.findOne({ organizationId: organization.id, 'userContact.userId': id }).lean() as any;
  const consumed = async (id = userId) => (await stored(id)).usageLevels[SERVICE].maxPets.consumed;
  const journal = (key: string) => IdempotencyKey.findOne({ organizationId: organization.id, key }).lean() as any;
  const keyed = (method: 'post' | 'put', path: string, key: string, value: any = {}) =>
    request(app)[method](baseUrl + path).set('x-api-key', apiKey).set('Idempotency-Key', key).send(value);
  const increment = (key: string) => keyed('put', `/contracts/${userId}/usageLevels`, key, { [SERVICE]: { maxPets: 2 } });
  const consume = (key?: string, amount = 1) => {
    const call = request(app).post(`${baseUrl}/features/${userId}/${FEATURE}`).set('x-api-key', apiKey);
    if (key) call.set('Idempotency-Key', key);
    return call.send({ 'petclinic-maxPets': amount });
  };
  const failed = (response: request.Response) => expect([500, 503], JSON.stringify(response.body)).toContain(response.status);
  const recoverAndReplay = async (call: () => request.Test, status = 200) => {
    const recovered = await call(); expect(recovered.status, JSON.stringify(recovered.body)).toBe(status);
    const replay = await call(); expect(replay.status, JSON.stringify(replay.body)).toBe(status);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(recovered.body); expect(replay.text).toBe(recovered.text);
    expect(replay.headers.etag).toBe(recovered.headers.etag);
    return recovered;
  };
  const interruptAfterApply = (nth = 1) => {
    const repository: any = container.resolve('idempotencyContractRepository'), original = repository.apply.bind(repository);
    let calls = 0;
    return vi.spyOn(repository, 'apply').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      if (++calls === nth) throw new Error('Injected crash after contract effect before checkpoint');
      return result;
    });
  };
  beforeAll(async () => { app = await getApp(); });
  beforeEach(async () => {
    owner = await createTestUser('USER', `idem_recovery_${uuidv4()}`);
    organization = await createTestOrganization(owner.username);
    apiKey = generateOrganizationApiKey(); await addApiKeyToOrganization(organization.id!, { key: apiKey, scope: 'ALL' });
    await uploadPetclinicService(app, apiKey); userId = uuidv4();
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await IdempotencyKey.deleteMany({ organizationId: organization.id }); await UsageConsumption.deleteMany({ organizationId: organization.id });
    await Contract.deleteMany({ organizationId: organization.id }); await Pricing.deleteMany({ _organizationId: organization.id });
    await Service.deleteMany({ organizationId: organization.id }); await deleteTestOrganization(organization.id!); await deleteTestUser(owner.username);
  });
  afterAll(async () => { await shutdownApp(); });

  it('recovers a consumed unit after the atomic effect but before its journal checkpoint', async () => {
    expect((await create()).status).toBe(201); const key = uuidv4(); interruptAfterApply();
    failed(await consume(key)); expect(await consumed()).toBe(1);
    const plan = (await journal(key)).plan;
    const response = await recoverAndReplay(() => consume(key));
    expect(response.body.eval).toBe(true); expect(response.body.consumptionId).toBe(plan.consumption.id);
    expect(await consumed()).toBe(1);
    expect(await UsageConsumption.countDocuments({ organizationId: organization.id, userId })).toBe(1);
  });

  it('recovers a usage increment after its write without applying it twice', async () => {
    expect((await create()).status).toBe(201); const key = uuidv4(); interruptAfterApply();
    failed(await increment(key)); expect(await consumed()).toBe(2);
    const response = await recoverAndReplay(() => increment(key));
    expect(response.body.usageLevels[SERVICE].maxPets.consumed).toBe(2); expect(await consumed()).toBe(2);
    expect((await stored()).history).toHaveLength(0);
  });

  it('recovers a creation with its preallocated identity and original 201 response', async () => {
    const key = uuidv4(); interruptAfterApply();
    const call = () => keyed('post', '/contracts', key, body());
    failed(await call());
    const preparedId = (await journal(key)).plan.writes[0].contractId;
    expect(await Contract.countDocuments({ organizationId: organization.id, 'userContact.userId': userId })).toBe(1);
    const response = await recoverAndReplay(call, 201);
    expect(response.body.id).toBe(preparedId); expect(response.body.userContact.userId).toBe(userId);
    expect(String((await stored())._id)).toBe(preparedId); expect((await stored()).history).toHaveLength(0);
  });

  it('recovers a conditional novation with the old If-Match without adding history twice', async () => {
    const created = await create(); expect(created.status).toBe(201); const before = await stored();
    const key = uuidv4(); interruptAfterApply();
    const call = () => request(app).put(`${baseUrl}/contracts/${userId}`).set('x-api-key', apiKey)
      .set('Idempotency-Key', key).set('If-Match', created.headers.etag).send({
        contractedServices: { [SERVICE]: PETCLINIC_BASE_VERSION }, subscriptionPlans: { [SERVICE]: 'PLATINUM' },
        subscriptionAddOns: { [SERVICE]: {} }, keepBillingPeriod: true,
      });
    failed(await call()); expect((await stored()).subscriptionPlans[SERVICE]).toBe('PLATINUM');
    const response = await recoverAndReplay(call);
    expect(response.body.subscriptionPlans[SERVICE]).toBe('PLATINUM');
    expect((await stored()).history).toHaveLength(1); expect((await stored()).billingPeriod).toEqual(before.billingPeriod);
  });

  it('freezes group members after a second persisted write and completes each original member once', async () => {
    const groupId = uuidv4(), ids = [userId, uuidv4(), uuidv4()];
    for (const id of ids) expect((await create(id, { groupId })).status).toBe(201);
    const key = uuidv4(); interruptAfterApply(2);
    const call = () => keyed('put', `/contracts?groupId=${groupId}`, key, {
      contractedServices: { [SERVICE]: PETCLINIC_BASE_VERSION }, subscriptionPlans: { [SERVICE]: 'PLATINUM' },
      subscriptionAddOns: { [SERVICE]: {} }, keepBillingPeriod: true,
    });
    failed(await call());
    expect(await Contract.countDocuments({ organizationId: organization.id, groupId, [`subscriptionPlans.${SERVICE}`]: 'PLATINUM' })).toBe(2);
    const newcomer = uuidv4(); expect((await create(newcomer, { groupId })).status).toBe(201);
    const recovered = await recoverAndReplay(call);
    expect(recovered.body).toHaveLength(3);
    expect(recovered.body.map((contract: any) => contract.userContact.userId).sort()).toEqual([...ids].sort());
    for (const id of ids) { expect((await stored(id)).history).toHaveLength(1); expect((await stored(id)).subscriptionPlans[SERVICE]).toBe('PLATINUM'); }
    expect((await stored(newcomer)).history).toHaveLength(0); expect((await stored(newcomer)).subscriptionPlans[SERVICE]).toBe('GOLD');
  });

  it('retries the same prepared request when failure happened before any business write', async () => {
    expect((await create()).status).toBe(201); const key = uuidv4();
    const repository: any = container.resolve('idempotencyContractRepository');
    vi.spyOn(repository, 'apply').mockRejectedValueOnce(new Error('Injected pre-write failure'));
    failed(await increment(key)); expect(await consumed()).toBe(0);
    await recoverAndReplay(() => increment(key)); expect(await consumed()).toBe(2);
  });

  it.each([false, true])('recovers after domain result persistence failed (persisted=%s)', async persisted => {
    expect((await create()).status).toBe(201); const key = uuidv4();
    const repository: any = container.resolve('idempotencyKeyRepository'), original = repository.saveResult.bind(repository);
    vi.spyOn(repository, 'saveResult').mockImplementationOnce(async (...args: any[]) => {
      if (persisted) await original(...args); throw new Error('Injected result persistence failure');
    });
    failed(await increment(key)); expect(await consumed()).toBe(2);
    await recoverAndReplay(() => increment(key)); expect(await consumed()).toBe(2);
  });

  it.each([false, true])('returns 503 when response completion fails and later replays success (persisted=%s)', async persisted => {
    expect((await create()).status).toBe(201); const key = uuidv4();
    const repository: any = container.resolve('idempotencyKeyRepository'), original = repository.complete.bind(repository);
    vi.spyOn(repository, 'complete').mockImplementationOnce(async (...args: any[]) => {
      if (persisted) await original(...args); throw new Error('Injected response completion failure');
    });
    const response = await increment(key); expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(await consumed()).toBe(2);
    await recoverAndReplay(() => increment(key)); expect(await consumed()).toBe(2);
  });

  it('repairs cache effects after a persisted increment without repeating that increment', async () => {
    expect((await create()).status).toBe(201); const key = uuidv4();
    const cache: any = container.resolve('cacheService'), original = cache.delMany.bind(cache); let interrupted = false;
    vi.spyOn(cache, 'delMany').mockImplementation(async (...args: any[]) => {
      if (!interrupted && args[0].includes(contractCacheKey(organization.id!, userId))) {
        interrupted = true; throw new Error('Injected cache invalidation failure after effect');
      }
      return original(...args);
    });
    failed(await increment(key)); expect(interrupted).toBe(true); expect(await consumed()).toBe(2);
    await recoverAndReplay(() => increment(key)); expect(await consumed()).toBe(2);
    const shown = await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', apiKey);
    expect(shown.status).toBe(200); expect(shown.body.usageLevels[SERVICE].maxPets.consumed).toBe(2);
  });

  it('freezes the selected legacy revert across an acknowledgement failure instead of refunding the next consumption', async () => {
    expect((await create()).status).toBe(201);
    const first = await consume(undefined, 2), second = await consume(undefined, 1);
    expect(first.status).toBe(200); expect(second.status).toBe(200); expect(await consumed()).toBe(3);
    const key = uuidv4();
    const repository: any = container.resolve('usageConsumptionRepository'), original = repository.complete.bind(repository);
    vi.spyOn(repository, 'complete').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected legacy revert completion failure');
    });
    const call = () => keyed('post', `/features/${userId}/${FEATURE}?revert=true`, key);
    failed(await call()); expect(await consumed()).toBe(1);
    const operation = await journal(key); expect(operation.plan.consumption.id).toBe(first.body.consumptionId);
    await recoverAndReplay(call, 204); expect(await consumed()).toBe(1);
    expect((await UsageConsumption.findById(second.body.consumptionId).lean())?.revertedAt).toBeUndefined();
    const last = await request(app).post(`${baseUrl}/features/${userId}/${FEATURE}?revert=true&consumptionId=${second.body.consumptionId}`).set('x-api-key', apiKey);
    expect(last.status, JSON.stringify(last.body)).toBe(204); expect(await consumed()).toBe(0);
  });
});
