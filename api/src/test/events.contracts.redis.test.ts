import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import EventService from '../main/services/EventService';
import container from '../main/config/container';
import Contract from '../main/repositories/mongoose/models/ContractMongoose';
import { getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';

type Event = { code: string; details: { userId: string; organizationId: string } };

describe('Contract event authorization across API instances', () => {
  const publisher = new EventService();
  const receiver = new EventService();
  const addresses: string[] = [];
  const sockets: Socket[] = [];
  let owner: any;
  let organization: any;
  let otherOrganization: any;
  let allowedKey: string;
  let revokedKey: string;
  let otherKey: string;

  const connect = (instance: number, apiKey: string) => new Promise<Socket>((resolve, reject) => {
    const socket = io(`${addresses[instance]}/contracts`, {
      path: '/events', transports: ['websocket'], auth: { apiKey }, reconnection: false, forceNew: true,
    });
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('cross-instance connection timed out')), 4000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
  });

  const collect = (socket: Socket) => {
    const events: Event[] = [];
    socket.on('message', (event: Event) => events.push(event));
    return events;
  };

  const waitFor = async (events: Event[], userId: string) => {
    const end = Date.now() + 4000;
    while (Date.now() < end) {
      const event = events.find(value => value.details.userId === userId);
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`cross-instance event not received: ${JSON.stringify(events)}`);
  };

  const disconnected = (socket: Socket) => new Promise<void>((resolve, reject) => {
    if (!socket.connected) return resolve();
    const timer = setTimeout(() => reject(new Error('revoked remote connection stayed open')), 4000);
    socket.once('disconnect', () => { clearTimeout(timer); resolve(); });
  });

  const persistAndEmit = async () => {
    const contract = {
      userContact: { userId: randomUUID(), username: 'cross-instance-event' },
      organizationId: organization.id,
      contractedServices: { demo: '1_0' }, subscriptionPlans: { demo: 'basic' }, subscriptionAddOns: {},
      billingPeriod: { startDate: new Date('2025-01-01'), endDate: new Date('2026-01-01'), autoRenew: false, renewalDays: 30 },
      history: [], synchronizationHistory: [],
    };
    await Contract.collection.insertOne(contract);
    publisher.emitContractEvent('CONTRACT_CREATED', contract);
    return contract.userContact.userId;
  };

  beforeAll(async () => {
    await getApp(); // Real database/authentication, plus the application's own EventService.
    for (const service of [publisher, receiver]) {
      const server: Server = createServer();
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      await service.initialize(server);
      addresses.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
  });

  beforeEach(async () => {
    owner = await createTestUser('USER', `event-redis-${randomUUID()}`);
    organization = await createTestOrganization(owner.username);
    otherOrganization = await createTestOrganization(owner.username);
    allowedKey = generateOrganizationApiKey();
    revokedKey = generateOrganizationApiKey();
    otherKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id, { key: allowedKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id, { key: revokedKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id, { key: otherKey, scope: 'ALL' });
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await Contract.deleteMany({ organizationId: { $in: [organization.id, otherOrganization.id] } });
    await deleteTestOrganization(organization.id);
    await deleteTestOrganization(otherOrganization.id);
    await deleteTestUser(owner.username);
  });

  afterAll(async () => {
    await publisher.close();
    await receiver.close();
    await shutdownApp();
  });

  it('delivers each event once locally and remotely, only within its organization', async () => {
    const local = collect(await connect(0, allowedKey));
    const remote = collect(await connect(1, revokedKey));
    const other = collect(await connect(1, otherKey));
    const first = await persistAndEmit();
    await waitFor(local, first);
    await waitFor(remote, first);
    const second = await persistAndEmit();
    await waitFor(local, second);
    await waitFor(remote, second);
    expect(local.filter(event => event.details.userId === first)).toHaveLength(1);
    expect(remote.filter(event => event.details.userId === first)).toHaveLength(1);
    expect(other).toEqual([]);
  });

  it('disconnects a revoked remote key when another API instance removes it', async () => {
    const revoked = await connect(1, revokedKey);
    const revokedEvents = collect(revoked);
    const allowed = collect(await connect(1, allowedKey));
    const before = await persistAndEmit();
    await waitFor(revokedEvents, before);
    // The application's EventService is a third instance, distinct from both event servers.
    await container.resolve('organizationService').removeApiKey(organization.id, revokedKey, owner);
    await disconnected(revoked);
    const after = await persistAndEmit();
    await waitFor(allowed, after);
    expect(revokedEvents.some(event => event.details.userId === after)).toBe(false);
    await expect(connect(1, revokedKey)).rejects.toThrow(/Invalid/i);
  });

  it('checks remote outgoing access even when revocation notification is absent', async () => {
    const revoked = await connect(1, revokedKey);
    const revokedEvents = collect(revoked);
    const allowed = collect(await connect(0, allowedKey));
    const before = await persistAndEmit();
    await waitFor(revokedEvents, before);
    await container.resolve('organizationRepository').removeApiKey(organization.id, revokedKey);
    const after = await persistAndEmit();
    await waitFor(allowed, after);
    await disconnected(revoked);
    expect(revokedEvents.some(event => event.details.userId === after)).toBe(false);
  });
});
