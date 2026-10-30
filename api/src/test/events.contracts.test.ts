import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { v4 as uuidv4 } from 'uuid';
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
import container from '../main/config/container';
import { PETCLINIC_BASE_VERSION, uploadPetclinicService } from './utils/services/petclinicVersions';

/**
 * Contract events: an authenticated Socket.IO namespace `/contracts` that only
 * delivers events of the caller's organization.
 */

type ContractEvent = {
  code: string;
  details: { userId: string; organizationId: string; contractVersion: string | null; services: string[] };
};

describe('Contract events', function () {
  let app: Server;
  let url: string;
  let owner: LeanUser;
  let member: LeanUser;
  let outsider: LeanUser;
  let admin: LeanUser;
  let organization: LeanOrganization;
  let otherOrganization: LeanOrganization;
  let allKey: string;
  let evaluationKey: string;
  let otherKey: string;
  let serviceName: string;
  const sockets: Socket[] = [];

  /** Connect to /contracts and resolve once connected, or reject with the connect error. */
  const connect = (auth?: { apiKey?: string }, headers?: Record<string, string>) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(`${url}/contracts`, {
        path: '/events',
        transports: ['websocket'],
        auth,
        extraHeaders: headers,
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('connection timeout')), 3000);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });

  /** Collect the events a socket receives. */
  const collect = (socket: Socket) => {
    const events: ContractEvent[] = [];
    socket.on('message', (event: ContractEvent) => events.push(event));
    return events;
  };

  const waitFor = async (events: ContractEvent[], predicate: (e: ContractEvent) => boolean, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`event not received; got ${JSON.stringify(events)}`);
  };

  const createContract = async (key = allKey) => {
    const userId = uuidv4();
    const response = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', key)
      .send({
        userContact: { userId, username: `u-${userId.slice(0, 8)}` },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: {},
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body;
  };

  beforeAll(async function () {
    app = await getApp();
    url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });

  beforeEach(async function () {
    owner = await createTestUser('USER');
    member = await createTestUser('USER');
    outsider = await createTestUser('USER');
    admin = await createTestUser('ADMIN');
    organization = await createTestOrganization(owner.username);
    otherOrganization = await createTestOrganization(outsider.username);
    await addMemberToOrganization(organization.id!, { username: member.username, role: 'EVALUATOR' });
    allKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    otherKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: allKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id!, { key: evaluationKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id!, { key: otherKey, scope: 'ALL' });
    serviceName = (await uploadPetclinicService(app, allKey)).name.toLowerCase();
    await uploadPetclinicService(app, otherKey);
  });

  afterEach(async function () {
    for (const socket of sockets.splice(0)) socket.disconnect();
    const orgs = [organization.id, otherOrganization.id];
    await ContractMongoose.deleteMany({ organizationId: { $in: orgs } });
    await PricingMongoose.deleteMany({ _organizationId: { $in: orgs } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: orgs } });
    await deleteTestOrganization(organization.id!);
    await deleteTestOrganization(otherOrganization.id!);
    for (const user of [owner, member, outsider, admin]) await deleteTestUser(user.username);
    delete process.env.ENABLE_TEST_EVENTS;
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('authentication', function () {
    it('accepts organization keys of any scope (auth.apiKey or x-api-key) and member user keys', async function () {
      await expect(connect({ apiKey: allKey })).resolves.toBeDefined();
      await expect(connect({ apiKey: evaluationKey })).resolves.toBeDefined();
      await expect(connect(undefined, { 'x-api-key': allKey })).resolves.toBeDefined();
      await expect(connect({ apiKey: member.apiKey, organizationId: organization.id } as any)).resolves.toBeDefined();
    });

    it('rejects missing, unknown and malformed keys', async function () {
      await expect(connect()).rejects.toThrow(/API Key/i);
      await expect(connect({ apiKey: 'org_doesnotexist' })).rejects.toThrow(/Invalid/i);
      await expect(connect({ apiKey: 'nope' })).rejects.toThrow(/Invalid/i);
    });

    it('requires user keys to name an organization they belong to', async function () {
      await expect(connect({ apiKey: member.apiKey })).rejects.toThrow(/organizationId/);
      await expect(connect({ apiKey: outsider.apiKey, organizationId: organization.id } as any)).rejects.toThrow(/member/);
      await expect(connect({ apiKey: admin.apiKey, organizationId: organization.id } as any)).resolves.toBeDefined();
    });

    it('reports a credential lookup that fails as unavailable, not as an invalid key', async function () {
      const userService: any = container.resolve('userService');
      const outage = vi
        .spyOn(userService, 'findByApiKey')
        .mockRejectedValue(new Error('MongooseServerSelectionError: connection timed out'));
      try {
        await expect(connect({ apiKey: member.apiKey, organizationId: organization.id } as any)).rejects.toThrow(
          /unavailable/i
        );
      } finally {
        outage.mockRestore();
      }
      const organizationRepository: any = container.resolve('organizationRepository');
      const orgOutage = vi
        .spyOn(organizationRepository, 'findByApiKey')
        .mockRejectedValue(new Error('MongooseServerSelectionError: connection timed out'));
      try {
        await expect(connect({ apiKey: allKey })).rejects.toThrow(/unavailable/i);
      } finally {
        orgOutage.mockRestore();
      }
      // A key that was read and rejected is still invalid.
      await expect(connect({ apiKey: 'usr_doesnotexist', organizationId: organization.id } as any)).rejects.toThrow(/Invalid/i);
    });
  });

  const disconnected = (socket: Socket) => new Promise<void>((resolve, reject) => {
    if (!socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('revoked connection stayed open')), 3000);
    socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
  });

  describe('revocation', function () {
    it('disconnects a removed organization key and keeps authorized listeners working', async function () {
      const revoked = await connect({ apiKey: evaluationKey });
      const revokedEvents = collect(revoked);
      const allowed = collect(await connect({ apiKey: allKey }));
      const before = await createContract();
      await waitFor(revokedEvents, e => e.details.userId === before.userContact.userId);

      await container.resolve('organizationService').removeApiKey(organization.id!, evaluationKey, owner);
      await disconnected(revoked);
      const after = await createContract();
      await waitFor(allowed, e => e.details.userId === after.userContact.userId);
      expect(revokedEvents.some(e => e.details.userId === after.userContact.userId)).toBe(false);
      await expect(connect({ apiKey: evaluationKey })).rejects.toThrow(/Invalid/i);
    });

    it('disconnects a removed member while retaining other organization access', async function () {
      await addMemberToOrganization(otherOrganization.id!, { username: member.username, role: 'EVALUATOR' });
      const revoked = await connect({ apiKey: member.apiKey, organizationId: organization.id } as any);
      const other = await connect({ apiKey: member.apiKey, organizationId: otherOrganization.id } as any);
      const revokedEvents = collect(revoked);
      const otherEvents = collect(other);
      const allowed = collect(await connect({ apiKey: allKey }));
      const before = await createContract();
      await waitFor(revokedEvents, e => e.details.userId === before.userContact.userId);

      await container.resolve('organizationService').removeMember(organization.id!, member.username, owner);
      await disconnected(revoked);
      const after = await createContract();
      await waitFor(allowed, e => e.details.userId === after.userContact.userId);
      const otherContract = await createContract(otherKey);
      await waitFor(otherEvents, e => e.details.userId === otherContract.userContact.userId);
      expect(other.connected).toBe(true);
      expect(revokedEvents.some(e => e.details.userId === after.userContact.userId)).toBe(false);
      await expect(connect({ apiKey: member.apiKey, organizationId: organization.id } as any)).rejects.toThrow(/member/i);
    });

    it('disconnects a regenerated user key and accepts its replacement', async function () {
      const oldKey = member.apiKey;
      const revoked = await connect({ apiKey: oldKey, organizationId: organization.id } as any);
      const events = collect(revoked);
      const before = await createContract();
      await waitFor(events, e => e.details.userId === before.userContact.userId);

      const replacement = await container.resolve('userService').regenerateApiKey(member.username, member);
      await disconnected(revoked);
      await expect(connect({ apiKey: oldKey, organizationId: organization.id } as any)).rejects.toThrow(/Invalid/i);
      const allowed = collect(await connect({ apiKey: replacement, organizationId: organization.id } as any));
      const after = await createContract();
      await waitFor(allowed, e => e.details.userId === after.userContact.userId);
      expect(events.some(e => e.details.userId === after.userContact.userId)).toBe(false);
    });

    it.each(['changeRole', 'update'])('disconnects a global admin who loses authority through %s', async function (method) {
      const backup = await createTestUser('ADMIN', `event-backup-${uuidv4()}`);
      try {
        const revoked = await connect({ apiKey: admin.apiKey, organizationId: organization.id } as any);
        const events = collect(revoked);
        const allowed = collect(await connect({ apiKey: allKey }));
        const before = await createContract();
        await waitFor(events, e => e.details.userId === before.userContact.userId);
        const users: any = container.resolve('userService');
        if (method === 'changeRole') await users.changeRole(admin.username, 'USER', backup);
        else await users.update(admin.username, { role: 'USER' }, backup);
        await disconnected(revoked);
        const after = await createContract();
        await waitFor(allowed, e => e.details.userId === after.userContact.userId);
        expect(events.some(e => e.details.userId === after.userContact.userId)).toBe(false);
        await expect(connect({ apiKey: admin.apiKey, organizationId: organization.id } as any)).rejects.toThrow(/member/i);
      } finally { await deleteTestUser(backup.username); }
    });

    it('disconnects a deleted user', async function () {
      const revoked = await connect({ apiKey: member.apiKey, organizationId: organization.id } as any);
      const events = collect(revoked);
      const allowed = collect(await connect({ apiKey: allKey }));
      const before = await createContract();
      await waitFor(events, e => e.details.userId === before.userContact.userId);
      await container.resolve('userService').destroy(member.username, owner);
      await disconnected(revoked);
      const after = await createContract();
      await waitFor(allowed, e => e.details.userId === after.userContact.userId);
      expect(events.some(e => e.details.userId === after.userContact.userId)).toBe(false);
      await expect(connect({ apiKey: member.apiKey, organizationId: organization.id } as any)).rejects.toThrow(/Invalid/i);
    });

    it('rechecks outgoing delivery after a key is removed without a service notification', async function () {
      const revoked = await connect({ apiKey: evaluationKey });
      const events = collect(revoked);
      const allowed = collect(await connect({ apiKey: allKey }));
      const before = await createContract();
      await waitFor(events, e => e.details.userId === before.userContact.userId);
      await container.resolve('organizationRepository').removeApiKey(organization.id!, evaluationKey);
      const after = await createContract();
      await waitFor(allowed, e => e.details.userId === after.userContact.userId);
      await disconnected(revoked);
      expect(events.some(e => e.details.userId === after.userContact.userId)).toBe(false);
    });

    it('fails closed when a connected user credential cannot be checked', async function () {
      const revoked = await connect({ apiKey: member.apiKey, organizationId: organization.id } as any);
      const events = collect(revoked);
      const allowed = collect(await connect({ apiKey: allKey }));
      const before = await createContract();
      await waitFor(events, e => e.details.userId === before.userContact.userId);
      const outage = vi.spyOn(container.resolve<any>('userService'), 'findByApiKey').mockRejectedValue(new Error('database unavailable'));
      try {
        const after = await createContract();
        await waitFor(allowed, e => e.details.userId === after.userContact.userId);
        await disconnected(revoked);
        expect(events.some(e => e.details.userId === after.userContact.userId)).toBe(false);
      } finally { outage.mockRestore(); }
    });
  });

  describe('delivery', function () {
    it('delivers created, novated and deleted events of the organization', async function () {
      const events = collect(await connect({ apiKey: evaluationKey }));

      const contract = await createContract();
      const created = await waitFor(events, e => e.code === 'CONTRACT_CREATED' && e.details.userId === contract.userContact.userId);
      expect(created.details).toEqual({
        userId: contract.userContact.userId,
        organizationId: organization.id,
        contractVersion: contract.contractVersion,
        services: [serviceName],
      });

      const novated = await request(app)
        .put(`${baseUrl}/contracts/${contract.userContact.userId}`)
        .set('x-api-key', allKey)
        .send({ subscriptionPlans: { [serviceName]: 'PLATINUM' }, subscriptionAddOns: {} });
      const novation = await waitFor(events, e => e.code === 'CONTRACT_NOVATED');
      expect(novation.details.contractVersion).toBe(novated.body.contractVersion);
      expect(novation.details.services).toEqual([serviceName]);

      await request(app).delete(`${baseUrl}/contracts/${contract.userContact.userId}`).set('x-api-key', allKey);
      const deleted = await waitFor(events, e => e.code === 'CONTRACT_DELETED');
      expect(deleted.details).toMatchObject({ userId: contract.userContact.userId, contractVersion: null, services: [serviceName] });
    });

    it('delivers a novated event per contract of a group novation', async function () {
      const events = collect(await connect({ apiKey: allKey }));
      const groupId = `group-${uuidv4()}`;
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const userId = uuidv4();
        ids.push(userId);
        await request(app)
          .post(`${baseUrl}/contracts`)
          .set('x-api-key', allKey)
          .send({
            userContact: { userId, username: `g-${i}` }, groupId,
            contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
            subscriptionPlans: { [serviceName]: 'GOLD' }, subscriptionAddOns: {},
          });
      }

      await request(app)
        .put(`${baseUrl}/contracts?groupId=${groupId}`)
        .set('x-api-key', allKey)
        .send({ subscriptionPlans: { [serviceName]: 'BASIC' }, subscriptionAddOns: {} });

      for (const userId of ids) await waitFor(events, e => e.code === 'CONTRACT_NOVATED' && e.details.userId === userId);
    });

    it.each([true, false])('delivers written events after a partly rejected group novation (conditional: %s)', async function (conditional) {
      const events = collect(await connect({ apiKey: allKey }));
      const groupId = `group-${uuidv4()}`;
      const versions: Record<string, string> = {};
      for (let i = 0; i < 2; i++) {
        const userId = uuidv4();
        const created = await request(app)
          .post(`${baseUrl}/contracts`)
          .set('x-api-key', allKey)
          .send({
            userContact: { userId, username: `p-${i}` }, groupId,
            contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
            subscriptionPlans: { [serviceName]: 'GOLD' }, subscriptionAddOns: {},
          });
        versions[userId] = created.body.contractVersion;
      }
      const [written, skipped] = Object.keys(versions);
      // Reject the second write after the first succeeds, with or without preconditions.
      const repository: any = container.resolve('contractRepository');
      const original = repository.bulkUpdateGuarded.bind(repository);
      const guarded = vi.spyOn(repository, 'bulkUpdateGuarded').mockImplementation(async (entries: any) => {
        const kept = (entries as any[]).filter(entry => entry.contract.userContact.userId !== skipped);
        return [...(await original(kept)), skipped];
      });
      try {
        const response = await request(app)
          .put(`${baseUrl}/contracts?groupId=${groupId}`)
          .set('x-api-key', allKey)
          .send({
            subscriptionPlans: { [serviceName]: 'BASIC' }, subscriptionAddOns: {},
            ...(conditional ? { expectedContractVersions: versions } : {}),
          });

        expect(response.status).toBe(conditional ? 412 : 500);
        if (conditional) expect(response.body.novated).toEqual([written]);
      } finally {
        guarded.mockRestore();
      }

      const novated = await waitFor(events, e => e.code === 'CONTRACT_NOVATED' && e.details.userId === written);
      expect(novated.details.contractVersion).not.toBe(versions[written]);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(events.filter(e => e.code === 'CONTRACT_NOVATED' && e.details.userId === skipped)).toEqual([]);
    });

    it('delivers a deleted event per contract when the contracts of the organization are deleted', async function () {
      const events = collect(await connect({ apiKey: allKey }));
      const first = await createContract();
      const second = await createContract();

      const response = await request(app).delete(`${baseUrl}/contracts`).set('x-api-key', allKey);
      expect(response.status).toBeLessThan(300);

      for (const contract of [first, second]) {
        const deleted = await waitFor(events, e => e.code === 'CONTRACT_DELETED' && e.details.userId === contract.userContact.userId);
        expect(deleted.details).toEqual({
          userId: contract.userContact.userId,
          organizationId: organization.id,
          contractVersion: null,
          services: [serviceName],
        });
      }
    });

    it('delivers a novated event when the billing period changes, also for groups', async function () {
      const events = collect(await connect({ apiKey: allKey }));
      const contract = await createContract();
      const groupId = `group-${uuidv4()}`;
      await ContractMongoose.updateOne({ 'userContact.userId': contract.userContact.userId }, { $set: { groupId } });
      await container.resolve('cacheService').del(`contracts.${contract.userContact.userId}`);

      const single = await request(app)
        .put(`${baseUrl}/contracts/${contract.userContact.userId}/billingPeriod`)
        .set('x-api-key', allKey)
        .send({ renewalDays: 45 });
      const first = await waitFor(events, e => e.code === 'CONTRACT_NOVATED' && e.details.contractVersion === single.body.contractVersion);

      const group = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=${groupId}`)
        .set('x-api-key', allKey)
        .send({ renewalDays: 60 });
      expect(group.status).toBe(200);
      await waitFor(events, e => e.code === 'CONTRACT_NOVATED' && e.details.contractVersion === group.body[0].contractVersion);
      expect(first.details.userId).toBe(contract.userContact.userId);
    });

    it('delivers nothing for a novation preview', async function () {
      const contract = await createContract();
      const events = collect(await connect({ apiKey: allKey }));

      const preview = await request(app)
        .post(`${baseUrl}/contracts/${contract.userContact.userId}/novation/preview`)
        .set('x-api-key', allKey)
        .send({ subscriptionPlans: { [serviceName]: 'PLATINUM' }, subscriptionAddOns: {} });
      expect(preview.status).toBe(200);

      await new Promise(resolve => setTimeout(resolve, 300));
      expect(events.filter(e => e.details.userId === contract.userContact.userId)).toEqual([]);
    });

    it('delivers a renewed event when an expired auto-renew contract is renewed', async function () {
      const events = collect(await connect({ apiKey: allKey }));
      const contract = await createContract();
      await ContractMongoose.updateOne(
        { 'userContact.userId': contract.userContact.userId },
        { $set: { 'billingPeriod.endDate': new Date(Date.now() - 60_000) } }
      );
      await container.resolve('cacheService').del(`contracts.${contract.userContact.userId}`);

      await request(app).post(`${baseUrl}/features/${contract.userContact.userId}`).set('x-api-key', allKey);

      const renewed = await waitFor(events, e => e.code === 'CONTRACT_RENEWED');
      expect(renewed.details.userId).toBe(contract.userContact.userId);
    });

    it('never delivers events of another organization', async function () {
      const mine = collect(await connect({ apiKey: allKey }));
      const theirs = collect(await connect({ apiKey: otherKey }));
      const viaUser = collect(await connect({ apiKey: outsider.apiKey, organizationId: otherOrganization.id } as any));

      const contract = await createContract();
      await waitFor(mine, e => e.code === 'CONTRACT_CREATED' && e.details.userId === contract.userContact.userId);
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(theirs.filter(e => e.details.userId === contract.userContact.userId)).toEqual([]);
      expect(viaUser.filter(e => e.details.userId === contract.userContact.userId)).toEqual([]);
    });

    it('does not change the public /pricings namespace', async function () {
      const socket = io(`${url}/pricings`, { path: '/events', transports: ['websocket'], reconnection: false, forceNew: true });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      expect(socket.connected).toBe(true);
    });
  });

  describe('POST /events/test-event', function () {
    const testEvent = (key?: string) => {
      const req = request(app).post(`${baseUrl}/events/test-event`);
      if (key) req.set('x-api-key', key);
      return req.send({ serviceName: 'svc', pricingVersion: '1.0' });
    };

    it('requires an organization key with scope ALL or an ADMIN user', async function () {
      expect((await testEvent()).status).toBe(401);
      expect((await testEvent(evaluationKey)).status).toBe(403);
      expect((await testEvent(member.apiKey)).status).toBe(403);
      expect((await testEvent(allKey)).status).toBe(200);
      expect((await testEvent(admin.apiKey)).status).toBe(200);
    });

    it('is disabled in production unless ENABLE_TEST_EVENTS=true', async function () {
      const previous = process.env.ENVIRONMENT;
      try {
        process.env.ENVIRONMENT = 'production';
        expect((await testEvent(allKey)).status).toBe(404);
        process.env.ENABLE_TEST_EVENTS = 'true';
        expect((await testEvent(allKey)).status).toBe(200);
      } finally {
        process.env.ENVIRONMENT = previous;
      }
    });

    it('keeps GET /events/status public', async function () {
      expect((await request(app).get(`${baseUrl}/events/status`)).status).toBe(200);
    });
  });
});
