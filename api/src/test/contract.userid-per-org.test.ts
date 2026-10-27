import request from 'supertest';
import { Server } from 'http';
import { AddressInfo } from 'net';
import path from 'path';
import { decodeJwt } from 'jose';
import { io, Socket } from 'socket.io-client';
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

/**
 * `userId` is chosen by each host application ("1", "42", an email...), so it
 * is unique per organization, not across the server: two organizations may
 * each have a contract for user "42". Every route, cache, event and token keeps
 * the two apart.
 *
 * Both organizations upload the same pricing (same service name and version),
 * so a lookup that ignored the organization would find everything it needs to
 * succeed: the tests fail on the scoping, not on a missing pricing.
 */

type ContractEvent = {
  code: string;
  details: { userId: string; organizationId: string; contractVersion: string | null; services: string[] };
};

const ZOOM_PRICING_PATH = path.resolve(__dirname, './data/pricings/zoom-2025.yml');

describe('Contract userId unique per organization', function () {
  let app: Server;
  let url: string;
  let admin: LeanUser;
  let ownerA: LeanUser;
  let ownerB: LeanUser;
  let orgA: LeanOrganization;
  let orgB: LeanOrganization;
  let keyA: string;
  let keyB: string;
  let serviceName: string;
  let userId: string;
  const sockets: Socket[] = [];

  const subscription = (plan: string) => ({
    contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
    subscriptionPlans: { [serviceName]: plan },
    subscriptionAddOns: {},
  });

  const createContract = (key: string, id: string, username: string, plan: string, extra: any = {}) =>
    request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', key)
      .send({
        userContact: { userId: id, username },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        ...subscription(plan),
        ...extra,
      });

  const stored = (organizationId: string, id = userId) =>
    ContractMongoose.findOne({ organizationId, 'userContact.userId': id }).lean() as any;

  const read = (key: string, id = userId) => request(app).get(`${baseUrl}/contracts/${id}`).set('x-api-key', key);

  const connect = (apiKey: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(`${url}/contracts`, {
        path: '/events',
        transports: ['websocket'],
        auth: { apiKey },
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      const timer = setTimeout(() => reject(new Error('connection timeout')), 3000);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
    });

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

  beforeAll(async function () {
    app = await getApp();
    url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  });

  beforeEach(async function () {
    admin = await createTestUser('ADMIN');
    ownerA = await createTestUser('USER');
    ownerB = await createTestUser('USER');
    orgA = await createTestOrganization(ownerA.username);
    orgB = await createTestOrganization(ownerB.username);
    keyA = generateOrganizationApiKey();
    keyB = generateOrganizationApiKey();
    await addApiKeyToOrganization(orgA.id!, { key: keyA, scope: 'ALL' });
    await addApiKeyToOrganization(orgB.id!, { key: keyB, scope: 'ALL' });
    serviceName = (await uploadPetclinicService(app, keyA)).name.toLowerCase();
    await uploadPetclinicService(app, keyB);

    // The same userId in both organizations, with different contracts.
    userId = `user-${uuidv4()}`;
    const a = await createContract(keyA, userId, 'alice-of-a', 'GOLD');
    expect(a.status, JSON.stringify(a.body)).toBe(201);
  });

  afterEach(async function () {
    for (const socket of sockets.splice(0)) socket.disconnect();
    const orgs = [orgA.id, orgB.id];
    await ContractMongoose.deleteMany({ organizationId: { $in: orgs } });
    await PricingMongoose.deleteMany({ _organizationId: { $in: orgs } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: orgs } });
    await deleteTestOrganization(orgA.id!);
    await deleteTestOrganization(orgB.id!);
    for (const user of [admin, ownerA, ownerB]) await deleteTestUser(user.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  /** Org B creates its own contract for the same userId. */
  const createInB = async (plan = 'PLATINUM') => {
    const b = await createContract(keyB, userId, 'bob-of-b', plan);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    return b;
  };

  describe('POST /contracts', function () {
    it('lets a second organization create a contract with a userId another organization uses', async function () {
      const b = await createContract(keyB, userId, 'bob-of-b', 'PLATINUM');

      expect(b.status, JSON.stringify(b.body)).toBe(201);
      expect(b.body.organizationId).toBe(orgB.id);
      expect((await stored(orgA.id!)).userContact.username).toBe('alice-of-a');
      expect((await stored(orgB.id!)).userContact.username).toBe('bob-of-b');
    });

    it('also through the organization-scoped route of a member user', async function () {
      const b = await request(app)
        .post(`${baseUrl}/organizations/${orgB.id}/contracts`)
        .set('x-api-key', ownerB.apiKey)
        .send({
          userContact: { userId, username: 'bob-of-b' },
          billingPeriod: { autoRenew: true, renewalDays: 30 },
          ...subscription('PLATINUM'),
        });

      expect(b.status, JSON.stringify(b.body)).toBe(201);
      expect(b.body.organizationId).toBe(orgB.id);
    });

    it('still answers 409 for a duplicate userId within the same organization', async function () {
      const again = await createContract(keyA, userId, 'someone-else', 'BASIC');
      const viaMember = await request(app)
        .post(`${baseUrl}/organizations/${orgA.id}/contracts`)
        .set('x-api-key', ownerA.apiKey)
        .send({
          userContact: { userId, username: 'someone-else' },
          billingPeriod: { autoRenew: true, renewalDays: 30 },
          ...subscription('BASIC'),
        });

      expect(again.status).toBe(409);
      expect(viaMember.status).toBe(409);
      expect(await ContractMongoose.countDocuments({ organizationId: orgA.id, 'userContact.userId': userId })).toBe(1);
      expect((await stored(orgA.id!)).userContact.username).toBe('alice-of-a');
    });

    it('answers 409 for concurrent duplicates within one organization (unique index)', async function () {
      const id = `race-${uuidv4()}`;
      const responses = await Promise.all(
        [1, 2, 3].map(n => createContract(keyB, id, `racer-${n}`, 'BASIC'))
      );

      expect(responses.map(r => r.status).sort()).toEqual([201, 409, 409]);
      expect(await ContractMongoose.countDocuments({ organizationId: orgB.id, 'userContact.userId': id })).toBe(1);
    });
  });

  describe('organization API keys', function () {
    it('each read their own contract, also with warm caches', async function () {
      await createInB();

      for (let round = 0; round < 2; round++) {
        const a = await read(keyA);
        const b = await read(keyB);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        expect(a.body.organizationId).toBe(orgA.id);
        expect(a.body.userContact.username).toBe('alice-of-a');
        expect(a.body.subscriptionPlans[serviceName]).toBe('GOLD');
        expect(b.body.organizationId).toBe(orgB.id);
        expect(b.body.userContact.username).toBe('bob-of-b');
        expect(b.body.subscriptionPlans[serviceName]).toBe('PLATINUM');
      }
    });

    it('novate only their own contract, and the other cached contract stays the other one', async function () {
      await createInB();
      await read(keyA);
      await read(keyB);
      const evalB = await request(app).post(`${baseUrl}/features/${userId}?details=true`).set('x-api-key', keyB);
      expect(evalB.status).toBe(200);

      const novation = await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', keyA)
        .send(subscription('BASIC'));
      expect(novation.status, JSON.stringify(novation.body)).toBe(200);
      expect(novation.body.organizationId).toBe(orgA.id);
      expect(novation.body.subscriptionPlans[serviceName]).toBe('BASIC');

      expect((await stored(orgB.id!)).subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect((await stored(orgB.id!)).history).toHaveLength(0);
      const b = await read(keyB);
      expect(b.body.subscriptionPlans[serviceName]).toBe('PLATINUM');
      const a = await read(keyA);
      expect(a.body.subscriptionPlans[serviceName]).toBe('BASIC');

      // B's evaluation is still B's (PLATINUM has consultations, BASIC does not).
      const evalBAgain = await request(app).post(`${baseUrl}/features/${userId}?details=true`).set('x-api-key', keyB);
      expect(evalBAgain.body[`${serviceName}-consultations`].eval).toBe(true);
      const evalA = await request(app).post(`${baseUrl}/features/${userId}?details=true`).set('x-api-key', keyA);
      expect(evalA.body[`${serviceName}-consultations`].eval).toBe(false);
    });

    it('preview and list the pricings of their own contract', async function () {
      await createInB();

      const previewB = await request(app)
        .post(`${baseUrl}/contracts/${userId}/novation/preview`)
        .set('x-api-key', keyB)
        .send(subscription('GOLD'));
      const readB = await read(keyB);
      expect(previewB.status, JSON.stringify(previewB.body)).toBe(200);
      expect(previewB.body.contractVersion).toBe(readB.body.contractVersion);
      expect(previewB.body.contractVersion).not.toBe((await read(keyA)).body.contractVersion);

      const pricingsA = await request(app).get(`${baseUrl}/contracts/${userId}/pricings`).set('x-api-key', keyA);
      const pricingsB = await request(app).get(`${baseUrl}/contracts/${userId}/pricings`).set('x-api-key', keyB);
      expect(pricingsA.body.services[serviceName].plan).toBe('GOLD');
      expect(pricingsB.body.services[serviceName].plan).toBe('PLATINUM');
    });

    it('change user contact, billing period and usage levels of their own contract only', async function () {
      await createInB();
      await read(keyA);
      await read(keyB);

      const contact = await request(app)
        .put(`${baseUrl}/contracts/${userId}/userContact`)
        .set('x-api-key', keyB)
        .send({ username: 'bob-renamed' });
      const billing = await request(app)
        .put(`${baseUrl}/contracts/${userId}/billingPeriod`)
        .set('x-api-key', keyB)
        .send({ autoRenew: false });
      const usage = await request(app)
        .put(`${baseUrl}/contracts/${userId}/usageLevels`)
        .set('x-api-key', keyB)
        .send({ [serviceName]: { maxPets: 3 } });

      expect([contact.status, billing.status, usage.status]).toEqual([200, 200, 200]);
      const a = await stored(orgA.id!);
      const b = await stored(orgB.id!);
      expect(a.userContact.username).toBe('alice-of-a');
      expect(a.billingPeriod.autoRenew).toBe(true);
      expect(a.usageLevels[serviceName].maxPets.consumed).toBe(0);
      expect(b.userContact.username).toBe('bob-renamed');
      expect(b.billingPeriod.autoRenew).toBe(false);
      expect(b.usageLevels[serviceName].maxPets.consumed).toBe(3);
      expect((await read(keyA)).body.userContact.username).toBe('alice-of-a');
    });

    it('delete only their own contract', async function () {
      await createInB();
      await read(keyA);
      await read(keyB);

      const removed = await request(app).delete(`${baseUrl}/contracts/${userId}`).set('x-api-key', keyA);

      expect(removed.status).toBe(204);
      expect(await stored(orgA.id!)).toBeNull();
      expect(await stored(orgB.id!)).not.toBeNull();
      expect((await read(keyA)).status).toBe(404);
      const b = await read(keyB);
      expect(b.status).toBe(200);
      expect(b.body.organizationId).toBe(orgB.id);
    });

    it('evaluate and consume their own usage levels, also with warm evaluation caches', async function () {
      await createInB();
      const warmA = await request(app).post(`${baseUrl}/features/${userId}/${serviceName}-pets`).set('x-api-key', keyA);
      const warmB = await request(app).post(`${baseUrl}/features/${userId}/${serviceName}-pets`).set('x-api-key', keyB);
      expect([warmA.status, warmB.status]).toEqual([200, 200]);

      const consume = await request(app)
        .post(`${baseUrl}/features/${userId}/${serviceName}-pets`)
        .set('x-api-key', keyA)
        .send({ [`${serviceName}-maxPets`]: 2 });
      expect(consume.status, JSON.stringify(consume.body)).toBe(200);

      expect((await stored(orgA.id!)).usageLevels[serviceName].maxPets.consumed).toBe(2);
      expect((await stored(orgB.id!)).usageLevels[serviceName].maxPets.consumed).toBe(0);

      const evalA = await request(app).post(`${baseUrl}/features/${userId}?details=true`).set('x-api-key', keyA);
      const evalB = await request(app).post(`${baseUrl}/features/${userId}?details=true`).set('x-api-key', keyB);
      expect(evalA.body[`${serviceName}-pets`].used[`${serviceName}-maxPets`]).toBe(2);
      expect(evalA.body[`${serviceName}-pets`].limit[`${serviceName}-maxPets`]).toBe(4);
      expect(evalB.body[`${serviceName}-pets`].used[`${serviceName}-maxPets`]).toBe(0);
      expect(evalB.body[`${serviceName}-pets`].limit[`${serviceName}-maxPets`]).toBe(7);
    });

    it('revert their own consumption, never the other organization one', async function () {
      await createInB();
      const consumeA = await request(app)
        .post(`${baseUrl}/features/${userId}/${serviceName}-pets`)
        .set('x-api-key', keyA)
        .send({ [`${serviceName}-maxPets`]: 1 });
      const consumeB = await request(app)
        .post(`${baseUrl}/features/${userId}/${serviceName}-pets`)
        .set('x-api-key', keyB)
        .send({ [`${serviceName}-maxPets`]: 3 });
      expect([consumeA.status, consumeB.status]).toEqual([200, 200]);

      const revertB = await request(app)
        .post(`${baseUrl}/features/${userId}/${serviceName}-pets?revert=true&latest=true`)
        .set('x-api-key', keyB);
      expect(revertB.status).toBe(204);

      expect((await stored(orgB.id!)).usageLevels[serviceName].maxPets.consumed).toBe(0);
      expect((await stored(orgA.id!)).usageLevels[serviceName].maxPets.consumed).toBe(1);
    });

    it('get a pricing token for their own contract, also when the other one is cached', async function () {
      await createInB();
      const tokenA = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', keyA);
      expect(tokenA.status).toBe(200);

      for (let round = 0; round < 2; round++) {
        const tokenB = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', keyB);
        expect(tokenB.status).toBe(200);
        expect(tokenB.body.pricingToken).not.toBe(tokenA.body.pricingToken);
        const claims: any = decodeJwt(tokenB.body.pricingToken);
        expect(claims.sub).toBe(userId);
        expect(claims.organizationId).toBe(orgB.id);
        expect(claims.subscription.subscriptionPlans[serviceName]).toBe('PLATINUM');
      }

      const claimsA: any = decodeJwt(tokenA.body.pricingToken);
      expect(claimsA.organizationId).toBe(orgA.id);
      expect(claimsA.subscription.subscriptionPlans[serviceName]).toBe('GOLD');
    });

    it('drop their own cached token on novation and keep the other organization token', async function () {
      await createInB();
      const tokenA = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', keyA);
      const tokenB = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', keyB);

      const novation = await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', keyA)
        .send(subscription('BASIC'));
      expect(novation.status).toBe(200);

      const tokenA2 = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', keyA);
      const tokenB2 = await request(app).post(`${baseUrl}/features/${userId}/pricing-token`).set('x-api-key', keyB);
      expect((decodeJwt(tokenA2.body.pricingToken) as any).subscription.subscriptionPlans[serviceName]).toBe('BASIC');
      expect(tokenA2.body.pricingToken).not.toBe(tokenA.body.pricingToken);
      // Org B's cached token was not affected by org A's novation.
      expect(tokenB2.body.pricingToken).toBe(tokenB.body.pricingToken);
    });
  });

  describe('userIds that differ only in letter case', function () {
    it('keep separate cached contracts, evaluations and tokens', async function () {
      const upper = `Case-${uuidv4()}`;
      const lower = upper.toLowerCase();
      expect((await createContract(keyA, upper, 'upper', 'PLATINUM')).status).toBe(201);
      expect((await createContract(keyA, lower, 'lower', 'BASIC')).status).toBe(201);

      const readUpper = await read(keyA, upper);
      const readLower = await read(keyA, lower);
      expect(readUpper.body.userContact.username).toBe('upper');
      expect(readLower.body.userContact.username).toBe('lower');

      const evalUpper = await request(app).post(`${baseUrl}/features/${upper}?details=true`).set('x-api-key', keyA);
      const evalLower = await request(app).post(`${baseUrl}/features/${lower}?details=true`).set('x-api-key', keyA);
      expect(evalUpper.body[`${serviceName}-consultations`].eval).toBe(true);
      expect(evalLower.body[`${serviceName}-consultations`].eval).toBe(false);

      const tokenUpper = await request(app).post(`${baseUrl}/features/${upper}/pricing-token`).set('x-api-key', keyA);
      const tokenLower = await request(app).post(`${baseUrl}/features/${lower}/pricing-token`).set('x-api-key', keyA);
      expect((decodeJwt(tokenUpper.body.pricingToken) as any).sub).toBe(upper);
      expect((decodeJwt(tokenLower.body.pricingToken) as any).sub).toBe(lower);
    });
  });

  describe('contract events', function () {
    it('are delivered to the organization of the contract only', async function () {
      const socketA = await connect(keyA);
      const socketB = await connect(keyB);
      const eventsA = collect(socketA);
      const eventsB = collect(socketB);

      await createInB();
      await waitFor(eventsB, e => e.code === 'CONTRACT_CREATED' && e.details.userId === userId);

      const novation = await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', keyA)
        .send(subscription('BASIC'));
      expect(novation.status).toBe(200);
      const novatedA = await waitFor(eventsA, e => e.code === 'CONTRACT_NOVATED' && e.details.userId === userId);
      expect(novatedA.details.organizationId).toBe(orgA.id);
      expect(novatedA.details.contractVersion).toBe(novation.body.contractVersion);

      const removed = await request(app).delete(`${baseUrl}/contracts/${userId}`).set('x-api-key', keyB);
      expect(removed.status).toBe(204);
      const deletedB = await waitFor(eventsB, e => e.code === 'CONTRACT_DELETED' && e.details.userId === userId);
      expect(deletedB.details.organizationId).toBe(orgB.id);

      await new Promise(resolve => setTimeout(resolve, 200));
      expect(eventsA.every(e => e.details.organizationId === orgA.id)).toBe(true);
      expect(eventsB.every(e => e.details.organizationId === orgB.id)).toBe(true);
      expect(eventsA.some(e => e.code === 'CONTRACT_DELETED')).toBe(false);
      expect(eventsB.some(e => e.code === 'CONTRACT_NOVATED')).toBe(false);
    });
  });

  describe('platform ADMIN on the direct routes', function () {
    const asAdmin = (req: request.Test) => req.set('x-api-key', admin.apiKey);

    /** Every direct route that addresses one contract by userId, for an ADMIN, with an optional query string. */
    const userIdRoutes = (query = '') => {
      const base = `${baseUrl}/contracts/${userId}`;
      return {
        show: () => asAdmin(request(app).get(`${base}${query}`)),
        pricings: () => asAdmin(request(app).get(`${base}/pricings${query}`)),
        novate: () => asAdmin(request(app).put(`${base}${query}`)).send(subscription('BASIC')),
        preview: () => asAdmin(request(app).post(`${base}/novation/preview${query}`)).send(subscription('BASIC')),
        usageLevels: () => asAdmin(request(app).put(`${base}/usageLevels${query}`)).send({ [serviceName]: { maxPets: 2 } }),
        userContact: () => asAdmin(request(app).put(`${base}/userContact${query}`)).send({ username: 'renamed' }),
        billingPeriod: () =>
          asAdmin(request(app).put(`${base}/billingPeriod${query}`)).send({ autoRenew: false }),
        destroy: () => asAdmin(request(app).delete(`${base}${query}`)),
      };
    };

    /** Spies on every service method the direct routes call, to show that nothing was read, locked or written. */
    const spyOnContractService = () => {
      const contractService = container.resolve('contractService');
      const methods = [
        'show', 'pricings', 'novate', 'previewNovation', 'resetUsageLevels', 'novateUserContact',
        'novateBillingPeriod', 'destroy', 'novateByGroupId', 'novateBillingPeriodByGroupId', '_findContract',
      ];
      return methods.map(method => vi.spyOn(contractService, method));
    };

    const expectOrganizationRequired = (response: request.Response, kind: 'userId' | 'groupId') => {
      expect(response.status, JSON.stringify(response.body)).toBe(400);
      expect(response.body.code).toBe('ORGANIZATION_ID_REQUIRED');
      expect(response.body.error).toContain('?organizationId=');
      expect(response.body.error).toContain(kind === 'userId' ? `/organizations/{organizationId}/contracts/${userId}` : '/organizations/{organizationId}/contracts?groupId=');
      expect(response.body.organizationIds).toBeUndefined();
    };

    it('gets 400 ORGANIZATION_ID_REQUIRED without ?organizationId=, even for a userId of one organization only', async function () {
      const spies = spyOnContractService();
      try {
        for (const [name, send] of Object.entries(userIdRoutes())) {
          const response = await send();
          expect(response.status, `${name}: ${JSON.stringify(response.body)}`).toBe(400);
          expectOrganizationRequired(response, 'userId');
        }
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      const contract = await stored(orgA.id!);
      expect(contract.subscriptionPlans[serviceName]).toBe('GOLD');
      expect(contract.userContact.username).toBe('alice-of-a');
    });

    it('gets 400 ORGANIZATION_ID_REQUIRED, and changes nothing, when the userId exists in several organizations', async function () {
      await createInB();

      for (const send of Object.values(userIdRoutes())) expectOrganizationRequired(await send(), 'userId');

      expect((await stored(orgA.id!)).subscriptionPlans[serviceName]).toBe('GOLD');
      expect((await stored(orgA.id!)).userContact.username).toBe('alice-of-a');
      expect((await stored(orgB.id!)).subscriptionPlans[serviceName]).toBe('PLATINUM');
      expect((await stored(orgB.id!)).userContact.username).toBe('bob-of-b');
    });

    it('reaches every direct userId route with ?organizationId=', async function () {
      await createInB();
      const routes = userIdRoutes(`?organizationId=${orgB.id}`);

      const show = await routes.show();
      expect(show.status).toBe(200);
      expect(show.body.userContact.username).toBe('bob-of-b');
      expect((await routes.pricings()).status).toBe(200);
      const preview = await routes.preview();
      expect(preview.status, JSON.stringify(preview.body)).toBe(200);
      expect((await routes.usageLevels()).status).toBe(200);
      expect((await stored(orgB.id!)).usageLevels[serviceName].maxPets.consumed).toBe(2);
      expect((await stored(orgA.id!)).usageLevels[serviceName].maxPets.consumed).toBe(0);
      expect((await routes.userContact()).status).toBe(200);
      expect((await routes.billingPeriod()).status).toBe(200);
      const novate = await routes.novate();
      expect(novate.status, JSON.stringify(novate.body)).toBe(200);
      expect(novate.body.organizationId).toBe(orgB.id);

      expect((await stored(orgB.id!)).subscriptionPlans[serviceName]).toBe('BASIC');
      expect((await stored(orgB.id!)).userContact.username).toBe('renamed');
      expect((await stored(orgA.id!)).subscriptionPlans[serviceName]).toBe('GOLD');
      expect((await stored(orgA.id!)).userContact.username).toBe('alice-of-a');

      expect((await routes.destroy()).status).toBe(204);
      expect(await stored(orgB.id!)).toBeNull();
      expect(await stored(orgA.id!)).not.toBeNull();

      // One organization left with that userId: still required.
      expectOrganizationRequired(await userIdRoutes().show(), 'userId');
      expect((await userIdRoutes(`?organizationId=${orgA.id}`).show()).status).toBe(200);
    });

    it('answers 404 for an organization without that userId, or one that does not exist', async function () {
      const without = await userIdRoutes(`?organizationId=${orgB.id}`).show();
      const unknown = await userIdRoutes(`?organizationId=${uuidv4()}`).show();
      const unknownDelete = await userIdRoutes(`?organizationId=${uuidv4()}`).destroy();

      expect(without.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(unknownDelete.status).toBe(404);
      expect(await stored(orgA.id!)).not.toBeNull();
    });

    it('answers 400 for a malformed organizationId', async function () {
      const response = await userIdRoutes(`?organizationId=${orgA.id}&organizationId=${orgB.id}`).show();

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('organizationId');
    });

    it('keeps using the organization-scoped routes without the parameter', async function () {
      await createInB();

      const a = await asAdmin(request(app).get(`${baseUrl}/organizations/${orgA.id}/contracts/${userId}`));
      const b = await asAdmin(request(app).get(`${baseUrl}/organizations/${orgB.id}/contracts/${userId}`));

      expect(a.status).toBe(200);
      expect(a.body.userContact.username).toBe('alice-of-a');
      expect(b.body.userContact.username).toBe('bob-of-b');
    });

    it('lists and prunes every organization without ?organizationId=, or one with it', async function () {
      await createInB();

      const all = await asAdmin(request(app).get(`${baseUrl}/contracts?limit=100`));
      expect(all.status).toBe(200);
      const holders = all.body.filter((contract: any) => contract.userContact.userId === userId);
      expect(holders.map((contract: any) => contract.organizationId).sort()).toEqual([orgA.id, orgB.id].sort());
      const listed = await asAdmin(request(app).get(`${baseUrl}/contracts?organizationId=${orgB.id}`));
      expect(listed.status).toBe(200);
      expect(listed.body.map((contract: any) => contract.organizationId)).toEqual([orgB.id]);

      const pruned = await asAdmin(request(app).delete(`${baseUrl}/contracts?organizationId=${orgB.id}`));
      expect(pruned.status).toBe(204);
      expect(await stored(orgB.id!)).toBeNull();
      expect(await stored(orgA.id!)).not.toBeNull();
      expect((await read(keyA)).status).toBe(200);
    });

    it('requires ?organizationId= on the groupId routes, and changes nothing without it', async function () {
      const groupId = `group-${uuidv4()}`;
      expect((await createContract(keyA, `ga-${uuidv4()}`, 'ga', 'GOLD', { groupId })).status).toBe(201);
      expect((await createContract(keyB, `gb-${uuidv4()}`, 'gb', 'GOLD', { groupId })).status).toBe(201);
      const billingPeriod = { autoRenew: false };
      const inOrg = async (organizationId: string) =>
        (await ContractMongoose.findOne({ groupId, organizationId }).lean()) as any;

      const spies = spyOnContractService();
      try {
        expectOrganizationRequired(
          await asAdmin(request(app).put(`${baseUrl}/contracts?groupId=${groupId}`)).send(subscription('BASIC')),
          'groupId'
        );
        expectOrganizationRequired(
          await asAdmin(request(app).put(`${baseUrl}/contracts/billingPeriod?groupId=${groupId}`)).send(billingPeriod),
          'groupId'
        );
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      for (const organizationId of [orgA.id!, orgB.id!]) {
        expect((await inOrg(organizationId)).subscriptionPlans[serviceName]).toBe('GOLD');
        expect((await inOrg(organizationId)).billingPeriod.autoRenew).toBe(true);
      }

      const named = await asAdmin(
        request(app).put(`${baseUrl}/contracts?groupId=${groupId}&organizationId=${orgB.id}`)
      ).send(subscription('BASIC'));
      expect(named.status, JSON.stringify(named.body)).toBe(200);
      expect(named.body).toHaveLength(1);
      expect(named.body[0].organizationId).toBe(orgB.id);
      const period = await asAdmin(
        request(app).put(`${baseUrl}/contracts/billingPeriod?groupId=${groupId}&organizationId=${orgB.id}`)
      ).send(billingPeriod);
      expect(period.status, JSON.stringify(period.body)).toBe(200);
      expect(period.body).toHaveLength(1);
      expect((await inOrg(orgA.id!)).subscriptionPlans[serviceName]).toBe('GOLD');
      expect((await inOrg(orgA.id!)).billingPeriod.autoRenew).toBe(true);
      expect((await inOrg(orgB.id!)).billingPeriod.autoRenew).toBe(false);

      const unknown = await asAdmin(
        request(app).put(`${baseUrl}/contracts?groupId=${groupId}&organizationId=${uuidv4()}`)
      ).send(subscription('BASIC'));
      expect(unknown.status).toBe(404);
    });
  });

  describe('the organizationId query parameter for other callers', function () {
    it('is accepted when it names the caller organization and refused otherwise', async function () {
      await createInB();

      const own = await request(app).get(`${baseUrl}/contracts/${userId}?organizationId=${orgB.id}`).set('x-api-key', keyB);
      const other = await request(app).get(`${baseUrl}/contracts/${userId}?organizationId=${orgA.id}`).set('x-api-key', keyB);
      const route = await request(app)
        .get(`${baseUrl}/organizations/${orgB.id}/contracts/${userId}?organizationId=${orgA.id}`)
        .set('x-api-key', ownerB.apiKey);

      expect(own.status).toBe(200);
      expect(own.body.organizationId).toBe(orgB.id);
      expect(other.status).toBe(403);
      expect(other.body.userContact).toBeUndefined();
      expect(route.status).toBe(403);
    });
  });

  describe('moving a service to another organization', function () {
    it('is refused with 409 when a contract it would move uses a userId the target organization already has', async function () {
      const zoom = await request(app).post(`${baseUrl}/services`).set('x-api-key', keyA).attach('pricing', ZOOM_PRICING_PATH);
      expect(zoom.status).toBe(201);
      const zoomName = zoom.body.name.toLowerCase();
      const zoomVersion = Object.keys(zoom.body.activePricings)[0];
      const shared = `mover-${uuidv4()}`;
      const inA = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', keyA)
        .send({
          userContact: { userId: shared, username: 'mover-a' },
          billingPeriod: { autoRenew: true, renewalDays: 30 },
          contractedServices: { [zoomName]: zoomVersion },
          subscriptionPlans: { [zoomName]: 'BASIC' },
          subscriptionAddOns: {},
        });
      expect(inA.status, JSON.stringify(inA.body)).toBe(201);
      expect((await createContract(keyB, shared, 'mover-b', 'GOLD')).status).toBe(201);

      const move = await request(app)
        .put(`${baseUrl}/services/${zoomName}`)
        .set('x-api-key', keyA)
        .send({ organizationId: orgB.id });

      expect(move.status, JSON.stringify(move.body)).toBe(409);
      expect(move.body.error).toContain(shared);
      expect((await ServiceMongoose.findOne({ name: zoom.body.name }).lean() as any).organizationId).toBe(orgA.id);
      expect((await stored(orgA.id!, shared)).contractedServices[zoomName]).toBeDefined();
      expect((await stored(orgB.id!, shared)).userContact.username).toBe('mover-b');
    });
  });
});
