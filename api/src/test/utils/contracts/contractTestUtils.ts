import { faker } from '@faker-js/faker';
import { ContractToCreate, LeanContract, UsageLevel } from '../../../main/types/models/Contract';
import { baseUrl, getApp, useApp } from '../testApp';
import request from 'supertest';
import { generateContract, generateContractAndService } from './generators';
import { TestContract } from '../../types/models/Contract';
import { getTestAdminApiKey } from '../auth';
import { LeanService } from '../../../main/types/models/Service';
import { createMultipleTestServices } from '../services/serviceTestUtils';
import { LeanUser } from '../../../main/types/models/User';
import { createTestUser } from '../users/userTestUtils';

async function createTestContract(organizationId: string, services: LeanService[], app: any, groupId?: string): Promise<LeanContract> {
  if (!app){
    app = await getApp();
  }
  
  if (services.length === 0) {
    services = await createMultipleTestServices(3, organizationId);
  }

  const contractedServices: Record<string, string> = services.reduce(
    (acc, service) => {
      acc[service.name] = service.activePricings.keys().next().value!;
      return acc;
    },
    {} as Record<string, string>
  );

  const contractData: ContractToCreate = await generateContract(contractedServices, organizationId, undefined, app, groupId);
  const adminUser: LeanUser = await createTestUser('ADMIN');
  const apiKey = adminUser.apiKey;

  try{

    const response = await request(app)
        .post(`${baseUrl}/organizations/${organizationId}/contracts`)
        .set('x-api-key', apiKey)
        .send(contractData);
    
    return response.body as unknown as LeanContract;
  }catch(error){
    console.error('Error creating test contract:', error);
    throw error;
  }
}

async function getAllContracts(app?: any): Promise<any[]> {
  const copyApp = await useApp(app);
  const adminUser: LeanUser = await createTestUser('ADMIN');
  const apiKey = adminUser.apiKey;

  const response = await request(copyApp).get(`${baseUrl}/contracts`).set('x-api-key', apiKey);

  if (response.status !== 200) {
    throw new Error(
      `Failed to fetch contracts. Status: ${response.status}. Body: ${response.body}`
    );
  }

  return response.body;
}

/**
 * Read a contract as a platform ADMIN. A `userId` is only unique within an
 * organization, so the direct route needs `?organizationId=`.
 */
async function getContractByUserId(userId: string, organizationId: string, app?: any): Promise<TestContract> {
  const copyApp = await useApp(app);
  const adminUser: LeanUser = await createTestUser('ADMIN');
  const apiKey = adminUser.apiKey;

  const response = await request(copyApp)
    .get(`${baseUrl}/contracts/${userId}`)
    .query({ organizationId })
    .set('x-api-key', apiKey)
    .expect(200);

  return response.body;
}

async function getRandomContract(app?: any): Promise<any[]> {
  const contracts = await getAllContracts(app);

  const randomIndex = faker.number.int({ min: 0, max: contracts.length - 1 });

  return contracts[randomIndex];
}

async function createRandomContract(organizationId: string, app?: any): Promise<TestContract> {
  const copyApp = await useApp(app);
  const apiKey = await getTestAdminApiKey();

  const { contract } = await generateContractAndService(organizationId, undefined, copyApp);

  const response = await request(copyApp)
    .post(`${baseUrl}/contracts`)
    .set('x-api-key', apiKey)
    .send(contract);

  if (response.status !== 201) {
    throw new Error(`Failed to create contract. Body: ${JSON.stringify(response.body)}`);
  }

  return response.body;
}

async function createRandomContracts(
  organizationId: string,
  amount: number,
  app?: any
): Promise<TestContract[]> {
  const copyApp = await useApp(app);
  const apiKey = await getTestAdminApiKey();

  const createdContracts: TestContract[] = [];

  const { contract, services } = await generateContractAndService(
    organizationId,
    undefined,
    copyApp
  );

  let response = await request(copyApp)
    .post(`${baseUrl}/contracts`)
    .set('x-api-key', apiKey)
    .send(contract);

  if (response.status !== 201) {
    throw new Error(`Failed to create contract. Body: ${JSON.stringify(response.body)}`);
  }

  createdContracts.push(response.body);

  for (let i = 0; i < amount - 1; i++) {
    const generatedContract = await generateContract(services, organizationId, undefined, copyApp);

    response = await request(copyApp)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', apiKey)
      .send(generatedContract);

    if (response.status !== 201) {
      throw new Error(`Failed to create contract. Body: ${JSON.stringify(response.body)}`);
    }

    createdContracts.push(response.body);
  }

  return createdContracts;
}

async function createRandomContractsForService(
  organizationId: string,
  serviceName: string,
  pricingVersion: string,
  amount: number,
  app?: any
): Promise<TestContract[]> {
  const copyApp = await useApp(app);
  const apiKey = await getTestAdminApiKey();

  const createdContracts: TestContract[] = [];

  for (let i = 0; i < amount - 1; i++) {
    const generatedContract = await generateContract(
      { [serviceName]: pricingVersion },
      organizationId,
      undefined,
      copyApp
    );

    const response = await request(copyApp)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', apiKey)
      .send(generatedContract);

    if (response.status !== 201) {
      throw new Error(`Failed to create contract. Body: ${JSON.stringify(response.body)}`);
    }

    createdContracts.push(response.body);
  }

  return createdContracts;
}

async function incrementUsageLevel(
  userId: string,
  organizationId: string,
  serviceName: string,
  usageLimitName: string,
  app?: any
): Promise<TestContract> {
  const copyApp = await useApp(app);
  const apiKey = await getTestAdminApiKey();

  const response = await request(copyApp)
    .put(`${baseUrl}/contracts/${userId}/usageLevels`)
    .query({ organizationId })
    .set('x-api-key', apiKey)
    .send({
      [serviceName]: {
        [usageLimitName]: 5,
      },
    })
    .expect(200);

  return response.body;
}

async function incrementAllUsageLevel(
  userId: string,
  organizationId: string,
  usageLevels: Record<string, Record<string, UsageLevel>>,
  app?: any
): Promise<TestContract> {
  const copyApp = await useApp(app);
  const apiKey = await getTestAdminApiKey();

  const updatedUsageLevels = Object.keys(usageLevels).reduce(
    (acc, serviceName) => {
      acc[serviceName] = Object.keys(usageLevels[serviceName]).reduce(
        (innerAcc, usageLimitName) => {
          innerAcc[usageLimitName] = 5;
          return innerAcc;
        },
        {} as Record<string, number>
      );
      return acc;
    },
    {} as Record<string, Record<string, number>>
  );

  const response = await request(copyApp)
    .put(`${baseUrl}/contracts/${userId}/usageLevels`)
    .query({ organizationId })
    .set('x-api-key', apiKey)
    .send(updatedUsageLevels)
    .expect(200);

  return response.body;
}

async function deleteTestContract(userId: string, organizationId: string, app?: any): Promise<void> {
  const copyApp = await useApp(app);
  const apiKey = await getTestAdminApiKey();

  await request(copyApp)
    .delete(`${baseUrl}/contracts/${userId}`)
    .query({ organizationId })
    .set('x-api-key', apiKey)
    .expect(204);
}

export {
  createTestContract,
  createRandomContracts,
  getContractByUserId,
  getAllContracts,
  getRandomContract,
  createRandomContract,
  createRandomContractsForService,
  incrementAllUsageLevel,
  incrementUsageLevel,
  deleteTestContract
};
