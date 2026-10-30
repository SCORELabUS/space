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

  it('recovers the last available unit as the original successful evaluation without consuming it twice', async () => {
    expect((await create()).status).toBe(201);
    // The stock GOLD plan includes four pets. Leave exactly one available.
    const previous = await consume(undefined, 3);
    expect(previous.status).toBe(200); expect(previous.body.eval).toBe(true);
    expect(await consumed()).toBe(3);
    const key = uuidv4(); interruptAfterApply();
    failed(await consume(key)); expect(await consumed()).toBe(4);
    const selected = (await journal(key)).plan.consumption.id;

    const recovered = await recoverAndReplay(() => consume(key));
    expect(recovered.body.eval).toBe(true);
    expect(recovered.body.consumptionId).toBe(selected);
    expect(recovered.body.used['petclinic-maxPets']).toBe(4);
    expect(await consumed()).toBe(4);
    expect(await UsageConsumption.countDocuments({ organizationId: organization.id, userId })).toBe(2);
    expect((await UsageConsumption.findById(selected).lean())?.state).toBe('applied');
  });

  it('recovers a usage increment after its write without applying it twice', async () => {
    expect((await create()).status).toBe(201); const key = uuidv4(); interruptAfterApply();
    failed(await increment(key)); expect(await consumed()).toBe(2);
    const response = await recoverAndReplay(() => increment(key));
    expect(response.body.usageLevels[SERVICE].maxPets.consumed).toBe(2); expect(await consumed()).toBe(2);
    expect((await stored()).history).toHaveLength(0);
  });

  it('replays an interrupted reset without erasing a later consumption and returns its original result', async () => {
    expect((await create()).status).toBe(201);
    expect((await consume(undefined, 2)).status).toBe(200);
    expect(await consumed()).toBe(2);
    const key = uuidv4(); interruptAfterApply();
    const call = () => keyed('put', `/contracts/${userId}/usageLevels?reset=true&renewableOnly=false`, key);
    failed(await call()); expect(await consumed()).toBe(0);
    const original: any = await Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId })
      .select('+idempotencyReceipt').lean();
    const snapshot = original.idempotencyReceipt.result;
    expect(snapshot.usageLevels[SERVICE].maxPets.consumed).toBe(0);

    const later = await consume();
    expect(later.status).toBe(200); expect(later.body.eval).toBe(true);
    expect(await consumed()).toBe(1);
    const recovered = await recoverAndReplay(call);
    expect(recovered.body.id).toBe(snapshot.id);
    expect(recovered.body.usageLevels[SERVICE].maxPets.consumed).toBe(0);
    expect(await consumed()).toBe(1);
    expect((await UsageConsumption.findById(later.body.consumptionId).lean())?.revertedAt).toBeUndefined();
  });

  it('renews a running request through its heartbeat while a same-key contender remains blocked', async () => {
    expect((await create()).status).toBe(201);
    vi.stubEnv('IDEMPOTENCY_WAIT_MS', '0');
    const realSetInterval = globalThis.setInterval;
    let heartbeat: (() => void) | undefined;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
      if (ms === 20_000) heartbeat = () => callback(...args);
      return realSetInterval(callback, ms, ...args);
    }) as typeof setInterval);

    const receipts: any = container.resolve('idempotencyContractRepository');
    const originalApply = receipts.apply.bind(receipts);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const apply = vi.spyOn(receipts, 'apply').mockImplementation(async (...args: any[]) => {
      entered(); await gate; return originalApply(...args);
    });
    const repository: any = container.resolve('idempotencyKeyRepository');
    const originalRenew = repository.renew.bind(repository);
    let renewed!: () => void;
    const didRenew = new Promise<void>(resolve => { renewed = resolve; });
    const renew = vi.spyOn(repository, 'renew').mockImplementationOnce(async (...args: any[]) => {
      const record = await originalRenew(...args); renewed(); return record;
    });
    const key = uuidv4();
    const pending = increment(key).then(response => response);
    let first!: request.Response;
    try {
      await started;
      expect(heartbeat).toBeTypeOf('function');
      // Make the improvement deterministic without advancing global timers or sleeping.
      await IdempotencyKey.updateOne({ organizationId: organization.id, key }, { $set: { lockedUntil: new Date(Date.now() + 5000) } });
      const before = await journal(key);
      heartbeat!(); await didRenew;
      const after = await journal(key);
      expect(renew).toHaveBeenCalledWith(organization.id, key, before.owner, 60);
      expect(after.lockedUntil.getTime()).toBeGreaterThan(before.lockedUntil.getTime());
      expect(after.operationId).toBe(before.operationId);
      const contender = await increment(key);
      expect(contender.status).toBe(409);
      expect(contender.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(contender.headers['retry-after']).toBe('1');
      expect(await consumed()).toBe(0);
    } finally { release(); first = await pending; }
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await consumed()).toBe(2);
    const retry = await increment(key);
    expect(retry.status).toBe(200); expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body); expect(await consumed()).toBe(2);
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

  it('returns a deleted creation snapshot on retry without recreating its contract', async () => {
    const key = uuidv4();
    interruptAfterApply();
    const call = () => keyed('post', '/contracts', key, body());
    failed(await call());
    const prepared = await journal(key);
    const originalId = prepared.plan.writes[0].contractId;
    expect(String((await stored())._id)).toBe(originalId);
    expect(Object.keys(prepared.steps ?? {})).toHaveLength(0);

    const deleted = await request(app).delete(`${baseUrl}/contracts/${userId}`).set('x-api-key', apiKey);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    expect(await stored()).toBeNull();
    const checkpointed = await journal(key);
    expect(checkpointed.operationId).toBe(prepared.operationId);
    expect(Object.keys(checkpointed.steps ?? {})).toHaveLength(1);

    const recovered = await recoverAndReplay(call, 201);
    expect(recovered.body.id).toBe(originalId);
    expect(recovered.body.userContact.userId).toBe(userId);
    expect(await stored()).toBeNull();
    expect(await Contract.countDocuments({ organizationId: organization.id, 'userContact.userId': userId })).toBe(0);
  });

  it('returns the old increment snapshot after deletion without changing a replacement contract', async () => {
    expect((await create()).status).toBe(201);
    const originalId = String((await stored())._id);
    const key = uuidv4();
    interruptAfterApply();
    failed(await increment(key));
    expect(await consumed()).toBe(2);
    expect(Object.keys((await journal(key)).steps ?? {})).toHaveLength(0);

    const deleted = await request(app).delete(`${baseUrl}/contracts/${userId}`).set('x-api-key', apiKey);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
    expect(await stored()).toBeNull();
    const replacement = await create();
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
    const replacementId = String((await stored())._id);
    expect(replacementId).not.toBe(originalId);
    expect(await consumed()).toBe(0);

    const recovered = await recoverAndReplay(() => increment(key));
    expect(recovered.body.id).toBe(originalId);
    expect(recovered.body.usageLevels[SERVICE].maxPets.consumed).toBe(2);
    expect(String((await stored())._id)).toBe(replacementId);
    expect(await consumed()).toBe(0);
    expect((await stored()).history).toHaveLength(0);
    expect(await Contract.countDocuments({ organizationId: organization.id, 'userContact.userId': userId })).toBe(1);
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

  it('refuses to replay a prepared unconditioned novation over a later subscription change', async () => {
    expect((await create()).status).toBe(201);
    const key = uuidv4();
    const repository: any = container.resolve('idempotencyContractRepository');
    vi.spyOn(repository, 'apply').mockRejectedValueOnce(new Error('Injected failure before prepared novation write'));
    const subscription = (plan: string) => ({ contractedServices: { [SERVICE]: PETCLINIC_BASE_VERSION },
      subscriptionPlans: { [SERVICE]: plan }, subscriptionAddOns: { [SERVICE]: {} }, keepBillingPeriod: true });
    const call = () => keyed('put', `/contracts/${userId}`, key, subscription('PLATINUM'));
    failed(await call());
    expect((await stored()).subscriptionPlans[SERVICE]).toBe('GOLD');
    const later = await request(app).put(`${baseUrl}/contracts/${userId}`).set('x-api-key', apiKey).send(subscription('BASIC'));
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const beforeRetry = await stored();

    const recovered = await recoverAndReplay(call, 409);
    expect(recovered.body.code).toBe('IDEMPOTENCY_STATE_CHANGED');
    const afterRetry = await stored();
    expect(afterRetry.subscriptionPlans[SERVICE]).toBe('BASIC');
    expect(afterRetry.history).toEqual(beforeRetry.history);
    expect(afterRetry.history).toHaveLength(1);
    expect(afterRetry.billingPeriod).toEqual(beforeRetry.billingPeriod);
  });

  it('keeps an intervening group member novation and reports the already applied members on recovery', async () => {
    const groupId = uuidv4(), ids = [userId, uuidv4()];
    for (const id of ids) expect((await create(id, { groupId })).status).toBe(201);
    const key = uuidv4(), repository: any = container.resolve('idempotencyContractRepository');
    const originalApply = repository.apply.bind(repository);
    let calls = 0;
    vi.spyOn(repository, 'apply').mockImplementation(async (...args: any[]) => {
      if (++calls === 2) throw new Error('Injected failure before second group member write');
      return originalApply(...args);
    });
    const subscription = (plan: string) => ({ contractedServices: { [SERVICE]: PETCLINIC_BASE_VERSION },
      subscriptionPlans: { [SERVICE]: plan }, subscriptionAddOns: { [SERVICE]: {} }, keepBillingPeriod: true });
    const call = () => keyed('put', `/contracts?groupId=${groupId}`, key, subscription('PLATINUM'));
    failed(await call());
    const prepared = await journal(key);
    const [appliedId, pendingId] = prepared.plan.writes.map((write: any) => write.userId);
    expect((await stored(appliedId)).subscriptionPlans[SERVICE]).toBe('PLATINUM');
    expect((await stored(pendingId)).subscriptionPlans[SERVICE]).toBe('GOLD');
    const later = await request(app).put(`${baseUrl}/contracts/${pendingId}`).set('x-api-key', apiKey).send(subscription('BASIC'));
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    const pendingBeforeRetry = await stored(pendingId);

    const recovered = await recoverAndReplay(call, 409);
    expect(recovered.body.code).toBe('IDEMPOTENCY_STATE_CHANGED');
    expect(recovered.body.novated).toEqual([appliedId]);
    expect((await stored(appliedId)).subscriptionPlans[SERVICE]).toBe('PLATINUM');
    expect((await stored(appliedId)).history).toHaveLength(1);
    const pendingAfterRetry = await stored(pendingId);
    expect(pendingAfterRetry.subscriptionPlans[SERVICE]).toBe('BASIC');
    expect(pendingAfterRetry.history).toEqual(pendingBeforeRetry.history);
    expect(pendingAfterRetry.history).toHaveLength(1);
    expect(pendingAfterRetry.billingPeriod).toEqual(pendingBeforeRetry.billingPeriod);
  });

  it('checkpoints an abandoned applied receipt before a different key writes the same contract', async () => {
    expect((await create()).status).toBe(201);
    const firstKey = uuidv4(), nextKey = uuidv4();
    interruptAfterApply();
    failed(await increment(firstKey));
    expect(await consumed()).toBe(2);
    const abandoned = await journal(firstKey);
    expect(abandoned.plan).toBeDefined();
    expect(Object.keys(abandoned.steps ?? {})).toHaveLength(0);
    // Use a deterministic expired lease; recovery must not wait for the first client.
    await IdempotencyKey.updateOne({ organizationId: organization.id, key: firstKey }, { $set: { lockedUntil: new Date(0) } });

    const next = await recoverAndReplay(() => increment(nextKey));
    expect(next.body.usageLevels[SERVICE].maxPets.consumed).toBe(4);
    expect(await consumed()).toBe(4);
    const checkpointed = await journal(firstKey);
    expect(checkpointed.operationId).toBe(abandoned.operationId);
    expect(Object.values(checkpointed.steps ?? {})).toEqual([
      expect.objectContaining({ result: expect.objectContaining({
        usageLevels: expect.objectContaining({ [SERVICE]: expect.objectContaining({ maxPets: expect.objectContaining({ consumed: 2 }) }) }),
      }) }),
    ]);
    const recovered = await recoverAndReplay(() => increment(firstKey));
    expect(recovered.body.usageLevels[SERVICE].maxPets.consumed).toBe(2);
    expect(await consumed()).toBe(4);
    expect((await stored()).history).toHaveLength(0);
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

  it('finishes the original legacy revert after its only consumption was already acknowledged', async () => {
    expect((await create()).status).toBe(201);
    const target = await consume(); expect(target.status).toBe(200); expect(await consumed()).toBe(1);
    const repository: any = container.resolve('usageConsumptionRepository');
    const original = repository.complete.bind(repository);
    vi.spyOn(repository, 'complete').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected failure after the only legacy consumption was refunded and acknowledged');
    });
    const selection = vi.spyOn(repository, 'claimRecent');
    const key = uuidv4();
    const call = () => keyed('post', `/features/${userId}/${FEATURE}?revert=true`, key);
    failed(await call()); expect(await consumed()).toBe(0);
    expect((await UsageConsumption.findById(target.body.consumptionId).lean())?.revertedAt).toBeInstanceOf(Date);
    expect(selection).toHaveBeenCalledTimes(1);
    const prepared = await journal(key);
    expect(prepared.plan.consumption.id).toBe(target.body.consumptionId);
    const recovered = await recoverAndReplay(call, 204);
    expect(recovered.text).toBe(''); expect(await consumed()).toBe(0);
    // A retry resumes the frozen plan; finding no unrefunded consumption is not recovery.
    expect(selection).toHaveBeenCalledTimes(1);
    const completed = await journal(key);
    expect(completed.operationId).toBe(prepared.operationId);
    expect(completed.plan.consumption.id).toBe(target.body.consumptionId);
    expect(completed.result).toEqual({ value: null });
    expect(await UsageConsumption.countDocuments({ organizationId: organization.id, userId })).toBe(1);
  });

  it('acknowledges an already applied explicit refund after its service is paused without refunding twice', async () => {
    expect((await create()).status).toBe(201);
    const target = await consume(undefined, 2); expect(target.status).toBe(200);
    const key = uuidv4(); interruptAfterApply();
    const call = () => keyed('post', `/features/${userId}/${FEATURE}?revert=true&consumptionId=${target.body.consumptionId}`, key);
    failed(await call()); expect(await consumed()).toBe(0);
    const pending = await journal(key);
    expect(pending.plan.consumption.id).toBe(target.body.consumptionId);
    expect(Object.keys(pending.steps ?? {})).toHaveLength(0);
    const retainedId = String((await stored())._id);
    await request(app).delete(`${baseUrl}/services/${SERVICE}`).set('x-api-key', apiKey).expect(204);
    expect(String((await stored())._id)).toBe(retainedId);

    await recoverAndReplay(call, 204);
    expect(await consumed()).toBe(0);
    expect((await UsageConsumption.findById(target.body.consumptionId).lean())?.revertedAt).toBeInstanceOf(Date);
    expect((await journal(key)).operationId).toBe(pending.operationId);
    expect((await Service.findOne({ organizationId: organization.id, name: /^petclinic$/i }).lean())?.disabled).toBe(true);
  });

  it('recovers an applied refund from its generic receipt after consumption TTL and old refund receipts are gone', async () => {
    expect((await create()).status).toBe(201);
    const other = await consume(), target = await consume(undefined, 2);
    expect(other.status).toBe(200); expect(target.status).toBe(200); expect(await consumed()).toBe(3);
    const key = uuidv4(); interruptAfterApply();
    const call = () => keyed('post', `/features/${userId}/${FEATURE}?revert=true&consumptionId=${target.body.consumptionId}`, key);
    failed(await call()); expect(await consumed()).toBe(1);
    const pending = await journal(key);
    expect(Object.keys(pending.steps ?? {})).toHaveLength(0);
    await UsageConsumption.deleteOne({ _id: target.body.consumptionId });
    await Contract.updateOne({ organizationId: organization.id, 'userContact.userId': userId }, { $unset: { usageRevertReceipts: '' } });
    const retained: any = await Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId })
      .select('+idempotencyReceipt +usageRevertReceipts').lean();
    expect(retained.idempotencyReceipt).toMatchObject({ acknowledged: false, result: expect.any(Object) });
    expect(retained.usageRevertReceipts).toBeUndefined();

    await recoverAndReplay(call, 204);
    expect(await consumed()).toBe(1);
    expect(await UsageConsumption.findById(target.body.consumptionId).lean()).toBeNull();
    expect((await UsageConsumption.findById(other.body.consumptionId).lean())?.revertedAt).toBeUndefined();
    expect((await journal(key)).result).toEqual({ value: null });
  });

  it('refuses an unapplied prepared refund after its service is paused and preserves the original consumption', async () => {
    expect((await create()).status).toBe(201);
    const target = await consume(undefined, 2); expect(target.status).toBe(200);
    const repository: any = container.resolve('idempotencyContractRepository');
    vi.spyOn(repository, 'apply').mockRejectedValueOnce(new Error('Injected failure before prepared refund effect'));
    const key = uuidv4();
    const call = () => keyed('post', `/features/${userId}/${FEATURE}?revert=true&consumptionId=${target.body.consumptionId}`, key);
    failed(await call()); expect(await consumed()).toBe(2);
    expect((await journal(key)).plan.consumption.id).toBe(target.body.consumptionId);
    await request(app).delete(`${baseUrl}/services/${SERVICE}`).set('x-api-key', apiKey).expect(204);

    const retry = await call();
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
    expect(retry.body.code).toBe('SERVICE_DISABLED');
    expect(await consumed()).toBe(2);
    expect((await UsageConsumption.findById(target.body.consumptionId).lean())?.revertedAt).toBeUndefined();
    const untouched: any = await Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId })
      .select('+usageRevertReceipts +idempotencyReceipt').lean();
    expect(untouched.usageRevertReceipts).toBeUndefined();
    expect(untouched.idempotencyReceipt).toBeUndefined();
  });

  it('prunes expired private receipt markers during keyed consumption while retaining fresh markers', async () => {
    expect((await create()).status).toBe(201);
    const expiredConsume = 'a'.repeat(64), freshConsume = 'b'.repeat(64);
    const expiredRefund = 'c'.repeat(64), freshRefund = 'd'.repeat(64);
    const future = new Date('2100-01-01');
    await Contract.collection.updateOne({ organizationId: organization.id, 'userContact.userId': userId }, { $set: {
      usageConsumptionReceipts: { [expiredConsume]: new Date(0), [freshConsume]: future },
      usageRevertReceipts: { [expiredRefund]: new Date(0), [freshRefund]: future },
    } });
    const response = await consume(uuidv4());
    expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body.eval).toBe(true);
    const after: any = await Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId })
      .select('+usageConsumptionReceipts +usageRevertReceipts').lean();
    expect(after.usageConsumptionReceipts).not.toHaveProperty(expiredConsume);
    expect(after.usageConsumptionReceipts[freshConsume]).toEqual(future);
    expect(Object.keys(after.usageConsumptionReceipts)).toHaveLength(2);
    expect(after.usageRevertReceipts).not.toHaveProperty(expiredRefund);
    expect(after.usageRevertReceipts[freshRefund]).toEqual(future);
    expect(Object.keys(after.usageRevertReceipts)).toHaveLength(1);
    expect(await consumed()).toBe(1);
  });
});
