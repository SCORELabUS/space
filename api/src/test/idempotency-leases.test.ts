import { randomUUID } from 'node:crypto';
import type { Server } from 'http';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import IdempotencyKeyRepository, { IdempotencyOwnershipError } from '../main/repositories/mongoose/IdempotencyKeyRepository';
import IdempotencyContractRepository, { type IdempotentContractWrite } from '../main/repositories/mongoose/IdempotencyContractRepository';
import IdempotencyKey from '../main/repositories/mongoose/models/IdempotencyKeyMongoose';
import Contract from '../main/repositories/mongoose/models/ContractMongoose';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';

describe('Durable idempotency leases and contract receipts', () => {
  let app: Server;
  let repository: IdempotencyKeyRepository;
  let contracts: IdempotencyContractRepository;
  let organizationId: string;
  let key: string;
  const contractIds: string[] = [];
  const options = { ttlSeconds: 3600, lockSeconds: 60 };
  const response = { status: 201, headers: { 'content-type': 'application/json' }, body: '{"created":true}' };

  const reserve = (fingerprint = 'same-request', organization = organizationId) =>
    repository.reserve(organization, key, fingerprint, options);

  const expireLease = () => IdempotencyKey.updateOne({ organizationId, key }, { $set: { lockedUntil: new Date(0) } });

  const newWrite = (organization = organizationId): IdempotentContractWrite => {
    const contractId = new Types.ObjectId().toString();
    contractIds.push(contractId);
    const userId = `lease-user-${randomUUID()}`;
    return {
      contractId, organizationId: organization, userId,
      create: {
        organizationId: organization,
        userContact: { userId, username: 'lease-fixture' },
        billingPeriod: { startDate: new Date('2026-01-01'), endDate: new Date('2027-01-01'), autoRenew: false, renewalDays: 30 },
        usageLevels: { meter: { calls: { consumed: 7, resetTimeStamp: null } } },
        contractedServices: {}, subscriptionPlans: {}, subscriptionAddOns: {},
      },
    };
  };

  beforeAll(async () => {
    app = await getApp();
    repository = container.resolve('idempotencyKeyRepository');
    contracts = container.resolve('idempotencyContractRepository');
    await repository.initialize();
  });

  beforeEach(() => {
    organizationId = new Types.ObjectId().toString();
    key = randomUUID();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await IdempotencyKey.deleteMany({ key });
    await Contract.deleteMany({ _id: { $in: contractIds.splice(0) } });
  });

  afterAll(async () => { await shutdownApp(); });

  it('uses MongoDB time for reservation and renewal, independently of the worker clock', async () => {
    const workerTime = Date.now() + 24 * 3600 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(workerTime);
    const reservation = await reserve();
    expect(reservation.reserved).toBe(true);
    if (!reservation.reserved) throw new Error('Expected a lease');
    const [{ now }] = await IdempotencyKey.aggregate([
      { $match: { organizationId, key } }, { $project: { now: '$$NOW' } },
    ]);
    expect(reservation.record.createdAt.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(reservation.record.createdAt.getTime()).toBeGreaterThan(now.getTime() - 5000);
    expect(reservation.record.lockedUntil!.getTime() - reservation.record.createdAt.getTime()).toBe(60000);
    expect(reservation.record.lockedUntil!.getTime()).toBeLessThan(workerTime);

    const renewed = await repository.renew(organizationId, key, reservation.owner, 120);
    expect(renewed).not.toBeNull();
    expect(renewed!.lockedUntil!.getTime()).toBeGreaterThan(reservation.record.lockedUntil!.getTime());
    expect((await reserve()).reserved).toBe(false);

    // Expiry is changed in Mongo, without sleeping or relying on the worker's clock.
    await expireLease();
    expect(await repository.renew(organizationId, key, reservation.owner, 120)).toBeNull();
    const successor = await reserve();
    expect(successor.reserved).toBe(true);
    if (!successor.reserved) throw new Error('Expected takeover');
    expect(await repository.renew(organizationId, key, successor.owner, 120)).not.toBeNull();
  });

  it('preserves immutable operation identity, fingerprint, plan, steps and result on takeover', async () => {
    const first = await reserve();
    if (!first.reserved) throw new Error('Expected a lease');
    const plan = { kind: 'group-novation', contractIds: ['fixed-a', 'fixed-b'], target: 'v2' };
    const step = { result: { contractId: 'fixed-a', version: 'v2' } };
    const result = { updated: 1, pending: 1 };
    await repository.prepare(organizationId, key, first.owner, plan);
    await repository.checkpoint(organizationId, key, first.owner, 'contract-a', step);
    await repository.saveResult(organizationId, key, first.owner, result);
    await expireLease();

    const next = await reserve();
    if (!next.reserved) throw new Error('Expected takeover');
    expect(next.owner).not.toBe(first.owner);
    expect(next.record).toMatchObject({ operationId: first.record.operationId, fingerprint: 'same-request', plan, steps: { 'contract-a': step }, result });
    expect(next.record.createdAt).toEqual(first.record.createdAt);
    const immutable = await repository.prepare(organizationId, key, next.owner, { target: 'different-target' });
    expect(immutable.plan).toEqual(plan);
    expect(next.record.expiresAt).toBeUndefined();
  });

  it('rejects every old-owner mutation after expiry and takeover', async () => {
    const first = await reserve();
    if (!first.reserved) throw new Error('Expected a lease');
    await expireLease();
    await expect(repository.assertOwned(organizationId, key, first.owner)).rejects.toBeInstanceOf(IdempotencyOwnershipError);
    expect(await repository.complete(organizationId, key, first.owner, response)).toBe(false);
    expect(await repository.release(organizationId, key, first.owner)).toBe(false);
    const next = await reserve();
    if (!next.reserved) throw new Error('Expected takeover');

    await expect(repository.prepare(organizationId, key, first.owner, { stale: true })).rejects.toBeInstanceOf(IdempotencyOwnershipError);
    await expect(repository.checkpoint(organizationId, key, first.owner, 'stale', { applied: true })).rejects.toBeInstanceOf(IdempotencyOwnershipError);
    await expect(repository.saveResult(organizationId, key, first.owner, { stale: true })).rejects.toBeInstanceOf(IdempotencyOwnershipError);
    await expect(repository.yieldLease(organizationId, key, first.owner)).rejects.toBeInstanceOf(IdempotencyOwnershipError);
    expect(await repository.renew(organizationId, key, first.owner, 60)).toBeNull();
    expect(await repository.complete(organizationId, key, first.owner, response)).toBe(false);
    expect(await repository.release(organizationId, key, first.owner)).toBe(false);
    expect(await repository.assertOwned(organizationId, key, next.owner)).toMatchObject({ owner: next.owner, state: 'in_progress' });
  });

  it('never lets another fingerprint inherit an abandoned operation, while organizations remain independent', async () => {
    const first = await reserve();
    if (!first.reserved) throw new Error('Expected a lease');
    await repository.prepare(organizationId, key, first.owner, { target: 'original' });
    await expireLease();
    const conflict = await reserve('different-request');
    expect(conflict.reserved).toBe(false);
    if (conflict.reserved) throw new Error('Different fingerprint inherited an operation');
    expect(conflict.existing).toMatchObject({ operationId: first.record.operationId, fingerprint: 'same-request', plan: { target: 'original' } });
    const otherOrganization = await reserve('different-request', new Types.ObjectId().toString());
    expect(otherOrganization.reserved).toBe(true);
    if (!otherOrganization.reserved) throw new Error('Independent organization was blocked');
    expect(otherOrganization.record.operationId).not.toBe(first.record.operationId);
  });

  it('removes legacy in-progress TTLs at initialization and preserves the journal identity and progress', async () => {
    const id = new Types.ObjectId();
    const plan = { contractId: 'legacy-fixed-id' };
    // Bypass the new required operationId to represent a document written by the old release.
    // A future legacy TTL avoids racing MongoDB's asynchronous TTL deletion during fixture setup.
    await IdempotencyKey.collection.insertOne({ _id: id, organizationId, key, fingerprint: 'legacy', state: 'in_progress',
      owner: 'abandoned', lockedUntil: new Date(0), createdAt: new Date(0), expiresAt: new Date('2100-01-01'), plan,
      steps: { persisted: { result: { applied: true } } }, result: { recovered: true } });
    const upgraded = new IdempotencyKeyRepository();
    await upgraded.initialize();
    const stored: any = await IdempotencyKey.collection.findOne({ _id: id });
    expect(stored).not.toHaveProperty('expiresAt');
    expect(stored.operationId).toBe(id.toString());
    const resumed = await upgraded.reserve(organizationId, key, 'legacy', options);
    if (!resumed.reserved) throw new Error('Expected legacy recovery');
    expect(resumed.record).toMatchObject({ operationId: id.toString(), plan, steps: { persisted: { result: { applied: true } } }, result: { recovered: true } });
    expect(resumed.record.expiresAt).toBeUndefined();
  });

  it('starts a new operation only after a completed response replay window expires', async () => {
    const first = await reserve();
    if (!first.reserved) throw new Error('Expected a lease');
    expect(first.record.expiresAt).toBeUndefined();
    expect(await repository.complete(organizationId, key, first.owner, response, 3600)).toBe(true);
    const replay = await reserve();
    if (replay.reserved) throw new Error('Completed operation was repeated');
    expect(replay.existing.response).toEqual(response);
    expect(replay.existing.expiresAt).toBeInstanceOf(Date);
    await IdempotencyKey.updateOne({ organizationId, key }, { $set: { expiresAt: new Date(0) } });
    const fresh = await reserve('new-request');
    if (!fresh.reserved) throw new Error('Expired response prevented a fresh operation');
    expect(fresh.record.operationId).not.toBe(first.record.operationId);
    expect(fresh.record).toMatchObject({ state: 'in_progress', fingerprint: 'new-request' });
    expect(fresh.record.expiresAt).toBeUndefined();
    expect(fresh.record.plan).toBeUndefined();
    expect(fresh.record.response).toBeUndefined();
  });

  it('fences an expired contract update at MongoDB without changing the counter or storing a receipt', async () => {
    const write = newWrite();
    await Contract.create({ ...write.create, _id: write.contractId });
    const update = { ...write, create: undefined, increments: { 'meter.calls': 3 } };
    await expect(contracts.apply(update, randomUUID(), new Date(0))).rejects.toThrow(/lease lost/i);
    const stored: any = await Contract.findById(write.contractId).select('+idempotencyReceipt').lean();
    expect(stored.usageLevels.meter.calls.consumed).toBe(7);
    expect(stored.idempotencyReceipt).toBeUndefined();
  });

  it('rejects a preallocated creation after its lease deadline without inserting a partial contract', async () => {
    const write = newWrite();
    await expect(contracts.apply(write, randomUUID(), new Date(0))).rejects.toThrow();
    expect(await Contract.findById(write.contractId).lean()).toBeNull();
    expect(await Contract.countDocuments({ organizationId: write.organizationId, 'userContact.userId': write.userId })).toBe(0);
  });

  it('replays a preallocated contract creation once and rejects another organization or user scope', async () => {
    const write = newWrite();
    const stepId = randomUUID();
    const deadline = new Date(Date.now() + 60000);
    const first = await contracts.apply(write, stepId, deadline);
    const retry = await contracts.apply(write, stepId, deadline);
    expect(retry).toEqual(first);
    expect(first.id).toBe(write.contractId);
    expect(first).not.toHaveProperty('idempotencyReceipt');
    expect(await Contract.countDocuments({ _id: write.contractId })).toBe(1);
    for (const alien of [
      { ...write, organizationId: new Types.ObjectId().toString() },
      { ...write, userId: 'different-user' },
    ]) {
      await expect(contracts.apply(alien, stepId, deadline)).rejects.toThrow(/conflict/i);
    }
    const stored: any = await Contract.findById(write.contractId).select('+idempotencyReceipt').lean();
    expect(stored.organizationId).toBe(write.organizationId);
    expect(stored.userContact.userId).toBe(write.userId);
    expect(stored.idempotencyReceipt.stepId).toBe(stepId);
  });

  it('does not reveal a prepared contract receipt through show or aggregated listing responses', async () => {
    const owner = await createTestUser('USER', `receipt-owner-${randomUUID()}`);
    let orgId: string | undefined;
    try {
      const organization = await createTestOrganization(owner.username);
      orgId = organization.id!;
      const apiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(orgId, { key: apiKey, scope: 'ALL' });
      const write = newWrite(orgId);
      const stepId = randomUUID();
      await contracts.apply(write, stepId, new Date(Date.now() + 60000));
      const internal: any = await Contract.findById(write.contractId).select('+idempotencyReceipt').lean();
      expect(internal.idempotencyReceipt).toMatchObject({ stepId, acknowledged: false });
      const shown = await request(app).get(`${baseUrl}/contracts/${write.userId}`).set('x-api-key', apiKey).expect(200);
      const listed = await request(app).get(`${baseUrl}/contracts`).set('x-api-key', apiKey).expect(200);
      expect(shown.body.userContact.userId).toBe(write.userId);
      expect(listed.body).toHaveLength(1);
      for (const contract of [shown.body, ...listed.body]) {
        expect(contract).not.toHaveProperty('idempotencyReceipt');
        expect(JSON.stringify(contract)).not.toContain(stepId);
      }
    } finally {
      if (orgId) await deleteTestOrganization(orgId);
      await deleteTestUser(owner.username);
    }
  });
});
