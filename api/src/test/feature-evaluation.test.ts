import request from 'supertest';
import path from 'path';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import container from '../main/config/container';
import { LeanFeature } from '../main/types/models/FeatureEvaluation';
import { LeanService } from '../main/types/models/Service';
import { v4 as uuidv4 } from 'uuid';
import { addMonths, subDays, subMilliseconds } from 'date-fns';
import { verifyPricingToken } from './utils/pricingTokens';
import { LeanContract } from '../main/types/models/Contract';
import { cleanupAuthResources } from './utils/auth';
import { LeanUser } from '../main/types/models/User';
import { createTestUser } from './utils/users/userTestUtils';
import { resetEscapeVersion } from '../main/utils/helpers';
import {
  addApiKeyToOrganization,
  createTestOrganization,
} from './utils/organization/organizationTestUtils';
import { LeanOrganization } from '../main/types/models/Organization';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { addPricingToService } from './utils/services/serviceTestUtils';

const PETCLINIC_PRICING_PATH = path.resolve(__dirname, './data/pricings/petclinic-2025.yml');

const DETAILED_EVALUATION_EXPECTED_RESULT = {
  'petclinic-pets': {
    eval: true,
    used: {
      'petclinic-maxPets': 0,
    },
    limit: {
      'petclinic-maxPets': 6,
    },
    error: null,
  },
  'petclinic-visits': {
    eval: true,
    used: {
      'petclinic-maxVisits': 0,
    },
    limit: {
      'petclinic-maxVisits': 9,
    },
    error: null,
  },
  'petclinic-multiDependentFeature': {
    eval: true,
    used: {
      'petclinic-maxPets': 0,
      'petclinic-maxVisits': 0,
    },
    limit: {
      'petclinic-maxVisits': 9,
      'petclinic-maxPets': 6,
    },
    error: null,
  },
  'petclinic-calendar': {
    eval: true,
    used: {
      'petclinic-calendarEventsCreationLimit': 0,
    },
    limit: {
      'petclinic-calendarEventsCreationLimit': 15,
    },
    error: null,
  },
  'petclinic-vetSelection': { eval: true, used: null, limit: null, error: null },
  'petclinic-consultations': { eval: false, used: null, limit: null, error: null },
  'petclinic-petsDashboard': { eval: false, used: null, limit: null, error: null },
  'petclinic-lowSupportPriority': { eval: true, used: null, limit: null, error: null },
  'petclinic-mediumSupportPriority': { eval: true, used: null, limit: null, error: null },
  'petclinic-highSupportPriority': { eval: false, used: null, limit: null, error: null },
  'petclinic-slaCoverage': { eval: true, used: null, limit: null, error: null },
  'petclinic-petAdoptionCentre': { eval: true, used: null, limit: null, error: null },
  'petclinic-smartClinicReports': { eval: false, used: null, limit: null, error: null },
};

function isActivePricing(pricingVersion: string, service: LeanService): boolean {
  // Normalize version (convert underscores to dots)
  const normalizedVersion = resetEscapeVersion(pricingVersion);
  
  // Handle both Map and plain object (from API responses)
  if (service.activePricings instanceof Map) {
    return service.activePricings.has(normalizedVersion);
  }
  // Handle plain object from API responses
  return Object.prototype.hasOwnProperty.call(service.activePricings, normalizedVersion);
}

function isArchivedPricing(pricingVersion: string, service: LeanService): boolean {
  if (!service.archivedPricings) {
    return false;
  }
  
  // Normalize version (convert underscores to dots)
  const normalizedVersion = resetEscapeVersion(pricingVersion);
  
  // Handle both Map and plain object (from API responses)
  if (service.archivedPricings instanceof Map) {
    return service.archivedPricings.has(normalizedVersion);
  }
  // Handle plain object from API responses
  return Object.prototype.hasOwnProperty.call(service.archivedPricings, normalizedVersion);
}

describe('Features API Test Suite', function () {
  let app: Server;
  let adminUser: LeanUser;
  let ownerUser: LeanUser;
  let testOrganization: LeanOrganization;
  let testOrganizationApiKey: string;
  let testService: LeanService;

  beforeAll(async function () {
    app = await getApp();
    adminUser = await createTestUser('ADMIN');
    ownerUser = await createTestUser('USER');
    testOrganization = await createTestOrganization(ownerUser.username);
    testOrganizationApiKey = generateOrganizationApiKey();

    // Add API key to organization
    await addApiKeyToOrganization(testOrganization.id!, {
      key: testOrganizationApiKey,
      scope: 'ALL',
    });

    const response = await request(app)
      .post(`${baseUrl}/organizations/${testOrganization.id}/services`)
      .set('x-api-key', adminUser.apiKey)
      .attach('pricing', PETCLINIC_PRICING_PATH);

    expect(response.status).toEqual(201);
    testService = response.body;
  });

  afterAll(async function () {
    await cleanupAuthResources();
    await shutdownApp();
  });

  async function createPetclinicTestContract(userId = uuidv4()) {
    const contractData = {
      userContact: {
        userId,
        username: 'tUser',
      },
      billingPeriod: {
        autoRenew: true,
        renewalDays: 365,
      },
      organizationId: testOrganization.id!,
      contractedServices: {
        [testService.name]: Object.keys(testService.activePricings)[0],
      },
      subscriptionPlans: {
        [testService.name]: 'GOLD',
      },
      subscriptionAddOns: {
        [testService.name]: {
          petAdoptionCentre: 1,
          extraPets: 2,
          extraVisits: 6,
        },
      },
    };

    const createContractResponse = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', testOrganizationApiKey)
      .send(contractData);

    return createContractResponse.body;
  }

  describe('GET /features', function () {
    it('Should return 200 and the features', async function () {
      const response = await request(app)
        .get(`${baseUrl}/features?show=all`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(response.body.length).toBeGreaterThan(0);
    });

    it('Should filter features by featureName', async function () {
      const featureName = 'pets';
      const response = await request(app)
        .get(`${baseUrl}/features?featureName=${featureName}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(
        response.body.some((feature: LeanFeature) => feature.info.name === featureName)
      ).toBeTruthy();
    });

    it('Should filter features by serviceName', async function () {
      const serviceName = 'petclinic';
      const response = await request(app)
        .get(`${baseUrl}/features?serviceName=${serviceName}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(
        response.body.every(
          (feature: LeanFeature) => feature.service.toLowerCase() === serviceName.toLowerCase()
        )
      ).toBeTruthy();
    });

    it('Should filter features by pricingVersion', async function () {
      const pricingVersion = '2025-03-26';
      await addPricingToService(testOrganization.id!, testService.name, '2.0.0');

      const response = await request(app)
        .get(`${baseUrl}/features?pricingVersion=${pricingVersion}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(
        response.body.every((feature: LeanFeature) => feature.pricingVersion === pricingVersion)
      ).toBeTruthy();
    });

    it('Should paginate results using page parameter', async function () {
      const page = 1;
      const limit = 5;
      const response = await request(app)
        .get(`${baseUrl}/features?page=${page}&limit=${limit}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(response.body.length).toBeLessThanOrEqual(limit);
    });

    it('Should paginate results using offset parameter', async function () {
      const offset = 2;
      const limit = 5;
      const response = await request(app)
        .get(`${baseUrl}/features?offset=${offset}&limit=${limit}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(response.body.length).toBeLessThanOrEqual(limit);
    });

    it('Should sort results by featureName in ascending order', async function () {
      const response = await request(app)
        .get(`${baseUrl}/features?sort=featureName&order=asc`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();

      // Check if sorted correctly
      const sortedFeatures = [...response.body].sort((a, b) =>
        a.info.name.localeCompare(b.info.name)
      );
      expect(response.body).toEqual(sortedFeatures);
    });

    it('Should sort results by serviceName in descending order', async function () {
      const response = await request(app)
        .get(`${baseUrl}/features?sort=serviceName&order=desc`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();

      // Check if sorted correctly
      const sortedFeatures = [...response.body].sort((a, b) => b.service.localeCompare(a.service));
      expect(response.body).toEqual(sortedFeatures);
    });

    it('Should show only active features by default', async function () {
      const response = await request(app)
        .get(`${baseUrl}/features`)
        .set('x-api-key', testOrganizationApiKey);
      const responseServices = await request(app)
        .get(`${baseUrl}/services`)
        .set('x-api-key', testOrganizationApiKey);

      const services = responseServices.body;

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      // For each feature, check that its pricing version is active for its corresponding service
      expect(
        response.body.every((feature: LeanFeature) => {
          const service = services.find((s: LeanService) => s.name === feature.service);
          return service && isActivePricing(feature.pricingVersion, service);
        })
      ).toBeTruthy();
    });

    it('Should show only archived features when specified', async function () {
      const response = await request(app)
        .get(`${baseUrl}/features?show=archived`)
        .set('x-api-key', testOrganizationApiKey);
      const responseServices = await request(app)
        .get(`${baseUrl}/services`)
        .set('x-api-key', testOrganizationApiKey);

      const services = responseServices.body;

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(
        response.body.every((feature: LeanFeature) => {
          const service = services.find((s: LeanService) => s.name === feature.service);
          return service && isArchivedPricing(feature.pricingVersion, service);
        })
      ).toBeTruthy();
    });

    it('Should combine multiple query parameters correctly', async function () {
      const serviceName = 'petclinic';
      const limit = 5;
      const sort = 'featureName';

      const response = await request(app)
        .get(`${baseUrl}/features?serviceName=${serviceName}&limit=${limit}&sort=${sort}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
      expect(response.body.length).toBeLessThanOrEqual(limit);
      expect(
        response.body.every(
          (feature: LeanFeature) => feature.service.toLowerCase() === serviceName.toLowerCase()
        )
      ).toBeTruthy();

      // Check if sorted correctly
      const sortedFeatures = [...response.body].sort((a, b) =>
        a.info.name.localeCompare(b.info.name)
      );
      expect(response.body).toEqual(sortedFeatures);
    });

    it('Should handle invalid query parameters gracefully', async function () {
      const response = await request(app)
        .get(`${baseUrl}/features?invalidParam=value`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBeTruthy();
    });
  });

  describe('POST /features/:userId', function () {
    it('Should return 200 and the evaluation for a user', async function () {
      const newContract = await createPetclinicTestContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${newContract.userContact.userId}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toEqual({
        'petclinic-pets': true,
        'petclinic-visits': true,
        "petclinic-multiDependentFeature": true,
        'petclinic-calendar': true,
        'petclinic-vetSelection': true,
        'petclinic-consultations': false,
        'petclinic-petsDashboard': false,
        'petclinic-lowSupportPriority': true,
        'petclinic-mediumSupportPriority': true,
        'petclinic-highSupportPriority': false,
        'petclinic-slaCoverage': true,
        'petclinic-petAdoptionCentre': true,
        'petclinic-smartClinicReports': false,
      });
    });

    it('Should return 200 and evaluation for a user with plan case mismatch', async function () {
      const contractData = {
        userContact: {
          userId: uuidv4(),
          username: 'tUserCaseTest',
        },
        billingPeriod: {
          autoRenew: true,
          renewalDays: 365,
        },
        organizationId: testOrganization.id!,
        contractedServices: {
          [testService.name]: Object.keys(testService.activePricings)[0],
        },
        subscriptionPlans: {
          [testService.name]: 'platinum', // Use lowercase while pricing has PLATINUM
        },
        subscriptionAddOns: {
          [testService.name]: {
            petAdoptionCentre: 1,
            extraPets: 2,
            extraVisits: 6,
          },
        },
      };

      const createContractResponse = await request(app)
        .post(`${baseUrl}/contracts`)
        .set('x-api-key', testOrganizationApiKey)
        .send(contractData);

      expect(createContractResponse.status).toEqual(201);

      const response = await request(app)
        .post(`${baseUrl}/features/${contractData.userContact.userId}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toBeDefined();
      expect(Object.keys(response.body).length).toBeGreaterThan(0);
      // Verify that the features are evaluated correctly despite the plan case mismatch
      expect(response.body['petclinic-pets']).toBeTruthy();
      expect(response.body['petclinic-visits']).toBeTruthy();
    });

    it('Should return 200 and visits as false since its limit has been reached', async function () {
      const testUserId = uuidv4();
      await createPetclinicTestContract(testUserId);

      // Reach the limit of 9 visits
      await request(app)
        .put(`${baseUrl}/contracts/${testUserId}/usageLevels`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [testService.name.toLowerCase()]: {
            maxVisits: 9,
          },
        });

      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body['petclinic-visits']).toBeFalsy();
    });

    it('Given expired user subscription but with autoRenew = true should return 200', async function () {
      const testUserId = uuidv4();
      await createPetclinicTestContract(testUserId);

      // Expire user subscription
      await request(app)
        .put(`${baseUrl}/contracts/${testUserId}/billingPeriod`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          endDate: subDays(new Date(), 1),
          autoRenew: true,
        });

      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(Object.keys(response.body).length).toBeGreaterThan(0);

      const userContract = (
        await request(app)
          .get(`${baseUrl}/contracts/${testUserId}`)
          .set('x-api-key', testOrganizationApiKey)
      ).body;
      expect(new Date(userContract.billingPeriod.endDate).getFullYear()).toBe(
        new Date().getFullYear() + 1
      ); // + 1 year because the test contract is set to renew 1 year
    });

    it('Given expired user subscription with autoRenew = false should return 400', async function () {
      const testUserId = uuidv4();
      await createPetclinicTestContract(testUserId);

      // Expire user subscription
      await request(app)
        .put(`${baseUrl}/contracts/${testUserId}/billingPeriod`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          endDate: subMilliseconds(new Date(), 1),
          autoRenew: false,
        });

      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(400);
      expect(response.body.error).toEqual(
        'Invalid subscription: Your susbcription has expired and it is not set to renew automatically. To continue accessing the features, please purchase any subscription.'
      );
    });

    it('Should return 200 and a detailed evaluation for a user', async function () {
      const newContract = await createPetclinicTestContract();

      const response = await request(app)
        .post(`${baseUrl}/features/${newContract.userContact.userId}?details=true`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toEqual(DETAILED_EVALUATION_EXPECTED_RESULT);
    });
  });

  describe('POST /features/:userId/pricing-token', function () {
    it('Should return 200 and the evaluation for a user', async function () {
      const userId = uuidv4();
      const newContract = await createPetclinicTestContract(userId);

      const response = await request(app)
        .post(`${baseUrl}/features/${userId}/pricing-token`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body.pricingToken).toBeDefined();

      const token = response.body.pricingToken;

      // Verified the way an organization does: published public keys, ES256 only,
      // pinning the issuer and the organization it serves.
      const { payload, protectedHeader } = await verifyPricingToken(app, token, {
        issuer: process.env.JWT_ISSUER || 'space',
        audience: newContract.organizationId,
      });

      expect(protectedHeader).toBeDefined();
      expect(protectedHeader.alg).toEqual('ES256');
      expect(protectedHeader.kid).toBeDefined();
      expect(payload).toBeDefined();
      expect(payload.features).toEqual(DETAILED_EVALUATION_EXPECTED_RESULT);
      expect(payload.sub).toEqual(
        `urn:space:${newContract.organizationId}:${encodeURIComponent(newContract.userContact.userId)}`
      );
      expect(payload.userId).toEqual(newContract.userContact.userId);
      expect(payload.organizationId).toEqual(newContract.organizationId);
      expect(payload.aud).toEqual(newContract.organizationId);
      expect(payload.iss).toEqual(process.env.JWT_ISSUER || 'space');
      expect(payload.pricingContext).toBeDefined();
      expect(payload.subscriptionContext).toBeDefined();
    });
  });

  describe('POST /features/:userId/:featureId', function () {
    let testUserId: string;
    let testFeatureId: string;
    let testUsageLimitId: string;

    beforeEach(async function () {
      const newContract: LeanContract = await createPetclinicTestContract();
      const testServiceName = Object.keys(newContract.usageLevels)[0].toLowerCase();
      const testFeatureName = 'visits';
      const testUsageLimitName = 'maxVisits';
      testUserId = newContract.userContact.userId;
      testFeatureId = `${testServiceName}-${testFeatureName}`;
      testUsageLimitId = `${testServiceName}-${testUsageLimitName}`;
    });

    it('Should return 200 and the feature evaluation', async function () {
      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}/${testFeatureId}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body).toEqual({
        used: {
          [testUsageLimitId]: 0,
        },
        limit: {
          [testUsageLimitId]: 9,
        },
        eval: true,
        error: null,
      });
    });

    it('Should return 200: Given expected consumption', async function () {
      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}/${testFeatureId}`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [testUsageLimitId]: 1,
        });

      expect(response.status).toEqual(200);
      expect(response.body).toEqual({
        used: {
          [testUsageLimitId]: 1,
        },
        limit: {
          [testUsageLimitId]: 9,
        },
        eval: true,
        error: null,
        consumptionId: expect.any(String),
      });

      const contractAfter = (
        await request(app)
          .get(`${baseUrl}/contracts/${testUserId}`)
          .set('x-api-key', testOrganizationApiKey)
      ).body;
      expect(contractAfter.usageLevels).toBeDefined();

      const usageLevelService = testUsageLimitId.split('-')[0];
      const usageLevelName = testUsageLimitId.split('-')[1];

      expect(contractAfter.usageLevels[usageLevelService][usageLevelName]).toBeDefined();
      expect(contractAfter.usageLevels[usageLevelService][usageLevelName].consumed).toEqual(1);
    });

    it('Should return 200 and INVALID_EXPECTED_CONSUMPTION: Given incomplete expected consumption', async function () {
      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}/petclinic-multiDependentFeature`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [testUsageLimitId]: 1,
        });

      expect(response.status).toEqual(200);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe("INVALID_EXPECTED_CONSUMPTION");
    })

    it('Should return 200: Given expired renewable usage level', async function () {
      const serviceName = testUsageLimitId.split('-')[0];
      const usageLevelName = testUsageLimitId.split('-')[1];

      await request(app)
        .put(`${baseUrl}/contracts/${testUserId}/usageLevels`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [serviceName]: {
            [usageLevelName]: 4,
          },
        });

      const contractBefore = (
        await request(app)
          .get(`${baseUrl}/contracts/${testUserId}`)
          .set('x-api-key', testOrganizationApiKey)
      ).body;
      expect(contractBefore.usageLevels).toBeDefined();
      expect(contractBefore.usageLevels[serviceName]).toBeDefined();
      expect(contractBefore.usageLevels[serviceName][usageLevelName]).toBeDefined();
      expect(contractBefore.usageLevels[serviceName][usageLevelName].consumed).toEqual(4);

      vi.useFakeTimers();
      vi.setSystemTime(addMonths(new Date(), 2)); // Enough to expire the renewable usage level

      const cacheService = container.resolve('cacheService');
      const cacheGetSpy = vi.spyOn(cacheService, 'get').mockResolvedValue(null);
      const cacheSetSpy = vi.spyOn(cacheService, 'set').mockResolvedValue(undefined);
      const cacheMatchSpy = vi.spyOn(cacheService, 'match').mockResolvedValue([]);
      const cacheDelSpy = vi.spyOn(cacheService, 'del').mockResolvedValue(undefined);

      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}/${testFeatureId}`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [testUsageLimitId]: 1,
        });

      expect(response.status).toEqual(200);
      expect(response.body).toEqual({
        used: {
          [testUsageLimitId]: 1,
        },
        limit: {
          [testUsageLimitId]: 9,
        },
        eval: true,
        error: null,
        consumptionId: expect.any(String),
      });

      const contractAfter = (
        await request(app)
          .get(`${baseUrl}/contracts/${testUserId}`)
          .set('x-api-key', testOrganizationApiKey)
      ).body;
      expect(contractAfter.usageLevels).toBeDefined();
      expect(contractAfter.usageLevels[serviceName][usageLevelName]).toBeDefined();
      expect(contractAfter.usageLevels[serviceName][usageLevelName].consumed).toEqual(1);

      cacheGetSpy.mockRestore();
      cacheSetSpy.mockRestore();
      cacheMatchSpy.mockRestore();
      cacheDelSpy.mockRestore();
      vi.useRealTimers();
    });

    it('Should return 200: Given expired renewable usage levels should reset all and evaluate one', async function () {
      const serviceName = testUsageLimitId.split('-')[0];
      const usageLevelName = testUsageLimitId.split('-')[1];

      await request(app)
        .put(`${baseUrl}/contracts/${testUserId}/usageLevels`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [serviceName]: {
            [usageLevelName]: 4,
            calendarEventsCreationLimit: 10,
          },
        });

      const contractBefore = (
        await request(app)
          .get(`${baseUrl}/contracts/${testUserId}`)
          .set('x-api-key', testOrganizationApiKey)
      ).body;
      expect(contractBefore.usageLevels).toBeDefined();
      expect(contractBefore.usageLevels[serviceName]).toBeDefined();
      expect(contractBefore.usageLevels[serviceName][usageLevelName]).toBeDefined();
      expect(contractBefore.usageLevels[serviceName][usageLevelName].consumed).toEqual(4);

      vi.useFakeTimers();
      vi.setSystemTime(addMonths(new Date(), 2)); // Enough to expire the renewable usage level

      const cacheService = container.resolve('cacheService');
      const cacheGetSpy = vi.spyOn(cacheService, 'get').mockResolvedValue(null);
      const cacheSetSpy = vi.spyOn(cacheService, 'set').mockResolvedValue(undefined);
      const cacheMatchSpy = vi.spyOn(cacheService, 'match').mockResolvedValue([]);
      const cacheDelSpy = vi.spyOn(cacheService, 'del').mockResolvedValue(undefined);

      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}/${testFeatureId}`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [testUsageLimitId]: 1,
        });

      expect(response.status).toEqual(200);
      expect(response.body).toEqual({
        used: {
          [testUsageLimitId]: 1,
        },
        limit: {
          [testUsageLimitId]: 9,
        },
        eval: true,
        error: null,
        consumptionId: expect.any(String),
      });

      const contractAfter = (
        await request(app)
          .get(`${baseUrl}/contracts/${testUserId}`)
          .set('x-api-key', testOrganizationApiKey)
      ).body;
      expect(contractAfter.usageLevels).toBeDefined();
      expect(contractAfter.usageLevels[serviceName][usageLevelName]).toBeDefined();
      expect(contractAfter.usageLevels[serviceName][usageLevelName].consumed).toEqual(1);
      expect(contractAfter.usageLevels[serviceName].calendarEventsCreationLimit).toBeDefined();
      expect(contractAfter.usageLevels[serviceName].calendarEventsCreationLimit.consumed).toEqual(
        0
      );

      cacheGetSpy.mockRestore();
      cacheSetSpy.mockRestore();
      cacheMatchSpy.mockRestore();
      cacheDelSpy.mockRestore();
      vi.useRealTimers();
    });

    it('Should return 200 and revert usageLimit', async function () {
      const evaluationResponse = await request(app)
        .post(`${baseUrl}/features/${testUserId}/${testFeatureId}`)
        .set('x-api-key', testOrganizationApiKey)
        .send({
          [testUsageLimitId]: 5,
        });

      expect(evaluationResponse.status).toEqual(200);
      expect(evaluationResponse.body.used[testUsageLimitId]).toEqual(5);

      const revertResponse = await request(app)
        .post(`${baseUrl}/features/${testUserId}/${testFeatureId}?revert=true`)
        .set('x-api-key', testOrganizationApiKey);

      expect(revertResponse.status).toEqual(204);

      const contractAfterRevert = await request(app)
        .get(`${baseUrl}/contracts/${testUserId}`)
        .set('x-api-key', testOrganizationApiKey);

      expect(contractAfterRevert.status).toEqual(200);
      expect(contractAfterRevert.body.usageLevels[testFeatureId.split("-")[0]][testUsageLimitId.split("-")[1]].consumed).toEqual(0);
    });

    it('Should return 200 and error for non-existing feature', async function () {
      const response = await request(app)
        .post(`${baseUrl}/features/${testUserId}/non-existing-feature`)
        .set('x-api-key', testOrganizationApiKey);

      expect(response.status).toEqual(200);
      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe("FLAG_NOT_FOUND");
    });
  });
});
