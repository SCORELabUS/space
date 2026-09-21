import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import nock from 'nock';
import fs from 'node:fs/promises';
const mocks = vi.hoisted(() => ({ cache: { del: vi.fn(async () => {}), get: vi.fn(async () => null), set: vi.fn(async () => {}) }, events: { emitPricingActivedMessage: vi.fn(), emitServiceDisabledMessage: vi.fn() } }));
vi.mock('../main/config/container', async () => {
  const Repository = (await import('../main/repositories/mongoose/SphereSyncRepository')).default;
  return { default: { resolve: (key: string) => key === 'sphereSyncRepository' ? new Repository() : key === 'cacheService' ? mocks.cache : mocks.events } };
});
import SphereSyncService from '../main/services/sphere/SphereSyncService';
import { functionalHash } from '../main/services/sphere/SphereClient';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import Pricing from '../main/repositories/mongoose/models/PricingMongoose';
import Contract from '../main/repositories/mongoose/models/ContractMongoose';
import { SphereLease, SphereRun } from '../main/repositories/mongoose/models/SphereSyncMongoose';
import { enforceSpherePolicy } from '../main/services/sphere/contractPolicy';
import { withOrganizationLock } from '../main/services/sphere/lock';
const id = '111111111111111111111111', one = '222222222222222222222222', two = '333333333333333333333333';
const origin = 'https://sphere.score.us.es';
const yaml = (version: string, plan = 'basic', price: number | string = 0, syntaxVersion = '3.1') => `saasName: Demo\nversion: '${version}'\ncreatedAt: '${version === '1.0' ? '2024' : '2025'}-01-01'\nsyntaxVersion: '${syntaxVersion}'\ncurrency: USD\nfeatures:\n  enabled:\n    valueType: BOOLEAN\n    defaultValue: true\n    type: DOMAIN\nusageLimits:\n  calls:\n    valueType: NUMERIC\n    defaultValue: 10\n    type: NON_RENEWABLE\n    trackable: true\nplans:\n  ${plan}:\n    price: ${price}\n    unit: /month\n    features:\n      enabled: true\n    usageLimits:\n      calls: 10\n`;
const v = (versionId: string, version: string, text: string) => ({ versionId, version, createdAt: `${version === '1.0' ? '2024' : '2025'}-01-01T00:00:00.000Z`, contentHash: functionalHash(text) });
function remote(versions: any[], files: Record<string, string> = {}) {
  nock(origin).get(`/api/v1/public/pricings/${id}`).reply(200, { pricingId: id, name: 'Demo', permanentUrl: `${origin}/p/${id}`, latestVersionId: versions[versions.length - 1].versionId, versions });
  for (const [versionId, text] of Object.entries(files)) nock(origin).get(`/api/v1/public/pricings/${id}/versions/${versionId}/yaml`).times(2).reply(200, text);
}
const suite = process.env.SPHERE_SYNC_TEST_MONGO === 'true' ? describe : describe.skip;
suite('SPHERE synchronization with isolated MongoDB', () => {
  let sync: SphereSyncService;
  const files = new Set<string>();
  beforeAll(async () => {
    await mongoose.connect('mongodb://127.0.0.1:27981/space_sphere_sync_test');
    await Promise.all([Service.init(), Pricing.init(), Contract.init(), SphereLease.init(), SphereRun.init()]);
  });
  beforeEach(async () => {
    for (const copy of await Pricing.find({ sphere: { $exists: true } }).lean()) if (copy.yamlPath) files.add(copy.yamlPath);
    await Promise.all([Service.deleteMany({}), Pricing.deleteMany({}), Contract.deleteMany({}), SphereLease.deleteMany({}), SphereRun.deleteMany({})]);
    nock.cleanAll(); vi.clearAllMocks(); sync = new SphereSyncService();
  });
  afterAll(async () => {
    for (const copy of await Pricing.find({}).lean()) if (copy.yamlPath) files.add(copy.yamlPath);
    for (const file of files) await fs.rm(`public${file}`, { force: true });
    await mongoose.connection.dropDatabase(); await mongoose.disconnect(); nock.cleanAll();
  });
  async function create(policy: any = 'new_last') {
    const text = yaml('1.0'); remote([v(one, '1.0', text)], { [one]: text });
    return sync.create({ permanentUrl: `${origin}/p/${id}`, policy, selectedVersionId: one }, 'org');
  }
  async function contract() {
    return Contract.create({ userContact: { userId: 'user', username: 'user' }, organizationId: 'org',
      contractedServices: { demo: '1_0', other: 'old' }, subscriptionPlans: { demo: 'basic', other: 'keep' }, subscriptionAddOns: { demo: {}, other: {} },
      usageLevels: { demo: { calls: { consumed: 7 } } }, billingPeriod: { startDate: new Date('2024-01-01'), endDate: new Date('2024-02-01') }, history: [] });
  }
  async function update(service: any, text = yaml('2.0', 'cheap')) {
    remote([v(one, '1.0', yaml('1.0')), v(two, '2.0', text)], { [two]: text });
    await sync.enqueue('org', 'demo'); await sync.synchronize(String(service._id ?? service.id));
  }
  it('imports only the target and forces it for new contracts', async () => {
    await create(); expect(await Pricing.countDocuments()).toBe(1);
    const sub = { contractedServices: { demo: 'different' } }; await enforceSpherePolicy('org', sub);
    expect(sub.contractedServices.demo).toBe('1.0');
  });
  it('requires acknowledgement before importing and storing an upgraded legacy syntax', async () => {
    const legacy = yaml('1.0', 'basic', 0, '2.1');
    remote([v(one, '1.0', legacy)], { [one]: legacy });
    const preview = await sync.preview({ permanentUrl: `${origin}/p/${id}`, policy: 'new_last' });
    expect(preview.syntaxUpgrade).toEqual({ versionId: one, from: '2.1', to: '3.1' });

    remote([v(one, '1.0', legacy)], { [one]: legacy });
    await expect(sync.create({ permanentUrl: `${origin}/p/${id}`, policy: 'new_last' }, 'org')).rejects.toThrow('requires confirmation');

    remote([v(one, '1.0', legacy)], { [one]: legacy });
    const service = await sync.create({ permanentUrl: `${origin}/p/${id}`, policy: 'new_last', acceptedSyntaxUpgradeVersionId: one }, 'org');
    const snapshot: any = await Pricing.findOne({ 'sphere.serviceId': String(service.id) }).lean();
    expect(await fs.readFile(`public${snapshot.yamlPath}`, 'utf8')).toMatch(/syntaxVersion: ['"]?3\.1/);
  });
  it('New preserves current bindings and retains old versions only while used', async () => {
    const service = await create(); await contract(); await update(service);
    const state = await sync.get('org', 'demo'); expect(state.configuration.target.version).toBe('2.0');
    expect(await Pricing.countDocuments()).toBe(2);
    await Contract.deleteMany({}); await sync.cleanup(String(service.id));
    expect((await Pricing.find({}).lean()).map(p => p.version)).toEqual(['2_0']);
  });
  it('All migrates incompatible plans, preserves usage and billing, then removes obsolete copies', async () => {
    const service = await create('all_last'); const prior = await contract(); await update(service);
    const current: any = await Contract.findById(prior._id).lean();
    expect(current.contractedServices).toEqual({ demo: '2_0', other: 'old' });
    expect(current.subscriptionPlans).toEqual({ demo: 'cheap', other: 'keep' });
    expect(current.usageLevels.demo.calls.consumed).toBe(7);
    expect(current.billingPeriod.startDate).toEqual(new Date('2024-01-01'));
    expect(current.synchronizationHistory).toHaveLength(1);
    expect(await Pricing.countDocuments()).toBe(1);
    expect(mocks.cache.del).toHaveBeenCalledWith('features.user.*');
  });
  it('blocks an impossible fallback before modifying contracts and removes staged copies', async () => {
    const service = await create('all_last'); await contract(); await update(service, yaml('2.0', 'sales', 'Contact sales'));
    expect((await sync.get('org', 'demo')).configuration.status).toBe('blocked');
    expect((await Contract.findOne({}).lean())?.contractedServices).toEqual({ demo: '1_0', other: 'old' });
    expect(await Pricing.countDocuments()).toBe(1);
  });
  it('keeps the target and allows new bindings during an origin outage', async () => {
    const service = await create(); nock(origin).get(`/api/v1/public/pricings/${id}`).reply(503);
    await sync.enqueue('org', 'demo'); await sync.synchronize(String(service.id));
    expect((await sync.get('org', 'demo')).configuration.status).toBe('degraded');
    const subscription = { contractedServices: { demo: 'wrong' } }; await enforceSpherePolicy('org', subscription);
    expect(subscription.contractedServices.demo).toBe('1.0'); expect(await Pricing.countDocuments()).toBe(1);
  });
  it('recovers a failure after a contract write without duplicating migration history', async () => {
    const service = await create('all_last'); await contract();
    mocks.cache.del.mockImplementationOnce(async () => {});
    const original = Contract.updateOne.bind(Contract);
    let interrupted = false;
    const spy = vi.spyOn(Contract, 'updateOne').mockImplementation(((...args: any[]) => {
      const operation = original(...args as Parameters<typeof Contract.updateOne>);
      if ((args[1] as any).$push?.synchronizationHistory && !interrupted) {
        interrupted = true;
        return operation.then(() => { throw new Error('simulated crash after durable write'); });
      }
      return operation;
    }) as any);
    await update(service);
    spy.mockRestore();
    expect((await sync.get('org', 'demo')).configuration.status).toBe('applying');
    await sync.enqueue('org', 'demo'); await sync.synchronize(String(service.id));
    expect((await sync.get('org', 'demo')).configuration.status).toBe('ready');
    expect((await Contract.findOne({}).lean())?.synchronizationHistory).toHaveLength(1);
    expect(await Pricing.countDocuments()).toBe(1);
  });
  it('retries a concurrent consumption increment without losing it', async () => {
    const service = await create('all_last'); const bound = await contract();
    const original = Contract.updateOne.bind(Contract);
    let incremented = false;
    const spy = vi.spyOn(Contract, 'updateOne').mockImplementation(((...args: any[]) => {
      if ((args[1] as any).$push?.synchronizationHistory && !incremented) {
        incremented = true;
        return original({ _id: bound._id }, { $inc: { 'usageLevels.demo.calls.consumed': 3 } })
          .then(() => original(...args as Parameters<typeof Contract.updateOne>));
      }
      return original(...args as Parameters<typeof Contract.updateOne>);
    }) as any);
    await update(service); spy.mockRestore();
    expect((await Contract.findById(bound._id).lean() as any).usageLevels.demo.calls.consumed).toBe(10);
    expect((await sync.get('org', 'demo')).configuration.status).toBe('ready');
  });
  it.each(['all_pick', 'new_pick'] as const)('%s changes the selected target with the expected existing-contract behavior', async policy => {
    const service = await create(policy); await contract();
    const text = yaml('2.0', 'basic');
    remote([v(one, '1.0', yaml('1.0')), v(two, '2.0', text)]);
    await sync.configure('org', 'demo', { policy, permanentUrl: `${origin}/p/${id}`, selectedVersionId: two });
    remote([v(one, '1.0', yaml('1.0')), v(two, '2.0', text)], { [two]: text });
    await sync.synchronize(String(service.id));
    expect((await sync.get('org', 'demo')).configuration.target.version).toBe('2.0');
    expect((await Contract.findOne({}).lean() as any).contractedServices.demo).toBe(policy === 'all_pick' ? '2_0' : '1_0');
  });
  it('retains a removed/private target and rejects changed content under an imported identity', async () => {
    const service = await create();
    nock(origin).get(`/api/v1/public/pricings/${id}`).reply(404);
    await sync.enqueue('org', 'demo'); await sync.synchronize(String(service.id));
    expect(await Pricing.countDocuments()).toBe(1);
    remote([v(one, '1.0', yaml('1.0', 'different'))]);
    await sync.enqueue('org', 'demo'); await sync.synchronize(String(service.id));
    expect((await sync.get('org', 'demo')).configuration.status).toBe('blocked');
    expect(await Pricing.countDocuments()).toBe(1);
  });
  it('removes orphaned initial imports while preserving live snapshots', async () => {
    const service = await create();
    await sync.reconcileOrphans(); expect(await Pricing.countDocuments()).toBe(1);
    await Service.deleteOne({ _id: service.id });
    await sync.reconcileOrphans(); expect(await Pricing.countDocuments()).toBe(0);
  });
  it.each([true, false])('removes linked service bindings safely (disable=%s)', async disable => {
    const service = await create(); const existing = await contract();
    await withOrganizationLock('org', owned => sync.removeLinkedService(String(service.id), disable, owned));
    const updated: any = await Contract.findById(existing._id).lean();
    expect(updated.contractedServices).toEqual({ other: 'old' });
    expect(updated.subscriptionPlans).toEqual({ other: 'keep' });
    expect(updated.billingPeriod.startDate).toEqual(existing.billingPeriod!.startDate);
    expect(await Pricing.countDocuments()).toBe(disable ? 1 : 0);
    expect(await Service.countDocuments()).toBe(disable ? 1 : 0);
  });
  it('rejects writes from a worker that has lost its lease', async () => {
    const service = await create();
    await withOrganizationLock('org', async () => {
      await SphereLease.updateOne({ _id: 'sphere:org' }, { $set: { owner: 'replacement' } });
      await expect(Service.updateOne({ _id: service.id }, { $set: { disabled: true } })).rejects.toThrow('lock lost');
    });
    expect((await Service.findById(service.id).lean())?.disabled).toBe(false);
  });
  it('excludes simultaneous organization writers' , async () => {
    await withOrganizationLock('org', async () => {
      await expect(withOrganizationLock('org', async () => {})).rejects.toThrow('busy');
    });
    await expect(withOrganizationLock('org', async () => true)).resolves.toBe(true);
  });
});
