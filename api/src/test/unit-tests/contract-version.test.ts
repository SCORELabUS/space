import { describe, expect, it } from 'vitest';
import { computeContractVersion, parseIfMatch } from '../../main/utils/contracts/version';

const base = () => ({
  contractedServices: { petclinic: '2025-03-26' },
  subscriptionPlans: { petclinic: 'GOLD' },
  subscriptionAddOns: { petclinic: { extraPets: 2 } },
  billingPeriod: {
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-01-31T00:00:00.000Z'),
    autoRenew: true,
    renewalDays: 30,
  },
  usageLevels: { petclinic: { maxPets: { consumed: 0 } } },
  history: [] as any[],
});

describe('computeContractVersion', () => {
  it('is the same for the stored, cached and API shapes of one contract', () => {
    const stored = {
      ...base(),
      contractedServices: new Map([['petclinic', '2025-03-26']]),
      subscriptionPlans: new Map([['petclinic', 'GOLD']]),
      subscriptionAddOns: new Map([['petclinic', new Map([['extraPets', 2]])]]),
    };
    const cached = JSON.parse(JSON.stringify(base()));
    const escaped = { ...base(), contractedServices: { petclinic: '2025-03-26'.replace(/\./g, '_') } };

    expect(computeContractVersion(stored)).toBe(computeContractVersion(base()));
    expect(computeContractVersion(cached)).toBe(computeContractVersion(base()));
    expect(computeContractVersion(escaped)).toBe(computeContractVersion(base()));
  });

  it('treats dotted and escaped pricing versions alike', () => {
    const dotted = { ...base(), contractedServices: { petclinic: '1.0.0' } };
    const escaped = { ...base(), contractedServices: { petclinic: '1_0_0' } };

    expect(computeContractVersion(dotted)).toBe(computeContractVersion(escaped));
  });

  it('ignores consumption and the order of keys', () => {
    const consumed = { ...base(), usageLevels: { petclinic: { maxPets: { consumed: 9 } } } };
    const reordered = {
      ...base(),
      subscriptionAddOns: { petclinic: { extraVisits: 3, extraPets: 2 } },
    };
    const reorderedBack = {
      ...base(),
      subscriptionAddOns: { petclinic: { extraPets: 2, extraVisits: 3 } },
    };

    expect(computeContractVersion(consumed)).toBe(computeContractVersion(base()));
    expect(computeContractVersion(reordered)).toBe(computeContractVersion(reorderedBack));
  });

  it('changes with the plan, add-ons, pricing version and billing period', () => {
    const original = computeContractVersion(base());

    expect(computeContractVersion({ ...base(), subscriptionPlans: { petclinic: 'PLATINUM' } })).not.toBe(original);
    expect(computeContractVersion({ ...base(), subscriptionAddOns: { petclinic: { extraPets: 3 } } })).not.toBe(original);
    expect(computeContractVersion({ ...base(), contractedServices: { petclinic: '2026' } })).not.toBe(original);
    expect(
      computeContractVersion({ ...base(), billingPeriod: { ...base().billingPeriod, autoRenew: false } })
    ).not.toBe(original);
  });

  it('moves forward when a novation returns to an earlier subscription', () => {
    const before = computeContractVersion(base());
    const after = computeContractVersion({ ...base(), history: [{}, {}] });

    expect(after).not.toBe(before);
    expect(after.startsWith('2-')).toBe(true);
  });

  it('counts SPHERE migrations', () => {
    expect(computeContractVersion({ ...base(), synchronizationHistory: [{}] })).not.toBe(
      computeContractVersion(base())
    );
  });
});

describe('parseIfMatch', () => {
  it('returns the strong tags of the header, unquoted', () => {
    expect(parseIfMatch('"1-abc"')).toEqual(['1-abc']);
    expect(parseIfMatch('1-abc')).toEqual(['1-abc']);
    expect(parseIfMatch('"1-abc", "2-def"')).toEqual(['1-abc', '2-def']);
  });

  it('leaves out weak tags, which never match under strong comparison', () => {
    expect(parseIfMatch('W/"1-abc"')).toEqual([]);
    expect(parseIfMatch('W/"1-abc", "2-def"')).toEqual(['2-def']);
  });

  it('keeps the wildcard and ignores a missing header', () => {
    expect(parseIfMatch(' * ')).toEqual(['*']);
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('')).toBeUndefined();
  });
});
