import fs from 'fs';
import request from 'supertest';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import {
  addArchivedPricingToService,
  addPricingToService,
  archivePricingFromService,
  createTestService,
  deleteTestService,
  getRandomPricingFile,
  getService,
  createMultipleTestServices,
  getPricingFromService,
} from './utils/services/serviceTestUtils';
import { retrievePricingFromPath } from 'pricing4ts/server';
import { ExpectedPricingType, LeanUsageLimit } from '../main/types/models/Pricing';
import { createTestContract, deleteTestContract, getAllContracts, getContractByUserId } from './utils/contracts/contractTestUtils';
import { generateContract } from './utils/contracts/generators';
import { LeanContract } from '../main/types/models/Contract';
import { isSubscriptionValid } from '../main/controllers/validation/ContractValidation';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import { LeanService } from '../main/types/models/Service';
import { LeanOrganization } from '../main/types/models/Organization';
import { LeanUser } from '../main/types/models/User';
import { addApiKeyToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import nock from 'nock';
import { getFirstPlanFromPricing, getVersionFromPricing } from './utils/regex';

describe('Services API Test Suite', function () {
  let app: Server;
  let adminUser: LeanUser;
  let ownerUser: LeanUser;
  let testService: LeanService;
  let testOrganization: LeanOrganization;
  let testApiKey: string;

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    adminUser = await createTestUser('ADMIN');
    ownerUser = await createTestUser('USER');
    testOrganization = await createTestOrganization(ownerUser.username);
    testService = await createTestService(testOrganization.id);
    
    testApiKey = generateOrganizationApiKey();
    
    await addApiKeyToOrganization(testOrganization.id!, {key: testApiKey, scope: 'ALL'})

  });

  afterEach(async function () {
    if (testService.id){
      await deleteTestService(testService.name, testOrganization.id!);
    }
    if (testOrganization.id){
      await deleteTestOrganization(testOrganization.id);
    }
    if (adminUser.id){
      await deleteTestUser(adminUser.id);
    }
    if (ownerUser.id){
      await deleteTestUser(ownerUser.id);
    }
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('GET /services', function () {
    it('Should return 200 and the services', async function () {
      const response = await request(app).get(`${baseUrl}/services`).set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
    });
  });

  describe('POST /services', function () {
    it('Should return 201 and the created service: Given Pricing2Yaml file in the request', async function () {
      const pricingFilePath = await getRandomPricingFile(new Date().getTime().toString());
      const response = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', testApiKey)
        .attach('pricing', pricingFilePath);
      expect(response.status).toEqual(201);
      expect(response.body).toBeDefined();
      expect(Object.keys(response.body.activePricings).length).greaterThan(0);
      expect((Object.values(response.body.activePricings)[0] as any).id).toBeDefined();
      expect((Object.values(response.body.activePricings)[0] as any).url).toBeUndefined();
      expect(response.body.archivedPricings).toBeUndefined();
    });

    it('Should return 201 and the created service: Given url in the request', async function () {
      const response = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', testApiKey)
        .send({
          pricing:
            'https://sphere.score.us.es/static/collections/63f74bf8eeed64058364b52e/IEEE TSC 2025/notion/2025.yml',
        });
      expect(response.status).toEqual(201);
      expect(response.body).toBeDefined();
      expect(Object.keys(response.body.activePricings).length).greaterThan(0);
      expect((Object.values(response.body.activePricings)[0] as any).id).toBeUndefined();
      expect((Object.values(response.body.activePricings)[0] as any).url).toBeDefined();
      expect(response.body.archivedPricings).toBeUndefined();
    });

    it('Should return 4XX when creating a service with the same name as an existing one', async function () {
      // create initial service
      const pricingFilePath = await getRandomPricingFile(new Date().getTime().toString());
      const first = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', testApiKey)
        .attach('pricing', pricingFilePath);

      expect(first.status).toEqual(201);

      // attempt to create another service with the same pricing (and thus same saasName)
      const second = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', testApiKey)
        .attach('pricing', pricingFilePath);

      // It must be a 4xx error (client error), not 5xx
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(second.status).toBeLessThan(500);

      expect(second.body).toBeDefined();
      expect(second.body.error).toBeDefined();
      const errMsg = String(second.body.error).toLowerCase();
      expect(errMsg.length).toBeGreaterThan(0);
      // Error message should mention existence/duplication
      expect(['exists', 'already', 'duplicate'].some(k => errMsg.includes(k))).toBeTruthy();
    });

    it('Should return 201 when creating a service with the same name in a different organization', async function () {
      // Create initial service in first organization
      const pricingFilePath = await getRandomPricingFile(new Date().getTime().toString());
      const first = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', testApiKey)
        .attach('pricing', pricingFilePath);

      expect(first.status).toEqual(201);
      const firstServiceName = first.body.name;

      // Create a new organization
      const secondOrganization = await createTestOrganization(ownerUser.username);
      const secondOrgApiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(secondOrganization.id!, {
        key: secondOrgApiKey,
        scope: 'ALL',
      });

      // Attempt to create another service with the same name but in a different organization
      const second = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', secondOrgApiKey)
        .attach('pricing', pricingFilePath);

      // Should succeed (201) since it's in a different organization
      expect(second.status).toEqual(201);
      expect(second.body).toBeDefined();
      expect(second.body.name).toEqual(firstServiceName);
      expect(second.body.organizationId).toEqual(secondOrganization.id);
      expect(first.body.organizationId).not.toEqual(second.body.organizationId);

      // Cleanup
      await deleteTestService(firstServiceName, testOrganization.id!);
      await deleteTestService(second.body.name, secondOrganization.id!);
      await deleteTestOrganization(secondOrganization.id!);
    });
  });

  describe('GET /services/{serviceName}', function () {
    it('Should return 200: Given existent service name in lower case', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(Array.isArray(response.body)).toBe(false);
      expect(response.body.name.toLowerCase()).toBe(testService.name.toLowerCase());
    });

    it('Should return 200: Given existent service name in upper case', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name.toUpperCase()}`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(Array.isArray(response.body)).toBe(false);
      expect(response.body.name.toLowerCase()).toBe(testService.name.toLowerCase());
    });

    it('Should return 404 due to service not found', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/unexistent-service`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(404);
      expect(response.body.error).toBe('NOT FOUND: Service with name unexistent-service');
    });
  });

  describe('PUT /services/{serviceName}', function () {
    let contractsToCleanup: Set<string> = new Set();

    afterEach(async function () {
      // Reset service name if it was changed
      await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ name: testService.name })
        .catch(() => {}); // Ignore errors if service was deleted

      // Cleanup contracts
      for (const userId of contractsToCleanup) {
        await deleteTestContract(userId, app);
      }
      contractsToCleanup.clear();
    });

    // ======== POSITIVE TESTS ========

    it('Should return 200 and change service name without contracts', async function () {
      const newName = 'updated-service-name-' + Date.now();

      const serviceBeforeUpdate = await getService(testOrganization.id!, testService.name, app);
      expect(serviceBeforeUpdate.name.toLowerCase()).toBe(testService.name.toLowerCase());

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ name: newName });

      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body).toBeDefined();
      expect(responseUpdate.body.name).toEqual(newName);
      expect(responseUpdate.body.organizationId).toEqual(testOrganization.id);

      // Verify service was renamed
      const serviceAfterUpdate = await getService(testOrganization.id!, newName, app);
      expect(serviceAfterUpdate.name).toEqual(newName);

      // Update testService reference for cleanup
      testService.name = newName;
    });

    it('Should return 200 and update service name in existing contracts', async function () {
      const newServiceName = 'renamed-service-' + Date.now();
      
      // Create a contract that uses this service
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );
      const createResponse = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(contractData);

      expect(createResponse.status).toEqual(201);
      const contractBefore = createResponse.body as LeanContract;
      contractsToCleanup.add(contractBefore.userContact.userId);
      
      // Verify contract has the service
      expect(contractBefore.contractedServices).toHaveProperty(testService.name.toLowerCase());

      // Update service name
      const updateResponse = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ name: newServiceName });

      expect(updateResponse.status).toEqual(200);
      expect(updateResponse.body.name).toEqual(newServiceName);

      // Verify contract was updated with new service name
      const contractAfter = await getContractByUserId(contractBefore.userContact.userId, app);
      expect(contractAfter.contractedServices).toHaveProperty(newServiceName.toLowerCase());
      expect(contractAfter.contractedServices).not.toHaveProperty(testService.name.toLowerCase());
      expect(contractAfter.subscriptionPlans).toHaveProperty(newServiceName.toLowerCase());
      expect(contractAfter.subscriptionPlans).not.toHaveProperty(testService.name.toLowerCase());

      // Update testService reference for cleanup
      testService.name = newServiceName;
    });

    it('Should return 200 and change service organization (no contracts)', async function () {
      const newOrganization = await createTestOrganization(ownerUser.username);
      const newOrgApiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(newOrganization.id!, { key: newOrgApiKey, scope: 'ALL' });

      const serviceBeforeUpdate = await getService(testOrganization.id!, testService.name, app);
      expect(serviceBeforeUpdate.organizationId).toEqual(testOrganization.id);

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ organizationId: newOrganization.id });

      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body.organizationId).toEqual(newOrganization.id);

      // Verify service is now in new organization
      const serviceAfterUpdate = await getService(newOrganization.id!, testService.name, app);
      expect(serviceAfterUpdate.organizationId).toEqual(newOrganization.id);

      // Update reference
      testOrganization = newOrganization;
      testApiKey = newOrgApiKey;

      await deleteTestOrganization(newOrganization.id!);
    });

    it('Should return 200 and move contract with single service to new organization', async function () {
      const newOrganization = await createTestOrganization(ownerUser.username);
      const newOrgApiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(newOrganization.id!, { key: newOrgApiKey, scope: 'ALL' });

      // Create contract with ONLY this service
      const contractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );
      const createResponse = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(contractData);

      expect(createResponse.status).toEqual(201);
      const contractBefore = createResponse.body as LeanContract;
      contractsToCleanup.add(contractBefore.userContact.userId);
      expect(Object.keys(contractBefore.contractedServices).length).toEqual(1);
      expect(contractBefore.organizationId).toEqual(testOrganization.id);

      // Move service to new organization
      const updateResponse = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ organizationId: newOrganization.id });

      expect(updateResponse.status).toEqual(200);
      expect(updateResponse.body.organizationId).toEqual(newOrganization.id);

      // Verify contract was moved to new organization
      const contractAfter = await getContractByUserId(contractBefore.userContact.userId, app);
      expect(contractAfter.organizationId).toEqual(newOrganization.id);
      expect(contractAfter.contractedServices).toHaveProperty(testService.name.toLowerCase());

      // Update references
      testOrganization = newOrganization;
      testApiKey = newOrgApiKey;

      await deleteTestOrganization(newOrganization.id!);
    });

    it('Should return 200 and remove service from multi-service contract', async function () {
      // Create additional service in same organization
      const additionalService = await createTestService(testOrganization.id);

      // Create contract with MULTIPLE services
      const contractData = await generateContract(
        {
          [testService.name.toLowerCase()]: testService.activePricings.keys().next().value!,
          [additionalService.name.toLowerCase()]: additionalService.activePricings.keys().next().value!,
        },
        testOrganization.id!,
        undefined,
        app
      );
      const createResponse = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(contractData);

      expect(createResponse.status).toEqual(201);
      const contractBefore = createResponse.body as LeanContract;
      contractsToCleanup.add(contractBefore.userContact.userId);
      expect(Object.keys(contractBefore.contractedServices).length).toEqual(2);
      expect(contractBefore.organizationId).toEqual(testOrganization.id);
      const orgBefore = contractBefore.organizationId;

      // Move service to new organization
      const newOrganization = await createTestOrganization(ownerUser.username);
      const updateResponse = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ organizationId: newOrganization.id });

      expect(updateResponse.status).toEqual(200);
      expect(updateResponse.body.organizationId).toEqual(newOrganization.id);

      // Verify contract STILL in original organization but service was removed
      const contractAfter = await getContractByUserId(contractBefore.userContact.userId, app);
      expect(contractAfter.organizationId).toEqual(orgBefore);
      expect(contractAfter.contractedServices).not.toHaveProperty(testService.name.toLowerCase());
      expect(contractAfter.contractedServices).toHaveProperty(additionalService.name.toLowerCase());
      expect(Object.keys(contractAfter.contractedServices).length).toEqual(1);

      // Cleanup
      await deleteTestService(additionalService.name, testOrganization.id!);
      await deleteTestOrganization(newOrganization.id!);
      
      testService.id = undefined; // Mark original service as potentially deleted for afterEach cleanup
    });

    it('Should return 200 and ignore invalid fields like activePricings', async function () {
      const serviceBeforeUpdate = await getService(testOrganization.id!, testService.name, app);
      expect(serviceBeforeUpdate.activePricings).toBeDefined();

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ activePricings: null, description: 'should be ignored' });

      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body.activePricings).toEqual(serviceBeforeUpdate.activePricings);
    });

    it('Should return 200 and update both name and organization simultaneously', async function () {
      const newName = 'service-with-new-org-' + Date.now();
      const newOrganization = await createTestOrganization(ownerUser.username);
      const newOrgApiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(newOrganization.id!, { key: newOrgApiKey, scope: 'ALL' });

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ name: newName, organizationId: newOrganization.id });

      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body.name).toEqual(newName);
      expect(responseUpdate.body.organizationId).toEqual(newOrganization.id);

      // Update references
      testService.name = newName;
      testOrganization = newOrganization;
      testApiKey = newOrgApiKey;

      await deleteTestOrganization(newOrganization.id!);
    });

    it('Should return 200 and update contracts when name and organization change', async function () {
      const newName = 'service-contract-move-' + Date.now();
      const newOrganization = await createTestOrganization(ownerUser.username);
      const newOrgApiKey = generateOrganizationApiKey();
      await addApiKeyToOrganization(newOrganization.id!, { key: newOrgApiKey, scope: 'ALL' });

      const additionalService = await createTestService(testOrganization.id);

      // Contract with only this service
      const singleContractData = await generateContract(
        { [testService.name.toLowerCase()]: testService.activePricings.keys().next().value! },
        testOrganization.id!,
        undefined,
        app
      );
      const singleContractResponse = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(singleContractData);

      expect(singleContractResponse.status).toEqual(201);
      const singleContractBefore = singleContractResponse.body as LeanContract;
      contractsToCleanup.add(singleContractBefore.userContact.userId);

      // Contract with multiple services
      const multiContractData = await generateContract(
        {
          [testService.name.toLowerCase()]: testService.activePricings.keys().next().value!,
          [additionalService.name.toLowerCase()]:
            additionalService.activePricings.keys().next().value!,
        },
        testOrganization.id!,
        undefined,
        app
      );
      const multiContractResponse = await request(app)
        .post(`${baseUrl}/organizations/${testOrganization.id}/contracts`)
        .set('x-api-key', ownerUser.apiKey)
        .send(multiContractData);

      expect(multiContractResponse.status).toEqual(201);
      const multiContractBefore = multiContractResponse.body as LeanContract;
      contractsToCleanup.add(multiContractBefore.userContact.userId);

      const updateResponse = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ name: newName, organizationId: newOrganization.id });

      expect(updateResponse.status).toEqual(200);
      expect(updateResponse.body.name).toEqual(newName);
      expect(updateResponse.body.organizationId).toEqual(newOrganization.id);

      const singleContractAfter = await getContractByUserId(
        singleContractBefore.userContact.userId,
        app
      );
      expect(singleContractAfter.organizationId).toEqual(newOrganization.id);
      expect(singleContractAfter.contractedServices).toHaveProperty(newName.toLowerCase());
      expect(singleContractAfter.contractedServices).not.toHaveProperty(
        testService.name.toLowerCase()
      );

      const multiContractAfter = await getContractByUserId(
        multiContractBefore.userContact.userId,
        app
      );
      expect(multiContractAfter.organizationId).toEqual(testOrganization.id);
      expect(multiContractAfter.contractedServices).not.toHaveProperty(
        testService.name.toLowerCase()
      );
      expect(multiContractAfter.contractedServices).not.toHaveProperty(newName.toLowerCase());
      expect(multiContractAfter.contractedServices).toHaveProperty(
        additionalService.name.toLowerCase()
      );

      await deleteTestService(additionalService.name, testOrganization.id!);
      await deleteTestOrganization(newOrganization.id!);

      testService.id = undefined; // Mark original service as potentially deleted for afterEach cleanup
    });

    

    // ======== NEGATIVE TESTS ========

    it('Should return 4XX when trying to rename service to an existing name', async function () {
      // Create another service
      const secondService = await createTestService(testOrganization.id);

      // Try to rename first service to second service's name
      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ name: secondService.name });

      expect(responseUpdate.status).toBeGreaterThanOrEqual(400);
      expect(responseUpdate.status).toBeLessThan(500);
      expect(responseUpdate.body.error).toBeDefined();
      expect(responseUpdate.body.error.toLowerCase()).toContain('conflict');

      // Cleanup additional service
      await deleteTestService(secondService.name, testOrganization.id!);
    });

    it('Should return 4XX when trying to move service to non-existent organization', async function () {
      const fakeOrgId = '507f1f77bcf86cd799439012';

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({ organizationId: fakeOrgId });

      expect(responseUpdate.status).toBeGreaterThanOrEqual(400);
      expect(responseUpdate.status).toBeLessThan(500);
      expect(responseUpdate.body.error).toBeDefined();
      expect(responseUpdate.body.error.toLowerCase()).toContain('not found');
    });

    it('Should return 404 when trying to update non-existent service', async function () {
      const nonExistentServiceName = 'non-existent-service-' + Date.now();

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${nonExistentServiceName}`)
        .set('x-api-key', testApiKey)
        .send({ name: 'new-name' });

      expect(responseUpdate.status).toEqual(404);
      expect(responseUpdate.body.error).toBeDefined();
    });

    it('Should ignore empty/null update payload', async function () {
      const serviceBeforeUpdate = await getService(testOrganization.id!, testService.name, app);

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey)
        .send({});

      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body.name).toEqual(serviceBeforeUpdate.name);
      expect(responseUpdate.body.organizationId).toEqual(serviceBeforeUpdate.organizationId);
    });
  });
  describe('DELETE /services/{serviceName}', function () {
    it('Should return 204', async function () {
      const responseDelete = await request(app)
        .delete(`${baseUrl}/services/${testService.name.toLowerCase()}`)
        .set('x-api-key', testApiKey);
      expect(responseDelete.status).toEqual(204);

      testService.id = undefined
    });
  });

  describe('GET /services/{serviceName}/pricings', function () {
    it('Should return 200: Given existent service name in lower case', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name.toLowerCase()}/pricings`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0].features).toBeDefined();
      expect(Object.keys(response.body[0].features).length).toBeGreaterThan(0);
      expect(response.body[0].usageLimits).toBeDefined();
      expect(response.body[0].plans).toBeDefined();
      expect(response.body[0].addOns).toBeDefined();

      const service = await getService(testOrganization.id!, testService.name, app);
      expect(service.name.toLowerCase()).toBe(testService.name.toLowerCase());
      expect(response.body.map((p: ExpectedPricingType) => p.version).sort()).toEqual(
        Object.keys(service.activePricings).sort()
      );
    });

    it('Should return 200: Given existent service name in lower case and "archived" in query', async function () {
      await addArchivedPricingToService(testOrganization.id!, testService.name);
      
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name.toLowerCase()}/pricings?pricingStatus=archived`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0].features).toBeDefined();
      expect(Object.keys(response.body[0].features).length).toBeGreaterThan(0);
      expect(response.body[0].usageLimits).toBeDefined();
      expect(response.body[0].plans).toBeDefined();
      expect(response.body[0].addOns).toBeDefined();

      const service = await getService(testOrganization.id!, testService.name, app);
      expect(service.name.toLowerCase()).toBe(testService.name.toLowerCase());
      expect(response.body.map((p: ExpectedPricingType) => p.version).sort()).toEqual(
        Object.keys(service.archivedPricings).sort()
      );
    });

    it('Should return 200: Given existent service name in upper case', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name.toUpperCase()}/pricings`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);
      expect(response.body[0].features).toBeDefined();
      expect(Object.keys(response.body[0].features).length).toBeGreaterThan(0);
      expect(response.body[0].usageLimits).toBeDefined();
      expect(response.body[0].plans).toBeDefined();
      expect(response.body[0].addOns).toBeDefined();
    });

    it('Should return 404 due to service not found', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/unexistent-service/pricings`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(404);
      expect(response.body.error).toBe('NOT FOUND: Service with name unexistent-service');
    });
  });

  describe('POST /services/{serviceName}/pricings', function () {
    it('Should return 200 when adding a new pricing version to a service', async function () {
      const serviceBefore = await getService(testOrganization.id!, testService.name, app);
      expect(serviceBefore.activePricings).toBeDefined();

      const previousActivePricingsAmount = Object.keys(serviceBefore.activePricings).length;

      const newPricingVersionPath = await getRandomPricingFile(testService.name);

      const response = await request(app)
        .post(`${baseUrl}/services/${testService.name}/pricings`)
        .set('x-api-key', testApiKey)
        .attach('pricing', newPricingVersionPath);
      expect(response.status).toEqual(201);
      expect(serviceBefore.activePricings).toBeDefined();
      const newActivePricingsAmount = Object.keys(response.body.activePricings).length;
      expect(newActivePricingsAmount).toBeGreaterThan(previousActivePricingsAmount);

      // Check if the new pricing is the latest in activePricings
      const parsedPricing = retrievePricingFromPath(newPricingVersionPath);
      expect(
        Object.keys(response.body.activePricings).includes(parsedPricing.version)
      ).toBeTruthy();
    });

    it('Should return 200 even though the service has no archived pricings', async function () {
      const newPricingVersionPath = await getRandomPricingFile(testService.name);

      const response = await request(app)
        .post(`${baseUrl}/services/${testService.name}/pricings`)
        .set('x-api-key', testApiKey)
        .attach('pricing', newPricingVersionPath);
      expect(response.status).toEqual(201);
      expect(response.body.activePricings).toBeDefined();

      const newActivePricingsAmount = Object.keys(response.body.activePricings).length;
      expect(newActivePricingsAmount).toBeGreaterThan(
        Object.keys(testService.activePricings).length
      );
    });

    it('Should return 200 given a pricing with a link', async function () {
      
      const previousActivePricingsAmount = Object.keys(testService.activePricings).length;
      const newPricingVersionPath = await getRandomPricingFile(testService.name);
      const newPricingVersion = fs.readFileSync(newPricingVersionPath, 'utf-8');

      nock('https://test-domain.com')
      .get('/test-pricing.yaml')
      .reply(200, newPricingVersion);

      const response = await request(app)
        .post(`${baseUrl}/services/${testService.name}/pricings`)
        .set('x-api-key', testApiKey)
        .send({
          pricing:
            'https://test-domain.com/test-pricing.yaml',
        });

      expect(response.status).toEqual(201);
      expect(testService.activePricings).toBeDefined();
      expect(Object.keys(response.body.activePricings).length).toBeGreaterThan(
        previousActivePricingsAmount
      );

      // 5. Clean up fetch mock
      nock.cleanAll();
    });

    it('Should return 400 given a pricing with a link that do not coincide in saasName', async function () {
      const newPricingVersionPath = await getRandomPricingFile("random-name");
      const newPricingVersion = fs.readFileSync(newPricingVersionPath, 'utf-8');

      nock('https://test-domain.com')
      .get('/test-pricing.yaml')
      .reply(200, newPricingVersion);

      const response = await request(app)
        .post(`${baseUrl}/services/${testService.name}/pricings`)
        .set('x-api-key', testApiKey)
        .send({
          pricing:
            'https://test-domain.com/test-pricing.yaml',
        });

      expect(response.status).toEqual(400);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /services/{serviceName}/pricings/{pricingVersion}', function () {
    it('Should return 200: Given existent service name and pricing version', async function () {  
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name}/pricings/${testService.activePricings.keys().next().value}`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(response.body.features).toBeDefined();
      expect(Object.keys(response.body.features).length).toBeGreaterThan(0);
      expect(response.body.usageLimits).toBeDefined();
      expect(response.body.plans).toBeDefined();
      expect(response.body.addOns).toBeDefined();
      expect(response.body.id).toBeUndefined();
      expect(response.body._serviceName).toBeUndefined();
      expect(response.body._id).toBeUndefined();
    });

    it('Should return 200: Given existent service name in upper case and pricing version', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name.toUpperCase()}/pricings/${testService.activePricings.keys().next().value}`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(200);
      expect(response.body.features).toBeDefined();
      expect(Object.keys(response.body.features).length).toBeGreaterThan(0);
      expect(response.body.usageLimits).toBeDefined();
      expect(response.body.plans).toBeDefined();
      expect(response.body.addOns).toBeDefined();
      expect(response.body.id).toBeUndefined();
      expect(response.body._serviceName).toBeUndefined();
      expect(response.body._id).toBeUndefined();
    });

    it('Should return 404 due to service not found', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/unexistent-service/pricings/${testService.activePricings.keys().next().value}`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(404);
      expect(response.body.error).toBe('NOT FOUND: Service with name unexistent-service');
    });

    it('Should return 404 due to pricing not found', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${testService.name}/pricings/unexistent-version`)
        .set('x-api-key', testApiKey);
      expect(response.status).toEqual(404);
      expect(response.body.error).toBe(
        `Pricing version unexistent-version not found for service ${testService.name}`
      );
    });
  });

  describe('PUT /services/{serviceName}/pricings/{pricingVersion}', function () {
    it('Should return 200: Changing visibility using default value', async function () {
      
      const pricingToArchiveContent = await addPricingToService(testOrganization.id!, testService.name, undefined, true);
      const versionToArchive = getVersionFromPricing(pricingToArchiveContent);
      const fallbackPlan = getFirstPlanFromPricing(pricingToArchiveContent);
      
      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name}/pricings/${versionToArchive}`)
        .set('x-api-key', testApiKey)
        .send({
          subscriptionPlan: fallbackPlan,
        });
      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body.activePricings).toBeDefined();
      expect(
        Object.keys(responseUpdate.body.activePricings).includes(versionToArchive)
      ).toBeFalsy();
      expect(
        Object.keys(responseUpdate.body.archivedPricings).includes(versionToArchive)
      ).toBeTruthy();
    });

    it('Should return 200: Changing visibility using "archived"', async function () {
      const pricingToArchiveContent = await addPricingToService(testOrganization.id!, testService.name, undefined, true);
      const versionToArchive = getVersionFromPricing(pricingToArchiveContent);
      const fallbackPlan = getFirstPlanFromPricing(pricingToArchiveContent);
      
      const responseUpdate = await request(app)
        .put(
          `${baseUrl}/services/${testService.name}/pricings/${versionToArchive}?availability=archived`
        )
        .set('x-api-key', testApiKey)
        .send({
          subscriptionPlan: fallbackPlan,
        });
      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body.activePricings).toBeDefined();
      expect(
        Object.keys(responseUpdate.body.activePricings).includes(versionToArchive)
      ).toBeFalsy();
      expect(
        Object.keys(responseUpdate.body.archivedPricings).includes(versionToArchive)
      ).toBeTruthy();
    });

    it('Should return 200: Changing visibility using "active"', async function () {
      const archivedVersion = await addArchivedPricingToService(testOrganization.id!, testService.name);

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name}/pricings/${archivedVersion}?availability=active`)
        .set('x-api-key', testApiKey);
      expect(responseUpdate.status).toEqual(200);
      expect(responseUpdate.body.activePricings).toBeDefined();
      expect(
        Object.keys(responseUpdate.body.activePricings).includes(archivedVersion)
      ).toBeTruthy();
      expect(
        Object.keys(responseUpdate.body.archivedPricings).includes(archivedVersion)
      ).toBeFalsy();
    });

    it('Should return 200 and novate all contracts: Changing visibility using "archived"',
      async function () {
        const newPricingContent = await addPricingToService(testOrganization.id!, testService.name, undefined, true);
        const newVersion = getVersionFromPricing(newPricingContent);
        const fallbackPlan = getFirstPlanFromPricing(newPricingContent);
        const versionToArchive = testService.activePricings.keys().next().value;
        
        const testContract = await createTestContract(
          testOrganization.id!,
          [testService],
          app
        );

        const responseUpdate = await request(app)
          .put(
            `${baseUrl}/services/${testService.name}/pricings/${versionToArchive}?availability=archived`
          )
          .set('x-api-key', testApiKey)
          .send({
            subscriptionPlan: fallbackPlan,
          });
        expect(responseUpdate.status).toEqual(200);
        expect(responseUpdate.body.activePricings).toBeDefined();
        expect(
          Object.keys(responseUpdate.body.activePricings).includes(newVersion)
        ).toBeTruthy();
        expect(
          Object.keys(responseUpdate.body.archivedPricings).includes(versionToArchive!)
        ).toBeTruthy();

        const reponseContractsAfter = await request(app)
          .get(`${baseUrl}/contracts`)
          .set('x-api-key', testApiKey)
          .send({ filters: { services: [testService.name] } });

        expect(reponseContractsAfter.status).toEqual(200);
        expect(Array.isArray(reponseContractsAfter.body)).toBe(true);

        for (const contract of reponseContractsAfter.body) {
          expect(contract.contractedServices[testService.name.toLowerCase()]).toBeDefined();
          expect(contract.contractedServices[testService.name.toLowerCase()]).not.toEqual(
            testContract.contractedServices[testService.name.toLowerCase()]
          );
          expect(contract.subscriptionPlans[testService.name.toLowerCase()]).toEqual(
            fallbackPlan
          );
          
          expect(Object.keys(contract.subscriptionAddOns[testService.name.toLowerCase()]).length).toBe(0);

          // Alternative approach with try/catch
          try {
            await isSubscriptionValid({
              contractedServices: contract.contractedServices,
              subscriptionPlans: contract.subscriptionPlans,
              subscriptionAddOns: contract.subscriptionAddOns,
            }, testOrganization.id!);
          } catch (error) {
            expect.fail(`Contract subscription validation failed: ${(error as Error).message}`);
          }
        }
      },
      { timeout: 10000 }
    );

    it('Should return 400: Changing visibility using "invalidValue"', async function () {
      const pricingToArchiveContent = await addPricingToService(testOrganization.id!, testService.name, undefined,true);
      const versionToArchive = getVersionFromPricing(pricingToArchiveContent);
      const fallbackPlan = getFirstPlanFromPricing(pricingToArchiveContent);
      
      const responseUpdate = await request(app)
        .put(
          `${baseUrl}/services/${testService.name}/pricings/${versionToArchive}?availability=invalidValue`
        )
        .set('x-api-key', testApiKey)
        .send({
          subscriptionPlan: fallbackPlan,
        });
      expect(responseUpdate.status).toEqual(400);
      expect(responseUpdate.body.error).toBe(
        'Invalid availability status. Either provide "active" or "archived"'
      );
    });

    it('Should return 400: Changing visibility to archived when is the last activePricing', async function () {
      const versionToArchive = testService.activePricings.keys().next().value;

      const responseUpdate = await request(app)
        .put(`${baseUrl}/services/${testService.name}/pricings/${versionToArchive}`)
        .set('x-api-key', testApiKey);

      expect(responseUpdate.status).toEqual(400);
      expect(responseUpdate.body.error).toBe(
        `You cannot archive the last active pricing for service ${testService.name}`
      );
    });
  });

  describe('DELETE /services/{serviceName}/pricings/{pricingVersion}', function () {
    it('Should return 204', async function () {
      const versionToDelete = await addArchivedPricingToService(testOrganization.id!, testService.name);

      const responseDelete = await request(app)
        .delete(`${baseUrl}/services/${testService.name}/pricings/${versionToDelete}`)
        .set('x-api-key', testApiKey);
      expect(responseDelete.status).toEqual(204);

      const responseAfter = await request(app)
        .get(`${baseUrl}/services/${testService.name}`)
        .set('x-api-key', testApiKey);
      
        expect(responseAfter.status).toEqual(200);
      expect(responseAfter.body.activePricings).toBeDefined();
      expect(Object.keys(responseAfter.body.activePricings).includes(versionToDelete)).toBeFalsy();
    });

    it('Should return 204 with semver pricing version', async function () {
      const versionToDelete = await addArchivedPricingToService(testOrganization.id!, testService.name, "2.0.0");

      const responseDelete = await request(app)
        .delete(`${baseUrl}/services/${testService.name}/pricings/${versionToDelete}`)
        .set('x-api-key', testApiKey);
      expect(responseDelete.status).toEqual(204);

      const responseAfter = await request(app)
        .get(`${baseUrl}/services/${testService.name}`)
        .set('x-api-key', testApiKey);
      expect(responseAfter.status).toEqual(200);
      expect(responseAfter.body.activePricings).toBeDefined();
      expect(Object.keys(responseAfter.body.activePricings).includes(versionToDelete)).toBeFalsy();
    });

    it('Should return 404 since pricing to delete has not been archived before deleting', async function () {
      const versionToDelete = await addPricingToService(testOrganization.id!, testService.name);

      const responseDelete = await request(app)
        .delete(`${baseUrl}/services/${testService.name}/pricings/${versionToDelete}`)
        .set('x-api-key', testApiKey);

      expect(responseDelete.status).toEqual(404);
      expect(responseDelete.body.error).toBe(
        `Invalid request: No archived version ${versionToDelete} found for service ${testService.name}. Remember that a pricing must be archived before it can be deleted.`
      );

      // Necesary to delete
      await archivePricingFromService(testOrganization.id!, testService.name, versionToDelete, app);
      await request(app)
        .delete(`${baseUrl}/services/${testService.name}/pricings/${versionToDelete}`)
        .set('x-api-key', testApiKey)
        .expect(204);
    });

    it('Should return 404: Given an invalid pricing version', async function () {
      const versionToDelete = 'invalid';

      const responseDelete = await request(app)
        .delete(`${baseUrl}/services/${testService.name}/pricings/${versionToDelete}`)
        .set('x-api-key', testApiKey);
      expect(responseDelete.status).toEqual(404);

      expect(responseDelete.body.error).toBe(
        `Invalid request: No archived version ${versionToDelete} found for service ${testService.name}. Remember that a pricing must be archived before it can be deleted.`
      );
    });
  });

  describe('DELETE /services', function () {
    it('Should return 200', async function () {
      // Checks if there are services to delete
      const responseIndexBeforeDelete = await request(app)
        .get(`${baseUrl}/services`)
        .set('x-api-key', testApiKey);

      expect(responseIndexBeforeDelete.status).toEqual(200);
      expect(Array.isArray(responseIndexBeforeDelete.body)).toBe(true);
      expect(responseIndexBeforeDelete.body.length).greaterThan(0);

      // Deletes all services
      const responseDelete = await request(app)
        .delete(`${baseUrl}/services`)
        .set('x-api-key', testApiKey);

      expect(responseDelete.status).toEqual(200);

      // Checks if there are no services after delete
      const responseIndexAfterDelete = await request(app)
        .get(`${baseUrl}/services`)
        .set('x-api-key', testApiKey);

      expect(responseIndexAfterDelete.status).toEqual(200);
      expect(Array.isArray(responseIndexAfterDelete.body)).toBe(true);
      expect(responseIndexAfterDelete.body.length).toBe(0);

      testService.id = undefined;
    });
  });
});
