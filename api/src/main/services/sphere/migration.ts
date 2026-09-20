import { LeanPricing } from '../../types/models/Pricing';
import { generateUsageLevels } from '../../utils/contracts/helpers';

export function numericPrice(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
export function migrateSubscription(contract: any, service: string, pricing: LeanPricing, validate: (subscription: any) => void) {
  const subscription = { contractedServices: { ...contract.contractedServices, [service]: pricing.version },
    subscriptionPlans: { ...contract.subscriptionPlans }, subscriptionAddOns: { ...contract.subscriptionAddOns } };
  try { validate(subscription); return { subscription, replaced: false }; } catch { /* Try the documented fallback. */ }
  const candidates = Object.entries(pricing.plans ?? {}).filter(([, plan]) => !plan.private && numericPrice(plan.price) !== null)
    .sort(([a, x], [b, y]) => numericPrice(x.price)! - numericPrice(y.price)! || a.localeCompare(b));
  for (const [key] of candidates) {
    subscription.subscriptionPlans[service] = key;
    subscription.subscriptionAddOns[service] = {};
    try { validate(subscription); return { subscription, replaced: true }; } catch { /* Next valid plan. */ }
  }
  throw new Error('No valid public numeric-price plan without add-ons is available for automatic migration');
}
export function migrateUsage(previous: LeanPricing, next: LeanPricing, current: any = {}) {
  const result: any = generateUsageLevels(next) ?? {};
  for (const [key, value] of Object.entries(current)) {
    const before = previous.usageLimits?.[key];
    const after = next.usageLimits?.[key];
    if (!after) continue;
    if (!before || before.type !== after.type || before.valueType !== after.valueType ||
      JSON.stringify(before.period) !== JSON.stringify(after.period) || before.trackable !== after.trackable || before.unit !== after.unit) {
      throw new Error(`Incompatible consumption semantics for ${key}`);
    }
    result[key] = value;
  }
  return result;
}
