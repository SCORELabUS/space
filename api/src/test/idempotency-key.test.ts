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
import { PETCLINIC_BASE_VERSION, uploadPetclinicService } from './utils/services/petclinicVersions';
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';

/**
 * `Idempotency-Key` on writes that must not be applied twice when a client
 * retries them. The same key with the same request replays the first
 * response (`Idempotent-Replayed: true`) without applying it again; with
 * another request it is a conflict. Keys are scoped to the organization.
 */
describe('Idempotency-Key', function () {
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
  const maxPets = () => `${service}-maxPets`;
  const replayed = (response: request.Response) => response.headers['idempotent-replayed'] === 'true';

  const contractBody = (id: string, plan = 'GOLD', extra: any = {}) => ({
    userContact: { userId: id, username: 'consumer' },
    billingPeriod: { autoRenew: true, renewalDays: 30 },
    contractedServices: { [service]: PETCLINIC_BASE_VERSION },
    subscriptionPlans: { [service]: plan },
    subscriptionAddOns: { [service]: {} },
    ...extra,
  });

  const createContract = (key: string, id: string, idempotencyKey?: string, plan = 'GOLD') => {
    const call = request(app).post(`${baseUrl}/contracts`).set('x-api-key', key);
    if (idempotencyKey) call.set('Idempotency-Key', idempotencyKey);
    return call.send(contractBody(id, plan));
  };

  const consume = (body: Record<string, number>, idempotencyKey?: string, key = keyA, featureId = pets(), id = userId) => {
    const call = request(app).post(`${baseUrl}/features/${id}/${featureId}`).set('x-api-key', key);
    if (idempotencyKey) call.set('Idempotency-Key', idempotencyKey);
    return call.send(body);
  };

  const consumed = async (limit = 'maxPets', organizationId = orgA.id!, id = userId) => {
    const stored: any = await ContractMongoose.findOne({ organizationId, 'userContact.userId': id }).lean();
    return stored.usageLevels[service][limit].consumed;
  };

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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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

  describe('consumption', function () {
    it('replays a retried consumption instead of consuming twice', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const key = uuidv4();

      const first = await consume({ [maxPets()]: 1 }, key);
      const retry = await consume({ [maxPets()]: 1 }, key);

      expect(first.status).toBe(200);
      expect(replayed(first)).toBe(false);
      expect(retry.status).toBe(200);
      expect(replayed(retry)).toBe(true);
      expect(retry.body).toEqual(first.body);
      expect(retry.body.consumptionId).toBe(first.body.consumptionId);
      expect(await consumed()).toBe(1);
    });

    it('consumes every time without the header, as before', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);

      await consume({ [maxPets()]: 1 });
      const second = await consume({ [maxPets()]: 1 });

      expect(replayed(second)).toBe(false);
      expect(await consumed()).toBe(2);
    });

    it('answers 409 IDEMPOTENCY_CONFLICT for the same key with another request', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const otherUser = `user-${uuidv4()}`;
      expect((await createContract(keyA, otherUser)).status).toBe(201);
      const key = uuidv4();
      await consume({ [maxPets()]: 1 }, key);

      const otherAmount = await consume({ [maxPets()]: 2 }, key);
      const otherFeature = await consume({ [`${service}-maxVisits`]: 1 }, key, keyA, `${service}-visits`);
      const otherContract = await consume({ [maxPets()]: 1 }, key, keyA, pets(), otherUser);

      for (const response of [otherAmount, otherFeature, otherContract]) {
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('IDEMPOTENCY_CONFLICT');
      }
      expect(await consumed()).toBe(1);
      expect(await consumed('maxVisits')).toBe(0);
      expect(await consumed('maxPets', orgA.id!, otherUser)).toBe(0);
    });

    it('lets one of several concurrent requests with the same key run, and replays it to the others', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const key = uuidv4();

      const responses = await Promise.all(Array.from({ length: 8 }, () => consume({ [maxPets()]: 1 }, key)));

      expect(await consumed()).toBe(1);
      expect(responses.map(response => response.status)).toEqual(Array(8).fill(200));
      expect(new Set(responses.map(response => response.body.consumptionId)).size).toBe(1);
      expect(responses.filter(response => !replayed(response))).toHaveLength(1);
    });

    it('answers 409 IDEMPOTENCY_IN_PROGRESS with Retry-After while the first request is still running', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      vi.stubEnv('IDEMPOTENCY_WAIT_MS', '0');
      const contractService = container.resolve('contractService');
      const original = contractService._applyExpectedConsumptions.bind(contractService);
      let entered!: () => void;
      const started = new Promise<void>(resolve => (entered = resolve));
      let finish!: () => void;
      const gate = new Promise<void>(resolve => (finish = resolve));
      vi.spyOn(contractService, '_applyExpectedConsumptions').mockImplementation(async (...args: any[]) => {
        entered();
        await gate;
        return (original as any)(...args);
      });
      const key = uuidv4();

      const first = consume({ [maxPets()]: 1 }, key);
      const firstDone = first.then(response => response);
      await started;
      const second = await consume({ [maxPets()]: 1 }, key);
      finish();
      const firstResponse = await firstDone;

      expect(second.status).toBe(409);
      expect(second.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
      expect(second.headers['retry-after']).toBe('1');
      expect(firstResponse.status).toBe(200);
      expect(await consumed()).toBe(1);
      const third = await consume({ [maxPets()]: 1 }, key);
      expect(replayed(third)).toBe(true);
      expect(third.body.consumptionId).toBe(firstResponse.body.consumptionId);
    });

    it('forgets keys after their retention (IDEMPOTENCY_KEY_TTL_SECONDS)', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      vi.stubEnv('IDEMPOTENCY_KEY_TTL_SECONDS', '1');
      const key = uuidv4();

      const first = await consume({ [maxPets()]: 1 }, key);
      const withinTtl = await consume({ [maxPets()]: 1 }, key);
      await new Promise(resolve => setTimeout(resolve, 1200));
      const afterTtl = await consume({ [maxPets()]: 1 }, key);

      expect(replayed(withinTtl)).toBe(true);
      expect(replayed(afterTtl)).toBe(false);
      expect(afterTtl.body.consumptionId).not.toBe(first.body.consumptionId);
      expect(await consumed()).toBe(2);
    });

    it('scopes keys to the organization', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      await uploadPetclinicService(app, keyB);
      expect((await createContract(keyB, userId)).status).toBe(201);
      const key = uuidv4();

      const inA = await consume({ [maxPets()]: 1 }, key, keyA);
      const inB = await consume({ [maxPets()]: 1 }, key, keyB);
      const otherBodyInB = await consume({ [maxPets()]: 2 }, uuidv4(), keyB);

      expect(replayed(inA)).toBe(false);
      expect(replayed(inB)).toBe(false);
      expect(inB.body.consumptionId).not.toBe(inA.body.consumptionId);
      expect(otherBodyInB.status).toBe(200);
      expect(await consumed('maxPets', orgA.id!)).toBe(1);
      expect(await consumed('maxPets', orgB.id!)).toBe(3);
    });

    it('replays a revert by consumptionId', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const target = await consume({ [maxPets()]: 2 });
      const key = uuidv4();
      const revert = () =>
        request(app)
          .post(`${baseUrl}/features/${userId}/${pets()}?revert=true&consumptionId=${target.body.consumptionId}`)
          .set('x-api-key', keyA)
          .set('Idempotency-Key', key);

      const first = await revert();
      const retry = await revert();

      expect(first.status).toBe(204);
      expect(retry.status).toBe(204);
      expect(replayed(retry)).toBe(true);
      expect(await consumed()).toBe(0);
    });

    it('replays a revert that skipped a usage level with the same status and body', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const target = await consume({ [maxPets()]: 2, [`${service}-maxVisits`]: 1 }, undefined, keyA, `${service}-multiDependentFeature`);
      expect(target.body.eval, JSON.stringify(target.body)).toBe(true);
      // The service stays but no longer has maxVisits, as archiving its pricing version with a fallback without it leaves it.
      await ContractMongoose.updateOne(
        { organizationId: orgA.id, 'userContact.userId': userId },
        { $unset: { [`usageLevels.${service}.maxVisits`]: '' } }
      );
      await container.resolve('cacheService').del(contractCacheKey(orgA.id!, userId));
      const key = uuidv4();
      const revert = (idempotencyKey?: string) => {
        const call = request(app)
          .post(`${baseUrl}/features/${userId}/${service}-multiDependentFeature?revert=true&consumptionId=${target.body.consumptionId}`)
          .set('x-api-key', keyA);
        if (idempotencyKey) call.set('Idempotency-Key', idempotencyKey);
        return call;
      };

      const first = await revert(key);
      const retry = await revert(key);

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body).toEqual({
        consumptionId: target.body.consumptionId,
        reverted: { [maxPets()]: 2 },
        skipped: [`${service}-maxVisits`],
      });
      expect(replayed(first)).toBe(false);
      expect(retry.status).toBe(200);
      expect(replayed(retry)).toBe(true);
      expect(retry.headers['content-type']).toBe(first.headers['content-type']);
      expect(retry.body).toEqual(first.body);
      expect(await consumed()).toBe(0);
      // Without the key the revert runs again: already reverted, nothing to say.
      expect((await revert()).status).toBe(204);
      expect(await consumed()).toBe(0);
    });

    it('ignores the header on an evaluation that does not consume', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const key = uuidv4();

      const first = await consume({}, key);
      const second = await consume({}, key);
      const consuming = await consume({ [maxPets()]: 1 }, key);

      expect(replayed(first) || replayed(second)).toBe(false);
      expect(consuming.status).toBe(200);
      expect(replayed(consuming)).toBe(false);
      expect(await consumed()).toBe(1);
    });

    it('rejects a key that is empty or longer than 255 characters', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);

      const empty = await request(app)
        .post(`${baseUrl}/features/${userId}/${pets()}`)
        .set('x-api-key', keyA)
        .set('Idempotency-Key', '')
        .send({ [maxPets()]: 1 });
      const tooLong = await consume({ [maxPets()]: 1 }, 'k'.repeat(256));
      const longest = await consume({ [maxPets()]: 1 }, 'k'.repeat(255));

      for (const response of [empty, tooLong]) {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
      }
      expect(longest.status).toBe(200);
      expect(await consumed()).toBe(1);
    });
  });

  describe('usage levels', function () {
    it('replays a retried increment instead of adding it twice', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const key = uuidv4();
      const increment = () =>
        request(app)
          .put(`${baseUrl}/contracts/${userId}/usageLevels`)
          .set('x-api-key', keyA)
          .set('Idempotency-Key', key)
          .send({ [service]: { maxPets: 2 } });

      const first = await increment();
      const retry = await increment();

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(replayed(retry)).toBe(true);
      expect(retry.headers.etag).toBe(first.headers.etag);
      expect(retry.body).toEqual(first.body);
      expect(await consumed()).toBe(2);
    });
  });

  describe('contracts', function () {
    it('replays a retried creation (201 and the same body), creating one contract', async function () {
      const key = uuidv4();

      const first = await createContract(keyA, userId, key);
      const retry = await createContract(keyA, userId, key);
      const withoutKey = await createContract(keyA, userId);

      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(replayed(retry)).toBe(true);
      expect(retry.body).toEqual(first.body);
      expect(withoutKey.status).toBe(409);
      expect(await ContractMongoose.countDocuments({ organizationId: orgA.id, 'userContact.userId': userId })).toBe(1);
    });

    it('replays a creation on the organization-scoped route for member user keys', async function () {
      const key = uuidv4();
      const create = () =>
        request(app)
          .post(`${baseUrl}/organizations/${orgA.id}/contracts`)
          .set('x-api-key', ownerA.apiKey)
          .set('Idempotency-Key', key)
          .send(contractBody(userId));

      const first = await create();
      const retry = await create();

      expect(first.status, JSON.stringify(first.body)).toBe(201);
      expect(retry.status).toBe(201);
      expect(replayed(retry)).toBe(true);
      expect(await ContractMongoose.countDocuments({ organizationId: orgA.id, 'userContact.userId': userId })).toBe(1);
    });

    it('stores a 4xx outcome of the operation and replays it', async function () {
      const key = uuidv4();
      const invalid = () =>
        request(app)
          .post(`${baseUrl}/contracts`)
          .set('x-api-key', keyA)
          .set('Idempotency-Key', key)
          .send(contractBody(userId, 'NO_SUCH_PLAN'));

      const first = await invalid();
      const retry = await invalid();

      expect(first.status).toBe(400);
      expect(retry.status).toBe(400);
      expect(replayed(retry)).toBe(true);
      expect(retry.body).toEqual(first.body);
    });

    it('does not store a 5xx: a retry with the same key runs again', async function () {
      const contractService = container.resolve('contractService');
      const original = contractService.create.bind(contractService);
      let calls = 0;
      vi.spyOn(contractService, 'create').mockImplementation(async (...args: any[]) => {
        calls += 1;
        if (calls === 1) throw new Error('database unavailable');
        return (original as any)(...args);
      });
      const key = uuidv4();

      const first = await createContract(keyA, userId, key);
      const retry = await createContract(keyA, userId, key);

      expect(first.status).toBe(500);
      expect(retry.status).toBe(201);
      expect(replayed(retry)).toBe(false);
      expect(calls).toBe(2);
    });

    it('replays a novation with If-Match, even after the version it named changed', async function () {
      const created = await createContract(keyA, userId);
      const key = uuidv4();
      const novate = (plan: string, ifMatch: string, idempotencyKey = key) =>
        request(app)
          .put(`${baseUrl}/contracts/${userId}`)
          .set('x-api-key', keyA)
          .set('Idempotency-Key', idempotencyKey)
          .set('If-Match', ifMatch)
          .send({
            contractedServices: { [service]: PETCLINIC_BASE_VERSION },
            subscriptionPlans: { [service]: plan },
            subscriptionAddOns: { [service]: {} },
          });

      const first = await novate('PLATINUM', created.headers.etag);
      const retry = await novate('PLATINUM', created.headers.etag);
      const otherPrecondition = await novate('PLATINUM', first.headers.etag);
      const withoutReplay = await novate('PLATINUM', created.headers.etag, uuidv4());

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(replayed(retry)).toBe(true);
      expect(retry.headers.etag).toBe(first.headers.etag);
      expect(otherPrecondition.status).toBe(409);
      expect(otherPrecondition.body.code).toBe('IDEMPOTENCY_CONFLICT');
      // Run again (new key), the stale If-Match is refused: the replay did not re-apply it.
      expect(withoutReplay.status).toBe(412);
      const stored: any = await ContractMongoose.findOne({ organizationId: orgA.id, 'userContact.userId': userId }).lean();
      expect(stored.history).toHaveLength(1);
    });

    it('replays a group novation', async function () {
      const groupId = `group-${uuidv4()}`;
      for (const id of [userId, `${userId}-2`]) {
        const response = await request(app)
          .post(`${baseUrl}/contracts`)
          .set('x-api-key', keyA)
          .send(contractBody(id, 'GOLD', { groupId }));
        expect(response.status).toBe(201);
      }
      const key = uuidv4();
      const novate = () =>
        request(app)
          .put(`${baseUrl}/contracts?groupId=${groupId}`)
          .set('x-api-key', keyA)
          .set('Idempotency-Key', key)
          .send({
            contractedServices: { [service]: PETCLINIC_BASE_VERSION },
            subscriptionPlans: { [service]: 'PLATINUM' },
            subscriptionAddOns: { [service]: {} },
          });

      const first = await novate();
      const retry = await novate();

      expect(first.status).toBe(200);
      expect(replayed(retry)).toBe(true);
      expect(retry.body).toEqual(first.body);
      const stored: any[] = await ContractMongoose.find({ organizationId: orgA.id, groupId }).lean();
      expect(stored.map(contract => contract.history.length)).toEqual([1, 1]);
    });

    it('has no effect on reads', async function () {
      expect((await createContract(keyA, userId)).status).toBe(201);
      const key = uuidv4();
      const read = () =>
        request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', keyA).set('Idempotency-Key', key);

      const first = await read();
      await consume({ [maxPets()]: 1 });
      const second = await read();

      expect(replayed(second)).toBe(false);
      expect(first.body.usageLevels[service].maxPets.consumed).toBe(0);
      expect(second.body.usageLevels[service].maxPets.consumed).toBe(1);
    });
  });
});
