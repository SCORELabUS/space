import { Server } from 'http';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import {
  createTestOrganization,
  deleteTestOrganization,
  addApiKeyToOrganization,
} from './utils/organization/organizationTestUtils';
import { createTestService, deleteTestService, getPricingFromService } from './utils/services/serviceTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { LeanUser } from '../main/types/models/User';
import { LeanOrganization } from '../main/types/models/Organization';
import { LeanService } from '../main/types/models/Service';
import { LeanContract } from '../main/types/models/Contract';
import { generateContract } from './utils/contracts/generators';
import { createTestContract } from './utils/contracts/contractTestUtils';
import ContractMongoose from '../main/repositories/mongoose/models/ContractMongoose';

describe('Contract API routes', function () {
  let app: Server;
  let adminUser: LeanUser;
  let ownerUser: LeanUser;
  let testOrganization: LeanOrganization;
  let testService: LeanService;
  let testOrgApiKey: string;
  let testContract: LeanContract;
  const contractsToCleanup: Set<string> = new Set();

  const trackContractForCleanup = (contract?: any) => {
    if (contract?.userContact?.userId) {
      contractsToCleanup.add(contract.userContact.userId);
    }
  };

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    adminUser = await createTestUser('ADMIN');
    ownerUser = await createTestUser('USER');
    testOrganization = await createTestOrganization(ownerUser.username);
    testService = await createTestService(testOrganization.id);
    testOrgApiKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(testOrganization.id!, { key: testOrgApiKey, scope: 'ALL' });

    testContract = await createTestContract(testOrganization.id!, [testService], app);
    trackContractForCleanup(testContract);
  });

  afterEach(async function () {
    for (const userId of contractsToCleanup) {
      await ContractMongoose.deleteOne({ 'userContact.userId': userId });
    }
    contractsToCleanup.clear();

    if (testService?.id) {
      await deleteTestService(testService.name, testOrganization.id!);
    }
    if (testOrganization?.id) {
      await deleteTestOrganization(testOrganization.id);
    }
    if (adminUser?.username) {
      await deleteTestUser(adminUser.username);
    }
    if (ownerUser?.username) {
      await deleteTestUser(ownerUser.username);
    }
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('GET /contracts', function () {
    it('returns 200 and list of contracts with org API key', async function () {
      const response = await request(app)
        .get(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.some((c: LeanContract) => c.userContact.userId === testContract.userContact.userId)).toBe(true);
    });

    it('returns 200 and filters contracts by username query parameter', async function () {
      const response = await request(app)
        .get(`${baseUrl}/contracts?username=${testContract.userContact.username}`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0].userContact.username).toBe(testContract.userContact.username);
    });

    it('returns 200 and filters contracts by groupId within the request organization only', async function () {
      const sharedGroupId = `shared-group-${Date.now()}`;

      const orgContract = await createTestContract(testOrganization.id!, [testService], app, sharedGroupId);
      trackContractForCleanup(orgContract);

      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(
        foreignOrganization.id!,
        [foreignService],
        app,
        sharedGroupId
      );
      trackContractForCleanup(foreignContract);

      const response = await request(app)
        .get(`${baseUrl}/contracts?groupId=${sharedGroupId}`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.every((c: LeanContract) => c.groupId === sharedGroupId)).toBe(true);
      expect(response.body.every((c: LeanContract) => c.organizationId === testOrganization.id)).toBe(true);
      expect(
        response.body.some((c: LeanContract) => c.userContact.userId === orgContract.userContact.userId)
      ).toBe(true);
      expect(
        response.body.some((c: LeanContract) => c.userContact.userId === foreignContract.userContact.userId)
      ).toBe(false);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).get(`${baseUrl}/contracts`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });

    it('returns 200 and ADMIN user can list contracts from any organization', async function () {
      const response = await request(app)
        .get(`${baseUrl}/contracts`)
        .set('x-api-key', adminUser.apiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(
        response.body.some((c: LeanContract) => c.userContact.userId === testContract.userContact.userId)
      ).toBe(true);
    });
  });

  describe('GET /organizations/:organizationId/contracts', function () {
    it('returns 200 and contracts for specific organization with ADMIN user API key', async function () {
      const response = await request(app)
        .get(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', adminUser.apiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.some((c: LeanContract) => c.userContact.userId === testContract.userContact.userId)).toBe(true);
      expect(response.body.every((c: LeanContract) => c.organizationId === testOrganization.id)).toBe(true);
    });
    
    it('returns 200 and contracts for specific organization with USER user API key', async function () {
      const response = await request(app)
        .get(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.some((c: LeanContract) => c.userContact.userId === testContract.userContact.userId)).toBe(true);
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).get(
        `${baseUrl}/organizations/${testOrganization.id}/contracts`
      );

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });

    it('returns 403 when non-ADMIN user tries to list contracts from another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);

      const response = await request(app)
        .get(`${baseUrl}/organizations/${foreignOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(403);

      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 200 when ADMIN user lists contracts from another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(foreignOrganization.id!, [foreignService], app);
      trackContractForCleanup(foreignContract);

      const response = await request(app)
        .get(`${baseUrl}/organizations/${foreignOrganization.id}/contracts`)
        .set('x-api-key', adminUser.apiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(
        response.body.some((c: LeanContract) => c.userContact.userId === foreignContract.userContact.userId)
      ).toBe(true);
      expect(response.body.every((c: LeanContract) => c.organizationId === foreignOrganization.id)).toBe(true);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });
  });

  describe('POST /contracts', function () {
    it('returns 201 when creating a contract with org API key', async function () {
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send(contractData);

      expect(response.status).toBe(201);
      expect(response.body.userContact.userId).toBe(contractData.userContact.userId);
      expect(response.body.organizationId).toBe(testOrganization.id);
      trackContractForCleanup(response.body);
    });

    it('returns 409 when creating a duplicate contract for the same userId', async function () {
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );

      const first = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send(contractData);
      trackContractForCleanup(first.body);

      const response = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send(contractData);

      expect(response.status).toBe(409);
      expect(response.body.error).toBeDefined();
    });
    
    it('returns 403 when trying to create a contract for a different organization', async function () {
      const otherOrg = await createTestOrganization(ownerUser.username);
      
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        otherOrg.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send(contractData);

      expect(response.status).toBe(403);
      expect(response.body.error).toBeDefined();
    });

    it('returns 400 when creating a contract with non-existent service', async function () {
      const contractData = await generateContract(
        { 'non-existent-service': '1.0.0' },
        testOrganization.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send(contractData);

      expect(response.status).toBe(400);
      expect(response.body.error).toBeDefined();
    });

    it('returns 400 when creating a contract with invalid service version', async function () {
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: '99.99.99' },
        testOrganization.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send(contractData);

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid');
    });

    it('returns 422 when userContact.userId is empty', async function () {
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        '',
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send(contractData);

      expect(response.status).toBe(422);
      expect(response.body.error).toBeDefined();
    });

    it('returns 401 when API key is missing', async function () {
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );

      const response = await request(app).post(`${baseUrl}/contracts`).send(contractData);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('POST /organizations/:organizationId/contracts', function () {
    it('returns 201 when creating a contract with user API key', async function () {
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(contractData);

      expect(response.status).toBe(201);
      expect(response.body.organizationId).toBe(testOrganization.id);
      trackContractForCleanup(response.body);
    });

    it('returns 403 when organizationId in body does not match URL param', async function () {
      const otherOrg = await createTestOrganization(ownerUser.username);
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        otherOrg.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(contractData);

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Organization ID mismatch');

      await deleteTestOrganization(otherOrg.id!);
    });

    it('returns 401 when API key is missing', async function () {
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .send(contractData);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });

    it('returns 403 when non-ADMIN user tries to create a contract in another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);

      const contractData = await generateContract(
        { [foreignService.name.toLowerCase()]: foreignService.activePricings.keys().next().value! },
        foreignOrganization.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/organizations/${foreignOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(contractData);

      expect(response.status).toBe(403);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 201 when ADMIN user creates a contract in another organization (org endpoint)', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);

      const contractData = await generateContract(
        { [foreignService.name.toLowerCase()]: foreignService.activePricings.keys().next().value! },
        foreignOrganization.id!,
        undefined,
        app
      );

      const response = await request(app)
        .post(`${baseUrl}/organizations/${foreignOrganization.id}/contracts`)
        .set('x-api-key', adminUser.apiKey)
        .send(contractData);

      expect(response.status).toBe(201);
      expect(response.body.organizationId).toBe(foreignOrganization.id);
      trackContractForCleanup(response.body);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });
  });

  describe('PUT /organizations/:organizationId/contracts', function () {
    it('returns 200 and novates contracts filtered by groupId for that organization only', async function () {
      const sharedGroupId = `bulk-org-group-${Date.now()}`;
      const unaffectedGroupId = `bulk-org-unaffected-${Date.now()}`;

      const targetContract = await createTestContract(testOrganization.id!, [testService], app, sharedGroupId);
      trackContractForCleanup(targetContract);

      const unaffectedContract = await createTestContract(
        testOrganization.id!,
        [testService],
        app,
        unaffectedGroupId
      );
      trackContractForCleanup(unaffectedContract);

      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(
        foreignOrganization.id!,
        [foreignService],
        app,
        sharedGroupId
      );
      trackContractForCleanup(foreignContract);

      const novationService = await createTestService(testOrganization.id, `bulk-org-service-${Date.now()}`);
      const pricingVersion = novationService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(
        novationService.name,
        pricingVersion,
        testOrganization.id!,
        app
      );

      const novationData = {
        contractedServices: { [novationService.name.toLowerCase()]: pricingVersion },
        subscriptionPlans: { [novationService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0] },
        subscriptionAddOns: {},
      };

      const response = await request(app)
        .put(`${baseUrl}/organizations/${testOrganization.id}/contracts?groupId=${sharedGroupId}`)
        .set('x-api-key', ownerUser.apiKey)
        .send(novationData);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.every((c: LeanContract) => c.groupId === sharedGroupId)).toBe(true);
      expect(response.body.every((c: LeanContract) => c.organizationId === testOrganization.id)).toBe(true);
      expect(
        response.body.every(
          (c: LeanContract) => c.contractedServices[novationService.name.toLowerCase()] === pricingVersion
        )
      ).toBe(true);

      const unaffectedResponse = await request(app)
        .get(`${baseUrl}/organizations/${testOrganization.id}/contracts/${unaffectedContract.userContact.userId}`)
        .set('x-api-key', ownerUser.apiKey);

      expect(unaffectedResponse.status).toBe(200);
      expect(unaffectedResponse.body.groupId).toBe(unaffectedGroupId);
      expect(unaffectedResponse.body.contractedServices[novationService.name.toLowerCase()]).toBeUndefined();

      const foreignContractResponse = await request(app)
        .get(`${baseUrl}/organizations/${foreignOrganization.id}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', adminUser.apiKey);

      expect(foreignContractResponse.status).toBe(200);
      expect(foreignContractResponse.body.organizationId).toBe(foreignOrganization.id);
      expect(
        foreignContractResponse.body.contractedServices[novationService.name.toLowerCase()]
      ).toBeUndefined();

      await deleteTestService(novationService.name, testOrganization.id!);
      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 400 when groupId query parameter is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send({
          contractedServices: { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
          subscriptionPlans: {},
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing groupId');
    });

    it('returns 403 when non-ADMIN user tries to update contracts in another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(
        foreignOrganization.id!,
        [foreignService],
        app,
        `foreign-group-${Date.now()}`
      );
      trackContractForCleanup(foreignContract);

      const response = await request(app)
        .put(`${baseUrl}/organizations/${foreignOrganization.id}/contracts?groupId=${foreignContract.groupId}`)
        .set('x-api-key', ownerUser.apiKey)
        .send({
          contractedServices: { [foreignService.name.toLowerCase()]: foreignService.activePricings.keys().next().value! },
          subscriptionPlans: {},
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(403);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 200 when ADMIN user updates contracts in another organization by groupId', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignGroupId = `admin-bulk-${Date.now()}`;
      const foreignContract = await createTestContract(
        foreignOrganization.id!,
        [foreignService],
        app,
        foreignGroupId
      );
      trackContractForCleanup(foreignContract);

      const newService = await createTestService(foreignOrganization.id, `admin-service-${Date.now()}`);
      const pricingVersion = newService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(
        newService.name,
        pricingVersion,
        foreignOrganization.id!,
        app
      );

      const response = await request(app)
        .put(`${baseUrl}/organizations/${foreignOrganization.id}/contracts?groupId=${foreignGroupId}`)
        .set('x-api-key', adminUser.apiKey)
        .send({
          contractedServices: { [newService.name.toLowerCase()]: pricingVersion },
          subscriptionPlans: { [newService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0] },
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.every((c: LeanContract) => c.organizationId === foreignOrganization.id)).toBe(true);
      expect(response.body.every((c: LeanContract) => c.groupId === foreignGroupId)).toBe(true);

      await deleteTestService(newService.name, foreignOrganization.id!);
      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });
  });

  describe('GET /contracts/:userId', function () {
    it('returns 200 and the contract for the given userId', async function () {
      const response = await request(app)
        .get(`${baseUrl}/contracts/${testContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(200);
      expect(response.body.userContact.userId).toBe(testContract.userContact.userId);
    });

    it('returns 404 when contract is not found', async function () {
      const response = await request(app)
        .get(`${baseUrl}/contracts/non-existent-userId`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).get(`${baseUrl}/contracts/some-userId`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('GET /organizations/:organizationId/contracts/:userId', function () {
    it('returns 200 and the contract for the given userId with user API key', async function () {
      const response = await request(app)
        .get(
          `${baseUrl}/organizations/${testOrganization.id}/contracts/${testContract.userContact.userId}`
        )
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(200);
      expect(response.body.userContact.userId).toBe(testContract.userContact.userId);
    });

    it('returns 404 when contract is not found', async function () {
      const response = await request(app)
        .get(`${baseUrl}/organizations/${testOrganization.id}/contracts/non-existent-userId`)
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).get(
        `${baseUrl}/organizations/${testOrganization.id}/contracts/some-userId`
      );

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('PUT /contracts/:userId', function () {
    it('returns 200 and novates the contract', async function () {
      const newService = await createTestService(testOrganization.id, `new-service-${Date.now()}`);
      const pricingVersion = newService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(newService.name, pricingVersion, testOrganization.id!, app);

      const novationData = {
        contractedServices: { [newService.name.toLowerCase()]: newService.activePricings.keys().next().value! },
        subscriptionPlans: { [newService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0] },
        subscriptionAddOns: {},
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/${testContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey)
        .send(novationData);

      expect(response.status).toBe(200);
      expect(response.body.contractedServices).toHaveProperty(newService.name.toLowerCase());

      await deleteTestService(newService.name, testOrganization.id!);
    });

    it('returns 200 and contractedServices keys in lowercase even with uppercase service name', async function () {
      const upperCaseServiceName = 'UPPERCASE-SERVICE';
      const newService = await createTestService(testOrganization.id, upperCaseServiceName);
      const pricingVersion = newService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(newService.name, pricingVersion, testOrganization.id!, app);

      const novationData = {
        contractedServices: { [newService.name]: newService.activePricings.keys().next().value! },
        subscriptionPlans: { [newService.name]: Object.keys(pricingDetails!.plans!)[0] },
        subscriptionAddOns: {},
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/${testContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey)
        .send(novationData);

      expect(response.status).toBe(200);
      
      // Verify all keys are lowercase
      const contractedServicesKeys = Object.keys(response.body.contractedServices);
      const subscriptionPlansKeys = Object.keys(response.body.subscriptionPlans);
      const subscriptionAddOnsKeys = Object.keys(response.body.subscriptionAddOns);

      expect(contractedServicesKeys.every(key => key === key.toLowerCase())).toBe(true);
      expect(subscriptionPlansKeys.every(key => key === key.toLowerCase())).toBe(true);
      expect(subscriptionAddOnsKeys.every(key => key === key.toLowerCase())).toBe(true);

      await deleteTestService(newService.name, testOrganization.id!);
    });

    it('returns 404 when contract is not found', async function () {
      const novationData = {
        contractedServices: { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        subscriptionPlans: {},
        subscriptionAddOns: {},
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/non-existent-userId`)
        .set('x-api-key', testOrgApiKey)
        .send(novationData);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/some-userId`)
        .send({});

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('PUT /organizations/:organizationId/contracts/:userId', function () {
    it('returns 200 and novates the contract with user API key', async function () {
      const newService = await createTestService(testOrganization.id, `new-service-${Date.now()}`);
      const pricingVersion = newService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(newService.name, pricingVersion, testOrganization.id!, app);

      const novationData = {
        contractedServices: { [newService.name]: newService.activePricings.keys().next().value! },
        subscriptionPlans: { [newService.name]: Object.keys(pricingDetails!.plans!)[0] },
        subscriptionAddOns: {},
      };

      const response = await request(app)
        .put(
          `${baseUrl}/organizations/${testOrganization.id}/contracts/${testContract.userContact.userId}`
        )
        .set('x-api-key', ownerUser.apiKey)
        .send(novationData);

      expect(response.status).toBe(200);
      expect(response.body.contractedServices).toHaveProperty(newService.name.toLowerCase());

      await deleteTestService(newService.name, testOrganization.id!);
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/organizations/${testOrganization.id}/contracts/some-userId`)
        .send({});

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });

    it('returns 403 when non-ADMIN user tries to modify contract in another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(foreignOrganization.id!, [foreignService], app);
      trackContractForCleanup(foreignContract);

      const response = await request(app)
        .put(`${baseUrl}/organizations/${foreignOrganization.id}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', ownerUser.apiKey)
        .send({
          contractedServices: { [foreignService.name.toLowerCase()]: foreignService.activePricings.keys().next().value! },
          subscriptionPlans: {},
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(403);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 200 when ADMIN user modifies contract in another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(foreignOrganization.id!, [foreignService], app);
      trackContractForCleanup(foreignContract);

      const newService = await createTestService(foreignOrganization.id, `admin-mod-service-${Date.now()}`);
      const pricingVersion = newService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(
        newService.name,
        pricingVersion,
        foreignOrganization.id!,
        app
      );

      const novationData = {
        contractedServices: { [newService.name.toLowerCase()]: pricingVersion },
        subscriptionPlans: { [newService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0] },
        subscriptionAddOns: {},
      };

      const response = await request(app)
        .put(`${baseUrl}/organizations/${foreignOrganization.id}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', adminUser.apiKey)
        .send(novationData);

      expect(response.status).toBe(200);
      expect(response.body.contractedServices).toHaveProperty(newService.name.toLowerCase());

      await deleteTestService(newService.name, foreignOrganization.id!);
      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });
  });

  describe('PUT /contracts', function () {
    it('returns 200 and novates all contracts in a group from the requesting organization only', async function () {
      const sharedGroupId = `bulk-global-group-${Date.now()}`;
      const unaffectedGroupId = `bulk-global-unaffected-${Date.now()}`;

      const targetContract = await createTestContract(testOrganization.id!, [testService], app, sharedGroupId);
      trackContractForCleanup(targetContract);

      const unaffectedContract = await createTestContract(
        testOrganization.id!,
        [testService],
        app,
        unaffectedGroupId
      );
      trackContractForCleanup(unaffectedContract);

      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignOrgApiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(foreignOrganization.id!, { key: foreignOrgApiKey, scope: 'ALL' });

      const foreignContract = await createTestContract(
        foreignOrganization.id!,
        [foreignService],
        app,
        sharedGroupId
      );
      trackContractForCleanup(foreignContract);

      const novationService = await createTestService(testOrganization.id, `bulk-global-service-${Date.now()}`);
      const pricingVersion = novationService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(
        novationService.name,
        pricingVersion,
        testOrganization.id!,
        app
      );

      const novationData = {
        contractedServices: { [novationService.name.toLowerCase()]: pricingVersion },
        subscriptionPlans: { [novationService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0] },
        subscriptionAddOns: {},
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=${sharedGroupId}`)
        .set('x-api-key', testOrgApiKey)
        .send(novationData);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.every((c: LeanContract) => c.groupId === sharedGroupId)).toBe(true);
      expect(response.body.every((c: LeanContract) => c.organizationId === testOrganization.id)).toBe(true);
      expect(
        response.body.every(
          (c: LeanContract) => c.contractedServices[novationService.name.toLowerCase()] === pricingVersion
        )
      ).toBe(true);

      const unaffectedResponse = await request(app)
        .get(`${baseUrl}/contracts/${unaffectedContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey);
      expect(unaffectedResponse.status).toBe(200);
      expect(unaffectedResponse.body.contractedServices[novationService.name.toLowerCase()]).toBeUndefined();

      const foreignContractResponse = await request(app)
        .get(`${baseUrl}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', foreignOrgApiKey);
      expect(foreignContractResponse.status).toBe(200);
      expect(foreignContractResponse.body.organizationId).toBe(foreignOrganization.id);
      expect(
        foreignContractResponse.body.contractedServices[novationService.name.toLowerCase()]
      ).toBeUndefined();

      await deleteTestService(novationService.name, testOrganization.id!);
      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('clears cached single-feature evaluations when novating contracts by groupId', async function () {
      const sharedGroupId = `bulk-cache-features-${Date.now()}`;
      const targetContract = await createTestContract(testOrganization.id!, [testService], app, sharedGroupId);
      trackContractForCleanup(targetContract);

      const allFeaturesBeforeResponse = await request(app)
        .post(`${baseUrl}/features/${targetContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey);

      expect(allFeaturesBeforeResponse.status).toBe(200);
      const oldFeatureId = Object.keys(allFeaturesBeforeResponse.body)[0];
      expect(oldFeatureId).toBeDefined();

      const singleFeatureBeforeResponse = await request(app)
        .post(`${baseUrl}/features/${targetContract.userContact.userId}/${oldFeatureId}`)
        .set('x-api-key', testOrgApiKey);

      expect(singleFeatureBeforeResponse.status).toBe(200);
      expect(singleFeatureBeforeResponse.body.error).toBeFalsy();

      const novationService = await createTestService(
        testOrganization.id,
        `bulk-cache-features-service-${Date.now()}`
      );
      const pricingVersion = novationService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(
        novationService.name,
        pricingVersion,
        testOrganization.id!,
        app
      );

      const novationData = {
        contractedServices: { [novationService.name.toLowerCase()]: pricingVersion },
        subscriptionPlans: {
          [novationService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0],
        },
        subscriptionAddOns: {},
      };

      const novateResponse = await request(app)
        .put(`${baseUrl}/contracts?groupId=${sharedGroupId}`)
        .set('x-api-key', testOrgApiKey)
        .send(novationData);

      expect(novateResponse.status).toBe(200);

      const singleFeatureAfterResponse = await request(app)
        .post(`${baseUrl}/features/${targetContract.userContact.userId}/${oldFeatureId}`)
        .set('x-api-key', testOrgApiKey);

      expect(singleFeatureAfterResponse.status).toBe(200);
      expect(singleFeatureAfterResponse.body.error).toBeDefined();
      expect(singleFeatureAfterResponse.body.error.code).toBe('FLAG_NOT_FOUND');

      await deleteTestService(novationService.name, testOrganization.id!);
    });

    it('clears cached pricing token when novating contracts by groupId', async function () {
      const sharedGroupId = `bulk-cache-pricing-token-${Date.now()}`;
      const targetContract = await createTestContract(testOrganization.id!, [testService], app, sharedGroupId);
      trackContractForCleanup(targetContract);

      const pricingTokenBeforeResponse = await request(app)
        .post(`${baseUrl}/features/${targetContract.userContact.userId}/pricing-token`)
        .set('x-api-key', testOrgApiKey);

      expect(pricingTokenBeforeResponse.status).toBe(200);
      expect(pricingTokenBeforeResponse.body.pricingToken).toBeDefined();

      const novationService = await createTestService(
        testOrganization.id,
        `bulk-cache-pricing-token-service-${Date.now()}`
      );
      const pricingVersion = novationService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(
        novationService.name,
        pricingVersion,
        testOrganization.id!,
        app
      );

      const novationData = {
        contractedServices: { [novationService.name.toLowerCase()]: pricingVersion },
        subscriptionPlans: {
          [novationService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0],
        },
        subscriptionAddOns: {},
      };

      const novateResponse = await request(app)
        .put(`${baseUrl}/contracts?groupId=${sharedGroupId}`)
        .set('x-api-key', testOrgApiKey)
        .send(novationData);

      expect(novateResponse.status).toBe(200);

      const pricingTokenAfterResponse = await request(app)
        .post(`${baseUrl}/features/${targetContract.userContact.userId}/pricing-token`)
        .set('x-api-key', testOrgApiKey);

      expect(pricingTokenAfterResponse.status).toBe(200);
      expect(pricingTokenAfterResponse.body.pricingToken).toBeDefined();
      expect(pricingTokenAfterResponse.body.pricingToken).not.toBe(
        pricingTokenBeforeResponse.body.pricingToken
      );

      await deleteTestService(novationService.name, testOrganization.id!);
    });

    it('returns 400 when groupId query parameter is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey)
        .send({
          contractedServices: { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
          subscriptionPlans: {},
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing groupId');
    });

    it('returns 404 when no contracts are found for groupId in the requesting organization', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=group-does-not-exist`)
        .set('x-api-key', testOrgApiKey)
        .send({
          contractedServices: { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
          subscriptionPlans: {},
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(404);
      expect(response.body.error.toLowerCase()).toContain('no contracts found');
    });

    it('returns 403 when non-ADMIN user API key is used', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=any-group`)
        .set('x-api-key', ownerUser.apiKey)
        .send({
          contractedServices: { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
          subscriptionPlans: {},
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(403);
    });

    it('returns 422 when payload is invalid', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=any-group`)
        .set('x-api-key', testOrgApiKey)
        .send({ contractedServices: { [testService.name.toLowerCase()]: '1.0.0' } });

      expect(response.status).toBe(422);
    });

    it('returns 200 when ADMIN user novates contracts by groupId naming the organization', async function () {
      const adminGroupId = `admin-global-${Date.now()}`;
      const adminContract = await createTestContract(testOrganization.id!, [testService], app, adminGroupId);
      trackContractForCleanup(adminContract);

      const adminService = await createTestService(testOrganization.id, `admin-global-service-${Date.now()}`);
      const pricingVersion = adminService.activePricings.keys().next().value!;
      const pricingDetails = await getPricingFromService(
        adminService.name,
        pricingVersion,
        testOrganization.id!,
        app
      );

      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=${adminGroupId}&organizationId=${testOrganization.id}`)
        .set('x-api-key', adminUser.apiKey)
        .send({
          contractedServices: { [adminService.name.toLowerCase()]: pricingVersion },
          subscriptionPlans: { [adminService.name.toLowerCase()]: Object.keys(pricingDetails!.plans!)[0] },
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.every((c: LeanContract) => c.groupId === adminGroupId)).toBe(true);

      await deleteTestService(adminService.name, testOrganization.id!);
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts?groupId=any-group`)
        .send({
          contractedServices: { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
          subscriptionPlans: {},
          subscriptionAddOns: {},
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('PUT /contracts/billingPeriod', function () {
    it('returns 200 and updates billing period by groupId for contracts in the request organization only', async function () {
      const sharedGroupId = `billing-group-${Date.now()}`;
      const unaffectedGroupId = `billing-unaffected-${Date.now()}`;

      const targetContract = await createTestContract(testOrganization.id!, [testService], app, sharedGroupId);
      trackContractForCleanup(targetContract);

      const unaffectedContract = await createTestContract(
        testOrganization.id!,
        [testService],
        app,
        unaffectedGroupId
      );
      trackContractForCleanup(unaffectedContract);

      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignOrgApiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(foreignOrganization.id!, { key: foreignOrgApiKey, scope: 'ALL' });

      const foreignContract = await createTestContract(
        foreignOrganization.id!,
        [foreignService],
        app,
        sharedGroupId
      );
      trackContractForCleanup(foreignContract);

      const billingData = {
        autoRenew: !targetContract.billingPeriod.autoRenew,
        renewalDays: targetContract.billingPeriod.renewalDays === 30 ? 365 : 30,
      };

      const foreignContractBefore = await request(app)
        .get(`${baseUrl}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', foreignOrgApiKey);

      expect(foreignContractBefore.status).toBe(200);

      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=${sharedGroupId}`)
        .set('x-api-key', testOrgApiKey)
        .send(billingData);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.every((c: LeanContract) => c.groupId === sharedGroupId)).toBe(true);
      expect(response.body.every((c: LeanContract) => c.organizationId === testOrganization.id)).toBe(true);
      expect(
        response.body.every((c: LeanContract) => c.billingPeriod.autoRenew === billingData.autoRenew)
      ).toBe(true);
      expect(
        response.body.every((c: LeanContract) => c.billingPeriod.renewalDays === billingData.renewalDays)
      ).toBe(true);

      const unaffectedResponse = await request(app)
        .get(`${baseUrl}/contracts/${unaffectedContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey);
      expect(unaffectedResponse.status).toBe(200);
      expect(unaffectedResponse.body.groupId).toBe(unaffectedGroupId);

      const foreignContractResponse = await request(app)
        .get(`${baseUrl}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', foreignOrgApiKey);
      expect(foreignContractResponse.status).toBe(200);
      expect(foreignContractResponse.body.organizationId).toBe(foreignOrganization.id);
      expect(foreignContractResponse.body.billingPeriod.autoRenew).toBe(
        foreignContractBefore.body.billingPeriod.autoRenew
      );
      expect(foreignContractResponse.body.billingPeriod.renewalDays).toBe(
        foreignContractBefore.body.billingPeriod.renewalDays
      );

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 400 when groupId query parameter is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod`)
        .set('x-api-key', testOrgApiKey)
        .send({ autoRenew: true, renewalDays: 30 });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Missing groupId');
    });

    it('returns 404 when no contracts are found for groupId in the requesting organization', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=group-does-not-exist`)
        .set('x-api-key', testOrgApiKey)
        .send({ autoRenew: true, renewalDays: 30 });

      expect(response.status).toBe(404);
      expect(response.body.error.toLowerCase()).toContain('not found');
    });

    it('returns 403 when non-ADMIN user API key is used', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=any-group`)
        .set('x-api-key', ownerUser.apiKey)
        .send({ autoRenew: true, renewalDays: 30 });

      expect(response.status).toBe(403);
    });

    it('returns 422 when payload is invalid', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=any-group`)
        .set('x-api-key', testOrgApiKey)
        .send({ autoRenew: 'invalid-boolean' });

      expect(response.status).toBe(422);
    });

    it('returns 200 when ADMIN user updates billing period by groupId naming the organization', async function () {
      const adminBillingGroupId = `admin-billing-${Date.now()}`;
      const adminBillingContract = await createTestContract(
        testOrganization.id!,
        [testService],
        app,
        adminBillingGroupId
      );
      trackContractForCleanup(adminBillingContract);

      const billingData = {
        autoRenew: !adminBillingContract.billingPeriod.autoRenew,
        renewalDays: adminBillingContract.billingPeriod.renewalDays === 30 ? 365 : 30,
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=${adminBillingGroupId}&organizationId=${testOrganization.id}`)
        .set('x-api-key', adminUser.apiKey)
        .send(billingData);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.every((c: LeanContract) => c.groupId === adminBillingGroupId)).toBe(true);
      expect(
        response.body.every((c: LeanContract) => c.billingPeriod.autoRenew === billingData.autoRenew)
      ).toBe(true);
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=any-group`)
        .send({ autoRenew: true, renewalDays: 30 });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });

    it('returns 200 when ADMIN user updates billing period by groupId naming the organization', async function () {
      const adminBillingGroupId = `admin-billing-${Date.now()}`;
      const adminBillingContract = await createTestContract(
        testOrganization.id!,
        [testService],
        app,
        adminBillingGroupId
      );
      trackContractForCleanup(adminBillingContract);

      const billingData = {
        autoRenew: !adminBillingContract.billingPeriod.autoRenew,
        renewalDays: adminBillingContract.billingPeriod.renewalDays === 30 ? 365 : 30,
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/billingPeriod?groupId=${adminBillingGroupId}&organizationId=${testOrganization.id}`)
        .set('x-api-key', adminUser.apiKey)
        .send(billingData);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body.every((c: LeanContract) => c.groupId === adminBillingGroupId)).toBe(true);
      expect(
        response.body.every((c: LeanContract) => c.billingPeriod.autoRenew === billingData.autoRenew)
      ).toBe(true);
    });
  });

  describe('DELETE /contracts/:userId', function () {
    it('returns 204 when deleting an existing contract', async function () {
      const response = await request(app)
        .delete(`${baseUrl}/contracts/${testContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(204);

      // Verify deletion
      const getResponse = await request(app)
        .get(`${baseUrl}/contracts/${testContract.userContact.userId}`)
        .set('x-api-key', testOrgApiKey);
      expect(getResponse.status).toBe(404);
    });

    it('returns 404 when deleting a non-existent contract', async function () {
      const response = await request(app)
        .delete(`${baseUrl}/contracts/non-existent-userId`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).delete(`${baseUrl}/contracts/some-userId`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('DELETE /organizations/:organizationId/contracts/:userId', function () {
    it('returns 204 when deleting an existing contract with user API key', async function () {
      const response = await request(app)
        .delete(
          `${baseUrl}/organizations/${testOrganization.id}/contracts/${testContract.userContact.userId}`
        )
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(204);
    });

    it('returns 404 when deleting a non-existent contract', async function () {
      const response = await request(app)
        .delete(`${baseUrl}/organizations/${testOrganization.id}/contracts/non-existent-userId`)
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).delete(
        `${baseUrl}/organizations/${testOrganization.id}/contracts/some-userId`
      );

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });

    it('returns 403 when non-ADMIN user tries to delete a contract in another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(foreignOrganization.id!, [foreignService], app);
      trackContractForCleanup(foreignContract);

      const response = await request(app)
        .delete(`${baseUrl}/organizations/${foreignOrganization.id}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(403);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });

    it('returns 204 when ADMIN user deletes a contract in another organization', async function () {
      const foreignOrgOwner = await createTestUser('USER');
      const foreignOrganization = await createTestOrganization(foreignOrgOwner.username);
      const foreignService = await createTestService(foreignOrganization.id);
      const foreignContract = await createTestContract(foreignOrganization.id!, [foreignService], app);

      const response = await request(app)
        .delete(`${baseUrl}/organizations/${foreignOrganization.id}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', adminUser.apiKey);

      expect(response.status).toBe(204);

      const getResponse = await request(app)
        .get(`${baseUrl}/organizations/${foreignOrganization.id}/contracts/${foreignContract.userContact.userId}`)
        .set('x-api-key', adminUser.apiKey);
      expect(getResponse.status).toBe(404);

      await deleteTestService(foreignService.name, foreignOrganization.id!);
      await deleteTestOrganization(foreignOrganization.id!);
      await deleteTestUser(foreignOrgOwner.username);
    });
  });

  describe('DELETE /contracts', function () {
    it('returns 204 when deleting all contracts with org API key', async function () {
      const response = await request(app)
        .delete(`${baseUrl}/contracts`)
        .set('x-api-key', testOrgApiKey);

      expect(response.status).toBe(204);
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).delete(`${baseUrl}/contracts`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('DELETE /organizations/:organizationId/contracts', function () {
    it('returns 204 when deleting all contracts for an organization', async function () {
      const response = await request(app)
        .delete(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey);

      expect(response.status).toBe(204);
    });

    it('returns 401 when API key is missing', async function () {
      const response = await request(app).delete(
        `${baseUrl}/organizations/${testOrganization.id}/contracts`
      );

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('PUT /contracts/:userId/usageLevels', function () {
    it('returns 200 and increments usage levels', async function () {
      const serviceLowercase = testService.name.toLowerCase();
      const usageLimitName = testContract.usageLevels && testContract.usageLevels[serviceLowercase]
        ? Object.keys(testContract.usageLevels[serviceLowercase])[0]
        : 'defaultLimit';
        
      const incrementData = {
        [testService.name]: {
          [usageLimitName]: 10,
        },
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/${testContract.userContact.userId}/usageLevels`)
        .set('x-api-key', testOrgApiKey)
        .send(incrementData);

      expect(response.status).toBe(200);
      if (response.body.usageLevels && response.body.usageLevels[serviceLowercase]) {
        expect(response.body.usageLevels[serviceLowercase][usageLimitName].consumed).toBeGreaterThanOrEqual(10);
      }
    });

    it('returns 200 and resets usage levels with reset=true', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/${testContract.userContact.userId}/usageLevels?reset=true`)
        .set('x-api-key', testOrgApiKey)
        .send({});

      expect(response.status).toBe(200);
    });

    it('returns 400 when both reset and usageLimit are provided', async function () {
      const response = await request(app)
        .put(
          `${baseUrl}/contracts/${testContract.userContact.userId}/usageLevels?reset=true&usageLimit=someLimit`
        )
        .set('x-api-key', testOrgApiKey)
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid query');
    });

    it('returns 404 when contract is not found', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/non-existent-userId/usageLevels`)
        .set('x-api-key', testOrgApiKey)
        .send({});

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });
  });

  describe('PUT /contracts/:userId/userContact', function () {
    it('returns 200 and updates user contact information', async function () {
      const newContactData = {
        firstName: 'NewFirstName',
        lastName: 'NewLastName',
        email: 'newemail@example.com',
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/${testContract.userContact.userId}/userContact`)
        .set('x-api-key', testOrgApiKey)
        .send(newContactData);

      expect(response.status).toBe(200);
      expect(response.body.userContact.firstName).toBe('NewFirstName');
      expect(response.body.userContact.lastName).toBe('NewLastName');
      expect(response.body.userContact.email).toBe('newemail@example.com');
    });

    it('returns 404 when contract is not found', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/non-existent-userId/userContact`)
        .set('x-api-key', testOrgApiKey)
        .send({ firstName: 'Test' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });
  });

  describe('PUT /contracts/:userId/billingPeriod', function () {
    it('returns 200 and updates billing period', async function () {
      const newBillingPeriod = {
        endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        autoRenew: true,
        renewalDays: 365,
      };

      const response = await request(app)
        .put(`${baseUrl}/contracts/${testContract.userContact.userId}/billingPeriod`)
        .set('x-api-key', testOrgApiKey)
        .send(newBillingPeriod);

      expect(response.status).toBe(200);
      expect(response.body.billingPeriod.autoRenew).toBe(true);
      expect(response.body.billingPeriod.renewalDays).toBe(365);
    });

    it('returns 404 when contract is not found', async function () {
      const response = await request(app)
        .put(`${baseUrl}/contracts/non-existent-userId/billingPeriod`)
        .set('x-api-key', testOrgApiKey)
        .send({ autoRenew: true });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('not found');
    });
  });
});
