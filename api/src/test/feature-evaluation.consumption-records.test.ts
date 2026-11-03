import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import container from '../main/config/container';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import {
  addApiKeyToOrganization,
  addMemberToOrganization,
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
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';
import {
  PETCLINIC_BASE_VERSION,
  uploadPetclinicService,
  writePetclinicVariant,
} from './utils/services/petclinicVersions';

/**
 * Consumption records (`consumptionId`) when the service they consumed is
 * renamed, moved to another organization or deleted.
 *
 * A record names the service, the organization and the usage level it
 * incremented. Renaming or moving the service rewrites the contracts, so the
 * records must follow them: a revert by `consumptionId` keeps subtracting
 * exactly what was consumed. Deleting the service deletes its records, in
 * that organization only. A record that names a service the contract no
 * longer has is never claimed as if it had been reverted: the revert answers
 * 409 and the record stays as it was. A usage level that its service no
 * longer has (for example, after its pricing version was archived with a fallback without that limit) has nothing to give
 * back: it is skipped, the other levels are reverted, and the answer (200)
 * lists what was skipped.
 *
 * Petclinic and "Petclinicplus" (the same pricing under another saasName, a
 * name that starts like the other one), both GOLD: maxPets 4, maxVisits 3.
 */
const A = 'petclinic';
const PLUS = 'petclinicplus';

describe('Consumption records follow their service', function () {
  let app: Server;
  let ownerA: LeanUser;
  let ownerB: LeanUser;
  let orgA: LeanOrganization;
  let orgB: LeanOrganization;
  let keyA: string;
  let keyB: string;
  let userId: string;

  const plusFile = () =>
    writePetclinicVariant('1.0', '2025-01-01', pricing => {
      pricing.saasName = 'Petclinicplus';
    });

  const createContract = (key: string, id: string, services: Record<string, string>) =>
    request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', key)
      .send({
        userContact: { userId: id, username: 'consumer' },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: services,
        subscriptionPlans: Object.fromEntries(Object.keys(services).map(service => [service, 'GOLD'])),
        subscriptionAddOns: {},
      });

  /** Consume `amount` of `limit` through `feature` of `service`; returns the consumptionId. */
  const consume = async (key: string, service: string, amount: number, feature = 'pets', limit = 'maxPets', id = userId) => {
    const response = await request(app)
      .post(`${baseUrl}/features/${id}/${service}-${feature}`)
      .set('x-api-key', key)
      .send({ [`${service}-${limit}`]: amount });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.eval, JSON.stringify(response.body)).toBe(true);
    expect(typeof response.body.consumptionId).toBe('string');
    return response.body.consumptionId as string;
  };

  const revert = (key: string, featureId: string, consumptionId: string, id = userId) =>
    request(app)
      .post(`${baseUrl}/features/${id}/${featureId}?revert=true&consumptionId=${consumptionId}`)
      .set('x-api-key', key);

  /** A usage level as stored, never a cached copy. */
  const consumed = async (organizationId: string, service: string, limit = 'maxPets', id = userId) => {
    const stored: any = await ContractMongoose.findOne({ organizationId, 'userContact.userId': id }).lean();
    return stored?.usageLevels?.[service]?.[limit]?.consumed;
  };

  const record = (consumptionId: string) => UsageConsumptionMongoose.findById(consumptionId).lean() as any;

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    ownerA = await createTestUser('USER', `owner_a_${uuidv4()}`);
    ownerB = await createTestUser('USER', `owner_b_${uuidv4()}`);
    orgA = await createTestOrganization(ownerA.username);
    orgB = await createTestOrganization(ownerB.username);
    keyA = generateOrganizationApiKey();
    keyB = generateOrganizationApiKey();
    await addApiKeyToOrganization(orgA.id!, { key: keyA, scope: 'ALL' });
    await addApiKeyToOrganization(orgB.id!, { key: keyB, scope: 'ALL' });
    await uploadPetclinicService(app, keyA);
    await uploadPetclinicService(app, keyA, plusFile());
    userId = `user-${uuidv4()}`;
  });

  afterEach(async function () {
    const orgs = [orgA.id, orgB.id];
    await UsageConsumptionMongoose.deleteMany({ organizationId: { $in: orgs } });
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

  it('renaming a service keeps reverting its consumptions by consumptionId exactly', async function () {
    expect((await createContract(keyA, userId, { [A]: PETCLINIC_BASE_VERSION, [PLUS]: '1.0' })).status).toBe(201);
    const first = await consume(keyA, A, 2);
    await consume(keyA, A, 1);
    const plus = await consume(keyA, PLUS, 2);

    // Another casing of the exact name; "Petclinicplus" starts like it and is not renamed.
    const renamed = await request(app).put(`${baseUrl}/services/PETCLINIC`).set('x-api-key', keyA).send({ name: 'VetCare' });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(await consumed(orgA.id!, 'vetcare')).toBe(3);

    expect(await record(first)).toMatchObject({
      organizationId: orgA.id,
      featureId: 'vetcare-pets',
      levels: [{ serviceName: 'vetcare', usageLimit: 'maxPets', amount: 2 }],
    });
    expect((await record(plus)).featureId).toBe(`${PLUS}-pets`);
    expect((await record(plus)).levels[0].serviceName).toBe(PLUS);

    // The old feature id no longer names it, and claims nothing.
    expect((await revert(keyA, `${A}-pets`, first)).status).toBe(404);
    expect((await record(first)).revertedAt).toBeUndefined();

    const reverted = await revert(keyA, 'vetcare-pets', first);
    expect(reverted.status, JSON.stringify(reverted.body)).toBe(204);
    expect(await consumed(orgA.id!, 'vetcare')).toBe(1);

    const plusReverted = await revert(keyA, `${PLUS}-pets`, plus);
    expect(plusReverted.status, JSON.stringify(plusReverted.body)).toBe(204);
    expect(await consumed(orgA.id!, PLUS)).toBe(0);
  });

  it('moving a service to another organization takes its consumption records with the contracts that move', async function () {
    // The OWNER of the source organization, MANAGER of the target one, may move it.
    await addMemberToOrganization(orgB.id!, { username: ownerA.username, role: 'MANAGER' });
    const staysId = `user-${uuidv4()}`;
    expect((await createContract(keyA, userId, { [A]: PETCLINIC_BASE_VERSION })).status).toBe(201);
    expect((await createContract(keyA, staysId, { [A]: PETCLINIC_BASE_VERSION, [PLUS]: '1.0' })).status).toBe(201);
    const moving = await consume(keyA, A, 2);
    await consume(keyA, A, 1);
    const left = await consume(keyA, A, 1, 'pets', 'maxPets', staysId);
    const kept = await consume(keyA, PLUS, 2, 'pets', 'maxPets', staysId);

    const moved = await request(app)
      .put(`${baseUrl}/organizations/${orgA.id}/services/Petclinic`)
      .set('x-api-key', ownerA.apiKey)
      .send({ organizationId: orgB.id });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await consumed(orgB.id!, A)).toBe(3);

    // The contract that moved: its records are reverted from the organization it is in now.
    expect((await record(moving)).organizationId).toBe(orgB.id);
    expect((await revert(keyA, `${A}-pets`, moving)).status).toBe(404);
    const reverted = await revert(keyB, `${A}-pets`, moving);
    expect(reverted.status, JSON.stringify(reverted.body)).toBe(204);
    expect(await consumed(orgB.id!, A)).toBe(1);

    // The contract that stays lost the service: nothing of it is left to revert there.
    expect(await record(left)).toBeNull();
    expect((await revert(keyA, `${A}-pets`, left, staysId)).status).toBe(404);
    const keptReverted = await revert(keyA, `${PLUS}-pets`, kept, staysId);
    expect(keptReverted.status, JSON.stringify(keptReverted.body)).toBe(204);
    expect(await consumed(orgA.id!, PLUS, 'maxPets', staysId)).toBe(0);
  });

  describe('deleting a service deletes its consumption records, in its organization only', function () {
    let inA: string;
    let plusInA: string;
    let inB: string;

    beforeEach(async function () {
      await uploadPetclinicService(app, keyB);
      expect((await createContract(keyA, userId, { [A]: PETCLINIC_BASE_VERSION, [PLUS]: '1.0' })).status).toBe(201);
      expect((await createContract(keyB, userId, { [A]: PETCLINIC_BASE_VERSION })).status).toBe(201);
      inA = await consume(keyA, A, 2);
      plusInA = await consume(keyA, PLUS, 1);
      inB = await consume(keyB, A, 3);
    });

    const expectOtherOrganizationUntouched = async () => {
      expect((await record(inB)).revertedAt).toBeUndefined();
      const reverted = await revert(keyB, `${A}-pets`, inB);
      expect(reverted.status, JSON.stringify(reverted.body)).toBe(204);
      expect(await consumed(orgB.id!, A)).toBe(0);
    };

    it('destroy (exact name, any casing)', async function () {
      expect(await container.resolve('serviceService').destroy('PETCLINIC', orgA.id!)).toBeTruthy();

      expect(await record(inA)).toBeNull();
      expect(await record(plusInA)).not.toBeNull();
      expect((await revert(keyA, `${A}-pets`, inA)).status).toBe(404);
      await expectOtherOrganizationUntouched();
    });

    it('prune (every service of the organization)', async function () {
      const pruned = await request(app).delete(`${baseUrl}/services`).set('x-api-key', keyA);
      expect(pruned.status, JSON.stringify(pruned.body)).toBe(200);

      expect(await UsageConsumptionMongoose.countDocuments({ organizationId: orgA.id })).toBe(0);
      await expectOtherOrganizationUntouched();
    });
  });

  describe('a consumption whose service the contract no longer has', function () {
    it('is refused with 409 and not claimed, and reverts exactly once the service resolves again', async function () {
      expect((await createContract(keyA, userId, { [A]: PETCLINIC_BASE_VERSION })).status).toBe(201);
      await consume(keyA, A, 1);
      const consumptionId = await consume(keyA, A, 2);
      // As a record left behind when a service was renamed: it still names the old service.
      await UsageConsumptionMongoose.updateOne({ _id: consumptionId }, { $set: { 'levels.0.serviceName': 'renamedaway' } });

      const refused = await revert(keyA, `${A}-pets`, consumptionId);

      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error).toMatch(/renamedaway\.maxPets/);
      expect(await consumed(orgA.id!, A)).toBe(3);
      expect((await record(consumptionId)).revertedAt).toBeUndefined();

      await UsageConsumptionMongoose.updateOne({ _id: consumptionId }, { $set: { 'levels.0.serviceName': A } });
      const reverted = await revert(keyA, `${A}-pets`, consumptionId);
      expect(reverted.status, JSON.stringify(reverted.body)).toBe(204);
      expect(await consumed(orgA.id!, A)).toBe(1);
    });

    it('subtracts none of its levels when the service of one of them is gone', async function () {
      expect((await createContract(keyA, userId, { [A]: PETCLINIC_BASE_VERSION })).status).toBe(201);
      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/${A}-multiDependentFeature`)
        .set('x-api-key', keyA)
        .send({ [`${A}-maxPets`]: 2, [`${A}-maxVisits`]: 1 });
      expect(response.body.eval, JSON.stringify(response.body)).toBe(true);
      const consumptionId = response.body.consumptionId;
      // One level still names a service the contract does not have (a rename that raced with it).
      const levels = (await record(consumptionId)).levels;
      const visits = levels.findIndex((level: any) => level.usageLimit === 'maxVisits');
      await UsageConsumptionMongoose.updateOne({ _id: consumptionId }, { $set: { [`levels.${visits}.serviceName`]: 'renamedaway' } });

      const refused = await revert(keyA, `${A}-multiDependentFeature`, consumptionId);

      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.error).toMatch(/renamedaway\.maxVisits/);
      expect(await consumed(orgA.id!, A)).toBe(2);
      expect(await consumed(orgA.id!, A, 'maxVisits')).toBe(1);
      expect((await record(consumptionId)).revertedAt).toBeUndefined();
    });
  });

  describe('a consumption with a usage level that its service no longer has', function () {
    /**
     * Consume maxPets 2 and maxVisits 1 with multiDependentFeature, then 1
     * more maxPets with pets, and drop maxVisits from the contract while the
     * service stays, as archiving its pricing version with a fallback without that limit leaves it.
     */
    const consumeBothThenDropVisits = async () => {
      expect((await createContract(keyA, userId, { [A]: PETCLINIC_BASE_VERSION })).status).toBe(201);
      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/${A}-multiDependentFeature`)
        .set('x-api-key', keyA)
        .send({ [`${A}-maxPets`]: 2, [`${A}-maxVisits`]: 1 });
      expect(response.body.eval, JSON.stringify(response.body)).toBe(true);
      await consume(keyA, A, 1);
      await ContractMongoose.updateOne(
        { organizationId: orgA.id, 'userContact.userId': userId },
        { $unset: { [`usageLevels.${A}.maxVisits`]: '' } }
      );
      await container.resolve('cacheService').del(contractCacheKey(orgA.id!, userId));
      expect(await consumed(orgA.id!, A)).toBe(3);
      return response.body.consumptionId as string;
    };

    const partial = (consumptionId: string) => ({
      consumptionId,
      reverted: { [`${A}-maxPets`]: 2 },
      skipped: [`${A}-maxVisits`],
    });

    it('skips that level, gives back exactly the others and says so (by consumptionId)', async function () {
      const consumptionId = await consumeBothThenDropVisits();

      const reverted = await revert(keyA, `${A}-multiDependentFeature`, consumptionId);

      expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
      expect(reverted.body).toEqual(partial(consumptionId));
      expect(await consumed(orgA.id!, A)).toBe(1);
      expect(await consumed(orgA.id!, A, 'maxVisits')).toBeUndefined();
      expect((await record(consumptionId)).revertedAt).toBeDefined();

      // Already reverted: nothing changes, as for any revert repeated.
      const again = await revert(keyA, `${A}-multiDependentFeature`, consumptionId);
      expect(again.status, JSON.stringify(again.body)).toBe(204);
      expect(await consumed(orgA.id!, A)).toBe(1);
    });

    it('skips that level in the legacy ?revert=true as well', async function () {
      const consumptionId = await consumeBothThenDropVisits();
      const legacyRevert = () =>
        request(app).post(`${baseUrl}/features/${userId}/${A}-multiDependentFeature?revert=true`).set('x-api-key', keyA);

      const reverted = await legacyRevert();

      expect(reverted.status, JSON.stringify(reverted.body)).toBe(200);
      expect(reverted.body).toEqual(partial(consumptionId));
      expect(await consumed(orgA.id!, A)).toBe(1);
      expect((await record(consumptionId)).revertedAt).toBeDefined();

      // No other recent consumption of the feature: nothing to revert.
      const again = await legacyRevert();
      expect(again.status, JSON.stringify(again.body)).toBe(204);
      expect(await consumed(orgA.id!, A)).toBe(1);
    });
  });
});
