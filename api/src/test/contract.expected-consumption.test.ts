import { describe, it, expect, beforeEach, vi } from 'vitest';
import container from '../main/config/container';

/**
 * Applying expected consumption to usage limits.
 *
 * Read-modify-write loses consumptions in two ways. Applying the limits of one
 * evaluation in turn made each application read the whole contract, change one
 * usage level in its own copy and write the whole contract back, so an
 * evaluation touching two limits recorded one of them. Batching them into a
 * single read and write fixed that, and left the other: two requests arriving
 * together both read the same consumed value, both write the same total, and
 * one consumption disappears.
 *
 * The increment is now handed to the database as `$inc`, which is the only
 * place it can be settled.
 *
 * These tests work against a stubbed repository and cache so they can assert on
 * the reads and writes themselves, which is where the defect lived. The stub
 * models the database honestly: `incrementUsageLevels` adds to whatever is
 * *stored* at the moment it runs, which is exactly the guarantee `$inc` gives
 * and exactly the one an application-side read-modify-write cannot.
 */

function aContract() {
  return {
    userContact: { userId: 'user1', username: 'user1' },
    contractedServices: { petclinic: '2025' },
    subscriptionPlans: { petclinic: 'BASIC' },
    usageLevels: {
      petclinic: {
        maxPets: { consumed: 0 },
        maxVisits: { consumed: 0 },
      },
    },
  };
}

const copy = (value: any) => JSON.parse(JSON.stringify(value));

function withStubs(contract: any) {
  const state = { current: contract };
  let writes = 0;
  let reads = 0;
  let increments = 0;

  const contractRepository = {
    findByUserId: vi.fn(async () => {
      reads += 1;
      return copy(state.current);
    }),

    // Kept so a regression to read-modify-write is visible rather than a crash.
    // The await between reading and writing is what any real round trip has,
    // and what lets a second caller slip in between the two.
    update: vi.fn(async (_userId: string, updated: any) => {
      writes += 1;
      await Promise.resolve();
      state.current = copy(updated);
      return copy(state.current);
    }),

    incrementUsageLevels: vi.fn(async (_userId: string, byPath: Record<string, number>) => {
      increments += 1;
      await Promise.resolve();

      // The filter requires every path to exist; a miss matches no document.
      for (const path of Object.keys(byPath)) {
        const [serviceName, usageLimit] = path.split('.');
        if (!state.current.usageLevels[serviceName]?.[usageLimit]) {
          return null;
        }
      }

      for (const [path, amount] of Object.entries(byPath)) {
        const [serviceName, usageLimit] = path.split('.');
        state.current.usageLevels[serviceName][usageLimit].consumed += amount;
      }

      return copy(state.current);
    }),
  };

  const cacheService = {
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    del: vi.fn(async () => undefined),
  };

  const original = container.resolve.bind(container);
  vi.spyOn(container, 'resolve').mockImplementation((name: any) => {
    if (name === 'contractRepository') return contractRepository as any;
    if (name === 'cacheService') return cacheService as any;
    return original(name);
  });

  return {
    state,
    contractRepository,
    cacheService,
    counts: () => ({ reads, writes, increments }),
    consumed: () => state.current.usageLevels.petclinic,
  };
}

async function aService() {
  const { default: ContractService } = await import('../main/services/ContractService');
  return new (ContractService as any)();
}

describe('Applying expected consumption', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('records every limit, not just the last one written', async () => {
    const stubs = withStubs(aContract());
    const service = await aService();

    await service._applyExpectedConsumptions('user1', {
      'petclinic-maxPets': 1,
      'petclinic-maxVisits': 3,
    }, 'org1');

    expect(stubs.consumed().maxPets.consumed).toBe(1);
    expect(stubs.consumed().maxVisits.consumed).toBe(3);
  });

  it('loses nothing when two requests arrive together', async () => {
    // The case the batch alone could not fix, and the reason for `$inc`: two
    // callers spending the same limit at the same time. Under read-modify-write
    // both start from 0, both write 1, and one consumption is gone.
    const stubs = withStubs(aContract());
    const service = await aService();

    await Promise.all([
      service._applyExpectedConsumption('user1', 'petclinic-maxPets', 1, 'org1'),
      service._applyExpectedConsumption('user1', 'petclinic-maxPets', 1, 'org1'),
    ]);

    expect(stubs.consumed().maxPets.consumed).toBe(2);
  });

  it('loses nothing across many concurrent requests', async () => {
    const stubs = withStubs(aContract());
    const service = await aService();

    await Promise.all(
      Array.from({ length: 20 }, () =>
        service._applyExpectedConsumption('user1', 'petclinic-maxPets', 1, 'org1')
      )
    );

    expect(stubs.consumed().maxPets.consumed).toBe(20);
  });

  it('composes concurrent requests that touch different limits', async () => {
    const stubs = withStubs(aContract());
    const service = await aService();

    await Promise.all([
      service._applyExpectedConsumption('user1', 'petclinic-maxPets', 1, 'org1'),
      service._applyExpectedConsumption('user1', 'petclinic-maxVisits', 1, 'org1'),
    ]);

    expect(stubs.consumed().maxPets.consumed).toBe(1);
    expect(stubs.consumed().maxVisits.consumed).toBe(1);
  });

  it('touches the contract once however many limits there are', async () => {
    // Not only correctness: one round trip instead of one per limit, and no
    // read at all, since the database does the arithmetic.
    const stubs = withStubs(aContract());
    const service = await aService();

    await service._applyExpectedConsumptions('user1', {
      'petclinic-maxPets': 1,
      'petclinic-maxVisits': 1,
    }, 'org1');

    expect(stubs.counts()).toEqual({ reads: 0, writes: 0, increments: 1 });
  });

  it('still applies a single limit', async () => {
    const stubs = withStubs(aContract());
    const service = await aService();

    await service._applyExpectedConsumption('user1', 'petclinic-maxPets', 2, 'org1');

    expect(stubs.consumed().maxPets.consumed).toBe(2);
  });

  it('does nothing at all when given nothing', async () => {
    const stubs = withStubs(aContract());
    const service = await aService();

    await service._applyExpectedConsumptions('user1', {}, 'org1');

    expect(stubs.counts()).toEqual({ reads: 0, writes: 0, increments: 0 });
  });

  it('refuses the whole request when one limit does not exist', async () => {
    // Rather than applying the valid ones and then failing, which would leave
    // the contract half-updated. The check is part of the same operation, so a
    // limit cannot be validated and then vanish before the write.
    const stubs = withStubs(aContract());
    const service = await aService();

    await expect(
      service._applyExpectedConsumptions('user1', {
        'petclinic-maxPets': 1,
        'petclinic-nosuchlimit': 1,
      }, 'org1')
    ).rejects.toThrow(/not found in contract/);

    expect(stubs.consumed().maxPets.consumed).toBe(0);
  });

  it('says so when there is no contract at all', async () => {
    const stubs = withStubs(aContract());
    stubs.contractRepository.incrementUsageLevels.mockResolvedValue(null);
    stubs.contractRepository.findByUserId.mockResolvedValue(null);
    const service = await aService();

    await expect(
      service._applyExpectedConsumptions('user1', { 'petclinic-maxPets': 1 }, 'org1')
    ).rejects.toThrow(/Contract with userId user1 not found/);
  });

  it('keeps the previous value of every limit for reverting', async () => {
    const stubs = withStubs(aContract());
    const service = await aService();

    await service._applyExpectedConsumptions('user1', {
      'petclinic-maxPets': 1,
      'petclinic-maxVisits': 1,
    }, 'org1');

    const cachedKeys = stubs.cacheService.set.mock.calls.map((call: any[]) => call[0]);
    expect(cachedKeys.some((key: string) => key.includes('maxPets'))).toBe(true);
    expect(cachedKeys.some((key: string) => key.includes('maxVisits'))).toBe(true);
  });

  it('records this caller’s own starting point, not whatever it read', async () => {
    // The snapshot kept for reverting is derived from the result of the
    // increment, so it is this caller's contribution that gets taken back even
    // when other calls landed in between.
    const contract = aContract();
    contract.usageLevels.petclinic.maxPets.consumed = 7;

    const stubs = withStubs(contract);
    const service = await aService();

    await service._applyExpectedConsumptions('user1', { 'petclinic-maxPets': 3 }, 'org1');

    const snapshot = (stubs.cacheService.set.mock.calls as any[][]).find(call =>
      String(call[0]).includes('maxPets')
    );
    expect(snapshot?.[1]).toBe(7);
    expect(stubs.consumed().maxPets.consumed).toBe(10);
  });
});
