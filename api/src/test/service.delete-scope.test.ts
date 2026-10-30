import fs from 'fs';
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
import PricingMongoose from '../main/repositories/mongoose/models/PricingMongoose';
import { LEGACY_PRICINGS_PREFIX, PRIVATE_PRICINGS_PREFIX, legacyPublicYamlFile, pricingYamlFile, privateYamlPathFor } from '../main/services/pricingFiles';
import { PETCLINIC_BASE_VERSION, petclinicPricingPath, uploadPetclinicService, writePetclinicVariant } from './utils/services/petclinicVersions';

/**
 * Deleting and disabling services only ever touches the named service of the
 * caller's organization: names are matched exactly (case-insensitively, never
 * as a pattern), and the pricing documents and stored YAML files that go with
 * a deleted service are those of that service in that organization. Two
 * organizations may have services with the same name.
 */

const A = 'petclinic';

type Org = { owner: LeanUser; organization: LeanOrganization; key: string; userId: string };

describe('Deleting and disabling services: organization and exact name', function () {
  let app: Server;
  let one: Org;
  let two: Org;

  const variant = (saasName: string, version = '1.0') =>
    writePetclinicVariant(version, '2025-01-01', pricing => {
      pricing.saasName = saasName;
    });
  const upload = (org: Org, file: string) =>
    request(app).post(`${baseUrl}/services`).set('x-api-key', org.key).attach('pricing', file);
  const serviceOf = (org: Org, name: string) =>
    ServiceMongoose.findOne({ organizationId: org.organization.id, name }).lean() as any;
  const pricingsOf = (org: Org) =>
    PricingMongoose.find({ _organizationId: org.organization.id }).sort({ _id: 1 }).lean() as Promise<any[]>;
  const fileOf = (pricing: any) => pricingYamlFile(pricing.yamlPath)!;
  const contractOf = (org: Org) =>
    ContractMongoose.findOne({ organizationId: org.organization.id, 'userContact.userId': org.userId }).lean() as any;
  const evaluate = (org: Org) => request(app).post(`${baseUrl}/features/${org.userId}`).set('x-api-key', org.key);

  /** An organization with the stock Petclinic service and a contract on it. */
  const organizationWithPetclinic = async (): Promise<Org> => {
    const owner = await createTestUser('USER', `owner_${uuidv4()}`);
    const organization = await createTestOrganization(owner.username);
    const key = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key, scope: 'ALL' });
    await uploadPetclinicService(app, key);
    const userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', key)
      .send({
        userContact: { userId, username: `user-${userId.slice(0, 8)}` },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: { [A]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [A]: 'GOLD' },
        subscriptionAddOns: {},
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { owner, organization, key, userId };
  };

  /** What another organization has, to compare after the operation. */
  const snapshot = async (org: Org) => {
    const pricings = await pricingsOf(org);
    return {
      services: await ServiceMongoose.find({ organizationId: org.organization.id }).sort({ name: 1 }).lean(),
      pricings,
      files: pricings.map(pricing => fs.readFileSync(fileOf(pricing))),
      contract: await contractOf(org),
    };
  };
  const expectUnchanged = async (org: Org, before: Awaited<ReturnType<typeof snapshot>>) => {
    const after = await snapshot(org);
    expect(after.services).toEqual(before.services);
    expect(after.pricings).toEqual(before.pricings);
    after.files.forEach((bytes, i) => expect(bytes.equals(before.files[i])).toBe(true));
    expect(after.contract).toEqual(before.contract);
    const evaluation = await evaluate(org);
    expect(evaluation.status, JSON.stringify(evaluation.body)).toBe(200);
    expect(Object.keys(evaluation.body).length).toBeGreaterThan(0);
  };

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    one = await organizationWithPetclinic();
    two = await organizationWithPetclinic();
  });

  afterEach(async function () {
    vi.restoreAllMocks();
    for (const org of [one, two]) {
      for (const pricing of await pricingsOf(org)) {
        if (pricing.yamlPath) fs.rmSync(fileOf(pricing), { force: true });
      }
      await ContractMongoose.deleteMany({ organizationId: org.organization.id });
      await PricingMongoose.deleteMany({ _organizationId: org.organization.id });
      await ServiceMongoose.deleteMany({ organizationId: org.organization.id });
      await deleteTestOrganization(org.organization.id!);
      await deleteTestUser(org.owner.username);
    }
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('DELETE /services (prune)', function () {
    it('deletes the pricings and YAML files of the services it deletes, disabled ones included, and nothing of another organization', async function () {
      for (const org of [one, two]) expect((await upload(org, variant('Vetclinic'))).status).toBe(201);
      expect((await request(app).delete(`${baseUrl}/services/Vetclinic`).set('x-api-key', one.key)).status).toBe(204);
      const deleted = await pricingsOf(one);
      expect(deleted).toHaveLength(2);
      for (const pricing of deleted) expect(fs.existsSync(fileOf(pricing))).toBe(true);
      const other = await snapshot(two);

      const response = await request(app).delete(`${baseUrl}/services`).set('x-api-key', one.key);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(await ServiceMongoose.countDocuments({ organizationId: one.organization.id })).toBe(0);
      expect(await pricingsOf(one)).toEqual([]);
      for (const pricing of deleted) expect(fs.existsSync(fileOf(pricing))).toBe(false);
      await expectUnchanged(two, other);
    });

    it('lets the same pricing be uploaded again afterwards', async function () {
      expect((await request(app).delete(`${baseUrl}/services`).set('x-api-key', one.key)).status).toBe(200);

      const response = await upload(one, petclinicPricingPath);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const pricings = await request(app).get(`${baseUrl}/services/Petclinic/pricings`).set('x-api-key', one.key);
      expect(pricings.status).toBe(200);
      expect(pricings.body.map((pricing: any) => pricing.version)).toEqual([PETCLINIC_BASE_VERSION]);
      const [stored] = await pricingsOf(one);
      expect(fs.existsSync(fileOf(stored))).toBe(true);
    });

    it('as a platform ADMIN on the organization route: that organization only, its pricings included', async function () {
      const admin = await createTestUser('ADMIN', `admin_${uuidv4()}`);
      const other = await snapshot(two);
      try {
        const response = await request(app)
          .delete(`${baseUrl}/organizations/${one.organization.id}/services`)
          .set('x-api-key', admin.apiKey);

        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(await ServiceMongoose.countDocuments({ organizationId: one.organization.id })).toBe(0);
        expect(await pricingsOf(one)).toEqual([]);
        await expectUnchanged(two, other);
      } finally {
        await deleteTestUser(admin.username);
      }
    });

    it('global prune holds the organization lease until its services are deleted, preventing late contract bindings', async function () {
      const admin = await createTestUser('ADMIN', `admin_${uuidv4()}`);
      const newcomer = uuidv4();
      const repository: any = container.resolve('serviceRepository');
      const original = repository.destroyByIds.bind(repository);
      let attempted = false;
      const fault = vi.spyOn(repository, 'destroyByIds').mockImplementation(async (...args: any[]) => {
        if (!attempted && args[1] === one.organization.id) {
          attempted = true;
          // A separate HTTP request has its own lease context. Before the fix
          // this succeeds in the gap between contract cleanup and service deletion.
          const created = await request(app).post(`${baseUrl}/contracts`).set('x-api-key', one.key).send({
            userContact: { userId: newcomer, username: 'late-during-global-prune' },
            billingPeriod: { autoRenew: true, renewalDays: 30 },
            contractedServices: { [A]: PETCLINIC_BASE_VERSION },
            subscriptionPlans: { [A]: 'GOLD' }, subscriptionAddOns: {},
          });
          expect(created.status, JSON.stringify(created.body)).not.toBe(201);
          expect(created.body.error).toMatch(/busy|retry/i);
        }
        return original(...args);
      });
      try {
        const response = await request(app).delete(`${baseUrl}/services`).set('x-api-key', admin.apiKey);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(attempted).toBe(true);
        expect(await ContractMongoose.countDocuments({ 'userContact.userId': newcomer })).toBe(0);
        expect(await ServiceMongoose.countDocuments({ organizationId: { $in: [one.organization.id, two.organization.id] } })).toBe(0);
        expect((await contractOf(one)).contractedServices).toEqual({});
        expect((await contractOf(two)).contractedServices).toEqual({});
      } finally {
        fault.mockRestore();
        await deleteTestUser(admin.username);
      }
    }, 10000);

    it('deletes only the services it read, with their pricings', async function () {
      // A service created while the prune runs (after the services were read)
      // was not removed from contracts, so it is not deleted either.
      const serviceService = container.resolve('serviceService');
      const original = serviceService._removeServicesFromContracts.bind(serviceService);
      let late = false;
      vi.spyOn(serviceService, '_removeServicesFromContracts').mockImplementation(async (...args: any[]) => {
        if (!late) {
          late = true;
          // Reentrant internal writer under the held lease: a second HTTP
          // request would correctly wait for the prune's organization lock.
          expect((await serviceService.create({ path: variant('Latecomer') }, 'file', one.organization.id!)).name).toBe('Latecomer');
        }
        return (original as any)(...args);
      });

      expect((await request(app).delete(`${baseUrl}/services`).set('x-api-key', one.key)).status).toBe(200);

      expect(late).toBe(true);
      const remaining = await ServiceMongoose.find({ organizationId: one.organization.id }).lean();
      expect(remaining.map((service: any) => service.name)).toEqual(['Latecomer']);
      const pricings = await pricingsOf(one);
      expect(pricings.map(pricing => pricing._serviceName)).toEqual(['Latecomer']);
      expect(fs.existsSync(fileOf(pricings[0]))).toBe(true);
    });
  });

  describe('destroy (deleting one service)', function () {
    const destroy = (name: string, org: Org) => container.resolve('serviceService').destroy(name, org.organization.id!);

    it('deletes the pricings of that service in its organization only', async function () {
      expect((await upload(one, variant('Vetclinic'))).status).toBe(201);
      const [petclinicPricing] = (await pricingsOf(one)).filter(pricing => pricing._serviceName === 'Petclinic');
      const other = await snapshot(two);

      expect(await destroy('Petclinic', one)).toBeTruthy();

      await expectUnchanged(two, other);
      expect(await serviceOf(one, 'Petclinic')).toBeNull();
      expect((await pricingsOf(one)).map(pricing => pricing._serviceName)).toEqual(['Vetclinic']);
      expect(fs.existsSync(fileOf(petclinicPricing))).toBe(false);
    });

    it.each(['private', 'legacy'] as const)('keeps a file while another organization holds its %s alias', async reference => {
      const [own] = await pricingsOf(one), [other] = await pricingsOf(two);
      const orphanedOtherFile = fileOf(other);
      const privatePath = privateYamlPathFor(own.yamlPath);
      const legacyPath = LEGACY_PRICINGS_PREFIX + privatePath.slice(PRIVATE_PRICINGS_PREFIX.length);
      const sharedFile = pricingYamlFile(privatePath)!;
      await PricingMongoose.updateOne({ _id: own._id }, { $set: { yamlPath: reference === 'private' ? legacyPath : privatePath } });
      await PricingMongoose.updateOne({ _id: other._id }, { $set: { yamlPath: reference === 'private' ? privatePath : legacyPath } });
      try {
        expect(await destroy('Petclinic', one)).toBeTruthy();
        expect(fs.existsSync(sharedFile)).toBe(true);
        expect(await PricingMongoose.findById(other._id).lean()).not.toBeNull();
        expect(await destroy('Petclinic', two)).toBeTruthy();
        expect(fs.existsSync(sharedFile)).toBe(false);
      } finally { fs.rmSync(orphanedOtherFile, { force: true }); }
    });

    it('removes both protected storage and a legacy public copy when no pricing references either', async () => {
      const [own] = await pricingsOf(one);
      const privateFile = fileOf(own);
      const privatePath = privateYamlPathFor(own.yamlPath);
      const legacyPath = LEGACY_PRICINGS_PREFIX + privatePath.slice(PRIVATE_PRICINGS_PREFIX.length);
      const legacyFile = legacyPublicYamlFile(legacyPath)!;
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.copyFileSync(privateFile, legacyFile);
      await PricingMongoose.updateOne({ _id: own._id }, { $set: { yamlPath: legacyPath } });
      try {
        expect(await destroy('Petclinic', one)).toBeTruthy();
        expect(fs.existsSync(privateFile)).toBe(false);
        expect(fs.existsSync(legacyFile)).toBe(false);
      } finally { fs.rmSync(legacyFile, { force: true }); }
    });

    it('only accepts contained manual-pricing paths for file cleanup', () => {
      const service = container.resolve('serviceService');
      for (const unsafe of ['/etc/passwd', 'https://example.com/pricing.yaml', '/private/sphere/a/b.yaml', '/static/pricings/sphere/a/b.yaml',
        '/private/pricings//shared.yaml', '/private/pricings/../outside.yaml', '/private/pricings/a/../../outside.yaml', '/static/pricings/../outside.yaml',
        '/private/pricings/back\\slash.yaml', '/private/pricings/null\0.yaml']) {
        expect(service._isUploadedPricingYamlPath(unsafe), unsafe).toBe(false);
      }
      expect(service._isUploadedPricingYamlPath('/private/pricings/example.yaml')).toBe(true);
      expect(service._isUploadedPricingYamlPath('/static/pricings/example.yaml')).toBe(true);
    });

    it('deletes exactly the named service, not one it is a prefix of or matches as a pattern', async function () {
      for (const name of ['zoom-pro', 'zoom', 'zoomxpro', 'zoom.pro']) {
        expect((await upload(one, variant(name))).status).toBe(201);
      }

      await destroy('zoom', one);
      await destroy('zoom.pro', one);

      const names = (await ServiceMongoose.find({ organizationId: one.organization.id }).lean()).map((s: any) => s.name);
      expect(names.sort()).toEqual(['Petclinic', 'zoom-pro', 'zoomxpro']);
      const pricings = (await pricingsOf(one)).map(pricing => pricing._serviceName);
      expect(pricings.sort()).toEqual(['Petclinic', 'zoom-pro', 'zoomxpro']);
    });
  });

  describe('DELETE /services/{serviceName} (disable)', function () {
    const disable = (name: string, org: Org = one) =>
      request(app).delete(`${baseUrl}/services/${encodeURIComponent(name)}`).set('x-api-key', org.key);

    it('disables exactly the named service, not one whose name contains it', async function () {
      for (const name of ['a-zoom', 'zoom-pro', 'zoom']) {
        expect((await upload(one, variant(name))).status).toBe(201);
      }

      expect((await disable('zoom')).status).toBe(204);

      expect((await serviceOf(one, 'zoom')).disabled).toBe(true);
      for (const name of ['a-zoom', 'zoom-pro']) {
        const other = await serviceOf(one, name);
        expect(other.disabled).toBe(false);
        expect(Object.keys(other.activePricings)).toEqual(['1_0']);
      }
    });

    it('reads names with regular expression characters literally', async function () {
      expect((await upload(one, variant('zoomxpro'))).status).toBe(201);
      expect((await upload(one, variant('zoom.pro'))).status).toBe(201);
      expect((await upload(one, variant('zoom (beta)'))).status).toBe(201);

      expect((await disable('zoom.pro')).status).toBe(204);
      const beta = await disable('zoom (beta)');

      expect(beta.status, JSON.stringify(beta.body)).toBe(204);
      expect((await serviceOf(one, 'zoom.pro')).disabled).toBe(true);
      expect((await serviceOf(one, 'zoom (beta)')).disabled).toBe(true);
      expect((await serviceOf(one, 'zoomxpro')).disabled).toBe(false);
    });

    it('leaves the service with the same name of another organization alone', async function () {
      const other = await snapshot(two);

      expect((await disable('Petclinic')).status).toBe(204);

      expect((await serviceOf(one, 'Petclinic')).disabled).toBe(true);
      await expectUnchanged(two, other);
    });
  });

  describe('lists', function () {
    it('GET /services/{serviceName}/pricings lists the pricings of that service only', async function () {
      expect((await upload(one, variant('zoom-pro'))).status).toBe(201);
      expect((await upload(one, variant('zoom'))).status).toBe(201);

      const response = await request(app).get(`${baseUrl}/services/zoom/pricings`).set('x-api-key', one.key);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].version).toBe('1.0');
      const stored: any = await PricingMongoose.findOne({ _organizationId: one.organization.id, _serviceName: 'zoom' }).lean();
      expect(response.body[0].yamlPath).toBe(stored.yamlPath);
    });

    it('GET /services?name= matches the text literally', async function () {
      expect((await upload(one, variant('zoomxpro'))).status).toBe(201);
      expect((await upload(one, variant('zoom.pro'))).status).toBe(201);

      const dotted = await request(app).get(`${baseUrl}/services?name=zoom.pro`).set('x-api-key', one.key);
      const parenthesis = await request(app).get(`${baseUrl}/services?name=${encodeURIComponent('zoom(')}`).set('x-api-key', one.key);

      expect(dotted.status).toBe(200);
      expect(dotted.body.map((service: any) => service.name)).toEqual(['zoom.pro']);
      expect(parenthesis.status).toBe(200);
      expect(parenthesis.body).toEqual([]);
    });
  });

  describe('SPHERE-linked services', function () {
    const linkedName = 'linkedcase';

    const insertLinked = async (org: Org) => {
      const pricing = await PricingMongoose.create({
        _serviceName: linkedName, _organizationId: org.organization.id, version: '5_0', currency: 'USD', createdAt: new Date('2025-01-01'),
        features: { enabled: { name: 'enabled', valueType: 'BOOLEAN', defaultValue: true, type: 'DOMAIN' } },
        plans: { basic: { name: 'basic', price: 0, features: { enabled: true } } },
        sphere: { serviceId: 'pending' },
      });
      const inserted = await ServiceMongoose.collection.insertOne({
        name: linkedName, organizationId: org.organization.id, source: 'sphere', disabled: false,
        activePricings: { '5_0': { id: pricing._id } }, archivedPricings: {},
        sphere: { permanentUrl: 'https://sphere.score.us.es/p/111111111111111111111111', pricingId: '111111111111111111111111',
          name: 'Linked', policy: 'all_last', revision: 1, status: 'ready',
          target: { versionId: '222222222222222222222222', version: '5.0', createdAt: '2025-01-01T00:00:00.000Z', contentHash: 'a'.repeat(64) } },
      } as any);
      await PricingMongoose.updateOne({ _id: pricing._id }, { $set: { 'sphere.serviceId': String(inserted.insertedId) } });
      await ContractMongoose.updateOne(
        { organizationId: org.organization.id, 'userContact.userId': org.userId },
        { $set: { [`contractedServices.${linkedName}`]: '5_0', [`subscriptionPlans.${linkedName}`]: 'basic', [`subscriptionAddOns.${linkedName}`]: {} } }
      );
    };

    it('includes linked services in the prune count', async function () {
      await insertLinked(one);
      const response = await request(app).delete(`${baseUrl}/services`).set('x-api-key', one.key);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.message).toBe('Pruned 2 services');
      expect(await ServiceMongoose.countDocuments({ organizationId: one.organization.id })).toBe(0);
      expect(await serviceOf(two, 'Petclinic')).not.toBeNull();
    });

    it('pause through the SPHERE path and retain contracts whatever the casing of the URL name', async function () {
      await insertLinked(one);
      const before = await contractOf(one);
      const snapshots = await pricingsOf(one);

      const response = await request(app).delete(`${baseUrl}/services/LINKEDCASE`).set('x-api-key', one.key);

      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect((await serviceOf(one, linkedName)).disabled).toBe(true);
      expect(await contractOf(one)).toEqual(before);
      expect(await pricingsOf(one)).toEqual(snapshots);
    });

    it.each([false, true])('refuses a manual upload through a case alias of a SPHERE service (paused=%s)', async paused => {
      await insertLinked(one);
      if (paused) expect((await request(app).delete(`${baseUrl}/services/LINKEDCASE`).set('x-api-key', one.key)).status).toBe(204);
      const before = await serviceOf(one, linkedName), contract = await contractOf(one), pricings = await pricingsOf(one);
      const file = variant('LINKEDCASE', '6.0');
      const response = paused
        ? await upload(one, file)
        : await request(app).post(`${baseUrl}/services/LINKEDCASE/pricings`).set('x-api-key', one.key).attach('pricing', file);
      expect(response.status).toBe(400);
      expect(response.body.error).toContain('SPHERE');
      expect(await serviceOf(one, linkedName)).toEqual(before);
      expect(await contractOf(one)).toEqual(contract);
      expect(await pricingsOf(one)).toEqual(pricings);
    });

    it('cannot be renamed through another casing of the name in the URL', async function () {
      await insertLinked(one);

      const response = await request(app)
        .put(`${baseUrl}/services/LINKEDCASE`)
        .set('x-api-key', one.key)
        .send({ name: 'renamed' });

      expect(response.status).not.toBe(200);
      expect(response.body.error).toContain('SPHERE');
      expect(await serviceOf(one, linkedName)).not.toBeNull();
    });
  });
});
