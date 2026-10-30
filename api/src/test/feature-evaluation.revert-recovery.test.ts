import request from 'supertest';
import { Server } from 'http';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';
import Contract from '../main/repositories/mongoose/models/ContractMongoose';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import Pricing from '../main/repositories/mongoose/models/PricingMongoose';
import UsageConsumption from '../main/repositories/mongoose/models/UsageConsumptionMongoose';
import { LeanUser } from '../main/types/models/User';
import { LeanOrganization } from '../main/types/models/Organization';
import { PETCLINIC_BASE_VERSION, uploadPetclinicService } from './utils/services/petclinicVersions';

const SERVICE = 'petclinic';
const FEATURE = 'petclinic-pets';
describe('Consumption revert recovery', () => {
  let app: Server, owner: LeanUser, organization: LeanOrganization;
  let key: string, userId: string, consumptionId: string;
  const create = () => request(app).post(`${baseUrl}/contracts`).set('x-api-key', key).send({
    userContact: { userId, username: 'revert-recovery' }, billingPeriod: { autoRenew: true, renewalDays: 30 },
    contractedServices: { [SERVICE]: PETCLINIC_BASE_VERSION }, subscriptionPlans: { [SERVICE]: 'GOLD' }, subscriptionAddOns: {},
  });
  const consume = async (amount: number) => {
    const response = await request(app).post(`${baseUrl}/features/${userId}/${FEATURE}`).set('x-api-key', key).send({ 'petclinic-maxPets': amount });
    expect(response.status, JSON.stringify(response.body)).toBe(200); expect(response.body.eval).toBe(true);
    expect(typeof response.body.consumptionId).toBe('string'); return response.body.consumptionId as string;
  };
  const revert = (id = consumptionId) => request(app).post(`${baseUrl}/features/${userId}/${FEATURE}?revert=true&consumptionId=${id}`).set('x-api-key', key);
  const stored = () => Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId }).lean() as any;
  const consumed = async () => (await stored()).usageLevels[SERVICE].maxPets.consumed;
  const record = () => UsageConsumption.findById(consumptionId).lean() as any;
  const shownConsumed = async () => {
    const response = await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', key);
    expect(response.status, JSON.stringify(response.body)).toBe(200); return response.body.usageLevels[SERVICE].maxPets.consumed;
  };
  beforeAll(async () => { app = await getApp(); });
  beforeEach(async () => {
    owner = await createTestUser('USER', `revert_${uuidv4()}`); organization = await createTestOrganization(owner.username);
    key = generateOrganizationApiKey(); await addApiKeyToOrganization(organization.id!, { key, scope: 'ALL' });
    await uploadPetclinicService(app, key); userId = uuidv4(); expect((await create()).status).toBe(201);
    consumptionId = await consume(2); await consume(1); expect(await consumed()).toBe(3);
    expect(await shownConsumed()).toBe(3);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await UsageConsumption.deleteMany({ organizationId: organization.id }); await Contract.deleteMany({ organizationId: organization.id });
    await Service.deleteMany({ organizationId: organization.id }); await Pricing.deleteMany({ _organizationId: organization.id });
    await deleteTestOrganization(organization.id!); await deleteTestUser(owner.username);
  });
  afterAll(async () => { await shutdownApp(); });

  it('subtracts once after the decrement persisted but its caller failed before acknowledging it', async () => {
    const repository: any = container.resolve('contractRepository'), original = repository.decrementUsageLevels.bind(repository);
    const fault = vi.spyOn(repository, 'decrementUsageLevels').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected failure after persisted decrement');
    });
    const failed = await revert(); expect(failed.status, JSON.stringify(failed.body)).toBe(500);
    expect(await consumed()).toBe(1); expect((await record()).revertedAt).toBeUndefined();
    expect((await record()).revertRequestedAt).toBeInstanceOf(Date);
    const receipt = createHash('sha256').update(consumptionId).digest('hex');
    const raw: any = await Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId }).select('+usageRevertReceipts').lean();
    expect(raw.usageRevertReceipts[receipt]).toBeInstanceOf(Date);
    const recovered = await revert(); expect(recovered.status, JSON.stringify(recovered.body)).toBe(204);
    expect(fault).toHaveBeenCalledTimes(1); expect(await consumed()).toBe(1); expect(await shownConsumed()).toBe(1);
    expect((await record()).revertedAt).toBeInstanceOf(Date);
  });

  it('recovers when completion fails before its database write', async () => {
    const repository: any = container.resolve('usageConsumptionRepository');
    const fault = vi.spyOn(repository, 'complete').mockRejectedValueOnce(new Error('Injected failure before completion'));
    expect((await revert()).status).toBe(500); expect(await consumed()).toBe(1); expect((await record()).revertedAt).toBeUndefined();
    const recovered = await revert(); expect(recovered.status, JSON.stringify(recovered.body)).toBe(204);
    expect(fault).toHaveBeenCalledTimes(2); expect(await consumed()).toBe(1); expect(await shownConsumed()).toBe(1);
  });

  it('recovers when completion persisted before its caller failed', async () => {
    const repository: any = container.resolve('usageConsumptionRepository'), original = repository.complete.bind(repository);
    vi.spyOn(repository, 'complete').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected failure after completion');
    });
    expect((await revert()).status).toBe(500); expect(await consumed()).toBe(1);
    const completed = (await record()).revertedAt; expect(completed).toBeInstanceOf(Date);
    const recovered = await revert(); expect(recovered.status, JSON.stringify(recovered.body)).toBe(204);
    expect(await consumed()).toBe(1); expect(await shownConsumed()).toBe(1); expect((await record()).revertedAt).toEqual(completed);
  });

  it('recovers a Redis invalidation failure after decrement without refunding twice', async () => {
    const cache: any = container.resolve('cacheService'), original = cache.del.bind(cache);
    const contractKey = contractCacheKey(organization.id!, userId); let injected = false;
    vi.spyOn(cache, 'del').mockImplementation(async (...args: any[]) => {
      // The wrapper also invalidates before reverting; fail only after the decrement.
      if (!injected && args[0] === contractKey && await consumed() === 1) { injected = true; throw new Error('Injected Redis failure after decrement'); }
      return original(...args);
    });
    expect((await revert()).status).toBe(500); expect(injected).toBe(true); expect(await consumed()).toBe(1);
    const recovered = await revert(); expect(recovered.status, JSON.stringify(recovered.body)).toBe(204);
    expect(await consumed()).toBe(1); expect(await shownConsumed()).toBe(1);
    expect((await revert()).status).toBe(204); expect(await consumed()).toBe(1);
  });

  it('allows retry when the decrement failed before writing its receipt', async () => {
    const repository: any = container.resolve('contractRepository');
    const fault = vi.spyOn(repository, 'decrementUsageLevels').mockRejectedValueOnce(new Error('Injected failure before decrement'));
    expect((await revert()).status).toBe(500); expect(await consumed()).toBe(3); expect((await record()).revertedAt).toBeUndefined();
    const recovered = await revert(); expect(recovered.status, JSON.stringify(recovered.body)).toBe(204);
    expect(fault).toHaveBeenCalledTimes(2); expect(await consumed()).toBe(1);
  });

  it('serializes concurrent reverts and subtracts the recorded amount exactly once', async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => revert()));
    for (const response of responses) expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(await consumed()).toBe(1); expect(await shownConsumed()).toBe(1); expect((await record()).revertedAt).toBeInstanceOf(Date);
  });

  it('keeps receipt state private in both contract show and listing responses', async () => {
    expect((await revert()).status).toBe(204);
    const raw: any = await Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId }).select('+usageRevertReceipts').lean();
    expect(Object.keys(raw.usageRevertReceipts)).toHaveLength(1);
    for (const path of [`/contracts/${userId}`, '/contracts']) {
      const response = await request(app).get(baseUrl + path).set('x-api-key', key);
      expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toContain('usageRevertReceipts');
      expect(JSON.stringify(response.body)).not.toContain(createHash('sha256').update(consumptionId).digest('hex'));
    }
  });

  it('never applies an orphaned old consumption to a recreated contract with the same userId', async () => {
    const old: any = await record(); const previousContractId = old.contractId;
    expect(typeof previousContractId).toBe('string');
    expect((await request(app).delete(`${baseUrl}/contracts/${userId}`).set('x-api-key', key)).status).toBe(204);
    expect((await create()).status).toBe(201); const fresh = await consume(1);
    expect(String((await stored())._id)).not.toBe(previousContractId);
    // Reproduce interrupted old-record cleanup: its immutable contract identity is still old.
    await UsageConsumption.create(old);
    const response = await revert(); expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(await consumed()).toBe(1); expect((await record()).revertedAt).toBeUndefined();
    expect((await revert(fresh)).status).toBe(204); expect(await consumed()).toBe(0);
  });
  describe('write-ahead consumption recovery', () => {
    beforeEach(async () => {
      // Leave the common revert fixture alone and use a fresh zero-usage contract.
      userId = uuidv4();
      expect((await create()).status).toBe(201);
    });
    const apply = () => request(app).post(`${baseUrl}/features/${userId}/${FEATURE}`).set('x-api-key', key)
      .send({ 'petclinic-maxPets': 1 });
    const appliedRecord = () => UsageConsumption.findOne({ organizationId: organization.id, userId, featureId: FEATURE }).lean() as any;

    it('continues once when preparing the record persisted but its acknowledgement failed', async () => {
      const repository: any = container.resolve('usageConsumptionRepository'), original = repository.create.bind(repository);
      let preparedId = '';
      const fault = vi.spyOn(repository, 'create').mockImplementationOnce(async (...args: any[]) => {
        preparedId = args[0].id;
        await original(...args);
        throw new Error('Injected failure after prepared-record insert');
      });
      const response = await apply();
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.eval).toBe(true);
      expect(response.body.consumptionId).toBe(preparedId);
      expect(fault).toHaveBeenCalledTimes(1);
      expect(await UsageConsumption.countDocuments({ organizationId: organization.id, userId })).toBe(1);
      expect(await consumed()).toBe(1);
      expect(await appliedRecord()).toMatchObject({ _id: preparedId, state: 'applied', contractId: String((await stored())._id) });
      expect((await revert(preparedId)).status).toBe(204);
      expect((await revert(preparedId)).status).toBe(204);
      expect(await consumed()).toBe(0);
    });

    it('does not change usage when preparing the consumption record fails before insertion', async () => {
      const repository: any = container.resolve('usageConsumptionRepository');
      vi.spyOn(repository, 'create').mockRejectedValueOnce(new Error('Injected failure before prepared-record insert'));
      const increment = vi.spyOn(container.resolve('contractRepository'), 'incrementUsageLevels');
      const response = await apply();
      expect(response.status, JSON.stringify(response.body)).toBe(500);
      expect(increment).not.toHaveBeenCalled();
      expect(await consumed()).toBe(0);
      expect(await UsageConsumption.countDocuments({ organizationId: organization.id, userId })).toBe(0);
    });

    it('keeps the prepared record and atomic receipt when the increment persisted before throwing', async () => {
      const repository: any = container.resolve('contractRepository'), original = repository.incrementUsageLevels.bind(repository);
      const decrement = vi.spyOn(repository, 'decrementUsageLevels');
      vi.spyOn(repository, 'incrementUsageLevels').mockImplementationOnce(async (...args: any[]) => {
        await original(...args);
        throw new Error('Injected failure after persisted consumption increment');
      });
      const response = await apply();
      expect(response.status, JSON.stringify(response.body)).toBe(500);
      expect(await consumed()).toBe(1);
      expect(decrement).not.toHaveBeenCalled(); // No compensation against potentially newer state.
      const prepared = await appliedRecord();
      expect(prepared.state).toBe('prepared');
      expect(prepared.contractId).toBe(String((await stored())._id));
      const raw: any = await Contract.findOne({ organizationId: organization.id, 'userContact.userId': userId }).select('+usageConsumptionReceipts').lean();
      expect(raw.usageConsumptionReceipts[createHash('sha256').update(prepared._id).digest('hex')]).toBeInstanceOf(Date);
      const recovered = await revert(prepared._id);
      expect(recovered.status, JSON.stringify(recovered.body)).toBe(204);
      expect((await revert(prepared._id)).status).toBe(204);
      expect(decrement).toHaveBeenCalledTimes(1);
      expect(await consumed()).toBe(0);
      expect(await appliedRecord()).toMatchObject({ state: 'applied', revertedAt: expect.any(Date) });
    });

    it.each([false, true])('can revert when applied acknowledgement fails (persisted=%s)', async persisted => {
      const repository: any = container.resolve('usageConsumptionRepository'), original = repository.applied.bind(repository);
      vi.spyOn(repository, 'applied').mockImplementationOnce(async (...args: any[]) => {
        if (persisted) await original(...args);
        throw new Error('Injected applied acknowledgement failure');
      });
      const response = await apply();
      expect(response.status, JSON.stringify(response.body)).toBe(500);
      expect(await consumed()).toBe(1);
      const interrupted = await appliedRecord();
      expect(interrupted.state).toBe(persisted ? 'applied' : 'prepared');
      const recovered = await revert(interrupted._id);
      expect(recovered.status, JSON.stringify(recovered.body)).toBe(204);
      expect((await revert(interrupted._id)).status).toBe(204);
      expect(await consumed()).toBe(0);
      expect((await appliedRecord()).revertedAt).toBeInstanceOf(Date);
    });

    it('does not refund an expired legacy row while TTL cleanup has not removed it', async () => {
      const response = await apply();
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const id = response.body.consumptionId;
      const now = Date.now();
      await UsageConsumption.updateOne({ _id: id }, {
        $unset: { state: '', contractId: '' }, $set: { expiresAt: new Date(now + 30_000) },
      });
      // Advance only the application's Date. MongoDB's real TTL clock still
      // sees an unexpired row, while it is expired and recent enough for the
      // legacy selector in SPACE. Real HTTP/Redis timers remain running.
      vi.setSystemTime(new Date(now + 60_000));
      try {
        expect(await UsageConsumption.findById(id).lean()).not.toBeNull();
        const legacy = await request(app).post(`${baseUrl}/features/${userId}/${FEATURE}?revert=true&latest=true`).set('x-api-key', key);
        expect(legacy.status, JSON.stringify(legacy.body)).toBe(204);
        expect(await consumed()).toBe(1);
        const explicit = await revert(id);
        expect(explicit.status, JSON.stringify(explicit.body)).toBe(404);
        expect(await consumed()).toBe(1);
        expect(await UsageConsumption.findById(id).lean()).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });

});
