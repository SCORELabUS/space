import { createHash } from 'node:crypto';
import { escapeVersion, resetEscapeVersion } from '../helpers';

/**
 * The opaque version of a contract, used for optimistic concurrency.
 *
 * It is derived from what a novation depends on, not stored: the subscription
 * (contracted pricing versions, plans and add-ons), the billing period and how
 * many novations and synchronization migrations the contract has gone through.
 * Every writer that changes any of these - novations, SPHERE migrations, the
 * fallback novation when a pricing is archived, renewals - therefore changes the
 * version without having to remember to, and legacy documents need no
 * migration. Consumption (`usageLevels`) and the user contact are not part of
 * it: recording usage is not a change of contract.
 *
 * The history lengths make the version strictly move forward: novating A -> B
 * -> A yields a different version than the original A.
 */

type VersionedContract = {
  contractedServices?: Record<string, string> | Map<string, string>;
  subscriptionPlans?: Record<string, string> | Map<string, string>;
  subscriptionAddOns?: Record<string, Record<string, number>> | Map<string, any>;
  billingPeriod?: { startDate?: Date | string; endDate?: Date | string; autoRenew?: boolean; renewalDays?: number };
  history?: unknown[];
  synchronizationHistory?: unknown[];
};

const plain = (value: any): Record<string, any> => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
};

const canonical = (value: any): any => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])])
    );
  }
  return value;
};

const isoDate = (value?: Date | string) => (value === undefined || value === null ? null : new Date(value).toISOString());

export function computeContractVersion(contract: VersionedContract): string {
  const historyLength = contract.history?.length ?? 0;
  const synchronizations = contract.synchronizationHistory?.length ?? 0;

  const versions = Object.fromEntries(
    Object.entries(plain(contract.contractedServices)).map(([service, version]) => [
      service.toLowerCase(),
      resetEscapeVersion(String(version)),
    ])
  );
  const plans = Object.fromEntries(
    Object.entries(plain(contract.subscriptionPlans)).map(([service, plan]) => [service.toLowerCase(), plan])
  );
  const addOns = Object.fromEntries(
    Object.entries(plain(contract.subscriptionAddOns)).map(([service, selected]) => [
      service.toLowerCase(),
      plain(selected),
    ])
  );

  const material = canonical({
    contractedServices: versions,
    subscriptionPlans: plans,
    subscriptionAddOns: addOns,
    billingPeriod: {
      startDate: isoDate(contract.billingPeriod?.startDate),
      endDate: isoDate(contract.billingPeriod?.endDate),
      autoRenew: contract.billingPeriod?.autoRenew ?? null,
      renewalDays: contract.billingPeriod?.renewalDays ?? null,
    },
    history: historyLength,
    synchronizationHistory: synchronizations,
  });

  const digest = createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 16);
  return `${historyLength}-${digest}`;
}

/** Strip the quotes (and weak prefix) of an entity tag. `*` is returned as is. */
export function parseEntityTag(header?: string): string | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (value === '*') return value;
  return value.replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

/** Pin an array to exactly `length` elements (a missing array counts as empty). */
const exactLength = (path: string, length: number): Record<string, unknown> => ({
  [`${path}.${length}`]: { $exists: false },
  ...(length > 0 ? { [`${path}.${length - 1}`]: { $exists: true } } : {}),
});

const keyCount = (path: string, count: number) => ({
  $eq: [{ $size: { $objectToArray: { $ifNull: [`$${path}`, {}] } } }, count],
});

/**
 * MongoDB filter conditions that only match while the stored contract still
 * has the version of `contract` (as it was read from the database). Used to
 * make a novation conditional: when anything the version depends on changed in
 * between, the update matches nothing instead of overwriting that change.
 */
export function contractVersionGuard(contract: VersionedContract): Record<string, unknown> {
  const guard: Record<string, unknown> = {
    ...exactLength('history', contract.history?.length ?? 0),
    ...exactLength('synchronizationHistory', contract.synchronizationHistory?.length ?? 0),
  };
  const counts: any[] = [];

  for (const field of ['contractedServices', 'subscriptionPlans'] as const) {
    const entries = Object.entries(plain(contract[field]));
    // Pricing versions are stored escaped ('.' -> '_'); callers may hold either form.
    for (const [key, value] of entries) {
      guard[`${field}.${key}`] = field === 'contractedServices' ? escapeVersion(String(value)) : value;
    }
    counts.push(keyCount(field, entries.length));
  }

  const addOns = Object.entries(plain(contract.subscriptionAddOns));
  counts.push(keyCount('subscriptionAddOns', addOns.length));
  for (const [service, selected] of addOns) {
    const entries = Object.entries(plain(selected));
    for (const [addOn, quantity] of entries) guard[`subscriptionAddOns.${service}.${addOn}`] = quantity;
    counts.push(keyCount(`subscriptionAddOns.${service}`, entries.length));
  }

  const billing = contract.billingPeriod ?? {};
  for (const key of ['startDate', 'endDate'] as const) {
    if (billing[key] !== undefined) guard[`billingPeriod.${key}`] = new Date(billing[key]!);
  }
  if (billing.autoRenew !== undefined) guard['billingPeriod.autoRenew'] = billing.autoRenew;
  if (billing.renewalDays !== undefined) guard['billingPeriod.renewalDays'] = billing.renewalDays;

  guard.$expr = { $and: counts };
  return guard;
}

/**
 * A novation was conditional on a contract version that is no longer current.
 * `contractVersion` is the current version of the contract or, for a group
 * novation, the current versions (null: not in the group) of the contracts
 * whose precondition failed.
 */
export class ContractChangedError extends Error {
  constructor(
    public readonly contractVersion: string | Record<string, string | null>,
    /** Group novation only: contracts that were novated nevertheless. */
    public readonly novated?: string[]
  ) {
    super('CONTRACT_CHANGED');
    this.name = 'ContractChangedError';
  }
}
