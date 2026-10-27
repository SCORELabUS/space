import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
