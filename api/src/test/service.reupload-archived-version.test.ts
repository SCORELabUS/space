import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { Server } from 'http';
import nock from 'nock';
import yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { pricingYamlFile } from '../main/services/pricingFiles';
import { contractCacheKey } from '../main/utils/contracts/cacheKeys';
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
import { PETCLINIC_BASE_VERSION, uploadPetclinicService, writePetclinicVariant } from './utils/services/petclinicVersions';

/**
 * Uploading a pricing version that the service already has archived (also
 * when a disabled service is enabled again with the version its contracts
 * use): the archived version is active again when the upload has the same
 * content as the stored one, and the upload is refused with 409 when it does
 * not. It never fails with a duplicate key error.
 */

const A = 'petclinic';
const B = 'vetclinic';

describe('Uploading a pricing version the service has archived', function () {
  let app: Server;
  let owner: LeanUser;
  let organization: LeanOrganization;
  let orgKey: string;
  let userId: string;

  const vetclinicFile = (version = '1.0', mutate: (pricing: any) => void = () => {}) =>
    writePetclinicVariant(version, '2025-01-01', pricing => {
      pricing.saasName = 'Vetclinic';
      mutate(pricing);
    });
  const vetclinic1 = () => vetclinicFile('1.0');
  const changed1 = () => vetclinicFile('1.0', pricing => {
    pricing.plans.GOLD.price = 99;
  });

  const stored = async (id = userId) =>
    ContractMongoose.findOne({ organizationId: organization.id, 'userContact.userId': id }).lean() as any;
  const service = async () =>
    ServiceMongoose.findOne({ organizationId: organization.id, name: 'Vetclinic' }).lean() as any;
  const pricingDocs = () => PricingMongoose.find({ _organizationId: organization.id, _serviceName: 'Vetclinic' }).lean();
  const yamlFileOf = async (version = '1_0') => {
    const pricing: any = await PricingMongoose.findOne({ _organizationId: organization.id, _serviceName: 'Vetclinic', version }).lean();
    return pricingYamlFile(pricing.yamlPath)!;
  };
  const disable = () => request(app).delete(`${baseUrl}/services/Vetclinic`).set('x-api-key', orgKey);
  const upload = (file: string) => request(app).post(`${baseUrl}/services`).set('x-api-key', orgKey).attach('pricing', file);
  const addVersion = (file: string) =>
    request(app).post(`${baseUrl}/services/Vetclinic/pricings`).set('x-api-key', orgKey).attach('pricing', file);
  const evaluateFeature = (featureId: string, id = userId) =>
    request(app).post(`${baseUrl}/features/${id}/${featureId}`).set('x-api-key', orgKey);

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    owner = await createTestUser('USER', `owner_${uuidv4()}`);
    organization = await createTestOrganization(owner.username);
    orgKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: orgKey, scope: 'ALL' });
    await uploadPetclinicService(app, orgKey);
    await uploadPetclinicService(app, orgKey, vetclinic1());

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', orgKey)
      .send({
        userContact: { userId, username: 'two-services' },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: { [A]: PETCLINIC_BASE_VERSION, [B]: '1.0' },
        subscriptionPlans: { [A]: 'GOLD', [B]: 'GOLD' },
        subscriptionAddOns: { [B]: { extraPets: 2 } },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  afterEach(async function () {
    vi.restoreAllMocks();
    nock.cleanAll();
    await ContractMongoose.deleteMany({ organizationId: organization.id });
    await PricingMongoose.deleteMany({ _organizationId: organization.id });
    await ServiceMongoose.deleteMany({ organizationId: organization.id });
    await deleteTestOrganization(organization.id!);
    await deleteTestUser(owner.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('conflicts preserve stored YAML bytes', function () {
    it('rejects an orphaned pricing row before replacing its YAML', async function () {
      const file = await yamlFileOf(); const bytes = fs.readFileSync(file);
      await ServiceMongoose.updateOne({ organizationId: organization.id, name: 'Vetclinic' }, { $unset: { 'activePricings.1_0': '' } });
      await container.resolve('cacheService').del(`service.${organization.id}.Vetclinic`);
      const before = await service();
      const response = await addVersion(changed1());
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error).toContain('stored pricing');
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect(await service()).toEqual(before);
      expect(await pricingDocs()).toHaveLength(1);
    });

    it('does not replace an existing unreferenced file when importing a new version', async function () {
      const sync = container.resolve('serviceService');
      const file = pricingYamlFile(sync._buildPricingYamlRelativePath(organization.id!, 'Vetclinic', '2.0'))!;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const bytes = Buffer.from('Existing bytes from an interrupted import'); fs.writeFileSync(file, bytes);
      const before = await service();
      try {
        const response = await addVersion(vetclinicFile('2.0'));
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(response.body.error).toContain('not replaced');
        expect(fs.readFileSync(file).equals(bytes)).toBe(true);
        expect(await service()).toEqual(before);
        expect(await pricingDocs()).toHaveLength(1);
      } finally { fs.rmSync(file, { force: true }); }
    });
  });

  describe('enabling a disabled service again', function () {
    it('with the version its contracts use: that version is active again and the contracts work as before', async function () {
      expect((await addVersion(vetclinicFile('2.0'))).status).toBe(201);
      const onTwo = uuidv4();
      expect(
        (
          await request(app)
            .post(`${baseUrl}/contracts`)
            .set('x-api-key', orgKey)
            .send({
              userContact: { userId: onTwo, username: 'on-two' },
              billingPeriod: { autoRenew: true, renewalDays: 30 },
              contractedServices: { [B]: '2.0' },
              subscriptionPlans: { [B]: 'GOLD' },
              subscriptionAddOns: {},
            })
        ).status
      ).toBe(201);
      await ContractMongoose.updateOne(
        { organizationId: organization.id, 'userContact.userId': userId },
        { $set: { [`usageLevels.${B}.maxPets.consumed`]: 3 } }
      );
      await container.resolve('cacheService').del(contractCacheKey(organization.id!, userId));
      const before = (await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', orgKey)).body;
      const pricingId = String((await service()).activePricings['1_0'].id);
      expect((await disable()).status).toBe(204);
      const events = vi.spyOn(container.resolve('eventService'), 'emitPricingActivedMessage');

      const response = await upload(vetclinic1());

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const enabled = await service();
      expect(enabled.disabled).toBe(false);
      expect(Object.keys(enabled.activePricings)).toEqual(['1_0']);
      expect(String(enabled.activePricings['1_0'].id)).toBe(pricingId);
      expect(Object.keys(enabled.archivedPricings ?? {})).toEqual(['2_0']);
      expect(await pricingDocs()).toHaveLength(2);
      expect(events).toHaveBeenCalledWith('Vetclinic', '1.0');

      const feature = await evaluateFeature(`${B}-vetSelection`);
      expect(feature.status, JSON.stringify(feature.body)).toBe(200);
      expect(feature.body.eval).toBe(true);
      expect(feature.body.error).toBeNull();
      expect((await evaluateFeature(`${B}-vetSelection`, onTwo)).body.eval).toBe(true);
      const after = (await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', orgKey)).body;
      expect(after.contractVersion).toBe(before.contractVersion);
      expect(after.usageLevels[B].maxPets.consumed).toBe(3);
      const pricings = await request(app).get(`${baseUrl}/contracts/${userId}/pricings`).set('x-api-key', orgKey);
      expect(pricings.body.services[B].status).toBe('active');
      expect(pricings.body.services[B].serviceStatus).toBe('enabled');
    });

    it('with that version but other content: 409, and nothing changes (the stored file neither)', async function () {
      const file = await yamlFileOf();
      const bytes = fs.readFileSync(file);
      expect((await disable()).status).toBe(204);
      const disabled = await service();

      const response = await upload(changed1());

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body.error).toContain('1.0');
      expect(await service()).toEqual(disabled);
      expect(await pricingDocs()).toHaveLength(1);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
      expect((await evaluateFeature(`${B}-vetSelection`)).body.error.code).toBe('SERVICE_DISABLED');
    });

    it('from a URL with the version its contracts use', async function () {
      const text = fs.readFileSync(vetclinicFile('3.0'), 'utf8');
      nock('https://pricings.example.com').persist().get('/vetclinic-3.yaml').reply(200, text);
      const url = 'https://pricings.example.com/vetclinic-3.yaml';
      expect((await request(app).post(`${baseUrl}/services/Vetclinic/pricings`).set('x-api-key', orgKey).send({ pricing: url })).status).toBe(201);
      await request(app)
        .put(`${baseUrl}/contracts/${userId}`)
        .set('x-api-key', orgKey)
        .send({
          contractedServices: { [A]: PETCLINIC_BASE_VERSION, [B]: '3.0' },
          subscriptionPlans: { [A]: 'GOLD', [B]: 'GOLD' },
          subscriptionAddOns: {},
        });
      expect((await stored()).contractedServices[B]).toBe('3_0');
      expect((await disable()).status).toBe(204);

      const response = await request(app).post(`${baseUrl}/services`).set('x-api-key', orgKey).send({ pricing: url });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const enabled = await service();
      expect(enabled.disabled).toBe(false);
      expect(enabled.activePricings['3_0'].url).toBe(url);
      expect(enabled.activePricings['3_0'].id).toBeUndefined();
      expect(Object.keys(enabled.archivedPricings ?? {}).sort()).toEqual(['1_0']);
      expect((await evaluateFeature(`${B}-vetSelection`)).body.eval).toBe(true);
    });
  });

  describe('adding a version to an enabled service', function () {
    beforeEach(async function () {
      expect((await addVersion(vetclinicFile('2.0'))).status).toBe(201);
      const archived = await request(app)
        .put(`${baseUrl}/services/Vetclinic/pricings/1.0?availability=archived`)
        .set('x-api-key', orgKey)
        .send({ subscriptionPlan: 'GOLD', subscriptionAddOns: {} });
      expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    });

    it('with the same content as the archived version: it is active again', async function () {
      const pricingId = String((await service()).archivedPricings['1_0'].id);

      const response = await addVersion(vetclinic1());

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const updated = await service();
      expect(Object.keys(updated.activePricings).sort()).toEqual(['1_0', '2_0']);
      expect(String(updated.activePricings['1_0'].id)).toBe(pricingId);
      expect(Object.keys(updated.archivedPricings ?? {})).toEqual([]);
      expect(await pricingDocs()).toHaveLength(2);
      const versions = await request(app).get(`${baseUrl}/services/Vetclinic/pricings?pricingStatus=active`).set('x-api-key', orgKey);
      expect(versions.body.map((pricing: any) => pricing.version).sort()).toEqual(['1.0', '2.0']);
    });

    it('with other content: 409, and the archived version stays as it is', async function () {
      const file = await yamlFileOf();
      const bytes = fs.readFileSync(file);
      const before = await service();

      const response = await addVersion(changed1());

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await service()).toEqual(before);
      expect(await pricingDocs()).toHaveLength(2);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    });

    it.each(['feature', 'add-on'])('does not ignore a legitimate %s named _id when comparing archived content', async function (kind) {
      const file = await yamlFileOf();
      const bytes = fs.readFileSync(file);
      const before = await service();
      const changed = vetclinicFile('1.0', pricing => {
        if (kind === 'feature') {
          pricing.features._id = {
            valueType: 'BOOLEAN', defaultValue: true, type: 'DOMAIN',
          };
          pricing.plans.GOLD.features._id = false;
        } else {
          pricing.addOns._id = { ...pricing.addOns.extraPets, price: 7 };
        }
      });

      const response = await addVersion(changed);

      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(await service()).toEqual(before);
      expect(await pricingDocs()).toHaveLength(2);
      expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    });

    it('compares content, not formatting: the same pricing written differently is the same version', async function () {
      const reformatted = path.resolve(path.dirname(vetclinic1()), `reformatted-${uuidv4()}.yaml`);
      const pricing: any = yaml.load(fs.readFileSync(vetclinic1(), 'utf8'));
      fs.writeFileSync(reformatted, `# same pricing, other layout\n${yaml.dump(pricing, { indent: 4, sortKeys: true })}`, 'utf8');

      const response = await addVersion(reformatted);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(Object.keys((await service()).activePricings).sort()).toEqual(['1_0', '2_0']);
    });
  });
});
