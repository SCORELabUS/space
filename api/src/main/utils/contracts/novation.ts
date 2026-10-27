import { addDays } from "date-fns";
import { LeanContract } from "../../types/models/Contract";
import { escapeContractedServiceVersions } from "./helpers";
import { convertKeysToLowercase } from "../helpers";

/**
 * @param options.keepBillingPeriod keep the current billing period (start and
 *        end date) instead of starting a new one. The previous subscription is
 *        still recorded in the history.
 */
export function performNovation(
  contract: LeanContract,
  newSubscription: any,
  options: { keepBillingPeriod?: boolean } = {}
): LeanContract {
  const newContract: LeanContract = {
    ...contract,
    contractedServices: convertKeysToLowercase(escapeContractedServiceVersions(newSubscription.contractedServices)),
    subscriptionPlans: convertKeysToLowercase(newSubscription.subscriptionPlans),
    subscriptionAddOns: convertKeysToLowercase(newSubscription.subscriptionAddOns),
  };

  newContract.history.push({
    startDate: contract.billingPeriod.startDate,
    endDate: new Date(),
    contractedServices: contract.contractedServices,
    subscriptionPlans: contract.subscriptionPlans,
    subscriptionAddOns: contract.subscriptionAddOns,
  });

  const renewalDays = newContract.billingPeriod?.renewalDays ?? 30; // Default to 30 days if not provided
  const startDate = options.keepBillingPeriod ? contract.billingPeriod.startDate : new Date();
  const endDate = options.keepBillingPeriod
    ? contract.billingPeriod.endDate
    : addDays(new Date(startDate), renewalDays);

  newContract.billingPeriod = {
    startDate: startDate,
    endDate: endDate,
    autoRenew: newSubscription.billingPeriod?.autoRenew ?? contract.billingPeriod.autoRenew,
    renewalDays: renewalDays,
  };

  return newContract;
}