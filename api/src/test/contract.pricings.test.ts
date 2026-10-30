import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
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
import {
  PETCLINIC_BASE_VERSION,
  addPetclinicVersion,
  archivePetclinicVersion,
  uploadPetclinicService,
} from './utils/services/petclinicVersions';

/**
 * GET /contracts/{userId}/pricings: for each contracted service, the version of
 * the contract, its status, where to get its Pricing2Yaml, the version new
 * contracts would get, and the subscription; plus the contractVersion.
 */

describe('Pricing versions of a contract', function () {
  let app: Server;
  let owner: LeanUser;
  let outsider: LeanUser;
  let organization: LeanOrganization;
  let otherOrganization: LeanOrganization;
  let allKey: string;
  let managementKey: string;
  let evaluationKey: string;
  let otherKey: string;
  let storedName: string;
  let serviceName: string;
  let userId: string;

  const pricingsOf = (id = userId, key = allKey) =>
    request(app).get(`${baseUrl}/contracts/${id}/pricings`).set('x-api-key', key);

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    owner = await createTestUser('USER');
    outsider = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    otherOrganization = await createTestOrganization(outsider.username);
    allKey = generateOrganizationApiKey();
    managementKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    otherKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: allKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id!, { key: managementKey, scope: 'MANAGEMENT' });
    await addApiKeyToOrganization(organization.id!, { key: evaluationKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id!, { key: otherKey, scope: 'ALL' });

    storedName = (await uploadPetclinicService(app, allKey)).name;
    serviceName = storedName.toLowerCase();
    await addPetclinicVersion(app, allKey, storedName, '2.0.1', '2025-06-01');

    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', allKey)
      .send({
        userContact: { userId, username: 'pricings-user' },
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'GOLD' },
        subscriptionAddOns: { [serviceName]: { extraPets: 2 } },
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  afterEach(async function () {
    const orgs = [organization.id, otherOrganization.id];
    await ContractMongoose.deleteMany({ organizationId: { $in: orgs } });
    await PricingMongoose.deleteMany({ _organizationId: { $in: orgs } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: orgs } });
    await deleteTestOrganization(organization.id!);
    await deleteTestOrganization(otherOrganization.id!);
    await deleteTestUser(owner.username);
    await deleteTestUser(outsider.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  it('describes every contracted service and the contract version', async function () {
    const response = await pricingsOf();
    const contract = await request(app).get(`${baseUrl}/contracts/${userId}`).set('x-api-key', allKey);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      services: {
        [serviceName]: {
          version: PETCLINIC_BASE_VERSION,
          status: 'active',
          yamlUrl: `/api/v1/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}?format=yaml`,
          newContractsVersion: '2.0.1',
          plan: 'GOLD',
          addOns: { extraPets: 2 },
        },
      },
      contractVersion: contract.body.contractVersion,
    });
    expect(response.headers.etag).toBe(`"${contract.body.contractVersion}"`);
  });

  it('serves the YAML of the contracted version at yamlUrl', async function () {
    const { yamlUrl } = (await pricingsOf()).body.services[serviceName];

    const yaml = await request(app).get(yamlUrl).set('x-api-key', allKey);

    expect(yaml.status).toBe(200);
    expect(yaml.headers['content-type']).toBe('application/yaml; charset=utf-8');
  });

  it('unescapes dotted versions and reports archived ones', async function () {
    await request(app)
      .put(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', allKey)
      .send({
        contractedServices: { [serviceName]: '2.0.1' },
        subscriptionPlans: { [serviceName]: 'PLATINUM' },
        subscriptionAddOns: {},
      });
    await addPetclinicVersion(app, allKey, storedName, '3.0', '2025-09-01');
    // Keep the contract on 2.0.1 after archiving (archiving novates contracts to the latest version).
    await archivePetclinicVersion(app, allKey, storedName, '2.0.1');
    await ContractMongoose.updateOne(
      { 'userContact.userId': userId },
      { $set: { [`contractedServices.${serviceName}`]: '2_0_1' } }
    );
    const cacheService = (await import('../main/config/container')).default.resolve('cacheService');
    await cacheService.del(contractCacheKey(organization.id!, userId));

    const entry = (await pricingsOf()).body.services[serviceName];

    expect(entry.version).toBe('2.0.1');
    expect(entry.status).toBe('archived');
    expect(entry.yamlUrl).toBe(`/api/v1/services/${storedName}/pricings/2.0.1?format=yaml`);
    expect(entry.newContractsVersion).toBe('3.0');
    expect(entry.addOns).toEqual({});
  });

  it('honours the service defaultVersion for newContractsVersion', async function () {
    await request(app).put(`${baseUrl}/services/${storedName}`).set('x-api-key', allKey).send({ defaultVersion: PETCLINIC_BASE_VERSION });

    const entry = (await pricingsOf()).body.services[serviceName];

    expect(entry.newContractsVersion).toBe(PETCLINIC_BASE_VERSION);
  });

  it('reports newContractsVersion null only when it cannot be determined, not on failures', async function () {
    const serviceService = container.resolve('serviceService');
    const spy = vi.spyOn(serviceService, 'newContractsPricing');
    try {
      spy.mockRejectedValueOnce(new Error('NOT FOUND: No active pricing version for service x'));
      const unknown = await pricingsOf();
      spy.mockRejectedValueOnce(new Error('connection to the database lost'));
      const failure = await pricingsOf();

      expect(unknown.status).toBe(200);
      expect(Object.values(unknown.body.services).map((entry: any) => entry.newContractsVersion)).toEqual([null]);
      expect(failure.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });

  it('changes contractVersion after a novation', async function () {
    const before = (await pricingsOf()).body.contractVersion;
    await request(app)
      .put(`${baseUrl}/contracts/${userId}`)
      .set('x-api-key', allKey)
      .send({
        contractedServices: { [serviceName]: PETCLINIC_BASE_VERSION },
        subscriptionPlans: { [serviceName]: 'PLATINUM' },
        subscriptionAddOns: {},
      });

    const after = (await pricingsOf()).body;

    expect(after.contractVersion).not.toBe(before);
    expect(after.services[serviceName].plan).toBe('PLATINUM');
  });

  it('is available on the organization route with organization-scoped yamlUrl', async function () {
    const response = await request(app)
      .get(`${baseUrl}/organizations/${organization.id}/contracts/${userId}/pricings`)
      .set('x-api-key', owner.apiKey);

    expect(response.status).toBe(200);
    expect(response.body.services[serviceName].yamlUrl).toBe(
      `/api/v1/organizations/${organization.id}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}?format=yaml`
    );
  });

  it('has the same authorization and organization scoping as GET /contracts/{userId}', async function () {
    const management = await pricingsOf(userId, managementKey);
    const evaluation = await pricingsOf(userId, evaluationKey);
    const foreign = await pricingsOf(userId, otherKey);
    const foreignUser = await request(app)
      .get(`${baseUrl}/organizations/${otherOrganization.id}/contracts/${userId}/pricings`)
      .set('x-api-key', outsider.apiKey);
    const nonMember = await request(app)
      .get(`${baseUrl}/organizations/${organization.id}/contracts/${userId}/pricings`)
      .set('x-api-key', outsider.apiKey);
    const unknown = await pricingsOf(uuidv4());
    const anonymous = await request(app).get(`${baseUrl}/contracts/${userId}/pricings`);

    expect(management.status).toBe(200);
    expect(evaluation.status).toBe(403);
    expect(foreign.status).toBe(404);
    expect(foreignUser.status).toBe(404);
    expect(nonMember.status).toBe(403);
    expect(unknown.status).toBe(404);
    expect(anonymous.status).toBe(401);
  });
});
