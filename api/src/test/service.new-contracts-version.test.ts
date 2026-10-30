import mongoose from 'mongoose';
import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import {
  PETCLINIC_BASE_VERSION,
  addPetclinicVersion,
  archivePetclinicVersion,
  uploadPetclinicService,
  writePetclinicVariant,
} from './utils/services/petclinicVersions';

/**
 * The pricing version SPACE assigns to new contracts: the SPHERE policy target
 * for linked services, otherwise the service's `defaultVersion`, otherwise the
 * most recently created active version.
 */

describe('Pricing version for new contracts', function () {
  let app: Server;
  let owner: LeanUser;
  let evaluator: LeanUser;
  let organization: LeanOrganization;
  let otherOrganization: LeanOrganization;
  let allKey: string;
  let evaluationKey: string;
  let otherKey: string;
  let storedName: string;
  let serviceName: string;

  const newContracts = (key = evaluationKey, name = storedName) =>
    request(app).get(`${baseUrl}/services/${name}/pricings/new-contracts`).set('x-api-key', key);
  const setDefault = (defaultVersion: unknown, name = storedName) =>
    request(app).put(`${baseUrl}/services/${name}`).set('x-api-key', allKey).send({ defaultVersion });
  const createContract = (body: any) => {
    const userId = uuidv4();
    return request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', allKey)
      .send({ userContact: { userId, username: `u-${userId.slice(0, 8)}` }, ...body });
  };

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    owner = await createTestUser('USER');
    evaluator = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    otherOrganization = await createTestOrganization(owner.username);
    await addMemberToOrganization(organization.id!, { username: evaluator.username, role: 'EVALUATOR' });
    allKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    otherKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: allKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id!, { key: evaluationKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id!, { key: otherKey, scope: 'ALL' });

    storedName = (await uploadPetclinicService(app, allKey)).name;
    serviceName = storedName.toLowerCase();
    await addPetclinicVersion(app, allKey, storedName, '2.0', '2025-06-01');
    // Older than the base version: "latest" is by creation date, not by upload order.
    await addPetclinicVersion(app, allKey, storedName, '0.9', '2024-01-01');
  });

  afterEach(async function () {
    const orgs = [organization.id, otherOrganization.id];
    await ContractMongoose.deleteMany({ organizationId: { $in: orgs } });
    await PricingMongoose.deleteMany({ _organizationId: { $in: orgs } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: orgs } });
    await deleteTestOrganization(organization.id!);
    await deleteTestOrganization(otherOrganization.id!);
    await deleteTestUser(owner.username);
    await deleteTestUser(evaluator.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('GET /services/:serviceName/pricings/new-contracts', function () {
    it('falls back to the most recently created active version', async function () {
      const response = await newContracts();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        version: '2.0',
        source: 'latest-active',
        yamlUrl: `/api/v1/services/${storedName}/pricings/2.0?format=yaml`,
      });
    });

    it('breaks ties between versions created at the same time by version, deterministically', async function () {
      await addPetclinicVersion(app, allKey, storedName, '10.0', '2025-06-01');

      const response = await newContracts();

      expect(response.status).toBe(200);
      expect(response.body.version).toBe('10.0');
    });

    it('puts versions without a creation date after dated ones', async function () {
      await PricingMongoose.updateOne(
        { _organizationId: organization.id, version: '2_0' },
        { $unset: { createdAt: '' } },
        { strict: false }
      );

      const response = await newContracts();

      expect(response.status).toBe(200);
      expect(response.body.version).toBe(PETCLINIC_BASE_VERSION);
    });

    it('matches the service name exactly, not as a pattern or a prefix', async function () {
      const prefix = await newContracts(evaluationKey, storedName.slice(0, 4));
      const pattern = await newContracts(evaluationKey, `${storedName.slice(0, 3)}.*`);
      const otherCase = await newContracts(evaluationKey, storedName.toUpperCase());

      expect(prefix.status).toBe(404);
      expect(pattern.status).toBe(404);
      expect(otherCase.status).toBe(200);
    });

    it('returns a yamlUrl that serves the version', async function () {
      const { yamlUrl } = (await newContracts()).body;

      const yaml = await request(app).get(yamlUrl).set('x-api-key', evaluationKey);

      expect(yaml.status).toBe(200);
      expect(yaml.headers['content-type']).toBe('application/yaml; charset=utf-8');
    });

    it('uses the defaultVersion of the service', async function () {
      expect((await setDefault(PETCLINIC_BASE_VERSION)).status).toBe(200);

      const response = await newContracts();

      expect(response.body).toMatchObject({ version: PETCLINIC_BASE_VERSION, source: 'default' });
    });

    it('ignores archived versions for the fallback', async function () {
      await archivePetclinicVersion(app, allKey, storedName, '2.0');

      const response = await newContracts();

      expect(response.body).toMatchObject({ version: PETCLINIC_BASE_VERSION, source: 'latest-active' });
    });

    it('is reachable through the organization route, with an organization-scoped yamlUrl', async function () {
      const response = await request(app)
        .get(`${baseUrl}/organizations/${organization.id}/services/${storedName}/pricings/new-contracts`)
        .set('x-api-key', evaluator.apiKey);

      expect(response.status).toBe(200);
      expect(response.body.yamlUrl).toBe(
        `/api/v1/organizations/${organization.id}/services/${storedName}/pricings/2.0?format=yaml`
      );
      const yaml = await request(app).get(response.body.yamlUrl).set('x-api-key', evaluator.apiKey);
      expect(yaml.status).toBe(200);
    });

    it('answers 404 for a service of another organization and 401 without a key', async function () {
      const foreign = await newContracts(otherKey);
      const anonymous = await request(app).get(`${baseUrl}/services/${storedName}/pricings/new-contracts`);

      expect(foreign.status).toBe(404);
      expect(anonymous.status).toBe(401);
    });

    it('does not shadow the JSON pricing of a version', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${storedName}/pricings/2.0`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toBe(200);
      expect(response.body.version).toBe('2.0');
    });
  });

  describe('PUT /services/:serviceName { defaultVersion }', function () {
    it('stores it and shows it on the service', async function () {
      const response = await setDefault('0.9');
      const shown = await request(app).get(`${baseUrl}/services/${storedName}`).set('x-api-key', evaluationKey);

      expect(response.status).toBe(200);
      expect(response.body.defaultVersion).toBe('0.9');
      expect(shown.body.defaultVersion).toBe('0.9');
    });

    it('updates only the exact service when a prefix sibling was inserted first', async function () {
      const sibling = await ServiceMongoose.findOne({ name: storedName, organizationId: organization.id }).lean();
      const exactName = storedName.slice(0, 4);
      await ServiceMongoose.collection.insertOne({
        ...sibling!, _id: new mongoose.Types.ObjectId(), name: exactName,
      });
      const response = await setDefault('0.9', exactName);
      expect(response.status).toBe(200);
      const exact = await ServiceMongoose.findOne({ name: exactName, organizationId: organization.id }).lean();
      const untouched = await ServiceMongoose.findOne({ name: storedName, organizationId: organization.id }).lean();
      expect(exact?.defaultVersion).toBe('0.9');
      expect(untouched?.defaultVersion).toBeUndefined();
    });

    it('rejects versions that are not active', async function () {
      await archivePetclinicVersion(app, allKey, storedName, '0.9');

      const archived = await setDefault('0.9');
      const missing = await setDefault('7.7');
      const notString = await setDefault(7);

      expect(archived.status).toBe(400);
      expect(missing.status).toBe(400);
      expect(notString.status).toBe(422);
      expect((await newContracts()).body.source).toBe('latest-active');
    });

    it('is cleared with null', async function () {
      await setDefault('0.9');

      const response = await setDefault(null);

      expect(response.status).toBe(200);
      expect(response.body.defaultVersion).toBeUndefined();
      expect((await newContracts()).body).toMatchObject({ version: '2.0', source: 'latest-active' });
    });

    it('is cleared when the default version is archived', async function () {
      await setDefault('0.9');

      await archivePetclinicVersion(app, allKey, storedName, '0.9');

      const shown = await request(app).get(`${baseUrl}/services/${storedName}`).set('x-api-key', evaluationKey);
      expect(shown.body.defaultVersion).toBeUndefined();
      expect((await newContracts()).body.source).toBe('latest-active');
    });
  });

  describe('POST /contracts without a pricing version', function () {
    it('uses the version for new contracts when contractedServices omits the service', async function () {
      await setDefault('0.9');

      const omittedService = await createContract({
        contractedServices: {},
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: {},
      });
      const omittedField = await createContract({
        subscriptionPlans: { [serviceName]: 'BASIC' },
        subscriptionAddOns: {},
      });

      expect(omittedService.status).toBe(201);
      expect(omittedService.body.contractedServices[serviceName]).toBe('0.9');
      expect(omittedField.status).toBe(201);
      expect(omittedField.body.contractedServices[serviceName]).toBe('0.9');
    });

    it('falls back to the latest active version without a default', async function () {
      const response = await createContract({ subscriptionPlans: { [serviceName]: 'GOLD' }, subscriptionAddOns: {} });

      expect(response.status).toBe(201);
      expect(response.body.contractedServices[serviceName]).toBe('2.0');
    });

    it('keeps an explicit version', async function () {
      await setDefault('0.9');

      const response = await createContract({
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: {},
      });

      expect(response.status).toBe(201);
      expect(response.body.contractedServices[serviceName]).toBe(PETCLINIC_BASE_VERSION);
    });

    it('still reports unknown services', async function () {
      const response = await createContract({ subscriptionPlans: { ghost: 'GOLD' }, subscriptionAddOns: {} });

      expect(response.status).toBe(400);
      expect(response.body.errors[0]).toMatchObject({ code: 'VERSION_NOT_FOUND', service: 'ghost' });
    });
  });

  describe('service names when validating contracts', function () {
    const proName = 'PetclinicPro';
    const serviceService = () => container.resolve('serviceService');

    beforeEach(async function () {
      // A service whose name starts with the name of the petclinic service.
      const file = writePetclinicVariant('1.0', '2025-01-01', pricing => {
        pricing.saasName = proName;
      });
      await uploadPetclinicService(app, allKey, file);
    });

    it('does not let a name match another service it is a prefix of', async function () {
      const prefix = await serviceService().indexByNames([storedName.slice(0, 4)], organization.id!);
      const exact = await serviceService().indexByNames([serviceName], organization.id!);

      expect(prefix).toBeNull();
      expect(exact.map((s: any) => s.name)).toEqual([storedName]);
    });

    it('treats regular expression metacharacters as literal characters', async function () {
      const literalName = 'pet+(clinic).*';
      await ServiceMongoose.collection.insertOne({
        name: literalName, organizationId: organization.id, disabled: false, activePricings: {}, archivedPricings: {},
      });

      const pattern = await serviceService().indexByNames([`${storedName.slice(0, 3)}.*`], organization.id!);
      const literal = await serviceService().indexByNames([literalName.toUpperCase()], organization.id!);
      const invalidPattern = await serviceService().indexByNames(['pet('], organization.id!);

      expect(pattern).toBeNull();
      expect(literal.map((s: any) => s.name)).toEqual([literalName]);
      expect(invalidPattern).toBeNull();
    });

    it('still matches exact names written in another casing', async function () {
      const services = await serviceService().indexByNames(
        [storedName.toUpperCase(), proName.toLowerCase()],
        organization.id!
      );

      expect(services.map((s: any) => s.name).sort()).toEqual([proName, storedName].sort());
    });

    it('creates a contract for a service whose name is a prefix of another one', async function () {
      const response = await createContract({
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: {},
      });

      expect(response.status).toBe(201);
      expect(Object.keys(response.body.contractedServices)).toEqual([serviceName]);
    });

    it('creates a contract with several services', async function () {
      const pro = proName.toLowerCase();
      const response = await createContract({
        contractedServices: { [serviceName]: '2.0', [pro]: '1.0' },
        subscriptionPlans: { [serviceName]: 'GOLD', [pro]: 'BASIC' },
        subscriptionAddOns: {},
      });

      expect(response.status).toBe(201);
      expect(response.body.contractedServices).toEqual({ [serviceName]: '2.0', [pro]: '1.0' });
    });
  });

  describe('SPHERE-linked services', function () {
    const linkedName = 'linkedsvc';

    beforeEach(async function () {
      await ServiceMongoose.collection.insertOne({
        name: linkedName, organizationId: organization.id, source: 'sphere', disabled: false,
        activePricings: { '3_0': { id: new mongoose.Types.ObjectId() }, '2_0': { id: new mongoose.Types.ObjectId() } },
        archivedPricings: {},
        sphere: {
          permanentUrl: 'https://sphere.score.us.es/p/111111111111111111111111', pricingId: '111111111111111111111111',
          name: 'Linked', policy: 'new_last', revision: 1, status: 'ready',
          target: { versionId: '222222222222222222222222', version: '2.0', createdAt: '2025-01-01T00:00:00.000Z', contentHash: 'a'.repeat(64) },
        },
      });
    });

    it('reports the SPHERE policy target', async function () {
      const response = await newContracts(evaluationKey, linkedName);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        version: '2.0',
        source: 'sphere-policy',
        yamlUrl: `/api/v1/services/${linkedName}/pricings/2.0?format=yaml`,
      });
    });

    it.each([linkedName, linkedName.toUpperCase()])('does not accept a defaultVersion with service name %s', async function (name) {
      const response = await setDefault('3.0', name);

      expect(response.status).toBe(400);
    });
  });
});
