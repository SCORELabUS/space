import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { v4 as uuidv4 } from 'uuid';
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
import container from '../main/config/container';
import EventService from '../main/services/EventService';
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';
import {
  addPetclinicVersion,
  PETCLINIC_BASE_VERSION,
  uploadPetclinicService,
} from './utils/services/petclinicVersions';

/**
 * Event ids: every event carries `eventId` (UUIDv7, the same for every copy of
 * one event) and `occurredAt` (ISO 8601, the server's time of the persisted
 * change), so that consumers can drop duplicates and know how old a hint is.
 */

type Event = {
  code: string;
  eventId?: string;
  occurredAt?: string;
  details: Record<string, any>;
  receivedAt: number;
};

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('Event ids', function () {
  let app: Server;
  let url: string;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let allKey: string;
  let serviceName: string;
  let serviceTitle: string;
  let startedAt: number;
  const sockets: Socket[] = [];

  const open = (namespace: string, base = url, auth?: Record<string, string>) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(`${base}${namespace}`, {
        path: '/events',
        transports: ['websocket'],
        auth,
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('connection timeout')), 3000);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });

  const connect = (base = url) => open('/contracts', base, { apiKey: allKey });

  const collect = (socket: Socket) => {
    const events: Event[] = [];
    socket.on('message', (event: Omit<Event, 'receivedAt'>) => events.push({ ...event, receivedAt: Date.now() }));
    return events;
  };

  const waitFor = async (events: Event[], predicate: (e: Event) => boolean, ms = 3000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const found = events.find(predicate);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`event not received; got ${JSON.stringify(events)}`);
  };

  /** eventId and occurredAt are well-formed, and the change happened during this test, before delivery. */
  const expectIds = (event: Event) => {
    expect(event.eventId, JSON.stringify(event)).toMatch(UUID_V7);
    expect(event.occurredAt, JSON.stringify(event)).toMatch(ISO_8601_UTC);
    const occurredAt = Date.parse(event.occurredAt!);
    expect(occurredAt).toBeGreaterThanOrEqual(startedAt);
    expect(occurredAt).toBeLessThanOrEqual(event.receivedAt);
  };

  const createContract = async (extra: Record<string, unknown> = {}) => {
    const userId = uuidv4();
    const response = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', allKey)
      .send({
        userContact: { userId, username: `u-${userId.slice(0, 8)}` },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: {},
        ...extra,
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
    organization = await createTestOrganization(owner.username);
    allKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: allKey, scope: 'ALL' });
    serviceTitle = (await uploadPetclinicService(app, allKey)).name;
    serviceName = serviceTitle.toLowerCase();
    startedAt = Date.now();
  });

  afterEach(async function () {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.disconnect();
    const orgs = [organization.id];
    await ContractMongoose.deleteMany({ organizationId: { $in: orgs } });
    await PricingMongoose.deleteMany({ _organizationId: { $in: orgs } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: orgs } });
    await deleteTestOrganization(organization.id!);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  it('every contract event of the HTTP API carries an eventId and occurredAt, unique per event', async function () {
    const events = collect(await connect());
    const groupId = `group-${uuidv4()}`;
    const single = await createContract();
    const grouped = await createContract({ groupId });
    const userId = single.userContact.userId;

    await request(app)
      .put(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', allKey)
      .send({ subscriptionPlans: { [serviceName]: 'PLATINUM' }, subscriptionAddOns: {} })
      .expect(200);
    await request(app)
      .put(`${baseUrl}/contracts/${userId}/billingPeriod`)
      .set('x-api-key', allKey)
      .send({ renewalDays: 45 })
      .expect(200);
    await request(app)
      .put(`${baseUrl}/contracts?groupId=${groupId}`)
      .set('x-api-key', allKey)
      .send({ subscriptionPlans: { [serviceName]: 'BASIC' }, subscriptionAddOns: {} })
      .expect(200);
    await request(app)
      .put(`${baseUrl}/contracts/billingPeriod?groupId=${groupId}`)
      .set('x-api-key', allKey)
      .send({ renewalDays: 60 })
      .expect(200);

    // Renewal of an expired auto-renew contract, on evaluation.
    await ContractMongoose.updateOne(
      { organizationId: organization.id, 'userContact.userId': userId },
      { $set: { 'billingPeriod.endDate': new Date(Date.now() - 60_000) } }
    );
    await container.resolve('cacheService').del(contractCacheKey(organization.id!, userId));
    await request(app).post(`${baseUrl}/features/${userId}`).set('x-api-key', allKey);
    await waitFor(events, e => e.code === 'CONTRACT_RENEWED' && e.details.userId === userId);

    await request(app).delete(`${baseUrl}/contracts/${userId}`).set('x-api-key', allKey).expect(204);
    const groupedUserId = grouped.userContact.userId;
    const pruned = await request(app).delete(`${baseUrl}/contracts`).set('x-api-key', allKey);
    expect(pruned.status).toBeLessThan(300);
    await waitFor(events, e => e.code === 'CONTRACT_DELETED' && e.details.userId === groupedUserId);
    await new Promise(resolve => setTimeout(resolve, 200));

    const mine = events.filter(e => [userId, groupedUserId].includes(e.details.userId));
    // created x2, novated (single, billing period, group, group billing period), renewed, deleted x2
    expect(mine.map(e => e.code).sort()).toEqual([
      'CONTRACT_CREATED',
      'CONTRACT_CREATED',
      'CONTRACT_DELETED',
      'CONTRACT_DELETED',
      'CONTRACT_NOVATED',
      'CONTRACT_NOVATED',
      'CONTRACT_NOVATED',
      'CONTRACT_NOVATED',
      'CONTRACT_RENEWED',
    ]);
    for (const event of mine) expectIds(event);
    expect(new Set(mine.map(e => e.eventId)).size).toBe(mine.length);
  });

  it('the archive fallback novation and the pricing events carry them too', async function () {
    const contracts = collect(await connect());
    const pricings = collect(await open('/pricings'));
    const contract = await createContract();
    const nextVersion = '2026.1.0';

    await addPetclinicVersion(app, allKey, serviceTitle, nextVersion, '2026-01-01');
    await request(app)
      .put(`${baseUrl}/services/${serviceTitle}/pricings/${PETCLINIC_BASE_VERSION}?availability=archived`)
      .set('x-api-key', allKey)
      .send({ subscriptionPlan: 'GOLD' })
      .expect(200);
    await request(app)
      .put(`${baseUrl}/services/${serviceTitle}/pricings/${PETCLINIC_BASE_VERSION}?availability=active`)
      .set('x-api-key', allKey)
      .send({})
      .expect(200);
    await request(app).delete(`${baseUrl}/services/${serviceTitle}`).set('x-api-key', allKey);

    const novated = await waitFor(
      contracts,
      e => e.code === 'CONTRACT_NOVATED' && e.details.userId === contract.userContact.userId
    );
    expectIds(novated);

    const ofService = (code: string) => (e: Event) =>
      e.code === code && String(e.details.serviceName).toLowerCase() === serviceName;
    for (const code of ['PRICING_CREATED', 'PRICING_ARCHIVED', 'PRICING_ACTIVED', 'SERVICE_DISABLED']) {
      expectIds(await waitFor(pricings, ofService(code)));
    }
    const ids = [...contracts, ...pricings].map(e => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('occurredAt is the time of the persisted change, not of the emission', async function () {
    const events = collect(await connect());
    const contract = await createContract();
    const userId = contract.userContact.userId;
    const cacheService: any = container.resolve('cacheService');
    const repository: any = container.resolve('contractRepository');
    const update = repository.update.bind(repository);
    const del = cacheService.del.bind(cacheService);
    let delayNextInvalidation = false;
    vi.spyOn(repository, 'update').mockImplementation(async (...args: any[]) => {
      const result = await update(...args);
      if (args[0] === userId && args[2] === organization.id && result) delayNextInvalidation = true;
      return result;
    });
    // Arm the delay only after the write returns: earlier invalidations must not count.
    vi.spyOn(cacheService, 'del').mockImplementation(async (...args: any[]) => {
      if (delayNextInvalidation && args[0] === contractCacheKey(organization.id!, userId)) {
        delayNextInvalidation = false;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      return del(...args);
    });

    const before = Date.now();
    await request(app)
      .put(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', allKey)
      .send({ subscriptionPlans: { [serviceName]: 'PLATINUM' }, subscriptionAddOns: {} })
      .expect(200);

    const novated = await waitFor(events, e => e.code === 'CONTRACT_NOVATED' && e.details.userId === userId);
    expectIds(novated);
    const occurredAt = Date.parse(novated.occurredAt!);
    expect(occurredAt).toBeGreaterThanOrEqual(before);
    expect(novated.receivedAt - occurredAt).toBeGreaterThanOrEqual(350);
  });

  describe('delivery', function () {
    let other: EventService;
    let otherServer: Server;

    beforeEach(async function () {
      // A second API instance sharing the Socket.IO Redis adapter.
      other = new EventService();
      otherServer = createServer();
      await new Promise<void>(resolve => otherServer.listen(0, '127.0.0.1', resolve));
      await other.initialize(otherServer);
    });

    afterEach(async function () {
      for (const socket of sockets.splice(0)) socket.disconnect();
      await other.close();
      await new Promise(resolve => otherServer.close(() => resolve(undefined)));
    });

    it('delivers one copy per connection, on any instance, all with the same eventId', async function () {
      expect(process.env.REDIS_URL, 'the Socket.IO Redis adapter needs REDIS_URL').toBeTruthy();
      const otherUrl = `http://127.0.0.1:${(otherServer.address() as AddressInfo).port}`;
      const first = collect(await connect());
      const second = collect(await connect());
      const remote = collect(await connect(otherUrl));

      const contract = await createContract();
      const isCreated = (e: Event) => e.code === 'CONTRACT_CREATED' && e.details.userId === contract.userContact.userId;
      for (const events of [first, second, remote]) await waitFor(events, isCreated);
      await new Promise(resolve => setTimeout(resolve, 300));

      const copies = [first, second, remote].map(events => events.filter(isCreated));
      for (const received of copies) expect(received).toHaveLength(1);
      const [original] = copies[0];
      expectIds(original);
      for (const [copy] of copies) {
        expect(copy.eventId).toBe(original.eventId);
        expect(copy.occurredAt).toBe(original.occurredAt);
      }
    });

    it('does not replay to a connection what happened while it was disconnected (at most once)', async function () {
      const before = await connect();
      before.disconnect();

      const contract = await createContract();
      const after = collect(await connect());
      await new Promise(resolve => setTimeout(resolve, 300));

      expect(after.filter(e => e.details.userId === contract.userContact.userId)).toEqual([]);
    });
  });
});
