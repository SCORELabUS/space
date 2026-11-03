import { LeanContract, UsageLevel } from '../../types/models/Contract';
import { LeanPricing } from '../../types/models/Pricing';
import { addPeriodToDate, escapeVersion, resetEscapeVersion } from '../helpers';

function generateUsageLevels(pricing: LeanPricing): Record<string, UsageLevel> | undefined {
  const serviceUsageLevels: Record<string, UsageLevel> = {};

  if (!pricing.usageLimits) {
    return undefined;
  }

  for (const usageLimit of Object.values(pricing.usageLimits)) {
    const mustBeTracked = usageLimit.period || usageLimit.trackable;

    if (mustBeTracked) {
      if (usageLimit.type === 'RENEWABLE') {
        if (!usageLimit.period) {
          throw new Error(
            `Usage limit ${usageLimit.name} must have a period defined, since it is RENEWABLE`
          );
        }

        let resetTimeStamp = new Date();
        resetTimeStamp = addPeriodToDate(resetTimeStamp, usageLimit.period);

        serviceUsageLevels[usageLimit.name] = {
          resetTimeStamp: resetTimeStamp,
          consumed: 0,
        };
      } else {
        serviceUsageLevels[usageLimit.name] = {
          consumed: 0,
        };
      }
    }
  }
  return Object.keys(serviceUsageLevels).length === 0 ? undefined : serviceUsageLevels;
}

function escapeContractedServiceVersions(contractedServices: Record<string, string>): Record<string, string> {
  const escapedServices: Record<string, string> = {};
  
  for (const [serviceName, version] of Object.entries(contractedServices)) {
    const escapedVersion = escapeVersion(version);
    escapedServices[serviceName] = escapedVersion;
  }

  return escapedServices;
}

function resetEscapeContractedServiceVersions(escapedServices: Record<string, string>): Record<string, string> {
  const contractedServices: Record<string, string> = {};
  
  for (const [serviceName, escapedVersion] of Object.entries(escapedServices)) {
    const version = resetEscapeVersion(escapedVersion);
    contractedServices[serviceName] = version;
  }

  return contractedServices;
}

/**
 * A copy of the contract without some services (names compared
 * case-insensitively) in `contractedServices`, `subscriptionPlans`,
 * `subscriptionAddOns` and `usageLevels`: what feature evaluation works with
 * when services of the contract are dormant. The contract is not changed.
 */
function withoutServices(contract: LeanContract, serviceNames: string[]): LeanContract {
  const excluded = new Set(serviceNames.map(name => name.toLowerCase()));
  if (excluded.size === 0) return contract;
  const keep = <T>(record: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => !excluded.has(key.toLowerCase())));
  return {
    ...contract,
    contractedServices: keep(contract.contractedServices),
    subscriptionPlans: keep(contract.subscriptionPlans),
    subscriptionAddOns: keep(contract.subscriptionAddOns),
    usageLevels: keep(contract.usageLevels),
  };
}

export {generateUsageLevels, escapeContractedServiceVersions, resetEscapeContractedServiceVersions, withoutServices}