import { describe, expect, it } from 'vitest';
import { consumptionTargets, usageLimitCeiling } from '../../main/utils/feature-evaluation/consumption';

/**
 * Which limit bounds each usage level of a consumption. The increment is only
 * written while the level plus the amount stays within the ceiling; a level
 * without a ceiling is incremented unconditionally, as before.
 */
describe('usageLimitCeiling', () => {
  it('is the value of a numeric limit, zero included', () => {
    expect(usageLimitCeiling(4)).toBe(4);
    expect(usageLimitCeiling(0)).toBe(0);
    expect(usageLimitCeiling(2.5)).toBe(2.5);
  });

  it('is null (no ceiling) for unlimited or non-numeric limits', () => {
    for (const value of [true, false, null, undefined, Number.POSITIVE_INFINITY, Number.NaN, '4', {}]) {
      expect(usageLimitCeiling(value)).toBeNull();
    }
  });
});

describe('consumptionTargets', () => {
  it('splits flattened limit ids and attaches the ceiling of positive amounts', () => {
    expect(
      consumptionTargets({ 'petclinic-maxPets': 2, 'petclinic-maxVisits': 1 }, {
        'petclinic-maxPets': 6,
        'petclinic-maxVisits': 3,
      })
    ).toEqual([
      { serviceName: 'petclinic', usageLimit: 'maxPets', amount: 2, ceiling: 6 },
      { serviceName: 'petclinic', usageLimit: 'maxVisits', amount: 1, ceiling: 3 },
    ]);
  });

  it('does not bound zero or negative amounts: they cannot take a level over its limit', () => {
    expect(consumptionTargets({ 'petclinic-maxPets': 0, 'petclinic-maxVisits': -2 }, {
      'petclinic-maxPets': 4,
      'petclinic-maxVisits': 3,
    }).map(target => target.ceiling)).toEqual([null, null]);
  });

  it('does not bound levels whose limit is unknown or unlimited', () => {
    expect(consumptionTargets({ 'petclinic-maxPets': 1, 'petclinic-maxVisits': 1 }, {
      'petclinic-maxVisits': true,
    }).map(target => target.ceiling)).toEqual([null, null]);
    expect(consumptionTargets({ 'petclinic-maxPets': 1 }).map(target => target.ceiling)).toEqual([null]);
  });
});
