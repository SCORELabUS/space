import path from 'path';
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

/**
 * Optimistic concurrency on novation (contractVersion / ETag / If-Match).
 *
 * A host shows a customer their contract, the customer picks a new
 * configuration and confirms. Meanwhile the contract may have changed (another
 * tab, an operator, a SPHERE migration). With `If-Match` (or
 * `expectedContractVersion`) the novation only applies to the version the
 * customer reviewed; otherwise it is refused with 412 and the current version.
 */

const PETCLINIC_PRICING_PATH = path.resolve(__dirname, './data/pricings/petclinic-2025.yml');

describe('Contract version and conditional novation', function () {
  let app: Server;
  let adminUser: LeanUser;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let orgKey: string;
  let serviceName: string;
  let pricingVersion: string;
  let userId: string;

  const subscription = (plan = 'GOLD', addOns: Record<string, number> = { extraPets: 2 }) => ({
    contractedServices: { [serviceName]: pricingVersion },
    subscriptionPlans: { [serviceName]: plan },
    subscriptionAddOns: { [serviceName]: addOns },
  });

  const createContract = async (groupId?: string) => {
    const id = uuidv4();
    const response = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', orgKey)
      .send({
        userContact: { userId: id, username: `user-${id.slice(0, 8)}` },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        groupId,
        ...subscription(),
      });
    expect(response.status).toBe(201);
    return response;
  };

  const read = () => request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', orgKey);
  const novate = (body: any, ifMatch?: string) => {
    const req = request(app).put(`${baseUrl}/contracts/${userId}`).set('x-api-key', orgKey);
    if (ifMatch !== undefined) req.set('If-Match', ifMatch);
    return req.send(body);
  };
  const stored = async () => ContractMongoose.findOne({ 'userContact.userId': userId }).lean() as any;

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    adminUser = await createTestUser('ADMIN');
    owner = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    orgKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: orgKey, scope: 'ALL' });

    const upload = await request(app)
      .post(`${baseUrl}/organizations/${organization.id}/services`)
      .set('x-api-key', adminUser.apiKey)
      .attach('pricing', PETCLINIC_PRICING_PATH);
    expect(upload.status).toBe(201);
    serviceName = upload.body.name.toLowerCase();
    pricingVersion = Object.keys(upload.body.activePricings)[0];

    userId = (await createContract()).body.userContact.userId;
  });

  afterEach(async function () {
    vi.restoreAllMocks();
    await ContractMongoose.deleteMany({ organizationId: organization.id });
    await ServiceMongoose.deleteMany({ organizationId: organization.id });
    await deleteTestOrganization(organization.id!);
    await deleteTestUser(adminUser.username);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('contractVersion in responses', function () {
    it('is returned by creation, read and list, with a matching ETag', async function () {
      const created = await createContract();
      const shown = await request(app)
        .get(`${baseUrl}/contracts/${created.body.userContact.userId}`)
        .set('x-api-key', orgKey);
      const listed = await request(app).get(`${baseUrl}/contracts`).set('x-api-key', orgKey);

      expect(typeof created.body.contractVersion).toBe('string');
      expect(created.headers.etag).toBe(`"${created.body.contractVersion}"`);
      expect(shown.body.contractVersion).toBe(created.body.contractVersion);
      expect(shown.headers.etag).toBe(`"${shown.body.contractVersion}"`);
      expect(listed.body.every((contract: any) => typeof contract.contractVersion === 'string')).toBe(true);
    });

    it('is returned by the organization-scoped read', async function () {
      const response = await request(app)
        .get(`${baseUrl}/organizations/${organization.id}/contracts/${userId}`)
        .set('x-api-key', owner.apiKey);

      expect(response.status).toBe(200);
      expect(response.headers.etag).toBe(`"${response.body.contractVersion}"`);
    });

    it('does not change when usage is recorded', async function () {
      const before = (await read()).body.contractVersion;

      const usage = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels`)
        .set('x-api-key', orgKey)
        .send({ [serviceName]: { maxPets: 1 } });
      const evaluation = await request(app)
        .post(`${baseUrl}/features/${userId}/${serviceName}-pets`)
        .set('x-api-key', orgKey)
        .send({ [`${serviceName}-maxPets`]: 1 });

      expect(usage.status).toBe(200);
      expect(evaluation.status).toBe(200);
      expect(usage.body.contractVersion).toBe(before);
      expect((await read()).body.contractVersion).toBe(before);
    });

    it('changes with every novation, also when returning to an earlier subscription', async function () {
      const first = (await read()).body.contractVersion;
      const second = (await novate(subscription('PLATINUM'))).body.contractVersion;
      const third = (await novate(subscription('GOLD'))).body.contractVersion;

      expect(new Set([first, second, third]).size).toBe(3);
    });

    it('is never answered with 304: usage levels change under the same version', async function () {
      const first = await read();
      const again = await request(app)
        .get(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', orgKey)
        .set('If-None-Match', first.headers.etag);

      expect(again.status).toBe(200);
      expect(again.body.userContact.userId).toBe(userId);
    });
  });

  describe('consumption concurrent with novation', function () {
    const recordWhileWriting = (id: string) => {
      const repository = container.resolve('contractRepository');
      let recorded = false;
      for (const method of ['update', 'bulkUpdate', 'bulkUpdateGuarded'] as const) {
        const original = repository[method].bind(repository);
        vi.spyOn(repository, method).mockImplementation(async (...args: any[]) => {
          if (!recorded) {
            recorded = true;
            await ContractMongoose.updateOne(
              { organizationId: organization.id, 'userContact.userId': id },
              { $inc: { [`usageLevels.${serviceName}.maxPets.consumed`]: 1 },
                $set: { 'userContact.email': 'concurrent@example.test' } }
            );
          }
          return original(...args);
        });
      }
    };

    it.each([false, true])('preserves consumption and contact on a single novation (conditional: %s)', async conditional => {
      const reviewed = await read();
      const before = await stored();
      recordWhileWriting(userId);

      const response = await novate(subscription('PLATINUM'), conditional ? reviewed.headers.etag : undefined);
      const after = await stored();
      const shown = await read();

      expect(response.status).toBe(200);
      expect(after.usageLevels[serviceName].maxPets.consumed).toBe(before.usageLevels[serviceName].maxPets.consumed + 1);
      expect(after.userContact.email).toBe('concurrent@example.test');
      expect(after.subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect(after.history).toHaveLength(before.history.length + 1);
      expect(shown.body.usageLevels[serviceName].maxPets.consumed).toBe(after.usageLevels[serviceName].maxPets.consumed);
      expect(shown.body.userContact.email).toBe(after.userContact.email);
    });

    it.each([false, true])('preserves consumption and contact on a group novation (conditional: %s)', async conditional => {
      const groupId = `group-${uuidv4()}`;
      const member = (await createContract(groupId)).body;
      recordWhileWriting(member.userContact.userId);

      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}`)
        .set('x-api-key', orgKey)
        .send({ ...subscription('PLATINUM'), ...(conditional ? {
          expectedContractVersions: { [member.userContact.userId]: member.contractVersion },
        } : {}) });
      const after: any = await ContractMongoose.findOne({ 'userContact.userId': member.userContact.userId }).lean();

      expect(response.status).toBe(200);
      expect(after.usageLevels[serviceName].maxPets.consumed).toBe(member.usageLevels[serviceName].maxPets.consumed + 1);
      expect(after.userContact.email).toBe('concurrent@example.test');
      expect(after.subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect(after.history).toHaveLength(1);
      expect(response.body[0].usageLevels[serviceName].maxPets.consumed).toBe(after.usageLevels[serviceName].maxPets.consumed);
    });

    it('preserves concurrent consumption while keeping the billing period', async () => {
      const reviewed = await read();
      const before = await stored();
      recordWhileWriting(userId);

      const response = await novate({ ...subscription('PLATINUM'), keepBillingPeriod: true }, reviewed.headers.etag);
      const after = await stored();

      expect(response.status).toBe(200);
      expect(after.billingPeriod.startDate).toEqual(before.billingPeriod.startDate);
      expect(after.billingPeriod.endDate).toEqual(before.billingPeriod.endDate);
      expect(after.usageLevels[serviceName].maxPets.consumed).toBe(before.usageLevels[serviceName].maxPets.consumed + 1);
    });

    it('invalidates a novation snapshot when consumption lands after its database write', async () => {
      const repository = container.resolve('contractRepository');
      const original = repository.update.bind(repository);
      vi.spyOn(repository, 'update').mockImplementationOnce(async (...args: any[]) => {
        const result = await original(...args);
        await ContractMongoose.updateOne(
          { organizationId: organization.id, 'userContact.userId': userId },
          { $inc: { [`usageLevels.${serviceName}.maxPets.consumed`]: 1 } }
        );
        return result;
      });
      const before = await stored();

      expect((await novate(subscription('PLATINUM'))).status).toBe(200);
      const shown = await read();
      expect(shown.body.usageLevels[serviceName].maxPets.consumed).toBe(before.usageLevels[serviceName].maxPets.consumed + 1);
    });

    it('does not recreate a group member deleted between the read and an unconditional write', async () => {
      const groupId = `group-${uuidv4()}`;
      const member = (await createContract(groupId)).body;
      const repository = container.resolve('contractRepository');
      let deleted = false;
      for (const method of ['bulkUpdate', 'bulkUpdateGuarded'] as const) {
        const original = repository[method].bind(repository);
        vi.spyOn(repository, method).mockImplementation(async (...args: any[]) => {
          if (!deleted) {
            deleted = true;
            await ContractMongoose.deleteOne({ 'userContact.userId': member.userContact.userId });
          }
          return original(...args);
        });
      }

      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}`)
        .set('x-api-key', orgKey)
        .send(subscription('PLATINUM'));

      expect(response.status).not.toBe(200);
      expect(await ContractMongoose.exists({ 'userContact.userId': member.userContact.userId })).toBeNull();
    });

    it('does not restore the previous plan from a consumption snapshot after novation', async () => {
      const reviewed = await read();
      const repository = container.resolve('contractRepository');
      const original = repository.incrementUsageLevels.bind(repository);
      vi.spyOn(repository, 'incrementUsageLevels').mockImplementationOnce(async (...args: any[]) => {
        const result = await original(...args);
        expect((await novate(subscription('PLATINUM'), reviewed.headers.etag)).status).toBe(200);
        return result;
      });

      await container.resolve('contractService')._applyExpectedConsumptions(
        userId, { [`${serviceName}-maxPets`]: 1 }, organization.id
      );
      const shown = await read();
      expect(shown.body.subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect(shown.body.usageLevels[serviceName].maxPets.consumed).toBe(1);
    });
  });

  describe('PUT /contracts/:userId with If-Match', function () {
    it('novates when the version matches', async function () {
      const current = await read();
      const response = await novate(subscription('PLATINUM'), current.headers.etag);

      expect(response.status).toBe(200);
      expect(response.body.subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect(response.body.contractVersion).not.toBe(current.body.contractVersion);
      expect(response.headers.etag).toBe(`"${response.body.contractVersion}"`);
    });

    it('compares strongly: a weak tag never matches, so nothing is written', async function () {
      const current = (await read()).body.contractVersion;
      const weak = await novate(subscription('PLATINUM'), `W/"${current}"`);

      expect(weak.status).toBe(412);
      expect(weak.body.contractVersion).toBe(current);
      expect((await stored()).subscriptionPlans[serviceName]).toBe('GOLD');
    });

    it('accepts a list of tags that includes the current version, and an unquoted tag', async function () {
      const listed = await novate(subscription('PLATINUM'), `"0-0000000000000000", "${(await read()).body.contractVersion}"`);
      const bare = await novate(subscription('GOLD'), (await read()).body.contractVersion);
      const stale = await novate(subscription('PLATINUM'), `"0-0000000000000000", W/"${(await read()).body.contractVersion}"`);

      expect(listed.status).toBe(200);
      expect(bare.status).toBe(200);
      expect(stale.status).toBe(412);
    });

    it('exposes ETag to browser clients through CORS', async function () {
      const response = await read().set('Origin', 'http://localhost:5403');

      expect(String(response.headers['access-control-expose-headers']).toLowerCase()).toContain('etag');
    });

    it('refuses with 412 and the current version when the contract changed, writing nothing', async function () {
      const reviewed = (await read()).body.contractVersion;
      const meanwhile = await novate(subscription('PLATINUM'));
      const before = await stored();

      const response = await novate(subscription('BASIC', {}), `"${reviewed}"`);

      expect(response.status).toBe(412);
      expect(response.body.error).toBe('CONTRACT_CHANGED');
      expect(response.body.contractVersion).toBe(meanwhile.body.contractVersion);
      const after = await stored();
      expect(after.subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect(after.history).toHaveLength(before.history.length);
    });

    it('lets exactly one of two concurrent novations of the same version through', async function () {
      const reviewed = (await read()).headers.etag;

      const [a, b] = await Promise.all([
        novate(subscription('PLATINUM'), reviewed),
        novate(subscription('BASIC', {}), reviewed),
      ]);

      expect([a.status, b.status].sort()).toEqual([200, 412]);
      const winner = a.status === 200 ? a : b;
      const after = await stored();
      expect(after.subscriptionPlans[serviceName]).toBe(winner.body.subscriptionPlans[serviceName]);
      expect(after.history).toHaveLength(1);
    });

    it('treats If-Match: * as "any current version"', async function () {
      const response = await novate(subscription('PLATINUM'), '*');

      expect(response.status).toBe(200);
    });

    it('still answers 404 for a contract that does not exist', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/${uuidv4()}`)
        .set('x-api-key', orgKey)
        .set('If-Match', '"0-0000000000000000"')
        .send(subscription());

      expect(response.status).toBe(404);
    });

    it('works on the organization-scoped route', async function () {
      const reviewed = (await read()).body.contractVersion;
      await novate(subscription('PLATINUM'));

      const response = await request(app)
        .put(`${baseUrl}/organizations/${organization.id}/contracts/${userId}`)
        .set('x-api-key', owner.apiKey)
        .set('If-Match', `"${reviewed}"`)
        .send(subscription('BASIC', {}));

      expect(response.status).toBe(412);
      expect(response.body.error).toBe('CONTRACT_CHANGED');
    });
  });

  describe('PUT /contracts/:userId with expectedContractVersion', function () {
    it('novates when the version matches and refuses with 412 otherwise', async function () {
      const reviewed = (await read()).body.contractVersion;

      const ok = await novate({ ...subscription('PLATINUM'), expectedContractVersion: reviewed });
      const stale = await novate({ ...subscription('BASIC', {}), expectedContractVersion: reviewed });

      expect(ok.status).toBe(200);
      expect(stale.status).toBe(412);
      expect(stale.body.contractVersion).toBe(ok.body.contractVersion);
    });

    it('rejects a body version that contradicts If-Match', async function () {
      const current = (await read()).body.contractVersion;

      const response = await novate({ ...subscription('PLATINUM'), expectedContractVersion: 'other' }, `"${current}"`);

      expect(response.status).toBe(400);
    });

    it('rejects a body version that is not a string', async function () {
      const response = await novate({ ...subscription('PLATINUM'), expectedContractVersion: 3 });

      expect(response.status).toBe(422);
    });
  });

  describe('PUT /contracts/:userId without a precondition', function () {
    it('novates as before, whatever happened in between', async function () {
      await novate(subscription('PLATINUM'));

      const response = await novate(subscription('BASIC', {}));

      expect(response.status).toBe(200);
      expect(response.body.subscriptionPlans[serviceName]).toBe('BASIC');
      // The new version comes back, so a client can check what it wrote.
      expect(response.body.contractVersion).toEqual(expect.any(String));
      expect(response.headers.etag).toBe(`"${response.body.contractVersion}"`);
    });
  });

  describe('PUT /contracts?groupId= with expectedContractVersions', function () {
    it('applies to the group only when every listed contract still has its version', async function () {
      const groupId = `group-${uuidv4()}`;
      const one = (await createContract(groupId)).body;
      const two = (await createContract(groupId)).body;

      await request(app)
        .put(`${baseUrl}/contracts/${two.userContact.userId}`)
        .set('x-api-key', orgKey)
        .send(subscription('PLATINUM'));
      const currentTwo = (
        await request(app).get(`${baseUrl}/contracts/${two.userContact.userId}`).set('x-api-key', orgKey)
      ).body.contractVersion;

      const stale = await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}`)
        .set('x-api-key', orgKey)
        .send({
          ...subscription('BASIC', {}),
          expectedContractVersions: {
            [one.userContact.userId]: one.contractVersion,
            [two.userContact.userId]: two.contractVersion,
          },
        });

      expect(stale.status).toBe(412);
      expect(stale.body.error).toBe('CONTRACT_CHANGED');
      expect(stale.body.contractVersions).toEqual({ [two.userContact.userId]: currentTwo });
      const untouched = (await ContractMongoose.findOne({ 'userContact.userId': one.userContact.userId }).lean()) as any;
      expect(untouched.subscriptionPlans[serviceName]).toBe('GOLD');

      const ok = await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}`)
        .set('x-api-key', orgKey)
        .send({
          ...subscription('BASIC', {}),
          expectedContractVersions: {
            [one.userContact.userId]: one.contractVersion,
            [two.userContact.userId]: currentTwo,
          },
        });

      expect(ok.status).toBe(200);
      expect(ok.body.every((contract: any) => contract.subscriptionPlans[serviceName] === 'BASIC')).toBe(true);
      expect(ok.body.every((contract: any) => typeof contract.contractVersion === 'string')).toBe(true);
    });

    it('rejects the single-contract expectedContractVersion instead of ignoring it', async function () {
      const groupId = `group-${uuidv4()}`;
      const member = (await createContract(groupId)).body;

      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}`)
        .set('x-api-key', orgKey)
        .send({ ...subscription('BASIC', {}), expectedContractVersion: member.contractVersion });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('expectedContractVersions');
      const after = (await ContractMongoose.findOne({ 'userContact.userId': member.userContact.userId }).lean()) as any;
      expect(after.subscriptionPlans[serviceName]).toBe('GOLD');
    });

    it('rejects If-Match, which cannot name the version of several contracts', async function () {
      const groupId = `group-${uuidv4()}`;
      await createContract(groupId);

      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}`)
        .set('x-api-key', orgKey)
        .set('If-Match', '"1-abc"')
        .send(subscription('BASIC', {}));

      expect(response.status).toBe(400);
    });
  });
});
