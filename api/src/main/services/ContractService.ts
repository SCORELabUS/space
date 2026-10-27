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
import {
  SubscriptionError,
  SubscriptionValidationError,
  collectSubscriptionErrors,
  validateSubscription,
} from '../controllers/validation/ContractValidation';
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
import {
  ContractChangedError,
  computeContractVersion,
  contractVersionGuard,
} from '../utils/contracts/version';
import { LeanUser } from '../types/models/User';
import { pricingYamlUrl } from '../utils/services/helpers';

/** Response of POST /contracts/{userId}/novation/preview. */
export interface NovationPreview {
  valid: boolean;
  errors: SubscriptionError[];
  effective: {
    contractedServices: Record<string, string>;
    subscriptionPlans: Record<string, string>;
    subscriptionAddOns: Record<string, Record<string, number>>;
  };
  versionChanges: Record<string, { from: string | null; to: string; reason: string }>;
  usageWarnings: { service: string; usageLimit: string; consumed: number; newLimit: number }[];
  billingPeriod: { startDate: string; endDate: string; restarts: boolean };
  contractVersion: string;
}

/**
 * Numeric usage limits that the subscription would set below what the contract
 * has already consumed. Limits as feature evaluation computes them: the plan's
 * value, overridden by add-on `usageLimits`, plus add-on
 * `usageLimitsExtensions` times the quantity.
 */
function usageBelowConsumption(
  contract: LeanContract,
  subscription: { subscriptionPlans: Record<string, string>; subscriptionAddOns: Record<string, Record<string, number>> },
  pricings: Record<string, LeanPricing>
): NovationPreview['usageWarnings'] {
  const warnings: NovationPreview['usageWarnings'] = [];
  const usageLevels = convertKeysToLowercase(contract.usageLevels ?? {});

  for (const [service, pricing] of Object.entries(pricings)) {
    const levels = usageLevels[service];
    if (!levels) continue;

    const planName = subscription.subscriptionPlans[service];
    const planKey = Object.keys(pricing.plans ?? {}).find(key => key.toLowerCase() === planName?.toLowerCase());
    const limits: Record<string, number | boolean | undefined> = { ...(planKey ? pricing.plans![planKey].usageLimits ?? {} : {}) };
    const selected = subscription.subscriptionAddOns[service] ?? {};

    // In pricing order, as feature evaluation applies them (later add-ons win).
    for (const [addOnName, addOn] of Object.entries(pricing.addOns ?? {})) {
      const quantity = selected[addOnName];
      if (!(quantity > 0)) continue;
      for (const [limit, value] of Object.entries(addOn.usageLimits ?? {})) limits[limit] = value;
      for (const [limit, value] of Object.entries(addOn.usageLimitsExtensions ?? {})) {
        if (typeof limits[limit] === 'number') limits[limit] = (limits[limit] as number) + value * quantity;
      }
    }

    for (const [limit, level] of Object.entries(levels)) {
      const newLimit = limits[limit];
      if (typeof newLimit === 'number' && typeof level?.consumed === 'number' && level.consumed > newLimit) {
        warnings.push({ service, usageLimit: limit, consumed: level.consumed, newLimit });
      }
    }
  }

  return warnings;
}

/** One entry of GET /contracts/{userId}/pricings. */
export interface ContractPricing {
  version: string;
  status: 'active' | 'archived';
  yamlUrl: string;
  newContractsVersion: string | null;
  plan?: string;
  addOns: Record<string, number>;
}

/** Options shared by the novation routes (see S8 in the API docs). */
export interface NovationOptions {
  /** Keep the billing period instead of restarting it. */
  keepBillingPeriod?: boolean;
  /** Opt-in: reject private plans and add-ons the contract does not have yet. */
  rejectPrivate?: boolean;
}

class ContractService {
  private readonly contractRepository: ContractRepository;
  private readonly serviceService: ServiceService;
  private readonly cacheService: CacheService;

  constructor() {
    this.contractRepository = container.resolve('contractRepository');
    this.serviceService = container.resolve('serviceService');
    this.cacheService = container.resolve('cacheService');
    // Position of the caller's organization among the arguments of the methods
    // that address a contract by userId (see `_findContract`).
    const scopeArgument: Record<string, number> = {
      novate: 2, renew: 1, destroy: 1, novateUserContact: 2, novateBillingPeriod: 2,
      resetUsageLevels: 3, _revertExpectedConsumption: 3,
    };
    // Serialize binding mutations with synchronization. Consumption uses conditional atomic writes separately.
    for (const method of ['create', 'novate', 'novateByGroupId', 'renew', 'destroy', 'novateUserContact', 'novateBillingPeriod', 'novateBillingPeriodByGroupId', 'resetUsageLevels', '_revertExpectedConsumption'] as const) {
      const original = (this[method] as (...args: any[]) => Promise<any>).bind(this);
      (this as any)[method] = async (...args: any[]) => {
        const scope = args[scopeArgument[method]];
        const contract: any = method === 'create' || method.endsWith('ByGroupId') ? null :
          await ContractModel.findOne({ 'userContact.userId': args[0], ...(scope ? { organizationId: scope } : {}) }).lean();
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

  /**
   * Look a contract up by `userId`, confined to `organizationId` when given.
   *
   * Contracts are cached under `contracts.<userId>` whatever their organization,
   * so a cached contract is checked against the organization as well: a hit
   * from another organization is a miss. Outside the organization the contract
   * does not exist, and the error says exactly what it says for an unknown
   * `userId`, so that a caller cannot tell the two apart.
   */
  async _findContract(userId: string, organizationId?: string): Promise<LeanContract> {
    let contract: LeanContract | null = await this.cacheService.get(`contracts.${userId}`);

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId);
      if (contract) {
        await this.cacheService.set(`contracts.${userId}`, contract, 3600, true); // Cache for 1 hour
      }
    }

    if (!contract || (organizationId && contract.organizationId !== organizationId)) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    return contract;
  }

  /**
   * The subscription a novation of `contract` actually applies, and why each
   * pricing version is what it is. Shared by the novation and its preview so
   * that the preview is exact.
   *
   * Service keys are lowercased. A service subscribed in
   * `subscriptionPlans`/`subscriptionAddOns` without a `contractedServices`
   * entry keeps the version the contract has or, for a service the contract
   * does not have, gets the version for new contracts. SPHERE policies are
   * enforced last.
   */
  async _resolveNovation(
    contract: LeanContract,
    requested: any
  ): Promise<{
    subscription: {
      contractedServices: Record<string, string>;
      subscriptionPlans: Record<string, string>;
      subscriptionAddOns: Record<string, Record<string, number>>;
      billingPeriod?: { autoRenew?: boolean };
    };
    reasons: Record<string, string>;
  }> {
    const subscription: {
      contractedServices: Record<string, string>;
      subscriptionPlans: Record<string, string>;
      subscriptionAddOns: Record<string, Record<string, number>>;
      billingPeriod?: { autoRenew?: boolean };
    } = {
      contractedServices: convertKeysToLowercase<string>(structuredClone(requested?.contractedServices ?? {})),
      subscriptionPlans: convertKeysToLowercase<string>(structuredClone(requested?.subscriptionPlans ?? {})),
      subscriptionAddOns: convertKeysToLowercase<Record<string, number>>(structuredClone(requested?.subscriptionAddOns ?? {})),
    };
    const reasons: Record<string, string> = {};
    for (const service of Object.keys(subscription.contractedServices)) reasons[service] = 'requested';

    const previous = convertKeysToLowercase<string>(contract.contractedServices ?? {});
    const subscribed = new Set([...Object.keys(subscription.subscriptionPlans), ...Object.keys(subscription.subscriptionAddOns)]);
    for (const service of subscribed) {
      if (service in subscription.contractedServices) continue;
      if (service in previous) {
        subscription.contractedServices[service] = resetEscapeVersion(previous[service]);
        reasons[service] = 'kept';
        continue;
      }
      try {
        const { version } = await this.serviceService.newContractsPricing(service, contract.organizationId);
        subscription.contractedServices[service] = version;
        reasons[service] = 'new-contracts-version';
      } catch (error) {
        if (!(error as Error).message.toLowerCase().includes('not found')) throw error;
        // Reported by validation as VERSION_NOT_FOUND.
      }
    }

    const beforePolicy = { ...subscription.contractedServices };
    const decidedBy = await enforceSpherePolicy(contract.organizationId, subscription, contract);
    for (const [service, version] of Object.entries(subscription.contractedServices)) {
      if (escapeVersion(String(version)) !== escapeVersion(String(beforePolicy[service]))) {
        reasons[service] = `policy:${decidedBy[service] ?? 'sphere'}`;
      }
    }

    // Billing period fields of the body (autoRenew) are applied by performNovation, as before.
    if (requested?.billingPeriod !== undefined) subscription.billingPeriod = structuredClone(requested.billingPeriod);

    return { subscription, reasons };
  }

  /**
   * What a novation would do, without writing anything (POST
   * /contracts/{userId}/novation/preview): the same resolution, SPHERE policy,
   * validation and billing period as `novate`, every validation problem with
   * its code, and limits that would fall below the current consumption.
   */
  async previewNovation(
    userId: string,
    newSubscription: any,
    organizationId?: string,
    options: NovationOptions = {}
  ): Promise<NovationPreview> {
    const found = await this._findContract(userId, organizationId);
    // The stored contract, as a conditional novation would see it.
    const contract = (await this.contractRepository.findByUserId(userId, found.organizationId)) ?? found;

    const { subscription, reasons } = await this._resolveNovation(contract, newSubscription);
    const { errors, pricings } = await collectSubscriptionErrors(subscription, contract.organizationId, {
      previous: contract,
      rejectPrivate: options.rejectPrivate,
    });

    const previousVersions = resetEscapeContractedServiceVersions(convertKeysToLowercase(contract.contractedServices ?? {}));
    const versionChanges: NovationPreview['versionChanges'] = {};
    for (const [service, version] of Object.entries(subscription.contractedServices)) {
      const to = resetEscapeVersion(escapeVersion(String(version)));
      const from = previousVersions[service] ?? null;
      if (from !== to) versionChanges[service] = { from, to, reason: reasons[service] ?? 'requested' };
    }

    const novated = performNovation(structuredClone(contract), subscription, {
      keepBillingPeriod: options.keepBillingPeriod,
    });

    return {
      valid: errors.length === 0,
      errors,
      effective: {
        contractedServices: Object.fromEntries(
          Object.entries(subscription.contractedServices).map(([service, version]) => [service, resetEscapeVersion(escapeVersion(String(version)))])
        ),
        subscriptionPlans: subscription.subscriptionPlans,
        subscriptionAddOns: subscription.subscriptionAddOns,
      },
      versionChanges,
      usageWarnings: usageBelowConsumption(contract, subscription, pricings),
      billingPeriod: {
        startDate: new Date(novated.billingPeriod.startDate).toISOString(),
        endDate: new Date(novated.billingPeriod.endDate).toISOString(),
        restarts: !options.keepBillingPeriod,
      },
      contractVersion: computeContractVersion(contract),
    };
  }

  /**
   * Services subscribed in `subscriptionPlans`/`subscriptionAddOns` but missing
   * from `contractedServices` get the version for new contracts of the service
   * (see `ServiceService.newContractsPricing`). Unknown services are left for
   * validation to report.
   */
  async _fillNewContractVersions(contractData: ContractToCreate): Promise<void> {
    contractData.contractedServices = { ...(contractData.contractedServices ?? {}) };
    const contracted = new Set(Object.keys(contractData.contractedServices).map(key => key.toLowerCase()));
    const subscribed = new Set(
      [...Object.keys(contractData.subscriptionPlans ?? {}), ...Object.keys(contractData.subscriptionAddOns ?? {})]
        .map(key => key.toLowerCase())
    );

    for (const serviceName of subscribed) {
      if (contracted.has(serviceName)) continue;
      try {
        const { version } = await this.serviceService.newContractsPricing(serviceName, contractData.organizationId);
        contractData.contractedServices[serviceName] = version;
      } catch (error) {
        if (!(error as Error).message.toLowerCase().includes('not found')) throw error;
        // Reported by validation as VERSION_NOT_FOUND.
      }
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

  /**
   * The pricing versions of a contract (GET /contracts/{userId}/pricings): per
   * contracted service, its version (unescaped), whether it is still active,
   * the version new contracts get (null if it cannot be determined) and the
   * subscribed plan and add-ons. `routeOrganizationId` only selects the kind of
   * `yamlUrl` (organization-scoped or direct).
   */
  async pricings(
    userId: string,
    organizationId?: string,
    routeOrganizationId?: string
  ): Promise<{ contract: LeanContract; services: Record<string, ContractPricing> }> {
    const contract = await this.show(userId, organizationId);
    const services: Record<string, ContractPricing> = {};

    for (const [serviceName, version] of Object.entries(contract.contractedServices)) {
      const status = await this.serviceService.pricingVersionStatus(serviceName, version, contract.organizationId);
      let storedName = serviceName;
      let newContractsVersion: string | null = null;
      try {
        const forNewContracts = await this.serviceService.newContractsPricing(serviceName, contract.organizationId);
        storedName = forNewContracts.serviceName;
        newContractsVersion = forNewContracts.version;
      } catch (error) {
        // Unknown service or no active version: newContractsVersion stays null.
        // Anything else (database or cache failure) is not hidden as "unknown".
        if (!(error as Error).message.toLowerCase().includes('not found')) throw error;
      }

      services[serviceName] = {
        version,
        // A version that is neither active nor archived (e.g. SPHERE history) is no longer offered.
        status: status === 'active' ? 'active' : 'archived',
        yamlUrl: pricingYamlUrl(routeOrganizationId, storedName, version),
        newContractsVersion,
        plan: contract.subscriptionPlans?.[serviceName],
        addOns: contract.subscriptionAddOns?.[serviceName] ?? {},
      };
    }

    return { contract, services };
  }

  async show(userId: string, organizationId?: string): Promise<LeanContract> {
    const contract = await this._findContract(userId, organizationId);

    contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);

    return contract;
  }

  /**
   * @param options.rejectPrivate reject private plans and add-ons (opt-in, see
   *        `validateSubscription`).
   */
  async create(
    contractData: ContractToCreate,
    options: { rejectPrivate?: boolean } = {}
  ): Promise<LeanContract> {
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

    await this._fillNewContractVersions(contractData);
    await enforceSpherePolicy(contractData.organizationId, contractData);

    // Convert keys to lowercase for contractedServices, subscriptionPlans and subscriptionAddOns
    contractData.contractedServices = convertKeysToLowercase(contractData.contractedServices);
    contractData.subscriptionPlans = convertKeysToLowercase(contractData.subscriptionPlans);
    contractData.subscriptionAddOns = convertKeysToLowercase(contractData.subscriptionAddOns);

    // Before anything reads the pricings: unknown or archived versions, invalid
    // or private selections are reported together, with stable codes.
    try {
      await validateSubscription(
        {
          contractedServices: contractData.contractedServices,
          subscriptionPlans: contractData.subscriptionPlans,
          subscriptionAddOns: contractData.subscriptionAddOns,
        },
        contractData.organizationId,
        { rejectPrivate: options.rejectPrivate }
      );
    } catch (error) {
      if (error instanceof SubscriptionValidationError) throw error;
      throw new Error(`Invalid subscription: ${error}`);
    }

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

    const contract = await this.contractRepository.create(contractDataToCreate);

    contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);

    await this.cacheService.set(`contracts.${contract.userContact.userId}`, contract, 3600, true); // Cache for 1 hour

    return contract;
  }

  /**
   * @param options.expectedContractVersion when given, the novation only applies
   *        to this version of the contract (see `computeContractVersion`), or to
   *        any of them when several are given; `*` stands for whatever version
   *        is current when the contract is read. The write is conditional on
   *        what the version covers (subscription, billing period, histories),
   *        so a novation that lands between the read and the write is not
   *        overwritten. A mismatch throws `ContractChangedError` and writes
   *        nothing. Usage levels are not part of the version: the write still
   *        sets the whole contract as read, so consumption recorded in that
   *        window (`$inc`) can be lost, with or without a precondition.
   */
  async novate(
    userId: string,
    newSubscription: any,
    organizationId?: string,
    options: NovationOptions & { expectedContractVersion?: string | string[] } = {}
  ): Promise<LeanContract> {
    let contract = await this._findContract(userId, organizationId);
    let guard: Record<string, unknown> = {};
    const expected = options.expectedContractVersion;

    if (expected !== undefined) {
      // Compare against the stored contract, never against a cached copy.
      const stored = await this.contractRepository.findByUserId(userId, contract.organizationId);
      if (!stored) {
        throw new Error(`Contract with userId ${userId} not found`);
      }
      const current = computeContractVersion(stored);
      const accepted = Array.isArray(expected) ? expected : [expected];
      if (!accepted.includes('*') && !accepted.includes(current)) {
        throw new ContractChangedError(current);
      }
      contract = stored;
      // Before performNovation, which appends to the history it is given.
      guard = contractVersionGuard(stored);
    }

    const { subscription } = await this._resolveNovation(contract, newSubscription);
    await validateSubscription(subscription, contract.organizationId, {
      previous: contract,
      rejectPrivate: options.rejectPrivate,
    });

    const newContract = performNovation(contract, subscription, {
      keepBillingPeriod: options.keepBillingPeriod,
    });

    const result = await this.contractRepository.update(
      userId,
      newContract,
      contract.organizationId,
      guard
    );

    if (!result && expected !== undefined) {
      const latest = await this.contractRepository.findByUserId(userId, contract.organizationId);
      await this.cacheService.del(`contracts.${userId}`);
      if (!latest) {
        throw new Error(`Contract with userId ${userId} not found`);
      }
      throw new ContractChangedError(computeContractVersion(latest));
    }

    if (!result) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    result.contractedServices = resetEscapeContractedServiceVersions(result.contractedServices);

    await this.cacheService.set(`contracts.${userId}`, result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(`features.${userId}.*`);

    return result;
  }
  
  /**
   * @param options.expectedContractVersions userId -> contract version. When
   *        given it must name every contract of the group with its current
   *        version; otherwise `ContractChangedError` reports the current version
   *        of each contract that differs (null for userIds not in the group) and
   *        nothing is written. Each write is then conditional on that version;
   *        a contract that changes between the check and its own write is left
   *        alone and reported, while the rest of the group is novated.
   */
  async novateByGroupId(
    groupId: string,
    organizationId: string,
    newSubscription: any,
    options: NovationOptions & { expectedContractVersions?: Record<string, string> } = {}
  ): Promise<LeanContract[]> {
    const contracts = await this.index({ groupId }, organizationId);

    if (!contracts || contracts.length === 0) {
      throw new Error(`INVALID DATA: No contracts found with groupId ${groupId} within organization ${organizationId}`);
    }

    const expected = options.expectedContractVersions;
    const guards = new Map<string, Record<string, unknown>>();

    if (expected) {
      const changed: Record<string, string | null> = {};
      const inGroup = new Set(contracts.map(contract => contract.userContact.userId));
      for (const contract of contracts) {
        const current = computeContractVersion(contract);
        if (expected[contract.userContact.userId] !== current) {
          changed[contract.userContact.userId] = current;
        }
      }
      for (const userId of Object.keys(expected)) {
        if (!inGroup.has(userId)) changed[userId] = null;
      }
      if (Object.keys(changed).length > 0) {
        throw new ContractChangedError(changed);
      }
      for (const contract of contracts) {
        guards.set(contract.userContact.userId, contractVersionGuard(contract));
      }
    }

    const updatedContracts: LeanContract[] = [];

    for (const contract of contracts) {
      // Resolved per contract: kept versions and the SPHERE policy may differ.
      const { subscription } = await this._resolveNovation(contract, newSubscription);
      await validateSubscription(subscription, contract.organizationId, {
        previous: contract,
        rejectPrivate: options.rejectPrivate,
      });
      const newContract = performNovation(contract, subscription, {
        keepBillingPeriod: options.keepBillingPeriod,
      });
      updatedContracts.push(newContract);
    }

    if (expected) {
      const rejected = await this.contractRepository.bulkUpdateGuarded(
        updatedContracts.map(contract => ({
          contract,
          guard: guards.get(contract.userContact.userId)!,
        }))
      );
      if (rejected.length > 0) {
        const changed: Record<string, string | null> = {};
        for (const userId of rejected) {
          await this.cacheService.del(`contracts.${userId}`);
          const latest = await this.contractRepository.findByUserId(userId, organizationId);
          changed[userId] = latest ? computeContractVersion(latest) : null;
        }
        for (const contract of updatedContracts) {
          await this.cacheService.del(`contracts.${contract.userContact.userId}`);
          await this.cacheService.del(`features.${contract.userContact.userId}.*`);
        }
        // Every precondition held when checked, but a contract changed before
        // its own write. Contracts are written one by one (no multi-document
        // transaction), so the others were novated: report them.
        const novated = updatedContracts
          .map(contract => contract.userContact.userId)
          .filter(userId => !rejected.includes(userId));
        throw new ContractChangedError(changed, novated);
      }
    } else {
      const result = await this.contractRepository.bulkUpdate(updatedContracts);

      if (!result) {
        throw new Error(`Failed to update contracts for groupId ${groupId} within organization ${organizationId}`);
      }
    }

    const contractsToReturn = await this.index({ groupId }, organizationId);

    for (const contract of contractsToReturn) {
      contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);
      this.cacheService.set(`contracts.${contract.userContact.userId}`, contract, 3600, true); // Cache for 1 hour
      this.cacheService.del(`features.${contract.userContact.userId}.*`);
    }

    return contractsToReturn;
  }

  async renew(userId: string, organizationId?: string): Promise<LeanContract> {
    const contract = await this._findContract(userId, organizationId);

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

    const result = await this.contractRepository.update(userId, contract, contract.organizationId);

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
    userContact: Omit<UserContact, 'userId'>,
    organizationId?: string
  ): Promise<LeanContract> {
    const contract = await this._findContract(userId, organizationId);

    contract.userContact = {
      ...contract.userContact,
      ...userContact,
    };

    const result = await this.contractRepository.update(userId, contract, contract.organizationId);

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
    newBillingPeriod: { endDate: Date; autoRenew: boolean; renewalDays: number },
    organizationId?: string
  ): Promise<LeanContract> {
    const contract = await this._findContract(userId, organizationId);

    if (new Date(newBillingPeriod.endDate) < new Date(contract.billingPeriod.startDate)) {
      throw new Error('End date cannot be before the start date');
    }

    contract.billingPeriod = {
      ...contract.billingPeriod,
      ...newBillingPeriod,
    };

    const result = await this.contractRepository.update(userId, contract, contract.organizationId);

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

    // The billing period is part of contractVersion: drop cached contracts,
    // evaluations and pricing tokens (they carry the version).
    await this.cacheService.delMany(
      contractsToReturn.flatMap(contract => [
        `contracts.${contract.userContact.userId}`,
        `features.${contract.userContact.userId}.*`,
      ])
    );

    for (const contract of contractsToReturn) {
      contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);
    }

    return contractsToReturn;
  }

  async resetUsageLevels(
    userId: string,
    queryParams: UsageLevelsResetQuery,
    usageLevelsIncrements?: Record<string, Record<string, number>>,
    organizationId?: string
  ): Promise<LeanContract> {
    const contract = await this._findContract(userId, organizationId);

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

    const updatedContract = await this.contractRepository.update(userId, contract, contract.organizationId);

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
    expectedConsumption: number,
    organizationId?: string
  ): Promise<void> {
    await this._applyExpectedConsumptions(userId, { [usageLimitId]: expectedConsumption }, organizationId);
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
    expectedConsumptions: Record<string, number>,
    organizationId?: string
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

    const updatedContract = await this.contractRepository.incrementUsageLevels(
      userId,
      increments,
      organizationId
    );

    if (!updatedContract) {
      // The update requires the contract and every named usage level to exist,
      // so it matched nothing. Which of the two is missing only matters for the
      // message, and is worth a read to get right.
      await this._explainMissingUsageLevels(userId, targets, organizationId);
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
    targets: { serviceName: string; usageLimit: string }[],
    organizationId?: string
  ): Promise<never> {
    const contract = await this.contractRepository.findByUserId(userId, organizationId);

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
    latest: boolean = false,
    organizationId?: string
  ): Promise<void> {
    const contract = await this._findContract(userId, organizationId);

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

    const updatedContract = await this.contractRepository.update(userId, contract, contract.organizationId);

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

  async destroy(userId: string, organizationId?: string): Promise<void> {
    const contract = await this._findContract(userId, organizationId);

    await this.contractRepository.destroy(userId, contract.organizationId);

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
      contractToUpdate,
      contract.organizationId
    );

    if (!updatedContract) {
      throw new Error(`Failed to update contract for userId ${contract.userContact.userId}`);
    }

    return updatedContract;
  }
}

export default ContractService;
