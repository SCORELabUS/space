import ServiceModel from '../repositories/mongoose/models/ServiceMongoose';
import ContractModel from '../repositories/mongoose/models/ContractMongoose';
import { withOrganizationLock } from './sphere/lock';
import { enforceSpherePolicy } from './sphere/contractPolicy';
import container from '../config/container';
import {
  ContractToCreate,
  LeanContract,
  UsageLevel,
  UsageLevelsResetQuery,
  UserContact,
} from '../types/models/Contract';
import ContractRepository from '../repositories/mongoose/ContractRepository';
import { validateContractQueryFilters } from './validation/ContractServiceValidation';
import ServiceService from './ServiceService';
import { LeanPricing, LeanUsageLimit } from '../types/models/Pricing';
import { addDays, isAfter } from 'date-fns';
import { isSubscriptionValid } from '../controllers/validation/ContractValidation';
import { performNovation } from '../utils/contracts/novation';
import CacheService from './CacheService';
import {
  addPeriodToDate,
  convertKeysToLowercase,
  escapeVersion,
  resetEscapeVersion,
} from '../utils/helpers';
import {
  generateUsageLevels,
  resetEscapeContractedServiceVersions,
} from '../utils/contracts/helpers';
import { query } from 'express';
import { LeanUser } from '../types/models/User';

class ContractService {
  private readonly contractRepository: ContractRepository;
  private readonly serviceService: ServiceService;
  private readonly cacheService: CacheService;

  constructor() {
    this.contractRepository = container.resolve('contractRepository');
    this.serviceService = container.resolve('serviceService');
    this.cacheService = container.resolve('cacheService');
    // Serialize binding mutations with synchronization. Consumption uses conditional atomic writes separately.
    for (const method of ['create', 'novate', 'novateByGroupId', 'renew', 'destroy', 'novateUserContact', 'novateBillingPeriod', 'novateBillingPeriodByGroupId', 'resetUsageLevels', '_revertExpectedConsumption'] as const) {
      const original = (this[method] as (...args: any[]) => Promise<any>).bind(this);
      (this as any)[method] = async (...args: any[]) => {
        const contract: any = method === 'create' || method.endsWith('ByGroupId') ? null :
          await ContractModel.findOne({ 'userContact.userId': args[0] }).lean();
        const org = method === 'create' ? args[0]?.organizationId : method.endsWith('ByGroupId') ? args[1] : contract?.organizationId;
        if (!org || !await ServiceModel.exists({ organizationId: org, source: 'sphere' })) return original(...args);
        return withOrganizationLock(org, async assertOwned => {
          if (await ServiceModel.exists({ organizationId: org, source: 'sphere', 'sphere.status': 'applying' })) throw new Error('Synchronization is applying; retry shortly');
          if (contract) await this.cacheService.del(`contracts.${contract.userContact.userId}`);
          await assertOwned();
          const result = await original(...args);
          const services = await ServiceModel.find({ organizationId: org, source: 'sphere' }).select('_id').lean();
          for (const service of services) await container.resolve('sphereSyncService').cleanup(String(service._id), assertOwned);
          return result;
        });
      };
    }

  }

  async index(queryParams: any, organizationId?: string): Promise<LeanContract[]> {
    const errors = validateContractQueryFilters(queryParams);

    if (errors.length > 0) {
      throw new Error(
        'Errors where found during validation of query params: ' + errors.join(' | ')
      );
    }

    queryParams.organizationId = organizationId;

    const contracts: LeanContract[] = await this.contractRepository.findByFilters(queryParams);

    for (const contract of contracts) {
      contract.contractedServices = resetEscapeContractedServiceVersions(
        contract.contractedServices
      );
    }

    return contracts;
  }

  async count(queryParams: any, organizationId?: string): Promise<number> {
    const errors = validateContractQueryFilters(queryParams);

    if (errors.length > 0) {
      throw new Error(
        'Errors where found during validation of query params: ' + errors.join(' | ')
      );
    }

    queryParams.organizationId = organizationId;

    return this.contractRepository.countByFilters(queryParams);
  }

  async show(userId: string): Promise<LeanContract> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
      await this.cacheService.set(`contracts.${userId}`, contract, 3600, true); // Cache for 1 hour
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);

    return contract;
  }

  async create(contractData: ContractToCreate): Promise<LeanContract> {
    // Prevent creating more than one contract per userId
    if (!contractData || !contractData.userContact || !contractData.userContact.userId) {
      throw new Error('Invalid request: Missing userContact.userId');
    }

    if (!contractData.organizationId) {
      throw new Error('INVALID DATA: Missing organizationId');
    }

    const existingContract = await this.contractRepository.findByUserId(
      contractData.userContact.userId
    );

    if (existingContract) {
      throw new Error(
        `CONFLICT: Contract for user ${contractData.userContact.userId} already exists`
      );
    }

    await enforceSpherePolicy(contractData.organizationId, contractData);

    const servicesKeys = Object.keys(contractData.contractedServices || {}).map(key =>
      key.toLowerCase()
    );
    const services = await this.serviceService.indexByNames(
      servicesKeys,
      contractData.organizationId
    );

    if (!services || services.length === 0) {
      throw new Error(`Invalid contract: Services not found: ${servicesKeys.join(', ')}`);
    }

    if (services && servicesKeys.length !== services.length) {
      const missingServices = servicesKeys.filter(
        key => !services.some(service => service.name.toLowerCase() === key.toLowerCase())
      );
      throw new Error(`Invalid contract: Services not found: ${missingServices.join(', ')}`);
    }

    for (const serviceName in contractData.contractedServices) {
      const pricingVersion = escapeVersion(contractData.contractedServices[serviceName]);
      const service = services.find(s => s.name.toLowerCase() === serviceName.toLowerCase());

      if (!service) {
        throw new Error(`Invalid contract: Services not found: ${serviceName}`);
      }

      if (!service.activePricings.get(pricingVersion)) {
        throw new Error(
          `Invalid contract: Pricing version ${pricingVersion} for service ${serviceName} not found`
        );
      }

      contractData.contractedServices[serviceName] = escapeVersion(pricingVersion); // Ensure the version is stored correctly
    }

    const startDate = new Date();
    const renewalDays = contractData.billingPeriod?.renewalDays ?? 30; // Default to 30 days if not provided
    const endDate = addDays(new Date(startDate), renewalDays);

    // Convert keys to lowercase for contractedServices, subscriptionPlans and subscriptionAddOns
    contractData.contractedServices = convertKeysToLowercase(contractData.contractedServices);
    contractData.subscriptionPlans = convertKeysToLowercase(contractData.subscriptionPlans);
    contractData.subscriptionAddOns = convertKeysToLowercase(contractData.subscriptionAddOns);

    const contractDataToCreate: LeanContract = {
      ...contractData,
      billingPeriod: {
        startDate: startDate,
        endDate: endDate,
        autoRenew: contractData.billingPeriod?.autoRenew ?? false,
        renewalDays: renewalDays,
      },
      usageLevels:
        (await this._createUsageLevels(
          contractData.contractedServices,
          contractData.organizationId
        )) || {},
      history: [],
    };
    try {
      await isSubscriptionValid(
        {
          contractedServices: contractData.contractedServices,
          subscriptionPlans: contractData.subscriptionPlans,
          subscriptionAddOns: contractData.subscriptionAddOns,
        },
        contractData.organizationId
      );
    } catch (error) {
      throw new Error(`Invalid subscription: ${error}`);
    }

    const contract = await this.contractRepository.create(contractDataToCreate);

    contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);

    await this.cacheService.set(`contracts.${contract.userContact.userId}`, contract, 3600, true); // Cache for 1 hour

    return contract;
  }

  async novate(userId: string, newSubscription: any): Promise<LeanContract> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    await enforceSpherePolicy(contract.organizationId, newSubscription, contract);
    await isSubscriptionValid(newSubscription, contract.organizationId);

    const newContract = performNovation(contract, newSubscription);

    const result = await this.contractRepository.update(userId, newContract);

    if (!result) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    result.contractedServices = resetEscapeContractedServiceVersions(result.contractedServices);

    await this.cacheService.set(`contracts.${userId}`, result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(`features.${userId}.*`);

    return result;
  }
  
  async novateByGroupId(groupId: string, organizationId: string, newSubscription: any): Promise<LeanContract[]> {
    const contracts = await this.index({ groupId }, organizationId);

    if (!contracts || contracts.length === 0) {
      throw new Error(`INVALID DATA: No contracts found with groupId ${groupId} within organization ${organizationId}`);
    }

    const updatedContracts: LeanContract[] = [];

    for (const contract of contracts) {
      await enforceSpherePolicy(contract.organizationId, newSubscription, contract);
    await isSubscriptionValid(newSubscription, contract.organizationId);
      const newContract = performNovation(contract, newSubscription);
      updatedContracts.push(newContract);
    }

    const result = await this.contractRepository.bulkUpdate(updatedContracts);

    if (!result) {
      throw new Error(`Failed to update contracts for groupId ${groupId} within organization ${organizationId}`);
    }

    const contractsToReturn = await this.index({ groupId }, organizationId);

    for (const contract of contractsToReturn) {
      contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);
      this.cacheService.set(`contracts.${contract.userContact.userId}`, contract, 3600, true); // Cache for 1 hour
      this.cacheService.del(`features.${contract.userContact.userId}.*`);
    }

    return contractsToReturn;
  }

  async renew(userId: string): Promise<LeanContract> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    if (!contract.billingPeriod.autoRenew) {
      throw new Error(
        `Contract with userId ${userId} is not set to auto-renew. It must be renewed manually.`
      );
    }

    const newEndDate = addDays(
      new Date(contract.billingPeriod.endDate),
      contract.billingPeriod.renewalDays
    );
    contract.billingPeriod.endDate = newEndDate;

    const result = await this.contractRepository.update(userId, contract);

    if (!result) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    result.contractedServices = resetEscapeContractedServiceVersions(result.contractedServices);

    await this.cacheService.set(`contracts.${userId}`, result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(`features.${userId}.*`);

    return result;
  }

  async novateUserContact(
    userId: string,
    userContact: Omit<UserContact, 'userId'>
  ): Promise<LeanContract> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    contract.userContact = {
      ...contract.userContact,
      ...userContact,
    };

    const result = await this.contractRepository.update(userId, contract);

    if (!result) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    result.contractedServices = resetEscapeContractedServiceVersions(result.contractedServices);

    await this.cacheService.set(`contracts.${userId}`, result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(`features.${userId}.*`);

    return result;
  }

  async novateBillingPeriod(
    userId: string,
    newBillingPeriod: { endDate: Date; autoRenew: boolean; renewalDays: number }
  ): Promise<LeanContract> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    if (new Date(newBillingPeriod.endDate) < new Date(contract.billingPeriod.startDate)) {
      throw new Error('End date cannot be before the start date');
    }

    contract.billingPeriod = {
      ...contract.billingPeriod,
      ...newBillingPeriod,
    };

    const result = await this.contractRepository.update(userId, contract);

    if (!result) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    result.contractedServices = resetEscapeContractedServiceVersions(result.contractedServices);

    await this.cacheService.set(`contracts.${userId}`, result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(`features.${userId}.*`);

    return result;
  }
  
  async novateBillingPeriodByGroupId(
    groupId: string,
    organizationId: string,
    newBillingPeriod: { endDate: Date; autoRenew: boolean; renewalDays: number }
  ): Promise<LeanContract[]> {

    const contracts = await this.index({ groupId: groupId }, organizationId);

    if (!contracts || contracts.length === 0) {
      throw new Error(`INVALID DATA: Contract with groupId ${groupId} not found within organization ${organizationId}`);
    }

    const updatedContracts: LeanContract[] = [];

    for (const contract of contracts) {
      if (new Date(newBillingPeriod.endDate) < new Date(contract.billingPeriod.startDate)) {
        throw new Error(`INVALID DATA: Error updating billing period for contract of user ${contract.userContact.userId}. End date cannot be before the start date.`);
      }
      contract.billingPeriod = {
        ...contract.billingPeriod,
        ...newBillingPeriod,
      };

      updatedContracts.push(contract);
    }

    const result = await this.contractRepository.bulkUpdate(updatedContracts);

    if (!result) {
      throw new Error(`Failed to update contracts for groupId ${groupId} within organization ${organizationId}`);
    }

    const contractsToReturn = await this.index({ groupId: groupId }, organizationId);

    for (const contract of contractsToReturn) {
      contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);
    }

    return contractsToReturn;
  }

  async resetUsageLevels(
    userId: string,
    queryParams: UsageLevelsResetQuery,
    usageLevelsIncrements?: Record<string, Record<string, number>>
  ): Promise<LeanContract> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    if (queryParams.usageLimit) {
      await this._resetUsageLimitUsageLevels(
        contract,
        queryParams.usageLimit,
        contract.organizationId
      );
    } else if (queryParams.reset) {
      await this._resetUsageLevels(contract, queryParams.renewableOnly, contract.organizationId);
    } else if (usageLevelsIncrements) {
      for (const serviceName in usageLevelsIncrements) {
        for (const usageLimit in usageLevelsIncrements[serviceName]) {
          if (contract.usageLevels[serviceName][usageLimit]) {
            contract.usageLevels[serviceName][usageLimit].consumed +=
              usageLevelsIncrements[serviceName][usageLimit];
          }
        }
      }
    } else {
      throw new Error(`Invalid query params: ${JSON.stringify(queryParams)}`);
    }

    const updatedContract = await this.contractRepository.update(userId, contract);

    if (!updatedContract) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    updatedContract.contractedServices = resetEscapeContractedServiceVersions(
      updatedContract.contractedServices
    );

    await this.cacheService.set(`contracts.${userId}`, updatedContract, 3600, true); // Cache for 1 hour
    await this.cacheService.del(`features.${userId}.*`);

    return updatedContract;
  }

  async _applyExpectedConsumption(
    userId: string,
    usageLimitId: string,
    expectedConsumption: number
  ): Promise<void> {
    await this._applyExpectedConsumptions(userId, { [usageLimitId]: expectedConsumption });
  }

  /**
   * Apply several expected consumptions to a contract in one atomic update.
   *
   * Read-modify-write loses consumptions, and it does so in two ways. Applying
   * the limits of one evaluation in turn made each application read the whole
   * contract, change a single usage level in its own copy and write the whole
   * contract back, so an evaluation touching two limits recorded one of them.
   * Batching the limits into a single read and write fixes that, but not the
   * case of two requests arriving together: both read the same consumed value,
   * both write the same total, and one consumption is gone.
   *
   * The database is the only place that can settle this, so the increment is
   * handed to it as `$inc` and evaluated against the stored document. Whatever
   * order concurrent calls arrive in, every one of them is added.
   */
  async _applyExpectedConsumptions(
    userId: string,
    expectedConsumptions: Record<string, number>
  ): Promise<void> {
    const usageLimitIds = Object.keys(expectedConsumptions);
    if (usageLimitIds.length === 0) {
      return;
    }

    const targets = usageLimitIds.map(usageLimitId => {
      const serviceName: string = usageLimitId.split('-')[0];
      const usageLimit: string = usageLimitId.split('-')[1];

      return { serviceName, usageLimit, amount: expectedConsumptions[usageLimitId] };
    });

    const increments: Record<string, number> = {};
    for (const { serviceName, usageLimit, amount } of targets) {
      increments[`${serviceName}.${usageLimit}`] = amount;
    }

    const updatedContract = await this.contractRepository.incrementUsageLevels(userId, increments);

    if (!updatedContract) {
      // The update requires the contract and every named usage level to exist,
      // so it matched nothing. Which of the two is missing only matters for the
      // message, and is worth a read to get right.
      await this._explainMissingUsageLevels(userId, targets);
    }

    const appliedAt = new Date().getTime();

    for (const { serviceName, usageLimit, amount } of targets) {
      // What the level held before this call, for `_revertExpectedConsumption`.
      // Derived from the result rather than from a prior read, so it is this
      // caller's own contribution that gets taken back even if others landed in
      // between.
      await this.cacheService.set(
        `${appliedAt}.usageLevels.${userId}.${serviceName}.${usageLimit}`,
        updatedContract!.usageLevels[serviceName][usageLimit].consumed - amount,
        120
      ); // 120 secs = 2 mins
    }

    await this.cacheService.set(`contracts.${userId}`, updatedContract, 3600, true); // Cache for 1 hour
  }

  /**
   * Say which part of the contract was missing, having established that one was.
   */
  private async _explainMissingUsageLevels(
    userId: string,
    targets: { serviceName: string; usageLimit: string }[]
  ): Promise<never> {
    const contract = await this.contractRepository.findByUserId(userId);

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    const missing = targets.find(
      ({ serviceName, usageLimit }) => !contract.usageLevels[serviceName]?.[usageLimit]
    );

    if (missing) {
      throw new Error(
        `Usage level ${missing.usageLimit} not found in contract for userId ${userId}`
      );
    }

    throw new Error(`Failed to update contract for userId ${userId}`);
  }

  async _revertExpectedConsumption(
    userId: string,
    featureId: string,
    latest: boolean = false
  ): Promise<void> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    const serviceName: string = featureId.split('-')[0].toLowerCase();
    const featureName: string = featureId.split('-')[1];

    const pricing: LeanPricing = await this.serviceService.showPricing(
      serviceName,
      contract.contractedServices[serviceName],
      contract.organizationId
    );

    const affectedUsageLimits = Object.values(pricing.usageLimits || {})
      .filter((usageLimit: LeanUsageLimit) => usageLimit.linkedFeatures?.includes(featureName))
      .map(ul => ul.name!);

    for (const usageLimitName of affectedUsageLimits) {
      if (contract.usageLevels[serviceName][usageLimitName]) {
        const previousCachedValue = await this._getCachedUsageLevel(
          userId,
          serviceName,
          usageLimitName,
          latest
        );

        if (previousCachedValue === null || previousCachedValue === undefined) {
          console.log(
            `WARNING: No previous cached value found for limit: ${serviceName}-${usageLimitName}. Unable to perform revert operation.`
          );
        }else{
          contract.usageLevels[serviceName][usageLimitName].consumed = previousCachedValue;
        }
      } else {
        throw new Error(
          `Usage level ${serviceName}-${usageLimitName} not found in contract for user ${contract.userContact.username}`
        );
      }
    }

    const updatedContract = await this.contractRepository.update(userId, contract);

    if (!updatedContract) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    await this.cacheService.set(`contracts.${userId}`, updatedContract, 3600, true); // Cache for 1 hour
  }

  async prune(organizationId?: string, reqUser?: LeanUser): Promise<number> {
    if (
      reqUser &&
      reqUser.role !== 'ADMIN' &&
      !['OWNER', 'ADMIN'].includes(reqUser.orgRole ?? '')
    ) {
      throw new Error('PERMISSION ERROR: Only ADMIN users can prune organization contracts');
    }

    const organizations = organizationId ? [organizationId] : await ContractModel.distinct('organizationId');
    let removed = 0;
    for (const org of organizations) {
      const clean = async (assertOwned: () => Promise<void>) => {
        await assertOwned();
        removed += await this.contractRepository.prune(org);
        const services = await ServiceModel.find({ organizationId: org, source: 'sphere' }).select('_id').lean();
        for (const service of services) await container.resolve('sphereSyncService').cleanup(String(service._id), assertOwned);
      };
      if (await ServiceModel.exists({ organizationId: org, source: 'sphere' })) await withOrganizationLock(org, clean);
      else await clean(async () => {});
    }
    await this.cacheService.del('contracts.*');
    await this.cacheService.del('features.*');
    return removed;
  }

  async destroy(userId: string): Promise<void> {
    let contract = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
    }

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    await this.contractRepository.destroy(userId);

    this.cacheService.del(`contracts.${userId}`);
  }

  async _getCachedUsageLevel(
    userId: string,
    serviceName: string,
    usageLimit: string,
    latest: boolean = false
  ): Promise<number | null> {
    let cachedValues: string[] = await this.cacheService.match(
      `*.usagelevels.${userId}.${serviceName}.${usageLimit}`
    );
    cachedValues = cachedValues.sort((a, b) => {
      const aTimestamp = parseInt(a.split('.')[0]);
      const bTimestamp = parseInt(b.split('.')[0]);
      return aTimestamp - bTimestamp;
    });

    if (cachedValues.length === 0) {
      return null;
    }

    return await this.cacheService.get(
      latest ? cachedValues[cachedValues.length - 1] : cachedValues[0]
    );
  }

  async _createUsageLevels(
    services: Record<string, string>,
    organizationId: string
  ): Promise<Record<string, Record<string, UsageLevel>>> {
    const usageLevels: Record<string, Record<string, UsageLevel>> = {};

    for (const serviceName in services) {
      const pricing: LeanPricing = await this.serviceService.showPricing(
        serviceName,
        services[serviceName],
        organizationId
      );

      const serviceUsageLevels: Record<string, UsageLevel> | undefined =
        generateUsageLevels(pricing);

      if (serviceUsageLevels) {
        usageLevels[serviceName] = serviceUsageLevels;
      }
    }
    return usageLevels;
  }

  _discoverUsageLimitServices(contract: LeanContract, usageLimit: string): string[] {
    const serviceNames: string[] = [];
    for (const serviceName in contract.usageLevels) {
      if (contract.usageLevels[serviceName][usageLimit]) {
        serviceNames.push(serviceName);
      }
    }
    return serviceNames;
  }

  async _resetUsageLimitUsageLevels(
    contract: LeanContract,
    usageLimit: string,
    organizationId: string
  ): Promise<void> {
    const serviceNames: string[] = this._discoverUsageLimitServices(contract, usageLimit);

    if (serviceNames.length === 0) {
      throw new Error(
        `Usage limit: ${usageLimit} not found in the contract. Maybe it's not being tracked as usage level`
      );
    }

    for (const serviceName of serviceNames) {
      contract.usageLevels[serviceName][usageLimit].consumed = 0;

      if (contract.usageLevels[serviceName][usageLimit].resetTimeStamp) {
        await this._setResetTimeStamp(contract, serviceName, usageLimit, organizationId);
      }
    }
  }

  async _setResetTimeStamp(
    contract: LeanContract,
    serviceName: string,
    usageLimit: string,
    organizationId: string
  ): Promise<void> {
    const pricingVersion = contract.contractedServices[serviceName];

    const servicePricing: LeanPricing = await this.serviceService.showPricing(
      serviceName,
      pricingVersion,
      organizationId
    );

    contract.usageLevels[serviceName][usageLimit].resetTimeStamp = addPeriodToDate(
      contract.usageLevels[serviceName][usageLimit].resetTimeStamp!, // Cannot be undefined, since we are inside the if
      servicePricing.usageLimits![usageLimit].period! // Cannot be undefined, since renewawlPeriod was assigned to the usage level during the contract creation
    );
  }

  async _resetUsageLevels(
    contract: LeanContract,
    renewableOnly: boolean,
    organizationId: string
  ): Promise<void> {
    for (const serviceName in contract.usageLevels) {
      for (const usageLimit in contract.usageLevels[serviceName]) {
        if (renewableOnly && !contract.usageLevels[serviceName][usageLimit].resetTimeStamp) {
          continue;
        }
        contract.usageLevels[serviceName][usageLimit].consumed = 0;
        if (contract.usageLevels[serviceName][usageLimit].resetTimeStamp) {
          await this._setResetTimeStamp(contract, serviceName, usageLimit, organizationId);
        }
      }
    }
  }

  async _resetRenewableUsageLevels(
    contract: LeanContract,
    usageLimitsToRenew: string[],
    organizationId: string
  ): Promise<LeanContract> {
    if (usageLimitsToRenew.length === 0) {
      return contract;
    }

    const contractToUpdate = { ...contract };

    for (const usageLimitId of usageLimitsToRenew) {
      const serviceName: string = usageLimitId.split('-')[0];
      const usageLimitName: string = usageLimitId.split('-')[1];
      let currentResetTimeStamp =
        contractToUpdate.usageLevels[serviceName][usageLimitName].resetTimeStamp;

      if (currentResetTimeStamp && isAfter(new Date(), currentResetTimeStamp)) {
        const pricing: LeanPricing = await this.serviceService.showPricing(
          serviceName,
          contractToUpdate.contractedServices[serviceName],
          organizationId
        );
        currentResetTimeStamp = addPeriodToDate(
          currentResetTimeStamp,
          pricing.usageLimits![usageLimitName].period!
        );
        contractToUpdate.usageLevels[serviceName][usageLimitName].consumed = 0;
      }
    }

    const updatedContract = await this.contractRepository.update(
      contract.userContact.userId,
      contractToUpdate
    );

    if (!updatedContract) {
      throw new Error(`Failed to update contract for userId ${contract.userContact.userId}`);
    }

    return updatedContract;
  }
}

export default ContractService;
