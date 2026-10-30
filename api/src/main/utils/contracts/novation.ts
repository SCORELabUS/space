import { addDays } from "date-fns";
import { LeanContract } from "../../types/models/Contract";
import { escapeContractedServiceVersions } from "./helpers";
import { convertKeysToLowercase } from "../helpers";

/** Fields owned by a novation; consumption and contact must keep their stored values. */
export function novationFields(contract: LeanContract): Pick<LeanContract,
  'contractedServices' | 'subscriptionPlans' | 'subscriptionAddOns' | 'billingPeriod' | 'history'> {
  const { contractedServices, subscriptionPlans, subscriptionAddOns, billingPeriod, history } = contract;
  return { contractedServices, subscriptionPlans, subscriptionAddOns, billingPeriod, history };
}

export function performNovation(contract: LeanContract, newSubscription: any): LeanContract {
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

  const startDate = new Date();
  const renewalDays = newContract.billingPeriod?.renewalDays ?? 30; // Default to 30 days if not provided
  const endDate = addDays(new Date(startDate), renewalDays);

  newContract.billingPeriod = {
    startDate: startDate,
    endDate: endDate,
    autoRenew: newSubscription.billingPeriod?.autoRenew ?? contract.billingPeriod.autoRenew,
    renewalDays: renewalDays,
  };

  return newContract;
}
