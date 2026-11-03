import { describe, expect, it } from 'vitest';
import {
  contractCacheKey,
  contractCacheKeys,
  featuresCacheKey,
  featuresCachePattern,
  organizationContractCachePatterns,
  usageLevelSnapshotKey,
  usageLevelSnapshotPattern,
} from '../../main/utils/contracts/cacheKeys';

/**
 * Cache keys of per-user contract data include the organization, since a
 * userId is only unique within one. `CacheService` lowercases every key and
 * deletes `<prefix>.*` patterns as `<prefix>*` (glob), so the tests compare
 * keys the way Redis sees them.
 */
const stored = (key: string) => key.toLowerCase();
const globToRegExp = (glob: string) =>
  new RegExp(`^${glob.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
/** Whether `CacheService.del(pattern)` / `delMany([pattern])` would delete `key`. */
const deletes = (pattern: string, key: string) =>
  pattern.endsWith('.*') ? globToRegExp(`${pattern.slice(0, -2)}*`).test(stored(key)) : stored(pattern) === stored(key);

const orgA = '64b7f0c2a1b2c3d4e5f60718';
const orgB = '64b7f0c2a1b2c3d4e5f60719';

describe('Contract cache keys', () => {
  it('differ between organizations for the same userId', () => {
    expect(stored(contractCacheKey(orgA, '42'))).not.toBe(stored(contractCacheKey(orgB, '42')));
    expect(stored(featuresCacheKey(orgA, '42', 'pricingToken'))).not.toBe(stored(featuresCacheKey(orgB, '42', 'pricingToken')));
    expect(stored(usageLevelSnapshotKey(1, orgA, '42', 'petclinic', 'maxPets'))).not.toBe(
      stored(usageLevelSnapshotKey(1, orgB, '42', 'petclinic', 'maxPets'))
    );
  });

  it('differ for userIds that only differ in letter case, even once lowercased', () => {
    expect(stored(contractCacheKey(orgA, 'Alice'))).not.toBe(stored(contractCacheKey(orgA, 'alice')));
    expect(stored(featuresCacheKey(orgA, 'Alice', 'eval'))).not.toBe(stored(featuresCacheKey(orgA, 'alice', 'eval')));
  });

  it('invalidate the contract and its evaluations in its organization only', () => {
    const keysOfA = contractCacheKeys({ organizationId: orgA, userContact: { userId: '42' } });

    for (const key of [contractCacheKey(orgA, '42'), featuresCacheKey(orgA, '42', 'eval.petclinic-pets'), featuresCacheKey(orgA, '42', 'pricingToken')]) {
      expect(keysOfA.some(pattern => deletes(pattern, key))).toBe(true);
    }
    for (const key of [contractCacheKey(orgB, '42'), featuresCacheKey(orgB, '42', 'eval'), featuresCacheKey(orgB, '42', 'pricingToken')]) {
      expect(keysOfA.some(pattern => deletes(pattern, key))).toBe(false);
    }
  });

  it('keep glob characters of a userId from reaching other contracts', () => {
    const pattern = featuresCachePattern(orgA, '*');

    expect(deletes(pattern, featuresCacheKey(orgA, '*', 'eval'))).toBe(true);
    expect(deletes(pattern, featuresCacheKey(orgA, 'bob', 'eval'))).toBe(false);
    expect(globToRegExp(usageLevelSnapshotPattern(orgA, '*', 'petclinic', 'maxPets')).test(
      stored(usageLevelSnapshotKey(5, orgA, 'bob', 'petclinic', 'maxPets'))
    )).toBe(false);
    expect(globToRegExp(usageLevelSnapshotPattern(orgA, 'bob', 'petclinic', 'maxPets')).test(
      stored(usageLevelSnapshotKey(5, orgA, 'bob', 'petclinic', 'maxPets'))
    )).toBe(true);
  });

  it('cover one organization when pruning it', () => {
    const patterns = organizationContractCachePatterns(orgA);

    expect(patterns.some(pattern => deletes(pattern, contractCacheKey(orgA, '42')))).toBe(true);
    expect(patterns.some(pattern => deletes(pattern, featuresCacheKey(orgA, '42', 'eval')))).toBe(true);
    expect(patterns.some(pattern => deletes(pattern, contractCacheKey(orgB, '42')))).toBe(false);
  });
});
