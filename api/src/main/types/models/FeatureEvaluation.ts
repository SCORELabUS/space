import { PaymentType } from 'pricing4ts';
import { LeanPricingFeature } from './Pricing';

export interface LeanFeature {
  info: LeanPricingFeature;
  service: string;
  pricingVersion: string;
}

export interface FeatureIndexQueryParams {
  featureName?: string;
  serviceName?: string;
  pricingVersion?: string;
  page?: number;
  offset?: number;
  limit?: number;
  sort?: 'featureName' | 'serviceName';
  order?: 'asc' | 'desc';
  show?: 'active' | 'archived' | 'all';
}

export interface FeatureEvalQueryParams {
  details?: boolean;
  server?: boolean;
  returnContexts?: boolean;
}

export type SimpleFeatureEvaluation = Record<string, boolean>;

export type DetailedFeatureEvaluation = Record<string, FeatureEvaluationResult>;

export type PricingContext = {features: Record<string, string | boolean>, usageLimits: Record<string, number | boolean>};

export type SubscriptionContext = Record<string, number>;

export type EvaluationContext = Record<string, string>;

export interface FeatureEvaluationResult {
  eval: boolean;
  used: Record<string, number | boolean> | null;
  limit: Record<string, number | boolean> | null;
  error: {
    code: string;
    message: string;
  } | null;
  /**
   * Id of the consumption this evaluation applied (single-feature evaluation
   * with an expected consumption that was applied), for reverting it with
   * `?revert=true&consumptionId=`. Absent otherwise.
   */
  consumptionId?: string;
}

/**
 * A revert that skipped usage levels which their service no longer has (for
 * example, after its pricing version was archived with a fallback without that
 * limit): the levels it gave back, with the
 * amounts recorded, and those it skipped, both as usage limit ids
 * (`<service>-<limit>`, as in the expected consumption).
 */
export interface ConsumptionRevertResult {
  consumptionId: string;
  reverted: Record<string, number>;
  skipped: string[];
}

export type SingleFeatureEvalQueryParams = Omit<FeatureEvalQueryParams, "details"> & {revert?: boolean, latest?: boolean, consumptionId?: string};