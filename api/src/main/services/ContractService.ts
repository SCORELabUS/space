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
import ServiceService, { DormantReason, DormantServiceError } from './ServiceService';
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
import type EventService from './EventService';
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
import {
  contractCacheKey,
  contractCacheKeys,
  featuresCachePattern,
  organizationContractCachePatterns,
} from '../utils/contracts/cacheKeys';
import { randomUUID } from 'node:crypto';
import UsageConsumptionRepository, { UsageConsumption } from '../repositories/mongoose/UsageConsumptionRepository';
import { ConsumptionRevertResult } from '../types/models/FeatureEvaluation';
import {
  ConsumptionTarget,
  consumptionTargets,
  normalizeFeatureId,
} from '../utils/feature-evaluation/consumption';

/**
 * How long an applied consumption can be reverted by its `consumptionId`
 * (`CONSUMPTION_RETENTION_SECONDS`, default 24 hours, at least 60 seconds).
 */
export function consumptionRetentionSeconds(): number {
  const configured = Number(process.env.CONSUMPTION_RETENTION_SECONDS);
  return Number.isFinite(configured) && configured >= 60 ? Math.floor(configured) : 24 * 3600;
}

/** The legacy revert (`?revert=true` without `consumptionId`) only considers consumptions this recent. */
export const LEGACY_REVERT_WINDOW_MS = 120_000;

/**
 * What applying an expected consumption came to.
 * - `applied`: every level was incremented; `contract` is the stored contract
 *   after the increment, `consumptionId` identifies the consumption when it
 *   was recorded (single-feature evaluations).
 * - `limit`: nothing was written because a level would have exceeded its
 *   limit; `contract` is the stored contract that showed it.
 * - `changed`: nothing was written because the subscription the limits were
 *   computed from is no longer the stored one (or the room seen at the write
 *   was freed right after): the evaluation has to be made again.
 */
export type ConsumptionOutcome =
  | { status: 'applied'; contract: LeanContract; consumptionId?: string }
  | { status: 'limit'; contract: LeanContract }
  | { status: 'changed' };

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
  /**
   * Services of the resulting subscription that are dormant (disabled): kept
   * unchanged, their features stay unavailable until they are enabled again.
   */
  dormantServices: string[];
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
  /**
   * Whether the service itself is enabled. `disabled`: its features are not
   * available until a pricing with its saasName is uploaded again (all its
   * versions are archived meanwhile); `not-found`: the organization no longer
   * has it.
   */
  serviceStatus: 'enabled' | 'disabled' | 'not-found';
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
  private readonly usageConsumptionRepository: UsageConsumptionRepository;

  constructor() {
    this.contractRepository = container.resolve('contractRepository');
    this.serviceService = container.resolve('serviceService');
    this.cacheService = container.resolve('cacheService');
    this.usageConsumptionRepository = container.resolve('usageConsumptionRepository');
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
        let contract: any = null;
        if (method !== 'create') {
          // A userId or groupId is only unique within an organization: without
          // one, fail before reading or locking anything (callers always pass it).
          const scope = method.endsWith('ByGroupId') ? args[1] : args[scopeArgument[method]];
          if (!scope) throw new Error(`INTERNAL ERROR: ${method} requires the organization of the contract`);
          if (!method.endsWith('ByGroupId')) {
            contract = await ContractModel.findOne({ 'userContact.userId': args[0], organizationId: scope }).lean();
          }
        }
        const org = method === 'create' ? args[0]?.organizationId : method.endsWith('ByGroupId') ? args[1] : contract?.organizationId;
        if (!org || !await ServiceModel.exists({ organizationId: org, source: 'sphere' })) return original(...args);
        return withOrganizationLock(org, async assertOwned => {
          if (await ServiceModel.exists({ organizationId: org, source: 'sphere', 'sphere.status': 'applying' })) throw new Error('Synchronization is applying; retry shortly');
          if (contract) await this.cacheService.del(contractCacheKey(contract.organizationId, contract.userContact.userId));
          await assertOwned();
          const result = await original(...args);
          const services = await ServiceModel.find({ organizationId: org, source: 'sphere' }).select('_id').lean();
          for (const service of services) await container.resolve('sphereSyncService').cleanup(String(service._id), assertOwned);
          return result;
        });
      };
    }

  }

  /** EventService, resolved lazily (it is registered after this service). */
  _events(): EventService | undefined {
    try {
      return container.resolve('eventService');
    } catch {
      return undefined;
    }
  }

  /**
   * Look a contract up by `userId` within `organizationId` (required: a
   * `userId` is only unique within an organization).
   *
   * Contracts are cached per organization and userId (see `contractCacheKey`);
   * a cached entry is still checked against both. Outside the organization the
   * contract does not exist, and the error says exactly what it says for an
   * unknown `userId`, so that a caller cannot tell the two apart.
   */
  async _findContract(userId: string, organizationId: string): Promise<LeanContract> {
    const organization = organizationId;
    if (!organization) {
      throw new Error('INTERNAL ERROR: a contract is looked up by userId within an organization');
    }

    const key = contractCacheKey(organization, userId);
    let contract: LeanContract | null = await this.cacheService.get(key);
    if (contract && (contract.organizationId !== organization || contract.userContact?.userId !== userId)) {
      contract = null;
    }

    if (!contract) {
      contract = await this.contractRepository.findByUserId(userId, organization);
      if (contract) {
        await this.cacheService.set(key, contract, 3600, true); // Cache for 1 hour
      }
    }

    if (!contract) {
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
    organizationId: string,
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
    const dormant = await this.serviceService.dormantServices(
      Object.keys(subscription.contractedServices),
      contract.organizationId
    );

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
      dormantServices: Object.keys(dormant),
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
    organizationId: string,
    routeOrganizationId?: string
  ): Promise<{ contract: LeanContract; services: Record<string, ContractPricing> }> {
    const contract = await this.show(userId, organizationId);
    const services: Record<string, ContractPricing> = {};
    const dormant = await this.serviceService.dormantServices(
      Object.keys(contract.contractedServices),
      contract.organizationId
    );
    const serviceStatus = (serviceName: string): ContractPricing['serviceStatus'] => {
      const reason = dormant[serviceName.toLowerCase()];
      return reason === 'SERVICE_DISABLED' ? 'disabled' : reason === 'SERVICE_NOT_FOUND' ? 'not-found' : 'enabled';
    };

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
        serviceStatus: serviceStatus(serviceName),
      };
    }

    return { contract, services };
  }

  async show(userId: string, organizationId: string): Promise<LeanContract> {
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

    // userIds are unique per organization; a userId of another organization
    // neither conflicts nor is revealed.
    const existingContract = await this.contractRepository.findByUserId(
      contractData.userContact.userId,
      contractData.organizationId
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

    await this.cacheService.set(contractCacheKey(contract.organizationId, contract.userContact.userId), contract, 3600, true); // Cache for 1 hour
    this._events()?.emitContractEvent('CONTRACT_CREATED', contract);

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
    organizationId: string,
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
      await this.cacheService.del(contractCacheKey(contract.organizationId, userId));
      if (!latest) {
        throw new Error(`Contract with userId ${userId} not found`);
      }
      throw new ContractChangedError(computeContractVersion(latest));
    }

    if (!result) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    result.contractedServices = resetEscapeContractedServiceVersions(result.contractedServices);

    await this.cacheService.set(contractCacheKey(result.organizationId, userId), result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(featuresCachePattern(result.organizationId, userId));
    this._events()?.emitContractEvent('CONTRACT_NOVATED', result);

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
          await this.cacheService.del(contractCacheKey(organizationId, userId));
          const latest = await this.contractRepository.findByUserId(userId, organizationId);
          changed[userId] = latest ? computeContractVersion(latest) : null;
        }
        for (const contract of updatedContracts) {
          await this.cacheService.delMany(contractCacheKeys(contract));
        }
        // Every precondition held when checked, but a contract changed before
        // its own write. Contracts are written one by one (no multi-document
        // transaction), so the others were novated: report them.
        const novated = updatedContracts
          .map(contract => contract.userContact.userId)
          .filter(userId => !rejected.includes(userId));
        // Those writes are persisted: announce them before reporting the failure.
        for (const userId of novated) {
          const written = await this.contractRepository.findByUserId(userId, organizationId);
          if (written) this._events()?.emitContractEvent('CONTRACT_NOVATED', written);
        }
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
      this.cacheService.set(contractCacheKey(contract.organizationId, contract.userContact.userId), contract, 3600, true); // Cache for 1 hour
      this.cacheService.del(featuresCachePattern(contract.organizationId, contract.userContact.userId));
      this._events()?.emitContractEvent('CONTRACT_NOVATED', contract);
    }

    return contractsToReturn;
  }

  async renew(userId: string, organizationId: string): Promise<LeanContract> {
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

    await this.cacheService.set(contractCacheKey(result.organizationId, userId), result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(featuresCachePattern(result.organizationId, userId));
    this._events()?.emitContractEvent('CONTRACT_RENEWED', result);

    return result;
  }

  async novateUserContact(
    userId: string,
    userContact: Omit<UserContact, 'userId'>,
    organizationId: string
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

    await this.cacheService.set(contractCacheKey(result.organizationId, userId), result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(featuresCachePattern(result.organizationId, userId));

    return result;
  }

  async novateBillingPeriod(
    userId: string,
    newBillingPeriod: { endDate: Date; autoRenew: boolean; renewalDays: number },
    organizationId: string
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

    await this.cacheService.set(contractCacheKey(result.organizationId, userId), result, 3600, true); // Cache for 1 hour
    await this.cacheService.del(featuresCachePattern(result.organizationId, userId));
    // The billing period is part of contractVersion.
    this._events()?.emitContractEvent('CONTRACT_NOVATED', result);

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
    await this.cacheService.delMany(contractsToReturn.flatMap(contract => contractCacheKeys(contract)));

    for (const contract of contractsToReturn) {
      contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);
      this._events()?.emitContractEvent('CONTRACT_NOVATED', contract);
    }

    return contractsToReturn;
  }

  async resetUsageLevels(
    userId: string,
    queryParams: UsageLevelsResetQuery,
    usageLevelsIncrements: Record<string, Record<string, number>> | undefined,
    organizationId: string
  ): Promise<LeanContract> {
    const contract = await this._findContract(userId, organizationId);
    // Usage levels of dormant services are kept as they are: they cannot be
    // consumed, and resets leave them alone.
    const dormant = await this.serviceService.dormantServices(
      [...Object.keys(contract.contractedServices ?? {}), ...Object.keys(contract.usageLevels ?? {})],
      contract.organizationId
    );

    // Only the usage levels this request changes are written (`$set` of those
    // levels, `$inc` for increments). Writing the whole contract as read
    // would undo consumptions recorded meanwhile on any level.
    if (queryParams.usageLimit) {
      await this._resetUsageLimitUsageLevels(
        contract,
        queryParams.usageLimit,
        contract.organizationId,
        dormant
      );
    } else if (queryParams.reset) {
      await this._resetUsageLevels(contract, queryParams.renewableOnly, contract.organizationId, dormant);
    } else if (usageLevelsIncrements) {
      const increments: Record<string, number> = {};
      for (const serviceName in usageLevelsIncrements) {
        const reason = dormant[serviceName.toLowerCase()];
        if (reason) throw new DormantServiceError(serviceName.toLowerCase(), reason);
      }
      for (const serviceName in usageLevelsIncrements) {
        for (const usageLimit in usageLevelsIncrements[serviceName]) {
          if (contract.usageLevels?.[serviceName]?.[usageLimit]) {
            increments[`${serviceName}.${usageLimit}`] = usageLevelsIncrements[serviceName][usageLimit];
          }
        }
      }
      if (
        Object.keys(increments).length > 0 &&
        !(await this.contractRepository.incrementUsageLevels(userId, increments, contract.organizationId))
      ) {
        throw new Error(`Failed to update contract for userId ${userId}`);
      }
    } else {
      throw new Error(`Invalid query params: ${JSON.stringify(queryParams)}`);
    }

    if (queryParams.usageLimit || queryParams.reset) {
      // Every level the reset targets, whatever the copy read says it holds;
      // those of dormant services are not written at all.
      const reset: Record<string, { consumed: number; resetTimeStamp?: Date }> = {};
      for (const [serviceName, levels] of Object.entries(contract.usageLevels ?? {})) {
        if (dormant[serviceName.toLowerCase()]) continue;
        for (const [usageLimit, level] of Object.entries(levels)) {
          const targeted = queryParams.usageLimit
            ? usageLimit === queryParams.usageLimit
            : !(queryParams.renewableOnly && !level.resetTimeStamp);
          if (!targeted) continue;
          reset[`${serviceName}.${usageLimit}`] = {
            consumed: level.consumed,
            ...(level.resetTimeStamp ? { resetTimeStamp: new Date(level.resetTimeStamp) } : {}),
          };
        }
      }
      if (!(await this.contractRepository.setUsageLevels(userId, contract.organizationId, reset))) {
        throw new Error(`Failed to update contract for userId ${userId}`);
      }
    }

    const updatedContract = await this.contractRepository.findByUserId(userId, contract.organizationId);

    if (!updatedContract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    updatedContract.contractedServices = resetEscapeContractedServiceVersions(
      updatedContract.contractedServices
    );

    await this.cacheService.set(contractCacheKey(updatedContract.organizationId, userId), updatedContract, 3600, true); // Cache for 1 hour
    await this.cacheService.del(featuresCachePattern(updatedContract.organizationId, userId));

    return updatedContract;
  }

  async _applyExpectedConsumption(
    userId: string,
    usageLimitId: string,
    expectedConsumption: number,
    organizationId: string
  ): Promise<ConsumptionOutcome> {
    return this._applyExpectedConsumptions(userId, { [usageLimitId]: expectedConsumption }, organizationId);
  }

  /**
   * Apply several expected consumptions to a contract in one atomic update.
   *
   * Read-modify-write loses consumptions: two requests that read the same
   * consumed value both write the same total. The increment is handed to the
   * database as `$inc` instead, evaluated against the stored document.
   *
   * The limits are part of the same update. Checking them on the contract that
   * was read and incrementing afterwards let two requests both see room for one
   * more and both consume it; now a level is only incremented while
   * `consumed + amount` stays within its limit (`options.limits`, the limits
   * of the contract's current subscription as the evaluation computed them),
   * for every level of the consumption at once. With `options.contract`, the
   * update is also conditional on that contract's subscription still being the
   * stored one (`contractVersionGuard`), so the limits used are never those of
   * a subscription replaced in between.
   *
   * With `options.featureId` the consumption is recorded (collection
   * `usageConsumptions`) and its id returned, so that it can be reverted by id
   * (`revertConsumption`).
   */
  async _applyExpectedConsumptions(
    userId: string,
    expectedConsumptions: Record<string, number>,
    organizationId: string,
    options: { limits?: Record<string, unknown>; contract?: LeanContract; featureId?: string } = {}
  ): Promise<ConsumptionOutcome> {
    if (!organizationId) {
      throw new Error(`An organization is required to consume the usage levels of userId ${userId}`);
    }
    const targets = consumptionTargets(expectedConsumptions, options.limits);
    if (targets.length === 0) {
      return { status: 'applied', contract: options.contract as LeanContract };
    }

    const increments: Record<string, number> = {};
    const ceilings: Record<string, number> = {};
    for (const { serviceName, usageLimit, amount, ceiling } of targets) {
      increments[`${serviceName}.${usageLimit}`] = amount;
      if (ceiling !== null) ceilings[`${serviceName}.${usageLimit}`] = ceiling;
    }

    const updatedContract = await this.contractRepository.incrementUsageLevels(userId, increments, organizationId, {
      ceilings,
      guard: options.contract ? contractVersionGuard(options.contract) : undefined,
    });

    if (!updatedContract) {
      return this._explainRejectedConsumption(userId, targets, organizationId, options.contract);
    }

    let consumptionId: string | undefined;
    if (options.featureId) {
      consumptionId = randomUUID();
      const createdAt = new Date();
      try {
        await this.usageConsumptionRepository.create({
          id: consumptionId,
          organizationId,
          userId,
          featureId: normalizeFeatureId(options.featureId),
          levels: targets.map(({ serviceName, usageLimit, amount }) => {
            const resetTimeStamp = updatedContract.usageLevels[serviceName][usageLimit].resetTimeStamp;
            return { serviceName, usageLimit, amount, resetTimeStamp: resetTimeStamp ? new Date(resetTimeStamp) : null };
          }),
          createdAt,
          expiresAt: new Date(createdAt.getTime() + consumptionRetentionSeconds() * 1000),
        });
      } catch (error) {
        // Without its record the consumption could not be reverted: take it
        // back and report the failure, rather than answer with an id that
        // does not exist.
        const negated = Object.fromEntries(Object.entries(increments).map(([path, amount]) => [path, -amount]));
        await this.contractRepository.incrementUsageLevels(userId, negated, organizationId);
        await this.cacheService.del(contractCacheKey(organizationId, userId));
        throw error;
      }
    }

    await this.cacheService.set(contractCacheKey(organizationId, userId), updatedContract, 3600, true); // Cache for 1 hour

    return { status: 'applied', contract: updatedContract, consumptionId };
  }

  /**
   * Why a conditional consumption matched nothing, read from the stored
   * contract: no contract or a missing usage level (errors, as before), a
   * different subscription (`changed`), or a level that the consumption would
   * take over its limit (`limit`). If none of these holds any more, the room
   * was freed right after the write (a revert, a reset): `changed`, so that the
   * caller evaluates again.
   */
  private async _explainRejectedConsumption(
    userId: string,
    targets: ConsumptionTarget[],
    organizationId: string,
    evaluated?: LeanContract
  ): Promise<ConsumptionOutcome> {
    const contract = await this.contractRepository.findByUserId(userId, organizationId);

    if (!contract) {
      throw new Error(`Contract with userId ${userId} not found`);
    }

    const missing = targets.find(
      ({ serviceName, usageLimit }) => !contract.usageLevels?.[serviceName]?.[usageLimit]
    );

    if (missing) {
      throw new Error(
        `Usage level ${missing.usageLimit} not found in contract for userId ${userId}`
      );
    }

    await this.cacheService.set(contractCacheKey(organizationId, userId), contract, 3600, true);

    if (evaluated && computeContractVersion(contract) !== computeContractVersion(evaluated)) {
      return { status: 'changed' };
    }

    const overLimit = targets.some(
      ({ serviceName, usageLimit, amount, ceiling }) =>
        ceiling !== null && contract.usageLevels[serviceName][usageLimit].consumed + amount > ceiling
    );

    return overLimit ? { status: 'limit', contract } : { status: 'changed' };
  }

  /**
   * Revert one consumption by its id (`consumptionId` of the evaluation that
   * applied it): its amounts are subtracted from the usage levels it
   * incremented, once, never below zero, and nothing else is touched. Usage
   * recorded since (other consumptions, increments) is kept.
   *
   * Reverting a consumption that was already reverted does nothing. One that
   * does not exist in the caller's organization for this userId and feature,
   * or whose record expired, is not found.
   *
   * Each usage level of the consumption is looked up by its service:
   * - a service that the contract no longer has (a rename or move that raced
   *   with the consumption, or the service was removed from the contract):
   *   the consumption cannot be reverted exactly, so it is refused
   *   (`CONFLICT:`, 409), nothing is subtracted and the record is not claimed;
   * - a usage level that its service, still in the contract, no longer has (for
   *   example, the pricing version was archived with a fallback that has no such
   *   limit, which regenerates the service's levels): there is nothing to
   *   give back for it, so it is skipped and the other levels are reverted.
   * Renaming, moving and deleting services keep the records in step with the
   * contracts (see `ServiceService`).
   *
   * @returns what was reverted and skipped when a level was skipped, so that
   *          the caller can say so; null otherwise (every level reverted, or
   *          the consumption had already been reverted).
   */
  async revertConsumption(
    userId: string,
    featureId: string,
    consumptionId: string,
    organizationId: string
  ): Promise<ConsumptionRevertResult | null> {
    if (!organizationId) {
      throw new Error('INTERNAL ERROR: a consumption is reverted within the organization of its contract');
    }
    const scope = { organizationId, userId, featureId: normalizeFeatureId(featureId) };

    const contract = await this._findContract(userId, organizationId);
    await this._refuseDormantRevert(contract, featureId);

    // Refused before it is claimed, so that it is never seen as reverted.
    const existing = await this.usageConsumptionRepository.find(consumptionId, scope);
    if (existing && !existing.revertedAt) {
      const stored = await this.contractRepository.findByUserId(userId, organizationId);
      if (stored) this._resolveConsumption(existing, stored);
    }

    const claimed = await this.usageConsumptionRepository.claim(consumptionId, scope);
    if (!claimed) {
      const existing = await this.usageConsumptionRepository.find(consumptionId, scope);
      if (existing?.revertedAt) return null;
      throw new Error(`Consumption ${consumptionId} not found for userId ${userId} and feature ${featureId}`);
    }

    return this._takeBackConsumption(claimed);
  }

  /**
   * Legacy revert (`?revert=true[&latest=true]` without `consumptionId`),
   * deprecated in favour of `revertConsumption`: it picks one consumption of
   * this userId and feature made in the last two minutes, the oldest one or,
   * with `latest`, the most recent one, and reverts it like
   * `revertConsumption`. It used to set the usage levels back to a cached
   * snapshot and write the whole contract, which also undid everything
   * recorded after that snapshot.
   *
   * @returns as `revertConsumption`; null also when there was nothing to revert.
   */
  async _revertExpectedConsumption(
    userId: string,
    featureId: string,
    latest: boolean = false,
    organizationId: string
  ): Promise<ConsumptionRevertResult | null> {
    const contract = await this._findContract(userId, organizationId);
    const scope = {
      organizationId: contract.organizationId,
      userId,
      featureId: normalizeFeatureId(featureId),
    };

    await this._refuseDormantRevert(contract, featureId);

    const claimed = await this.usageConsumptionRepository.claimRecent(
      scope,
      new Date(Date.now() - LEGACY_REVERT_WINDOW_MS),
      latest
    );

    if (!claimed) {
      console.log(
        `WARNING: No recent consumption of feature ${featureId} found for userId ${userId}. Unable to perform revert operation.`
      );
      return null;
    }

    return this._takeBackConsumption(claimed);
  }

  /**
   * A consumption of a feature of a dormant (disabled or gone) service of the
   * contract is not reverted: the usage levels of a dormant service are kept as
   * they are until it is enabled again, so a revert is refused like a
   * consumption (`DormantServiceError`, 409). Checked before the consumption
   * is claimed, so that it can still be reverted once the service is enabled.
   */
  private async _refuseDormantRevert(contract: LeanContract, featureId: string): Promise<void> {
    const serviceName: string = featureId.split('-')[0].toLowerCase();
    const dormant = (await this.serviceService.dormantServices([serviceName], contract.organizationId))[serviceName];
    if (dormant && contract.contractedServices[serviceName] !== undefined) {
      throw new DormantServiceError(serviceName, dormant);
    }
  }

  /**
   * Which levels of a consumption the contract can take back: those of a
   * service of the contract that still has the level (`present`), and those
   * that the service no longer has (`skipped`: nothing to give back).
   * `services` are the keys of those services in `contractedServices`.
   *
   * @throws `CONFLICT:` (409) when a level belongs to a service that the
   *         contract no longer has: the consumption cannot be reverted
   *         exactly. The message must not say "not found", which would be
   *         answered as an unknown consumption (404) and keep the claim.
   */
  private _resolveConsumption(
    consumption: UsageConsumption,
    contract: LeanContract
  ): { present: UsageConsumption['levels']; skipped: UsageConsumption['levels']; services: string[] } {
    const contracted = contract.contractedServices instanceof Map
      ? Object.fromEntries(contract.contractedServices as Map<string, string>)
      : contract.contractedServices ?? {};
    const serviceKeys = new Map(Object.keys(contracted).map(key => [key.toLowerCase(), key]));

    const gone = consumption.levels.filter(({ serviceName }) => !serviceKeys.has(serviceName.toLowerCase()));
    if (gone.length > 0) {
      const names = [...new Set(gone.map(({ serviceName }) => serviceName))];
      throw new Error(
        `CONFLICT: Consumption ${consumption.id} cannot be reverted: the contract of userId ${consumption.userId} ` +
          `no longer has service ${names.join(', ')} (usage level ` +
          `${gone.map(({ serviceName, usageLimit }) => `${serviceName}.${usageLimit}`).join(', ')}); nothing was subtracted`
      );
    }

    const has = ({ serviceName, usageLimit }: UsageConsumption['levels'][number]) =>
      !!contract.usageLevels?.[serviceName]?.[usageLimit];
    return {
      present: consumption.levels.filter(has),
      skipped: consumption.levels.filter(level => !has(level)),
      services: [...new Set(consumption.levels.map(({ serviceName }) => serviceKeys.get(serviceName.toLowerCase())!))],
    };
  }

  /**
   * Subtract a claimed consumption; the claim is given back if that fails, so that the revert can be retried.
   *
   * @returns what was reverted and skipped when a level was skipped (see
   *          `revertConsumption`), null when every level was reverted.
   */
  private async _takeBackConsumption(consumption: UsageConsumption): Promise<ConsumptionRevertResult | null> {
    const { userId, organizationId } = consumption;
    try {
      // The levels of the contract's services, in one update; a level whose
      // service is gone refuses the revert (and gives the claim back), one
      // that its service no longer has is skipped. The update requires what
      // was decided to still hold (the services, the levels present and the
      // skipped ones absent); if that changes in between, look again.
      for (let attempt = 0; attempt < 3; attempt++) {
        const contract = await this.contractRepository.findByUserId(userId, organizationId);
        if (!contract) {
          throw new Error(`Contract with userId ${userId} not found`);
        }
        const { present, skipped, services } = this._resolveConsumption(consumption, contract);
        const levels = present.map(({ serviceName, usageLimit, amount, resetTimeStamp }) => ({
          path: `${serviceName}.${usageLimit}`,
          amount,
          resetTimeStamp: resetTimeStamp ? new Date(resetTimeStamp) : null,
        }));

        const applied = await this.contractRepository.decrementUsageLevels(userId, organizationId, levels, {
          services,
          absent: skipped.map(({ serviceName, usageLimit }) => `${serviceName}.${usageLimit}`),
        });
        if (applied) {
          await this.cacheService.del(contractCacheKey(organizationId, userId));
          if (skipped.length === 0) return null;
          return {
            consumptionId: consumption.id,
            reverted: Object.fromEntries(present.map(({ serviceName, usageLimit, amount }) => [`${serviceName}-${usageLimit}`, amount])),
            skipped: skipped.map(({ serviceName, usageLimit }) => `${serviceName}-${usageLimit}`),
          };
        }
      }
      throw new Error(`Failed to revert consumption ${consumption.id} for userId ${userId}`);
    } catch (error) {
      if (!String((error as Error)?.message).includes('not found')) {
        await this.usageConsumptionRepository.release(consumption.id);
      }
      throw error;
    }
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
        // What each deleted contract was, for its CONTRACT_DELETED event.
        const deleted = await this.contractRepository.findEventSummaries(org);
        removed += await this.contractRepository.prune(org);
        for (const contract of deleted) this._events()?.emitContractEvent('CONTRACT_DELETED', contract, { deleted: true });
        const services = await ServiceModel.find({ organizationId: org, source: 'sphere' }).select('_id').lean();
        for (const service of services) await container.resolve('sphereSyncService').cleanup(String(service._id), assertOwned);
        await this.usageConsumptionRepository.deleteAll(org);
      };
      if (await ServiceModel.exists({ organizationId: org, source: 'sphere' })) await withOrganizationLock(org, clean);
      else await clean(async () => {});
    }
    if (organizationId) {
      await this.cacheService.delMany(organizationContractCachePatterns(organizationId));
    } else {
      await this.cacheService.del('contracts.*');
      await this.cacheService.del('features.*');
    }
    return removed;
  }

  async destroy(userId: string, organizationId: string): Promise<void> {
    const contract = await this._findContract(userId, organizationId);

    await this.contractRepository.destroy(userId, contract.organizationId);

    // A contract created later with this userId starts without revertible consumptions.
    await this.usageConsumptionRepository.deleteAll(contract.organizationId, userId);
    await this.cacheService.delMany(contractCacheKeys(contract));
    this._events()?.emitContractEvent('CONTRACT_DELETED', contract, { deleted: true });
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

  _discoverUsageLimitServices(
    contract: LeanContract,
    usageLimit: string,
    dormant: Record<string, DormantReason> = {}
  ): string[] {
    const serviceNames: string[] = [];
    for (const serviceName in contract.usageLevels) {
      if (dormant[serviceName.toLowerCase()]) continue;
      if (contract.usageLevels[serviceName][usageLimit]) {
        serviceNames.push(serviceName);
      }
    }
    return serviceNames;
  }

  async _resetUsageLimitUsageLevels(
    contract: LeanContract,
    usageLimit: string,
    organizationId: string,
    dormant: Record<string, DormantReason> = {}
  ): Promise<void> {
    const serviceNames: string[] = this._discoverUsageLimitServices(contract, usageLimit, dormant);

    if (serviceNames.length === 0) {
      const [dormantService] = this._discoverUsageLimitServices(contract, usageLimit);
      if (dormantService) throw new DormantServiceError(dormantService.toLowerCase(), dormant[dormantService.toLowerCase()]);
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
    organizationId: string,
    dormant: Record<string, DormantReason> = {}
  ): Promise<void> {
    for (const serviceName in contract.usageLevels) {
      if (dormant[serviceName.toLowerCase()]) continue;
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

  /**
   * Renew the renewable usage levels whose period ended: `consumed` back to 0
   * and `resetTimeStamp` moved forward by whole periods until it is in the
   * future. Each level is written on its own and only while its stored
   * `resetTimeStamp` is still the one that ended, so it is renewed once per
   * period even when several evaluations notice the end at the same time
   * (consumptions applied right after the first renewal are not reset by the
   * others), and nothing else of the contract is written.
   *
   * Before, the new `resetTimeStamp` was computed but never stored: once a
   * period had ended, every evaluation reset the level again.
   *
   * @returns the stored contract after the renewals.
   */
  async _resetRenewableUsageLevels(
    contract: LeanContract,
    usageLimitsToRenew: string[],
    organizationId: string
  ): Promise<LeanContract> {
    if (usageLimitsToRenew.length === 0) {
      return contract;
    }

    const userId = contract.userContact.userId;
    const now = new Date();

    for (const usageLimitId of usageLimitsToRenew) {
      const serviceName: string = usageLimitId.split('-')[0];
      const usageLimitName: string = usageLimitId.split('-')[1];
      const stored = contract.usageLevels?.[serviceName]?.[usageLimitName]?.resetTimeStamp;

      if (!stored || !isAfter(now, new Date(stored))) continue;

      const pricing: LeanPricing = await this.serviceService.showPricing(
        serviceName,
        contract.contractedServices[serviceName],
        organizationId
      );
      const period = pricing.usageLimits?.[usageLimitName]?.period;
      if (!period) continue;

      const ended = new Date(stored);
      let next = addPeriodToDate(ended, period);
      for (let periods = 1; !isAfter(next, now) && periods < 100_000; periods++) {
        next = addPeriodToDate(next, period);
      }
      if (!isAfter(next, now)) next = addPeriodToDate(now, period);

      const path = `${serviceName}.${usageLimitName}`;
      // No match: another evaluation renewed it first (or it is gone).
      await this.contractRepository.setUsageLevels(
        userId,
        contract.organizationId,
        { [path]: { consumed: 0, resetTimeStamp: next } },
        { [path]: ended }
      );
    }

    await this.cacheService.del(contractCacheKey(contract.organizationId, userId));
    const updatedContract = await this.contractRepository.findByUserId(userId, contract.organizationId);

    if (!updatedContract) {
      throw new Error(`Failed to update contract for userId ${userId}`);
    }

    return updatedContract;
  }
}

export default ContractService;
