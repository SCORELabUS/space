import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { addApiKeyToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { contractCacheKey, featuresCacheKey } from '../main/utils/contracts/cacheKeys';
import { LeanUser } from '../main/types/models/User';
import { LeanOrganization } from '../main/types/models/Organization';
import Contract from '../main/repositories/mongoose/models/ContractMongoose';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import Pricing from '../main/repositories/mongoose/models/PricingMongoose';
import { ServiceRelocation, ServiceRelocationStep } from '../main/repositories/mongoose/models/ServiceRelocationMongoose';
import { PETCLINIC_BASE_VERSION, uploadPetclinicService, writePetclinicVariant } from './utils/services/petclinicVersions';

const FROM = 'Vetclinic', TO = 'Vetcare', OLD = 'vetclinic', NEW = 'vetcare';
const MAPS = ['contractedServices', 'subscriptionPlans', 'subscriptionAddOns', 'usageLevels'] as const;

describe('Service relocation recovery', () => {
  let app: Server, owner: LeanUser, source: LeanOrganization, target: LeanOrganization;
  let sourceKey: string, serviceId: string, pricingIds: string[], singles: string[], mixed: string;
  let before: Map<string, any>;
  const move = () => ({ name: TO, organizationId: target.id! });
  const update = (body: any = move(), org = source.id!, name = FROM) =>
    request(app).put(`${baseUrl}/organizations/${org}/services/${name}`).set('x-api-key', owner.apiKey).send(body);
  const pending = () => ServiceRelocation.findOne({ serviceId, state: 'pending' }).lean() as any;
  const stored = (userId: string) => Contract.findOne({ 'userContact.userId': userId }).lean() as any;
  beforeAll(async () => { app = await getApp(); });
  beforeEach(async () => {
    owner = await createTestUser('USER', `recovery_${uuidv4()}`);
    source = await createTestOrganization(owner.username); target = await createTestOrganization(owner.username);
    sourceKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(source.id!, { key: sourceKey, scope: 'ALL' });
    await uploadPetclinicService(app, sourceKey);
    const file = writePetclinicVariant('1.0', '2025-01-01', pricing => { pricing.saasName = FROM; });
    serviceId = (await uploadPetclinicService(app, sourceKey, file)).id;
    pricingIds = (await Pricing.find({ _serviceName: FROM, _organizationId: source.id }).select('_id').lean()).map(doc => String(doc._id));
    expect(pricingIds).toHaveLength(1);
    const now = Date.now(), ids = [uuidv4(), uuidv4(), uuidv4()];
    singles = [ids[0], ids[2]]; mixed = ids[1];
    await Contract.insertMany(ids.map((userId, index) => {
      const services = index === 1 ? { petclinic: PETCLINIC_BASE_VERSION.replace(/\./g, '_'), [OLD]: '1_0' } : { [OLD]: '1_0' };
      return { userContact: { userId, username: `recovery-${index}` }, organizationId: source.id,
        billingPeriod: { startDate: new Date(now - 86_400_000), endDate: new Date(now + 29 * 86_400_000), autoRenew: true, renewalDays: 30 },
        contractedServices: services,
        subscriptionPlans: Object.fromEntries(Object.keys(services).map(name => [name, 'GOLD'])),
        subscriptionAddOns: Object.fromEntries(Object.keys(services).map(name => [name, { extraPets: 1 }])),
        usageLevels: Object.fromEntries(Object.keys(services).map(name => [name, { maxPets: { consumed: index + 3 } }])), history: [] };
    }));
    before = new Map(await Promise.all(ids.map(async id => [id, await stored(id)] as const)));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    const operations = await ServiceRelocation.find({ $or: [{ sourceOrganizationId: source.id }, { targetOrganizationId: target.id }] }).select('_id').lean();
    await ServiceRelocationStep.deleteMany({ operationId: { $in: operations.map(operation => operation._id) } });
    await ServiceRelocation.deleteMany({ _id: { $in: operations.map(operation => operation._id) } });
    for (const org of [source, target]) {
      await Contract.deleteMany({ organizationId: org.id }); await Pricing.deleteMany({ _organizationId: org.id });
      await Service.deleteMany({ organizationId: org.id }); await deleteTestOrganization(org.id!);
    }
    await deleteTestUser(owner.username);
  });
  afterAll(async () => { await shutdownApp(); });

  const expectComplete = async (consumptionBump = 0) => {
    expect(await Service.findById(serviceId).lean()).toMatchObject({ name: TO, organizationId: target.id });
    for (const id of singles) {
      const contract = await stored(id);
      expect(String(contract._id)).toBe(String(before.get(id)._id)); expect(contract.organizationId).toBe(target.id);
      for (const field of MAPS) {
        expect(contract[field][OLD]).toBeUndefined(); expect(contract[field][NEW]).toEqual(before.get(id)[field][OLD]);
      }
      expect(contract.billingPeriod).toEqual(before.get(id).billingPeriod); expect(contract.history).toEqual(before.get(id).history);
    }
    const remaining = await stored(mixed);
    expect(remaining.organizationId).toBe(source.id);
    for (const field of MAPS) { expect(remaining[field][OLD]).toBeUndefined(); expect(remaining[field][NEW]).toBeUndefined(); }
    expect(remaining.contractedServices.petclinic).toBe(before.get(mixed).contractedServices.petclinic);
    expect(remaining.usageLevels.petclinic.maxPets.consumed).toBe(before.get(mixed).usageLevels.petclinic.maxPets.consumed + consumptionBump);
    expect(remaining.billingPeriod).toEqual(before.get(mixed).billingPeriod); expect(remaining.history).toHaveLength(1);
    expect(remaining.history[0].contractedServices[OLD]).toBe('1_0');
    expect(await Pricing.countDocuments({ _id: { $in: pricingIds }, _serviceName: TO, _organizationId: target.id })).toBe(pricingIds.length);
    const operation: any = await ServiceRelocation.findOne({ serviceId }).lean();
    expect(operation.state).toBe('complete'); expect(operation.finishedAt).toBeInstanceOf(Date);
    const steps = await ServiceRelocationStep.find({ operationId: operation._id }).lean();
    expect(steps).toHaveLength(3); expect(steps.every(step => step.applied && step.effectsDone)).toBe(true);
    expect(await pending()).toBeNull();
    const listed = await request(app).get(`${baseUrl}/organizations/${target.id}/contracts`).set('x-api-key', owner.apiKey);
    expect(listed.status).toBe(200); expect(listed.body).toHaveLength(2);
    expect(JSON.stringify(listed.body)).not.toContain('serviceRelocationOperationId');
  };

  it('recovers after pricing reassignment persisted before its stage acknowledgement', async () => {
    const repository: any = container.resolve('pricingRepository'), original = repository.reassignToService.bind(repository);
    const fault = vi.spyOn(repository, 'reassignToService').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected failure after pricing reassignment');
    });
    const failed = await update(); expect(failed.status, JSON.stringify(failed.body)).toBe(500);
    expect((await pending()).stage).toBe('prepared');
    expect(await Pricing.countDocuments({ _id: { $in: pricingIds }, _organizationId: target.id })).toBe(pricingIds.length);
    expect((await Service.findById(serviceId).lean())?.organizationId).toBe(source.id); fault.mockRestore();
    await Contract.updateOne({ 'userContact.userId': mixed, organizationId: source.id }, { $inc: { 'usageLevels.petclinic.maxPets.consumed': 2 } });
    const resumed = await update(); expect(resumed.status, JSON.stringify(resumed.body)).toBe(200); await expectComplete(2);
  });

  it('recognizes a persisted second contract write and repeated recovery never duplicates history', async () => {
    const repository: any = container.resolve('contractRepository'); let writes = 0, interruptedId = '';
    const faults = ['removeServicesFromContract', 'renameOrMoveServiceInContract'].map(method => {
      const original = repository[method].bind(repository);
      return vi.spyOn(repository, method).mockImplementation(async (...args: any[]) => {
        const result = await original(...args);
        if (result && ++writes === 2) { interruptedId = String(args[0].id ?? args[0]._id); throw new Error('Injected failure after contract write'); }
        return result;
      });
    });
    expect((await update()).status).toBe(500);
    const operation = await pending();
    const step = await ServiceRelocationStep.findOne({ operationId: operation._id, contractId: interruptedId }).lean();
    expect(step?.applied).toBe(false);
    expect((await Contract.findById(interruptedId).select('+serviceRelocationOperationId').lean() as any).serviceRelocationOperationId).toBe(operation._id);
    for (const fault of faults) fault.mockRestore();
    const journal: any = container.resolve('serviceRelocationRepository'), original = journal.effectsDone.bind(journal);
    const fault = vi.spyOn(journal, 'effectsDone').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected failure after effect acknowledgement');
    });
    expect((await update()).status).toBe(500); fault.mockRestore();
    const resumed = await update(); expect(resumed.status, JSON.stringify(resumed.body)).toBe(200); await expectComplete();
  });

  it('repairs cache and replays events after Redis fails following a persisted contract write', async () => {
    const cache: any = container.resolve('cacheService'), original = cache.delMany.bind(cache);
    const event = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');
    for (const id of [...singles, mixed]) {
      await cache.set(contractCacheKey(source.id!, id), before.get(id), 3600, true);
      await cache.set(featuresCacheKey(source.id!, id, 'pricingToken'), 'old-source-token', 3600, true);
      await cache.set(featuresCacheKey(target.id!, id, 'pricingToken'), 'old-target-token', 3600, true);
    }
    let failedUser = '';
    const fault = vi.spyOn(cache, 'delMany').mockImplementation(async (...args: any[]) => {
      if (!failedUser && args[0].some((key: string) => key.startsWith('contracts.'))) {
        const operation = await pending();
        const step: any = await ServiceRelocationStep.findOne({ operationId: operation._id, applied: true, effectsDone: false }).lean();
        failedUser = step?.before.userContact.userId ?? 'none';
        throw new Error('Injected Redis failure after contract write');
      }
      return original(...args);
    });
    expect((await update()).status).toBe(500); expect([...singles, mixed]).toContain(failedUser);
    const operation = await pending();
    expect(await ServiceRelocationStep.findOne({ operationId: operation._id, 'before.userContact.userId': failedUser }).lean()).toMatchObject({ applied: true, effectsDone: false });
    expect(await cache.get(featuresCacheKey(source.id!, failedUser, 'pricingToken'))).toBe('old-source-token');
    fault.mockRestore(); event.mockClear();
    const resumed = await update(); expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(await cache.get(contractCacheKey(source.id!, failedUser))).toBeNull();
    expect(await cache.get(featuresCacheKey(source.id!, failedUser, 'pricingToken'))).toBeNull();
    expect(await cache.get(featuresCacheKey(target.id!, failedUser, 'pricingToken'))).toBeNull();
    expect((event.mock.calls as any[][]).filter(([, contract]) => contract.userContact.userId === failedUser).map(([code, contract]) => [code, contract.organizationId]))
      .toEqual(failedUser === mixed ? [['CONTRACT_NOVATED', source.id]] : [['CONTRACT_DELETED', source.id], ['CONTRACT_CREATED', target.id]]);
    await expectComplete();
  });

  it('recovers from the original route after the service metadata already moved', async () => {
    const repository: any = container.resolve('serviceRepository'), original = repository.update.bind(repository);
    const fault = vi.spyOn(repository, 'update').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected failure after service metadata write');
    });
    expect((await update()).status).toBe(500);
    expect(await Service.findById(serviceId).lean()).toMatchObject({ name: TO, organizationId: target.id });
    expect((await pending()).stage).toBe('contracts'); fault.mockRestore();
    const resumed = await update(); expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(JSON.stringify(resumed.body)).not.toContain('serviceRelocationOperationId'); await expectComplete();
  });

  it('rejects changed or omitted destinations, target-only retries and new bindings while pending', async () => {
    const repository: any = container.resolve('pricingRepository'), original = repository.reassignToService.bind(repository);
    const fault = vi.spyOn(repository, 'reassignToService').mockImplementationOnce(async (...args: any[]) => {
      await original(...args); throw new Error('Injected pending relocation');
    });
    expect((await update()).status).toBe(500); fault.mockRestore(); const operation = await pending();
    for (const response of [await update({ name: 'Different', organizationId: target.id }), await update({ name: TO }), await update({}, target.id!, TO)]) {
      expect(response.status, JSON.stringify(response.body)).toBe(409); expect(response.body.error).toContain('original');
    }
    const id = uuidv4();
    const created = await request(app).post(`${baseUrl}/organizations/${source.id}/contracts`).set('x-api-key', owner.apiKey).send({
      userContact: { userId: id, username: 'blocked-new-binding' }, contractedServices: { [OLD]: '1.0' }, subscriptionPlans: { [OLD]: 'GOLD' }, subscriptionAddOns: {},
    });
    expect(created.status).toBeGreaterThanOrEqual(400); expect(created.body.error).toContain('relocation');
    expect(await Contract.countDocuments({ 'userContact.userId': id })).toBe(0); expect((await pending())._id).toBe(operation._id);
    const sourceSphere = await request(app).post(`${baseUrl}/organizations/${target.id}/services`).set('x-api-key', owner.apiKey)
      .send({ source: 'sphere', permanentUrl: 'https://sphere.score.us.es/p/111111111111111111111111', policy: 'new_last' });
    expect(sourceSphere.status).toBeGreaterThanOrEqual(400); expect(sourceSphere.body.error).toContain('relocation');
    expect(await Service.countDocuments({ source: 'sphere', organizationId: target.id })).toBe(0);
    const resumed = await update(); expect(resumed.status, JSON.stringify(resumed.body)).toBe(200); await expectComplete();
  });
});
