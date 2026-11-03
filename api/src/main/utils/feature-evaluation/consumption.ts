/**
 * The usage levels an expected consumption increments, and the limit that
 * bounds each of them.
 *
 * Usage limits are flattened as `<service>-<limit>` in evaluation contexts
 * (see `flattenUsageLevelsIntoSubscriptionContext`); usage levels are stored
 * as `usageLevels.<service>.<limit>`.
 */
export interface ConsumptionTarget {
  serviceName: string;
  usageLimit: string;
  amount: number;
  /**
   * Highest value the level may reach with this consumption: the increment is
   * only written while `consumed + amount <= ceiling`. Null when the level is
   * not bounded (see `consumptionTargets`).
   */
  ceiling: number | null;
}

/**
 * The ceiling of a usage limit as evaluation computes it (the plan's value,
 * with add-on overrides and extensions applied): its value when it is a finite
 * number, zero included. Anything else bounds nothing: a boolean limit, a
 * missing one (`null`/`undefined`) or an infinite one (unlimited).
 */
export function usageLimitCeiling(limit: unknown): number | null {
  return typeof limit === 'number' && Number.isFinite(limit) ? limit : null;
}

/**
 * @param consumptions flattened limit id -> amount to add.
 * @param limits flattened limit id -> limit value of the contract's current
 *        subscription (the `limit` of the evaluation).
 *
 * Only positive amounts are bounded: zero or a negative amount (a credit)
 * cannot take a level over its limit, and refusing a credit to a level that is
 * already over it (after a downgrade, for example) would keep it there.
 */
export function consumptionTargets(
  consumptions: Record<string, number>,
  limits: Record<string, unknown> = {}
): ConsumptionTarget[] {
  return Object.entries(consumptions).map(([usageLimitId, amount]) => {
    const serviceName: string = usageLimitId.split('-')[0];
    const usageLimit: string = usageLimitId.split('-')[1];
    const ceiling = amount > 0 ? usageLimitCeiling(limits[usageLimitId]) : null;
    return { serviceName, usageLimit, amount, ceiling };
  });
}

/** `<service>-<feature>` with the service lowercased, as evaluation contexts key features. */
export function normalizeFeatureId(featureId: string): string {
  const separator = featureId.indexOf('-');
  if (separator < 0) return featureId;
  return `${featureId.slice(0, separator).toLowerCase()}${featureId.slice(separator)}`;
}
