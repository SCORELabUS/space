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
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';
import { PETCLINIC_BASE_VERSION, uploadPetclinicService } from './utils/services/petclinicVersions';

/**
 * Consumption of usage limits under concurrency.
 *
 * A feature evaluation with an expected consumption decides on the contract it
 * read and then increments the usage levels. Two requests that read the same
 * contract could both see room for one more and both consume, so a limit could
 * be exceeded. The limit is now part of the write: the increment only applies
 * while every level stays within its limit.
 *
 * Each applied consumption gets a `consumptionId`; reverting it subtracts
 * exactly what it consumed, once. The former revert restored a cached snapshot
 * of the level, overwriting whatever had happened since.
 *
 * Petclinic GOLD: maxPets 4 (+1 per extraPets), maxVisits 3,
 * calendarEventsCreationLimit 15 (renewable, monthly).
 */
describe('Atomic usage limits and revert by consumption', function () {
  let app: Server;
  let ownerA: LeanUser;
  let ownerB: LeanUser;
  let orgA: LeanOrganization;
  let orgB: LeanOrganization;
  let keyA: string;
  let keyB: string;
  let service: string;
  let userId: string;

  const pets = () => `${service}-pets`;
  const multi = () => `${service}-multiDependentFeature`;
  const calendar = () => `${service}-calendar`;
  const maxPets = () => `${service}-maxPets`;
  const maxVisits = () => `${service}-maxVisits`;
  const calendarLimit = () => `${service}-calendarEventsCreationLimit`;

  const createContract = (key: string, id: string, addOns: Record<string, number> = {}) =>
    request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', key)
      .send({
        userContact: { userId: id, username: 'consumer' },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: { [service]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [service]: 'GOLD' },
        subscriptionAddOns: { [service]: addOns },
      });

  const consume = (featureId: string, body: Record<string, number>, key = keyA, id = userId) =>
    request(app).post(`${baseUrl}/features/${id}/${featureId}`).set('x-api-key', key).send(body);

  const revert = (featureId: string, query: string, key = keyA, id = userId) =>
    request(app).post(`${baseUrl}/features/${id}/${featureId}?revert=true${query}`).set('x-api-key', key);

  /** Usage levels as stored, never a cached copy. */
  const levels = async (organizationId = orgA.id!, id = userId) => {
    const stored: any = await ContractMongoose.findOne({ organizationId, 'userContact.userId': id }).lean();
    return stored.usageLevels[service];
  };

  const consumed = async (limit: string, organizationId = orgA.id!, id = userId) =>
    (await levels(organizationId, id))[limit].consumed;

  const setUsage = async (increments: Record<string, number>, key = keyA, id = userId) => {
    const response = await request(app)
      .put(`${baseUrl}/contracts/${id}/usageLevels`)
      .set('x-api-key', key)
      .send({ [service]: increments });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  };

  const forgetCachedContract = async (organizationId = orgA.id!, id = userId) =>
    container.resolve('cacheService').del(contractCacheKey(organizationId, id));

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    ownerA = await createTestUser('USER');
    ownerB = await createTestUser('USER');
    orgA = await createTestOrganization(ownerA.username);
    orgB = await createTestOrganization(ownerB.username);
    keyA = generateOrganizationApiKey();
    keyB = generateOrganizationApiKey();
    await addApiKeyToOrganization(orgA.id!, { key: keyA, scope: 'ALL' });
    await addApiKeyToOrganization(orgB.id!, { key: keyB, scope: 'ALL' });
    service = (await uploadPetclinicService(app, keyA)).name.toLowerCase();
    userId = `user-${uuidv4()}`;
  });

  afterEach(async function () {
    const orgs = [orgA.id, orgB.id];
    await ContractMongoose.deleteMany({ organizationId: { $in: orgs } });
    await PricingMongoose.deleteMany({ _organizationId: { $in: orgs } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: orgs } });
    await deleteTestOrganization(orgA.id!);
    await deleteTestOrganization(orgB.id!);
    await deleteTestUser(ownerA.username);
    await deleteTestUser(ownerB.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('the limit is enforced by the write', function () {
    it('matches a renewable period received as an ISO string from a cached contract DTO', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const repository = container.resolve('contractRepository');
      const contract = await repository.findByUserId(userId, orgA.id!);
      // Redis round-trips dates through JSON. Mongoose does not cast the
      // nested Map<Map<usageLevel>> query path back to a BSON Date for us.
      const cached = JSON.parse(JSON.stringify(contract));
      const period = cached.usageLevels[service].calendarEventsCreationLimit.resetTimeStamp;
      expect(period).toBeTypeOf('string');
      const path = `${service}.calendarEventsCreationLimit`;
      const updated = await repository.incrementUsageLevels(userId, { [path]: 1 }, orgA.id!, {
        ceilings: { [path]: 15 },
        receipt: { id: uuidv4(), expiresAt: new Date(Date.now() + 60000), contractId: cached.id,
          resetTimeStamps: { [path]: period } },
      });

      expect(updated).not.toBeNull();
      expect(updated!.usageLevels[service].calendarEventsCreationLimit.consumed).toBe(1);
      expect(await consumed('calendarEventsCreationLimit')).toBe(1);
    });

    it('N parallel consumptions against limit L never exceed L', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);

      const responses = await Promise.all(Array.from({ length: 12 }, () => consume(pets(), { [maxPets()]: 1 })));

      expect(responses.every(response => response.status === 200)).toBe(true);
      const allowed = responses.filter(response => response.body.eval === true);
      const refused = responses.filter(response => response.body.eval === false);
      expect(await consumed('maxPets')).toBe(4);
      expect(allowed).toHaveLength(4);
      // Refused exactly as an evaluation over the limit is answered.
      for (const response of refused) {
        expect(response.body).toEqual({
          eval: false,
          used: { [maxPets()]: 5 },
          limit: { [maxPets()]: 4 },
          error: null,
        });
      }
    });

    it('uses the limit with the add-ons of the contract', async function () {
      expect((await createContract(keyA, userId, { extraPets: 2 })).status).toBe(201);

      const responses = await Promise.all(Array.from({ length: 12 }, () => consume(pets(), { [maxPets()]: 1 })));

      expect(await consumed('maxPets')).toBe(6);
      expect(responses.filter(response => response.body.eval === true)).toHaveLength(6);
      expect(responses.find(response => response.body.eval === false)?.body.limit).toEqual({ [maxPets()]: 6 });
    });

    it('checks every limit of the evaluation at once', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);

      const body = { [maxPets()]: 1, [maxVisits()]: 1 };
      const responses = await Promise.all(Array.from({ length: 10 }, () => consume(multi(), body)));

      // maxVisits (3) runs out first; maxPets is never incremented without it.
      expect(await consumed('maxVisits')).toBe(3);
      expect(await consumed('maxPets')).toBe(3);
      expect(responses.filter(response => response.body.eval === true)).toHaveLength(3);
    });

    it('checks the limit of the subscription stored at the write, not of the one read', async function () {
      // A downgrade lands between the evaluation and its write: the
      // consumption must not be applied with the limit of the old add-ons.
      expect((await createContract(keyA, userId, { extraPets: 2 })).status).toBe(201);
      await setUsage({ maxPets: 4 });
      const repository = container.resolve('contractRepository');
      const original = repository.incrementUsageLevels.bind(repository);
      let downgraded = false;
      const spy = vi.spyOn(repository, 'incrementUsageLevels').mockImplementation(async (...args: any[]) => {
        if (!downgraded) {
          downgraded = true;
          const novation = await request(app)
            .put(`${baseUrl}/contracts/${userId}`)
            .set('x-api-key', keyA)
            .send({
              contractedServices: { [service]: PETCLINIC_BASE_VERSION },
              subscriptionPlans: { [service]: 'GOLD' },
              subscriptionAddOns: { [service]: {} },
            });
          expect(novation.status, JSON.stringify(novation.body)).toBe(200);
        }
        return (original as any)(...args);
      });

      try {
        const response = await consume(pets(), { [maxPets()]: 1 });

        expect(downgraded).toBe(true);
        expect(response.body).toMatchObject({ eval: false, limit: { [maxPets()]: 4 } });
        expect(await consumed('maxPets')).toBe(4);
      } finally {
        spy.mockRestore();
      }
    });

    it('refuses a consumption that would take a level past its limit', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await setUsage({ maxPets: 3 });

      const response = await consume(pets(), { [maxPets()]: 2 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        eval: false,
        used: { [maxPets()]: 5 },
        limit: { [maxPets()]: 4 },
        error: null,
      });
      expect(await consumed('maxPets')).toBe(3);
    });

    it('applies nothing when one of several limits would overflow', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await setUsage({ maxPets: 3 });

      const response = await consume(multi(), { [maxPets()]: 2, [maxVisits()]: 1 });

      expect(response.body.eval).toBe(false);
      expect(await consumed('maxPets')).toBe(3);
      expect(await consumed('maxVisits')).toBe(0);
    });

    it('allows a consumption that reaches the limit exactly', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await setUsage({ maxPets: 2 });

      const response = await consume(pets(), { [maxPets()]: 2 });

      expect(response.body).toMatchObject({ eval: true, used: { [maxPets()]: 4 }, limit: { [maxPets()]: 4 } });
      expect(await consumed('maxPets')).toBe(4);
    });

    it('does not bound a negative consumption (a credit)', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await setUsage({ maxPets: 3 });

      const response = await consume(pets(), { [maxPets()]: -1 });

      expect(response.body).toMatchObject({ eval: true, used: { [maxPets()]: 2 } });
      expect(await consumed('maxPets')).toBe(2);
    });
  });

  describe('revert by consumptionId', function () {
    it('identifies each applied consumption, and only those', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);

      const first = await consume(pets(), { [maxPets()]: 1 });
      const second = await consume(pets(), { [maxPets()]: 1 });
      const plain = await consume(pets(), {});
      await setUsage({ maxPets: 2 });
      const refused = await consume(pets(), { [maxPets()]: 1 });

      expect(first.body.consumptionId).toEqual(expect.any(String));
      expect(second.body.consumptionId).toEqual(expect.any(String));
      expect(first.body.consumptionId).not.toBe(second.body.consumptionId);
      expect(plain.body).not.toHaveProperty('consumptionId');
      expect(refused.body.eval).toBe(false);
      expect(refused.body).not.toHaveProperty('consumptionId');
    });

    it('subtracts exactly that consumption while others run concurrently', async function () {
      expect((await createContract(keyA, userId, { extraPets: 6 })).status).toBe(201);
      const target = await consume(pets(), { [maxPets()]: 2 });
      expect(target.body.consumptionId).toEqual(expect.any(String));

      const [reverted, ...others] = await Promise.all([
        revert(pets(), `&consumptionId=${target.body.consumptionId}`),
        ...Array.from({ length: 5 }, () => consume(pets(), { [maxPets()]: 1 })),
      ]);

      expect(reverted.status).toBe(204);
      expect(others.every(response => response.body.eval === true)).toBe(true);
      expect(await consumed('maxPets')).toBe(5);
    });

    it('applies a revert once: repeating it is a no-op', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const first = await consume(pets(), { [maxPets()]: 2 });
      await consume(pets(), { [maxPets()]: 1 });

      const reverts = await Promise.all(
        Array.from({ length: 3 }, () => revert(pets(), `&consumptionId=${first.body.consumptionId}`))
      );
      const again = await revert(pets(), `&consumptionId=${first.body.consumptionId}`);

      expect(reverts.map(response => response.status)).toEqual([204, 204, 204]);
      expect(again.status).toBe(204);
      expect(await consumed('maxPets')).toBe(1);
    });

    it('never goes below zero and leaves other levels alone', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const visit = await consume(`${service}-visits`, { [maxVisits()]: 2 });
      await consume(pets(), { [maxPets()]: 1 });
      const reset = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels?usageLimit=maxVisits`)
        .set('x-api-key', keyA);
      expect(reset.status).toBe(200);
      await setUsage({ calendarEventsCreationLimit: 1 });

      const response = await revert(`${service}-visits`, `&consumptionId=${visit.body.consumptionId}`);

      expect(response.status).toBe(204);
      const after = await levels();
      expect(after.maxVisits.consumed).toBe(0);
      expect(after.maxPets.consumed).toBe(1);
      expect(after.calendarEventsCreationLimit.consumed).toBe(1);
    });

    it('answers 404 for an unknown id, another feature or another user, and changes nothing', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const otherUser = `user-${uuidv4()}`;
      expect((await createContract(keyA, otherUser)).status).toBe(201);
      const target = await consume(pets(), { [maxPets()]: 2 });
      const id = target.body.consumptionId;

      expect((await revert(pets(), `&consumptionId=${uuidv4()}`)).status).toBe(404);
      expect((await revert(multi(), `&consumptionId=${id}`)).status).toBe(404);
      expect((await revert(pets(), `&consumptionId=${id}`, keyA, otherUser)).status).toBe(404);
      expect(await consumed('maxPets')).toBe(2);
    });

    it('cannot be used from another organization, even for the same userId', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await uploadPetclinicService(app, keyB);
      expect((await createContract(keyB, userId)).status).toBe(201);
      await consume(pets(), { [maxPets()]: 1 }, keyB);
      const target = await consume(pets(), { [maxPets()]: 2 });

      const response = await revert(pets(), `&consumptionId=${target.body.consumptionId}`, keyB);

      expect(response.status).toBe(404);
      expect(await consumed('maxPets')).toBe(2);
      expect(await consumed('maxPets', orgB.id!)).toBe(1);
    });

    it('is durable: it does not depend on the cache', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const target = await consume(pets(), { [maxPets()]: 3 });
      const cache = container.resolve('cacheService');
      await cache.delMany(await cache.match('*'));

      const response = await revert(pets(), `&consumptionId=${target.body.consumptionId}`);

      expect(response.status).toBe(204);
      expect(await consumed('maxPets')).toBe(0);
    });
  });

  describe('legacy revert (?revert=true[&latest=true], deprecated)', function () {
    it('subtracts the oldest recent consumption instead of restoring a snapshot', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await consume(calendar(), { [calendarLimit()]: 5 });
      await consume(calendar(), { [calendarLimit()]: 1 });

      const response = await revert(calendar(), '');

      expect(response.status).toBe(204);
      expect(await consumed('calendarEventsCreationLimit')).toBe(1);
    });

    it('with latest=true subtracts the most recent one', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await consume(calendar(), { [calendarLimit()]: 5 });
      await consume(calendar(), { [calendarLimit()]: 1 });

      const response = await revert(calendar(), '&latest=true');

      expect(response.status).toBe(204);
      expect(await consumed('calendarEventsCreationLimit')).toBe(5);
    });

    it('keeps changes made to the level after the consumption', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await consume(calendar(), { [calendarLimit()]: 2 });
      await setUsage({ calendarEventsCreationLimit: 3 });

      const response = await revert(calendar(), '&latest=true');

      expect(response.status).toBe(204);
      expect(await consumed('calendarEventsCreationLimit')).toBe(3);
    });

    it('no longer loses consumptions that land while it runs', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const initial = await consume(calendar(), { [calendarLimit()]: 2 });
      const initialDiagnostic = JSON.stringify({ status: initial.status, body: initial.body });
      expect(initial.status, initialDiagnostic).toBe(200);
      expect(initial.body.eval, initialDiagnostic).toBe(true);
      expect(initial.body.consumptionId, initialDiagnostic).toBeTypeOf('string');

      const [reverted, ...consumptions] = await Promise.all([
        revert(calendar(), '&latest=true'),
        ...Array.from({ length: 6 }, () => consume(calendar(), { [calendarLimit()]: 1 })),
      ]);

      for (const [index, response] of consumptions.entries()) {
        const diagnostic = JSON.stringify({ index, status: response.status, body: response.body });
        expect(response.status, diagnostic).toBe(200);
        expect(response.body.eval, diagnostic).toBe(true);
        expect(response.body.consumptionId, diagnostic).toBeTypeOf('string');
      }
      expect(reverted.status).toBe(204);
      // 2 + 6 consumed, and one operation reverted: either the first (2) or one of the others (1).
      expect([6, 7]).toContain(await consumed('calendarEventsCreationLimit'));
    });

    it('preserves all six consumptions completed after a legacy refund reads its contract', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const initial = await consume(calendar(), { [calendarLimit()]: 2 });
      const initialDiagnostic = JSON.stringify({ status: initial.status, body: initial.body });
      expect(initial.status, initialDiagnostic).toBe(200);
      expect(initial.body.eval, initialDiagnostic).toBe(true);
      expect(initial.body.consumptionId, initialDiagnostic).toBeTypeOf('string');
      expect(await consumed('calendarEventsCreationLimit')).toBe(2);

      const repository: any = container.resolve('contractRepository');
      const original = repository.decrementUsageLevels.bind(repository);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const decrement = vi.spyOn(repository, 'decrementUsageLevels').mockImplementationOnce(async (...args: any[]) => {
        entered();
        await gate;
        return original(...args);
      });
      const pending = revert(calendar(), '&latest=true').then(response => response);
      let refunded!: request.Response;
      try {
        await Promise.race([started, pending.then(response => {
          throw new Error(`Refund finished before reaching the decrement barrier: ${JSON.stringify({ status: response.status, body: response.body })}`);
        })]);
        // The refund has selected the original consumption and read its contract.
        // Every increment now lands before the subtraction itself is allowed to run.
        const responses = await Promise.all(Array.from({ length: 6 }, () => consume(calendar(), { [calendarLimit()]: 1 })));
        for (const [index, response] of responses.entries()) {
          const diagnostic = JSON.stringify({ index, status: response.status, body: response.body });
          expect(response.status, diagnostic).toBe(200);
          expect(response.body.eval, diagnostic).toBe(true);
          expect(response.body.consumptionId, diagnostic).toBeTypeOf('string');
        }
        expect(new Set(responses.map(response => response.body.consumptionId)).size).toBe(6);
        expect(await consumed('calendarEventsCreationLimit')).toBe(8);
      } finally {
        release();
        try { refunded = await pending; } finally { decrement.mockRestore(); }
      }
      expect(refunded.status, JSON.stringify(refunded.body)).toBe(204);
      expect(await consumed('calendarEventsCreationLimit')).toBe(6);
    });

    it('reverts each consumption once, then does nothing', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await consume(calendar(), { [calendarLimit()]: 2 });
      await consume(calendar(), { [calendarLimit()]: 3 });

      expect((await revert(calendar(), '&latest=true')).status).toBe(204);
      expect(await consumed('calendarEventsCreationLimit')).toBe(2);
      expect((await revert(calendar(), '&latest=true')).status).toBe(204);
      expect(await consumed('calendarEventsCreationLimit')).toBe(0);
      await setUsage({ calendarEventsCreationLimit: 4 });
      expect((await revert(calendar(), '&latest=true')).status).toBe(204);
      expect(await consumed('calendarEventsCreationLimit')).toBe(4);
    });
  });

  describe('renewable usage levels', function () {
    /** Make the renewable level due for its reset, as stored. */
    const expireCalendarLevel = async (consumedSoFar: number) => {
      const past = new Date(Date.now() - 24 * 3600 * 1000);
      await ContractMongoose.updateOne(
        { organizationId: orgA.id, 'userContact.userId': userId },
        {
          $set: {
            [`usageLevels.${service}.calendarEventsCreationLimit.consumed`]: consumedSoFar,
            [`usageLevels.${service}.calendarEventsCreationLimit.resetTimeStamp`]: past,
          },
        }
      );
      await forgetCachedContract();
      return past;
    };

    it('resets once per period and then counts again', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await expireCalendarLevel(10);

      await consume(calendar(), { [calendarLimit()]: 1 });
      await consume(calendar(), { [calendarLimit()]: 1 });

      const level = (await levels()).calendarEventsCreationLimit;
      expect(level.consumed).toBe(2);
      expect(new Date(level.resetTimeStamp).getTime()).toBeGreaterThan(Date.now());
    });

    it('does not reset twice when evaluations arrive together at the reset', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await expireCalendarLevel(10);

      await Promise.all(Array.from({ length: 6 }, () => consume(calendar(), { [calendarLimit()]: 1 })));

      expect(await consumed('calendarEventsCreationLimit')).toBe(6);
    });
  });
});
