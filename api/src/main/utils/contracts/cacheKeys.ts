/**
 * Cache keys of per-user contract data.
 *
 * A contract is identified by its organization and its `userId`: the `userId`
 * is chosen by each host application and is only unique within an
 * organization, so every key below starts with the organization.
 *
 * The `userId` is written as the hex of its UTF-8 bytes. `CacheService`
 * lowercases keys, so the raw value would make "Alice" and "alice" share
 * entries; hex is also free of `.`, `*` and the other characters that would
 * change the meaning of the patterns used to invalidate them.
 *
 * Keys of SPACE versions before this scheme (`contracts.<userId>`,
 * `features.<userId>.*`, `<ts>.usageLevels.<userId>.*`) are no longer read or
 * written; they expire on their own (at most one hour).
 */

/** Minimal shape of a contract for its cache keys. */
export interface ContractIdentity {
  organizationId: string;
  userContact: { userId: string };
}

const userSegment = (userId: string): string => Buffer.from(String(userId), 'utf8').toString('hex');

/** The cached contract. */
export const contractCacheKey = (organizationId: string, userId: string): string =>
  `contracts.${organizationId}.${userSegment(userId)}`;

/** A cached evaluation or pricing token: `suffix` is `eval`, `eval.<featureId>` or `pricingToken`. */
export const featuresCacheKey = (organizationId: string, userId: string, suffix: string): string =>
  `features.${organizationId}.${userSegment(userId)}.${suffix}`;

/** Every cached evaluation and pricing token of one contract (for `CacheService.del`). */
export const featuresCachePattern = (organizationId: string, userId: string): string =>
  `features.${organizationId}.${userSegment(userId)}.*`;

/** What a usage level held before an expected consumption was applied (for a later revert). */
export const usageLevelSnapshotKey = (
  appliedAt: number,
  organizationId: string,
  userId: string,
  serviceName: string,
  usageLimit: string
): string => `${appliedAt}.usageLevels.${organizationId}.${userSegment(userId)}.${serviceName}.${usageLimit}`;

/** Every snapshot of one usage level of one contract (for `CacheService.match`). */
export const usageLevelSnapshotPattern = (
  organizationId: string,
  userId: string,
  serviceName: string,
  usageLimit: string
): string => `*.usageLevels.${organizationId}.${userSegment(userId)}.${serviceName}.${usageLimit}`;

/** The cached contract and every cached evaluation and token of it. */
export const contractCacheKeys = (contract: ContractIdentity): string[] => [
  contractCacheKey(contract.organizationId, contract.userContact.userId),
  featuresCachePattern(contract.organizationId, contract.userContact.userId),
];

/** Every cached contract, evaluation and token of an organization. */
export const organizationContractCachePatterns = (organizationId: string): string[] => [
  `contracts.${organizationId}.*`,
  `features.${organizationId}.*`,
];
