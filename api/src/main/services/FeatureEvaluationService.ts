import { isAfter } from 'date-fns';
import container from '../config/container';
import ServiceRepository from '../repositories/mongoose/ServiceRepository';
import { LeanContract } from '../types/models/Contract';
import {
  DetailedFeatureEvaluation,
  FeatureEvalQueryParams,
  FeatureEvaluationResult,
  FeatureIndexQueryParams,
  LeanFeature,
  PricingContext,
  SimpleFeatureEvaluation,
  SingleFeatureEvalQueryParams,
  SubscriptionContext,
} from '../types/models/FeatureEvaluation';
import { LeanPricing } from '../types/models/Pricing';
import {
  flattenConfigurationsIntoPricingContext,
  flattenFeatureEvaluationsIntoEvaluationContext,
  flattenUsageLevelsIntoSubscriptionContext,
  getFeatureEvaluationExpressionsByService,
  getUserSubscriptionsFromContract,
  mapSubscriptionsToConfigurationsByService,
} from '../utils/feature-evaluation/evaluationContextsManagement';
import {
  evaluateAllFeatures,
  evaluateFeature,
} from '../utils/feature-evaluation/featureEvaluation';
import ContractService from './ContractService';
import ServiceService from './ServiceService';
import { generateTokenFromEvalResult } from '../utils/jwt';
import { escapeVersion } from '../utils/helpers';
import CacheService from './CacheService';

class FeatureEvaluationService {
  private readonly serviceService: ServiceService;
  private readonly serviceRepository: ServiceRepository;
  private readonly contractService: ContractService;
  private readonly cacheService: CacheService;

  constructor() {
    this.serviceRepository = container.resolve('serviceRepository');
    this.serviceService = container.resolve('serviceService');
    this.contractService = container.resolve('contractService');
    this.cacheService = container.resolve('cacheService');
  }

  async index(queryParams: FeatureIndexQueryParams, organizationId: string): Promise<LeanFeature[]> {
    const {
      featureName,
      serviceName,
      pricingVersion,
      page = 1,
      offset = 0,
      limit = 20,
      sort = 'serviceName',
      order = 'asc',
      show = 'active',
    } = queryParams || {};

    // Step 1: Generate an object that clasifies pricing details by version and service (i.e. Record<string, Record<string, LeanPricing>>)
    const pricings = await this._getPricingsToReturn(show, organizationId);

    // Step 2: Parse pricings to a list of features
    const features: LeanFeature[] = this._parsePricingsToFeatures(
      pricings,
      featureName,
      serviceName,
      pricingVersion
    );

    // Step 3: Sort features based on the sort and order parameters
    this._sortFeatures(features, sort, order);

    const startIndex = offset === 0 ? (page - 1) * limit : offset;
    const paginatedFeatures = features.slice(startIndex, startIndex + limit);

    return paginatedFeatures;
  }

  async eval(
    userId: string,
    reqOrg: any,
    options: FeatureEvalQueryParams
  ): Promise<
    | SimpleFeatureEvaluation
    | DetailedFeatureEvaluation
    | {
        pricingContext: PricingContext;
        subscriptionContext: SubscriptionContext;
        result: SimpleFeatureEvaluation | DetailedFeatureEvaluation;
      }
  > {

    // Step 1: Retrieve contexts
    const { subscriptionContext, pricingContext, evaluationContext } =
      await this._retrieveContextsByUserId(userId, options.server, reqOrg);

    // Step 2: Perform the evaluation
    const evaluationResults = await evaluateAllFeatures(
      pricingContext,
      subscriptionContext,
      evaluationContext,
      !options.details
    );

    await this.cacheService.set(`features.${userId}.eval`, evaluationResults, 3600, true); // Cache for 1 hour

    // Step 3: Return appropriate response based on options
    return options.returnContexts
      ? {
          pricingContext,
          subscriptionContext,
          result: evaluationResults,
        }
      : evaluationResults;
  }

  async generatePricingToken(userId: string, reqOrg: any, options: { server: boolean }): Promise<string> {
    // Resolve the contract within the caller's organization before anything
    // cached under this userId is returned.
    const contract = await this.contractService.show(userId, reqOrg.id);

    const cachedToken = await this.cacheService.get(`features.${userId}.pricingToken`);

    if (cachedToken) {
      return cachedToken;
    }

    const result = (await this.eval(userId, reqOrg, {
      details: true,
      server: options.server,
      returnContexts: true,
    })) as {
      pricingContext: PricingContext;
      subscriptionContext: SubscriptionContext;
      result: DetailedFeatureEvaluation;
    };

    const token = await generateTokenFromEvalResult(
      contract.userContact.userId,
      result.pricingContext,
      result.subscriptionContext,
      result.result
    );

    await this.cacheService.set(`features.${userId}.pricingToken`, token, 3600, true);

    return token;
  }

  async evalFeature(
    userId: string,
    featureId: string,
    expectedConsumption: Record<string, number>,
    reqOrg: any,
    options: SingleFeatureEvalQueryParams
  ): Promise<boolean | FeatureEvaluationResult> {
    // Resolve the contract within the caller's organization before anything
    // cached under this userId is returned.
    await this.contractService.show(userId, reqOrg.id);

    const evaluation = await this.cacheService.get(`features.${userId}.eval.${featureId}`);

    if (evaluation && !options.revert && !expectedConsumption) {
      return evaluation as FeatureEvaluationResult;
    }

    await this.cacheService.del(`features.${userId}.pricingToken`)

    // Step 1: Retrieve contexts
    const { subscriptionContext, pricingContext, evaluationContext } =
      await this._retrieveContextsByUserId(userId, options.server, reqOrg);

    if (options.revert) {
      await this.contractService._revertExpectedConsumption(
        userId,
        featureId,
        options.latest,
        reqOrg.id
      );
      return true;
    } else {
      // Step 2: Perform the evaluation
      const evaluationResults = await evaluateFeature(
        featureId,
        pricingContext,
        subscriptionContext,
        evaluationContext,
        {
          simple: false,
          expectedConsumption: expectedConsumption,
          userId: userId,
          organizationId: reqOrg.id,
        }
      );
      if (!(evaluationResults as FeatureEvaluationResult).limit) {
        await this.cacheService.set(
          `features.${userId}.eval.${featureId}`,
          evaluationResults,
          3600,
          true
        );
      }
      // Step 3: Return appropriate response based on options
      return evaluationResults as FeatureEvaluationResult;
    }
  }

  async _getPricingsByContract(contract: LeanContract, reqOrg: any): Promise<Record<string, LeanPricing>> {
    const pricingsToReturn: Record<string, LeanPricing> = {};

    // Parallelize pricing retrieval per service (showPricing may fetch remote URLs)
    const serviceNames = Object.keys(contract.contractedServices);
    const pricingPromises = serviceNames.map(async (serviceName) => {
      const pricingVersion = escapeVersion(contract.contractedServices[serviceName]);
      const pricing = await this.serviceService.showPricing(serviceName, pricingVersion, reqOrg.id);
      if (!pricing) {
        throw new Error(
          `Pricing version ${pricingVersion} for service ${serviceName} not found in organization ${reqOrg.name}`
        );
      }
      return { serviceName, pricing };
    });

    const pricingResults = await Promise.all(pricingPromises);
    for (const { serviceName, pricing } of pricingResults) {
      pricingsToReturn[serviceName] = pricing;
    }

    return pricingsToReturn;
  }

  _parsePricingsToFeatures(
    pricings: Record<string, Record<string, LeanPricing>>,
    featureName?: string,
    serviceName?: string,
    pricingVersion?: string
  ): LeanFeature[] {
    const features = [];

    for (const pricingServiceName in pricings) {
      const shouldAddService =
        !serviceName || serviceName.toLowerCase().includes(serviceName.toLowerCase());

      if (!shouldAddService) {
        continue;
      }

      for (const version in pricings[pricingServiceName]) {
        const shouldAddVersion =
          !pricingVersion || version.toLowerCase().includes(pricingVersion.toLowerCase());

        if (!shouldAddVersion) {
          continue;
        }

        for (const feature of Object.values(pricings[pricingServiceName][version].features)) {
          const shouldAddFeature =
            !featureName || feature.name.toLowerCase().includes(featureName.toLowerCase());

          if (!shouldAddFeature) {
            continue;
          }

          const featureToAdd: LeanFeature = {
            info: feature,
            service: pricingServiceName,
            pricingVersion: version,
          };

          features.push(featureToAdd);
        }
      }
    }

    return features;
  }

  _sortFeatures(
    features: LeanFeature[],
    sort: 'featureName' | 'serviceName',
    order: 'asc' | 'desc'
  ): void {
    if (sort === 'featureName') {
      features.sort((a, b) => {
        const featureA = a.info.name.toLowerCase();
        const featureB = b.info.name.toLowerCase();
        if (featureA < featureB) {
          return order === 'asc' ? -1 : 1;
        }
        if (featureA > featureB) {
          return order === 'asc' ? 1 : -1;
        }
        return 0;
      });
    } else if (sort === 'serviceName') {
      features.sort((a, b) => {
        const serviceA = a.service.toLowerCase();
        const serviceB = b.service.toLowerCase();
        if (serviceA < serviceB) {
          return order === 'asc' ? -1 : 1;
        }
        if (serviceA > serviceB) {
          return order === 'asc' ? 1 : -1;
        }
        return 0;
      });
    }
  }

  async _getPricingsToReturn(
    show: 'active' | 'archived' | 'all',
    organizationId: string
  ): Promise<Record<string, Record<string, LeanPricing>>> {
    const pricingsToReturn: Record<string, Record<string, LeanPricing>> = {};

  // Step 1: Return all services (only fields required to build pricings map)
  const services = await this.serviceRepository.findAllNoQueries(organizationId, false, { name: 1, activePricings: 1, archivedPricings: 1 });

    if (!services) {
      return {};
    }

    for (const service of services) {
      const serviceName = service.name;
      pricingsToReturn[serviceName] = {};

      // Step 2: Given the show parameter, discover all pricings that must be identified by id, and do the same for url
      let pricingsWithIdToCheck: string[] = [];
      let pricingsWithUrlToCheck: string[] = [];

      if (show === 'active' || show === 'all') {
        for (const [version, pricing] of service.activePricings) {
          if (pricing.id) {
            pricingsWithIdToCheck.push(version);
          }
          if (pricing.url) {
            pricingsWithUrlToCheck.push(version);
          }
        }
      }

      if ((show === 'archived' || show === 'all') && service.archivedPricings) {
        for (const [version, pricing] of service.archivedPricings) {
          if (pricing.id) {
            pricingsWithIdToCheck.push(version);
          }
          if (pricing.url) {
            pricingsWithUrlToCheck.push(version);
          }
        }
      }

      // Step 3: For each group (id and url) parse the versions to actual ExpectedPricingType objects
      let pricingsWithId = await this.serviceRepository.findPricingsByServiceName(
        serviceName,
        pricingsWithIdToCheck,
        organizationId
      );
      pricingsWithId ??= [];

      for (const pricing of pricingsWithId) {
        pricingsToReturn[serviceName][pricing.version] = pricing;
      }

      // Fetch all remote pricings for this service in parallel with limited concurrency
      const urlVersions = pricingsWithUrlToCheck.map((version) => ({
        version,
        url: (service.activePricings.get(version) ?? service.archivedPricings!.get(version))!.url,
      }));

      const concurrency = 8;
      for (let j = 0; j < urlVersions.length; j += concurrency) {
        const batch = urlVersions.slice(j, j + concurrency);
        const batchResults = await Promise.all(
          batch.map(async ({ version, url }) => {
            // Try cache first
            let pricing = await this.cacheService.get(`pricing.url.${url}`);
            if (!pricing) {
              if (!url) {
                throw new Error(`Pricing version ${version} for service ${serviceName} does not have a valid URL`);
              }
              pricing = await this.serviceService._getPricingFromUrl(url);
              try {
                await this.cacheService.set(`pricing.url.${url}`, pricing, 3600, true);
              } catch (err) {
                // Don't fail the pricing retrieval if cache set fails. Log for debugging.
                // eslint-disable-next-line no-console
                console.debug('Cache set failed for pricing.url.' + url, err);
              }
            }
            return { version, pricing };
          })
        );

        for (const { version, pricing } of batchResults) {
          pricingsToReturn[serviceName][version] = pricing;
        }
      }
    }

    return pricingsToReturn;
  }

  async _retrieveContextsByUserId(
    userId: string,
    server: boolean = false,
    reqOrg: any
  ): Promise<{
    subscriptionContext: SubscriptionContext;
    pricingContext: PricingContext;
    evaluationContext: Record<string, string>;
  }> {
    // Step 1.1: Retrieve the user contract, within the caller's organization
    let contract: LeanContract = await this.contractService.show(userId, reqOrg.id);

    // Step 1.2: Check if the user's contract has expired and if it can be renewed
    const isContractExpired = isAfter(new Date(), contract.billingPeriod.endDate);

    if (isContractExpired && !contract.billingPeriod.autoRenew) {
      throw new Error(
        'Invalid subscription: Your susbcription has expired and it is not set to renew automatically. To continue accessing the features, please purchase any subscription.'
      );
    } else if (isContractExpired) {
      await this.contractService.renew(userId, reqOrg.id);
    }

    // Step 1.3: Reset all expired renewable usage levels
    const usageLevelsToRenew = [];

    for (const serviceName in contract.usageLevels) {
      const usageLevels = contract.usageLevels[serviceName];
      for (const level in usageLevels) {
        const usageLevel = usageLevels[level];
        if (usageLevel.resetTimeStamp && isAfter(new Date(), usageLevel.resetTimeStamp)) {
          usageLevelsToRenew.push(`${serviceName}-${level}`);
          this.cacheService.del(`contracts.${userId}`);
        }
      }
    }

    if (usageLevelsToRenew.length > 0) {
      contract = await this.contractService._resetRenewableUsageLevels(
        contract,
        usageLevelsToRenew,
        reqOrg.id
      );
    }

    // Step 1.4: Build the subscription context
    const subscriptionContext: SubscriptionContext = flattenUsageLevelsIntoSubscriptionContext(
      contract.usageLevels
    );

    // Step 2.1: Retrieve all pricings to which the user is subscribed
    const userPricings = await this._getPricingsByContract(contract, reqOrg);

    // Step 2.2: Get User Subscriptions
    const userSubscriptionByService: Record<
      string,
      { plan?: string; addOns?: Record<string, number> }
    > = getUserSubscriptionsFromContract(contract);

    // Step 2.3: Build user configurations by service using the information of subscriptions and pricings
    const userConfigurationsByService: Record<string, PricingContext> =
      mapSubscriptionsToConfigurationsByService(userSubscriptionByService, userPricings);

    // Step 2.4: Build de pricing context
    const pricingContext: PricingContext = flattenConfigurationsIntoPricingContext(
      userConfigurationsByService
    );

    // Step 3.1: Create a map containing the evaluation expression to consider for each feature
    const evaluationExpressionsByService: Record<
      string,
      Record<string, string>
    > = getFeatureEvaluationExpressionsByService(userPricings, server ?? false);

    // Step 3.2: Build the evaluation context
    const evaluationContext: Record<string, string> =
      flattenFeatureEvaluationsIntoEvaluationContext(evaluationExpressionsByService);

    return { subscriptionContext, pricingContext, evaluationContext };
  }
}

export default FeatureEvaluationService;
