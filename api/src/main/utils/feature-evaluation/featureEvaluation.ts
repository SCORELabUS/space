import container from '../../config/container';
import ContractService from '../../services/ContractService';
import { LeanContract } from '../../types/models/Contract';
import {
  DetailedFeatureEvaluation,
  EvaluationContext,
  FeatureEvaluationResult,
  PricingContext,
  SimpleFeatureEvaluation,
  SubscriptionContext,
} from '../../types/models/FeatureEvaluation';

async function evaluateAllFeatures(
  pricingContext: PricingContext,
  subscriptionContext: SubscriptionContext,
  evaluationContext: EvaluationContext,
  simple: boolean = true
): Promise<SimpleFeatureEvaluation | DetailedFeatureEvaluation> {
  const features = Object.keys(evaluationContext);
  const result: SimpleFeatureEvaluation | DetailedFeatureEvaluation = {};

  for (const featureId of features) {
    result[featureId] = await evaluateFeature(
      featureId,
      pricingContext,
      subscriptionContext,
      evaluationContext,
      { simple: simple }
    );
  }

  return result;
}

/**
 * The subscription a consumption was evaluated against changed before it
 * could be written: evaluate again on the stored contract.
 */
class ConsumptionRetryError extends Error {
  constructor() {
    super('CONFLICT: The contract changed while the consumption was being applied; retry');
    this.name = 'ConsumptionRetryError';
  }
}

async function evaluateFeature(
  featureId: string,
  pricingContext: PricingContext,
  subscriptionContext: SubscriptionContext,
  evaluationContext: EvaluationContext,
  options: {
    simple: boolean;
    expectedConsumption?: Record<string, number>;
    userId?: string;
    organizationId?: string;
    /** The contract the contexts were built from; the consumption is only applied to that subscription. */
    contract?: LeanContract;
  } = {
    simple: true,
  }
): Promise<boolean | FeatureEvaluationResult> {
  let featureEvaluation: FeatureEvaluationResult = _evaluate(
    featureId,
    pricingContext,
    subscriptionContext,
    evaluationContext,
    options.expectedConsumption
  );

  if (featureEvaluation.eval && featureEvaluation.used !== null) {
    const expectedConsumption = options.expectedConsumption;

    if (expectedConsumption && Object.keys(expectedConsumption).length > 0) {
      // First validate all limits exist in expectedConsumption
      for (const limit in featureEvaluation.used) {
        if (expectedConsumption[limit] === undefined) {
          throw new Error(
            `Expected consumption for limit '${limit}' not provided. Please provide expected consumption for all limits involved in the evaluation of feature '${featureId}' or none at all.`
          );
        }
      }

      // Then apply all consumptions in one conditional atomic update: every
      // level is incremented only while it stays within its limit (the limit
      // of the contract's current subscription, as computed above), all of
      // them or none. The decision above was made on the contract as it was
      // read; the update makes sure it still holds when it is written.
      if (options.userId) {
        // A userId is only unique within an organization.
        if (!options.organizationId) {
          throw new Error(`An organization is required to consume the usage levels of userId ${options.userId}`);
        }
        const contractService: ContractService = container.resolve('contractService');

        const consumptions: Record<string, number> = {};
        for (const limit of Object.keys(featureEvaluation.used)) {
          consumptions[limit] = expectedConsumption[limit];
        }

        const outcome = await contractService._applyExpectedConsumptions(
          options.userId,
          consumptions,
          options.organizationId,
          { limits: featureEvaluation.limit ?? {}, contract: options.contract, featureId }
        );

        if (outcome.status === 'changed') {
          throw new ConsumptionRetryError();
        }

        // `used` from the stored levels rather than from the contract that was
        // read: under concurrency they differ, and the stored ones are what
        // the limit was checked against.
        const used = _usedAfter(featureEvaluation.used, consumptions, outcome.contract, outcome.status === 'applied');

        if (outcome.status === 'limit') {
          // Exactly what an evaluation over the limit answers.
          featureEvaluation = { eval: false, used, limit: featureEvaluation.limit, error: null };
        } else {
          featureEvaluation = {
            ...featureEvaluation,
            used,
            ...(outcome.consumptionId ? { consumptionId: outcome.consumptionId } : {}),
          };
        }
      }
    }
  }

  if (options.simple) {
    return featureEvaluation.eval;
  } else {
    return featureEvaluation;
  }
}

/**
 * `used` of a consumption from the stored usage levels: the level after the
 * consumption when it was applied, or the level plus the consumption (what it
 * would have reached) when it was refused. Limits whose level cannot be found
 * keep the value computed from the contract that was read.
 */
function _usedAfter(
  computed: Record<string, number | boolean>,
  consumptions: Record<string, number>,
  contract: LeanContract | undefined,
  applied: boolean
): Record<string, number | boolean> {
  const used: Record<string, number | boolean> = { ...computed };
  for (const limit of Object.keys(computed)) {
    const serviceName = limit.split('-')[0];
    const usageLimit = limit.split('-')[1];
    const consumed = contract?.usageLevels?.[serviceName]?.[usageLimit]?.consumed;
    if (typeof consumed === 'number') {
      used[limit] = applied ? consumed : consumed + consumptions[limit];
    }
  }
  return used;
}

function _evaluate(
  featureId: string,
  pricingContext: PricingContext,
  subscriptionContext: SubscriptionContext,
  evaluationContext: EvaluationContext,
  expectedConsumption?: Record<string, number>
): FeatureEvaluationResult {
  // Check if feature exists
  if (pricingContext.features[featureId] === undefined) {
    return _createErrorResult(
      'FLAG_NOT_FOUND',
      `Feature ${featureId} not found in "pricingContext".`
    );
  }

  const featureExpression: string | undefined = evaluationContext[featureId];

  // Validate feature expression
  const expressionError = validateExpression(featureId, featureExpression, pricingContext, subscriptionContext);
  if (expressionError) return expressionError;

  // Evaluate the expression
  try {
    const evalResult: boolean = eval(featureExpression!);

    if (typeof evalResult !== 'boolean') {
      return _createErrorResult(
        'TYPE_MISMATCH',
        `Feature ${featureId} has an expression that does not return a boolean! Returned value: ${evalResult} of type ${typeof evalResult}`
      );
    }

    if (evalResult === null || evalResult === undefined) {
      return _createErrorResult(
        'TYPE_MISMATCH',
        `Error while evaluating expression for feature ${featureId}. The returned expression is null or undefined`
      );
    }

    return _buildSuccessResult(
      featureId,
      featureExpression!,
      evalResult,
      pricingContext,
      subscriptionContext,
      expectedConsumption
    );
  } catch (error) {
    return _createErrorResult(
      'EVALUATION_ERROR',
      `Error evaluating feature ${featureId}: ${error}`
    );
  }
}

function _createErrorResult(code: string, message: string): FeatureEvaluationResult {
  console.warn(`[WARNING] ${message}`);
  return {
    eval: false,
    limit: null,
    used: null,
    error: { code, message },
  };
}

function validateExpression(
  featureId: string,
  expression?: string,
  pricingContext?: PricingContext,
  subscriptionContext?: SubscriptionContext
): FeatureEvaluationResult | null {
  if (!expression) {
    return _createErrorResult('PARSE_ERROR', `Feature ${featureId} has no expression defined!`);
  }

  if (!expression.includes('pricingContext') && !expression.includes('subscriptionContext')) {
    return _createErrorResult(
      'PARSE_ERROR',
      `Feature ${featureId} has no expression defined! If an expression is intended, please ensure it only references hard-coded values or variables from "pricingContext" and "subscriptionContext".`
    );
  }

  const invoquedFeatures = expression.match(/pricingContext\['features'\]\['([^']+)'\]/g)?.map(match => match.match(/pricingContext\['features'\]\['([^']+)'\]/)![1]) || [];
  const invoquedUsageLimits = expression.match(/subscriptionContext\['([^']+)'\]/g)?.map(match => match.match(/subscriptionContext\['([^']+)'\]/)![1]) || [];
  const invoquedUsageLevels = expression.match(/pricingContext\['usageLevels'\]\['([^']+)'\]/g)?.map(match => match.match(/pricingContext\['usageLevels'\]\['([^']+)'\]/)![1]) || [];

  for (const feature of invoquedFeatures) {
    if (pricingContext?.features[feature] === undefined) {
      return _createErrorResult(
        'PARSE_ERROR',
        `Feature ${featureId} expression references feature '${feature}' that was not found in pricingContext.features.`
      );
    }
  }

  for (const limit of invoquedUsageLimits) {
    if (subscriptionContext && subscriptionContext[limit] === undefined) {
      return _createErrorResult(
        'PARSE_ERROR',
        `Feature ${featureId} expression references usage limit '${limit}' that was not found in subscriptionContext.`
      );
    }
  }

  for (const limit of invoquedUsageLevels) {
    if (pricingContext?.usageLimits[limit] === undefined) {
      return _createErrorResult(
        'PARSE_ERROR',
        `Feature ${featureId} expression references usage level '${limit}' that was not found in pricingContext.usageLimits.`
      );
    }
  }

  return null;
}

function _buildSuccessResult(
  featureId: string,
  featureExpression: string,
  evalResult: boolean,
  pricingContext: PricingContext,
  subscriptionContext: SubscriptionContext,
  expectedConsumption?: Record<string, number>
): FeatureEvaluationResult {
  const limitsInvolvedInEvaluation = [
    ...featureExpression.matchAll(/subscriptionContext\['([^']+)'\]/g),
  ];

  const featureLimits: Record<string, number | boolean> = {};
  const usageLevels: Record<string, number> = {};

  for (const limit of limitsInvolvedInEvaluation) {
    const limitKey = limit[1];
    featureLimits[limitKey] = pricingContext.usageLimits[limitKey];

    if (expectedConsumption && Object.keys(expectedConsumption).length > 0) {
      const updatedUsageLevel = _updateUsageLevel(
        subscriptionContext[limitKey],
        expectedConsumption[limitKey]
      );
      if (updatedUsageLevel === undefined) {
        return _createErrorResult(
          'INVALID_EXPECTED_CONSUMPTION',
          `No expectedConsumption value was provided for limit '${limitKey}', which is used in the evaluation of feature '${featureId}'. Please note that if you provide an expectedConsumption for any limit, you must provide it for all limits involved in that feature's evaluation.`
        );
      }
      usageLevels[limitKey] = updatedUsageLevel;
    } else {
      usageLevels[limitKey] = subscriptionContext[limitKey];
    }
  }

  return {
    eval: evalResult,
    limit: Object.keys(featureLimits).length === 0 ? null : featureLimits,
    used: Object.keys(usageLevels).length === 0 ? null : usageLevels,
    error: null,
  };
}

function _updateUsageLevel(
  currentUsageLevel: number,
  expectedConsumption?: number
): number | undefined {
  // `undefined` means the caller did not mention this limit, which is the
  // error the caller is told about. `0` means they mentioned it and it costs
  // nothing - a different statement, and one a falsy check cannot tell apart.
  if (expectedConsumption === undefined || expectedConsumption === null) {
    return undefined;
  }

  return currentUsageLevel + expectedConsumption;
}

export { evaluateAllFeatures, evaluateFeature, ConsumptionRetryError };
