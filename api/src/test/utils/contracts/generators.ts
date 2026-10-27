import { faker } from '@faker-js/faker';
import { createRandomService, getAllServices, getPricingFromService } from '../services/serviceTestUtils';
import { TestService } from '../../types/models/Service';
import { TestAddOn, TestPricing } from '../../types/models/Pricing';
import { useApp } from '../testApp';
import { ContractToCreate } from '../../../main/types/models/Contract';
import { biasedRandomInt } from '../random';

async function generateContractAndService(
  organizationId: string,
  userId?: string,
  app?: any
): Promise<{ contract: ContractToCreate; services: Record<string, string> }> {
  const appCopy = await useApp(app);

  const contractedServices: Record<string, string> = await _generateNewContractedServices(appCopy);

  const contract = await generateContract(contractedServices, organizationId,userId, appCopy);

  return { contract, services: contractedServices };
}

async function generateContract(
  contractedServices: Record<string, string>,
  organizationId: string,
  userId?: string,
  app?: any,
  groupId?: string
): Promise<ContractToCreate> {
  const appCopy = await useApp(app);

  const servicesToConsiderKeys = faker.helpers.arrayElements(
    Object.keys(contractedServices),
    faker.number.int({ min: 1, max: Object.keys(contractedServices).length })
  );

  const servicesToConsider: Record<string, string> = Object.fromEntries(
    servicesToConsiderKeys.map(key => [key, contractedServices[key]])
  );

  const subscriptionPlans: Record<string, string> = await _generateSubscriptionPlans(
    servicesToConsider,
    organizationId,
    appCopy
  );

  const subscriptionAddOns = await _generateSubscriptionAddOns(
    servicesToConsider,
    subscriptionPlans,
    organizationId,
    appCopy
  );

  return {
    userContact: {
      userId: userId ?? faker.string.uuid(),
      username: faker.internet.username(),
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      email: faker.internet.email(),
      phone: faker.phone.number(),
    },
    billingPeriod: {
      autoRenew: faker.datatype.boolean(),
      renewalDays: faker.helpers.arrayElement([30, 365]),
    },
    organizationId: organizationId,
    groupId: groupId,
    contractedServices: contractedServices,
    subscriptionPlans: subscriptionPlans,
    subscriptionAddOns: subscriptionAddOns,
  };
}

async function generateNovation(organizationId: string, app?: any) {
  const appCopy = await useApp(app);

  const contractedServices: Record<string, string> =
    await _generateExistentContractedServices(appCopy);
  const subscriptionPlans: Record<string, string> = await _generateSubscriptionPlans(
    contractedServices,
    organizationId,
    appCopy
  );
  const subscriptionAddOns: Record<
    string,
    Record<string, number>
  > = await _generateSubscriptionAddOns(contractedServices, subscriptionPlans, organizationId, appCopy);

  return {
    contractedServices: contractedServices,
    subscriptionPlans: subscriptionPlans,
    subscriptionAddOns: subscriptionAddOns,
  };
}

async function _generateNewContractedServices(organizationId: string, app?: any): Promise<Record<string, string>> {
  const appCopy = await useApp(app);

  const contractedServices: Record<string, string> = {};

  for (let i = 0; i < biasedRandomInt(1, 3); i++) {
    const createdService: TestService = await createRandomService(organizationId, appCopy);
    const pricingVersion = Object.keys(createdService.activePricings)[0];
    contractedServices[createdService.name] = pricingVersion;
  }

  return contractedServices;
}

async function _generateExistentContractedServices(organizationId: string, app?: any): Promise<Record<string, string>> {
  const appCopy = await useApp(app);

  const contractedServices: Record<string, string> = {};
  const services = await getAllServices(organizationId, appCopy);

  const randomServices = faker.helpers.arrayElements(
    services,
    biasedRandomInt(1, services.length - 1)
  );

  for (const service of randomServices) {
    const pricingVersion = Object.keys(service.activePricings)[0];
    contractedServices[service.name] = pricingVersion;
  }

  return contractedServices;
}

async function _generateSubscriptionPlans(
  contractedServices: Record<string, string>,
  organizationId: string,
  app?: any
): Promise<Record<string, string>> {
  const appCopy = await useApp(app);

  const subscriptionPlans: Record<string, string> = {};

  for (const serviceName in contractedServices) {
    const pricing = await getPricingFromService(
      serviceName,
      contractedServices[serviceName],
      organizationId,
      appCopy
    );

    if (pricing.plans) {
      subscriptionPlans[serviceName] = faker.helpers.arrayElement(Object.keys(pricing.plans));
    }
  }

  return subscriptionPlans;
}

async function _generateSubscriptionAddOns(
  contractedServices: Record<string, string>,
  subscriptionPlans: Record<string, string>,
  organizationId: string,
  app?: any
): Promise<Record<string, Record<string, number>>> {
  const appCopy = await useApp(app);

  const subscriptionAddOns: Record<string, Record<string, number>> = {};

  const servicesPricings: Record<string, TestPricing> = {};

  for (const serviceName in contractedServices) {
    const pricing = await getPricingFromService(
      serviceName,
      contractedServices[serviceName],
      organizationId,
      appCopy
    );

    servicesPricings[serviceName] = pricing;
  }

  for (const serviceName in servicesPricings) {
    const pricing = servicesPricings[serviceName];
    if (!pricing.addOns) {
      continue;
    }

    if (!subscriptionAddOns[serviceName]) {
      subscriptionAddOns[serviceName] = {};
    }

    const planName = subscriptionPlans[serviceName];

    for (const addOnName in pricing.addOns) {
      const addOn = pricing.addOns[addOnName];

      if (!addOn.availableFor || _addOnAvailableForPlan(addOn.availableFor, planName)) {
        const minQuantity = pricing.addOns[addOnName].subscriptionConstraints?.minQuantity;
        const maxQuantity = pricing.addOns[addOnName].subscriptionConstraints?.maxQuantity;
        const quantityStep = pricing.addOns[addOnName].subscriptionConstraints?.quantityStep;

        const count = faker.number.int({
          min: minQuantity ?? 1,
          max: maxQuantity ?? 1,
          multipleOf: quantityStep ?? 1,
        });
        subscriptionAddOns[serviceName][addOnName] = _isScalableAddon(addOn) ? count : 1;
      }
    }

    _solveAddOnDependenciesAndExclusions(planName, subscriptionAddOns[serviceName], pricing.addOns);
  }

  return subscriptionAddOns;
}

function _addOnAvailableForPlan(availableFor: string[] | undefined, planName: string): boolean {
  return Array.isArray(availableFor) && availableFor.length > 0 && availableFor.includes(planName);
}

function _isScalableAddon(addOn: TestAddOn): boolean {
  return (
    Object.keys(addOn.features ?? {}).length === 0 &&
    Object.keys(addOn.usageLimits ?? {}).length === 0 &&
    Object.keys(addOn.usageLimitsExtensions ?? {}).length > 0
  );
}

function _solveAddOnDependenciesAndExclusions(
  subscriptionPlan: string,
  subscriptionAddOns: Record<string, number>,
  pricingAddons: Record<string, TestAddOn>
): void {
  const maxIterations = 10;
  let iterations = 0;
  let changesMade = true;
  
  while (changesMade && iterations < maxIterations) {
    changesMade = false;
    iterations++;
    
    // Process dependencies
    changesMade = _processDependencies(subscriptionPlan, subscriptionAddOns, pricingAddons) || changesMade;
    
    // Process exclusions
    changesMade = _processExclusions(subscriptionAddOns, pricingAddons) || changesMade;
  }
  
  // If we've reached max iterations, clean up any unresolved conflicts
  if (iterations >= maxIterations) {
    _cleanupUnresolvedConflicts(subscriptionAddOns, pricingAddons);
  }
}

function _processDependencies(
  subscriptionPlan: string,
  subscriptionAddOns: Record<string, number>,
  pricingAddons: Record<string, TestAddOn>
): boolean {
  let changesMade = false;
  
  for (const addOnName in subscriptionAddOns) {
    const pricingAddon = pricingAddons[addOnName];
    
    if (!pricingAddon.dependsOn) continue;
    
    for (const dependency of pricingAddon.dependsOn) {
      if (!subscriptionAddOns[dependency]) {
        if (pricingAddons[dependency]?.availableFor?.includes(subscriptionPlan)) {
          subscriptionAddOns[dependency] = 1;
          changesMade = true;
        } else {
          delete subscriptionAddOns[addOnName];
          changesMade = true;
          break;
        }
      }
    }
  }
  
  return changesMade;
}

function _processExclusions(
  subscriptionAddOns: Record<string, number>,
  pricingAddons: Record<string, TestAddOn>
): boolean {
  let changesMade = false;
  
  for (const addOnName in subscriptionAddOns) {
    const pricingAddon = pricingAddons[addOnName];
    
    if (!pricingAddon.excludes) continue;
    
    for (const exclusion of pricingAddon.excludes) {
      if (subscriptionAddOns[exclusion]) {
        delete subscriptionAddOns[exclusion];
        changesMade = true;
      }
    }
  }
  
  return changesMade;
}

function _cleanupUnresolvedConflicts(
  subscriptionAddOns: Record<string, number>,
  pricingAddons: Record<string, TestAddOn>
): void {
  for (const addOnName in subscriptionAddOns) {
    const pricingAddon = pricingAddons[addOnName];
    
    if (pricingAddon.dependsOn || pricingAddon.excludes) {
      delete subscriptionAddOns[addOnName];
    }
  }
}

export { generateContractAndService, generateContract, generateNovation };
