import RepositoryBase from '../RepositoryBase';
import ContractMongoose from './models/ContractMongoose';
import { ContractToCreate, LeanContract } from '../../types/models/Contract';
import { toPlainObject } from '../../utils/mongoose';
import { contractVersionGuard } from '../../utils/contracts/version';

/** Escape a string for use as a literal inside a regular expression. */
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
import { novationFields } from '../../utils/contracts/novation';

type ContractMatchPipeline = {
  pipeline: any[];
  matchConditions: any[];
  page: number;
  offset: number;
  limit: number;
  sort?: string;
  order?: 'asc' | 'desc';
};

/**
 * Filter that addresses one contract: a `userId` is chosen by each host
 * application and is only unique within an organization (unique index
 * `{ organizationId, userContact.userId }`), so the organization is always part
 * of it. Without one the filter could match a contract of any organization.
 */
const byUserId = (userId: string, organizationId: string): Record<string, unknown> => {
  if (!organizationId) {
    throw new Error(`An organization is required to address the contract with userId ${userId}`);
  }
  return { 'userContact.userId': userId, organizationId };
};

/** Duplicate key error of the unique index { organizationId, userContact.userId }. */
const isDuplicateKey = (error: any): boolean => error?.code === 11000;

const buildMatchPipeline = (queryFilters: any): ContractMatchPipeline => {
  const {
    username,
    firstName,
    lastName,
    email,
    page = 1,
    offset = 0,
    limit = 20,
    sort,
    order = 'asc',
    filters,
    organizationId,
    groupId,
  } = queryFilters || {};

  const matchConditions: any[] = [];

  if (username) {
    matchConditions.push({ 'userContact.username': { $regex: username, $options: 'i' } });
  }
  if (firstName) {
    matchConditions.push({ 'userContact.firstName': { $regex: firstName, $options: 'i' } });
  }
  if (lastName) {
    matchConditions.push({ 'userContact.lastName': { $regex: lastName, $options: 'i' } });
  }
  if (email) {
    matchConditions.push({ 'userContact.email': { $regex: email, $options: 'i' } });
  }
  if (organizationId) {
    matchConditions.push({ organizationId: organizationId });
  }
  if (groupId) {
    matchConditions.push({ groupId: groupId });
  }

  const pipeline: any[] = [
    { $addFields: { contractedServicesArray: { $objectToArray: '$contractedServices' } } },
  ];

  if (filters) {
    if (filters.services) {
      const services = filters.services;
      if (Array.isArray(services)) {
        matchConditions.push({
          'contractedServicesArray.k': { $in: services.map((s: string) => s.toLowerCase()) },
        });
      } else if (typeof services === 'object') {
        const perServiceMatches: any[] = [];
        for (const [serviceName, versions] of Object.entries(services)) {
          if (!Array.isArray(versions) || versions.length === 0) {
            perServiceMatches.push({
              'contractedServicesArray': { $elemMatch: { k: serviceName.toLowerCase() } },
            });
          } else {
            perServiceMatches.push({
              $and: [
                {
                  'contractedServicesArray': {
                    $elemMatch: {
                      k: serviceName.toLowerCase(),
                      v: { $in: versions.map((v: string) => v.replace(/\./g, '_')) },
                    },
                  },
                },
              ],
            });
          }
        }
        if (perServiceMatches.length > 0) {
          matchConditions.push({ $or: perServiceMatches });
        }
      }
    }

    if (filters.plans && typeof filters.plans === 'object') {
      const perServicePlanMatches: any[] = [];
      for (const [serviceName, plans] of Object.entries(filters.plans)) {
        if (Array.isArray(plans) && plans.length > 0) {
          perServicePlanMatches.push({
            [`subscriptionPlans.${serviceName.toLowerCase()}`]: {
              $in: plans.map((p: string) => new RegExp(`^${p}$`, 'i')),
            },
          });
        }
      }
      if (perServicePlanMatches.length > 0) {
        matchConditions.push({ $or: perServicePlanMatches });
      }
    }

    if (filters.addOns && typeof filters.addOns === 'object') {
      const perServiceAddOnMatches: any[] = [];
      for (const [serviceName, addOns] of Object.entries(filters.addOns)) {
        if (Array.isArray(addOns) && addOns.length > 0) {
          perServiceAddOnMatches.push({
            $or: addOns.map((addOnName: string) => ({
              [`subscriptionAddOns.${serviceName.toLowerCase()}.${addOnName.toLowerCase()}`]: {
                $exists: true,
              },
            })),
          });
        }
      }
      if (perServiceAddOnMatches.length > 0) {
        matchConditions.push({ $or: perServiceAddOnMatches });
      }
    }
  }

  if (matchConditions.length > 0) {
    pipeline.push({ $match: { $and: matchConditions } });
  }

  return { pipeline, matchConditions, page, offset, limit, sort, order };
};

class ContractRepository extends RepositoryBase {
  /**
   * Find contracts using advanced filters provided in `filters` key of queryFilters.
   * filters may contain:
   * - services: either array of service names OR object { serviceName: [versions] }
   * - plans: { serviceName: [planNames] }
   * - addOns: { serviceName: [addOnNames] }
   */
  async findByFilters(queryFilters: any) {
    const { pipeline, page, offset, limit, sort, order } = buildMatchPipeline(queryFilters);

    pipeline.push({
      $sort: {
        [`userContact.${sort ?? 'username'}`]: order === 'asc' ? 1 : -1,
      },
    });

    pipeline.push({ $skip: offset === 0 ? (page - 1) * limit : offset });
    pipeline.push({ $limit: Math.min(limit, 100) });

    const contracts = await ContractMongoose.aggregate(pipeline);

    return contracts.map(contract => toPlainObject<LeanContract>(contract));
  }

  async countByFilters(queryFilters: any): Promise<number> {
    const { pipeline } = buildMatchPipeline(queryFilters);
    const result = await ContractMongoose.aggregate([...pipeline, { $count: 'total' }]);
    return result[0]?.total ?? 0;
  }

  /** Internal move preflight: every binding is needed, without listing pagination. */
  async findAllByService(serviceName: string, organizationId: string): Promise<LeanContract[]> {
    if (!organizationId) throw new Error('An organization is required to list service contracts');
    const { pipeline } = buildMatchPipeline({ filters: { services: [serviceName] }, organizationId });
    const contracts = await ContractMongoose.aggregate(pipeline);
    return contracts.map(contract => toPlainObject<LeanContract>(contract));
  }

  async findByUserId(userId: string, organizationId: string): Promise<LeanContract | null> {
    const contract = await ContractMongoose.findOne(byUserId(userId, organizationId));
    return contract ? toPlainObject<LeanContract>(contract.toJSON()) : null;
  }

  /** Which of these userIds already have a contract in the organization. */
  async findExistingUserIds(organizationId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const ids = await ContractMongoose.distinct('userContact.userId', {
      organizationId,
      'userContact.userId': { $in: userIds },
    });
    return ids.map(id => String(id));
  }

  /**
   * @throws `CONFLICT:` when the organization already has a contract with this
   *         userId (unique index; also settles concurrent creations).
   */
  async create(contractData: ContractToCreate): Promise<LeanContract> {
    const contract = new ContractMongoose(contractData);
    try {
      await contract.save();
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new Error(`CONFLICT: Contract for user ${contractData.userContact.userId} already exists`);
      }
      throw error;
    }
    return toPlainObject<LeanContract>(contract.toJSON());
  }

  /**
   * @param guard extra filter conditions (see `contractVersionGuard`): when the
   *              stored contract no longer satisfies them nothing is written
   *              and null is returned.
   */
  async update(
    userId: string,
    contractData: Partial<ContractToCreate>,
    organizationId: string,
    guard: Record<string, unknown> = {}
  ): Promise<LeanContract | null> {
    const contract = await ContractMongoose.findOneAndUpdate(
      { ...guard, ...byUserId(userId, organizationId) },
      { $set: contractData },
      { new: true }
    );
    return contract ? toPlainObject<LeanContract>(contract.toJSON()) : null;
  }

  /**
   * Add to several usage levels of one contract in a single atomic update.
   *
   * `$inc` is evaluated by the database against the stored document rather than
   * against a copy the process read earlier, so concurrent increments compose
   * instead of overwriting one another. Read-modify-write cannot do this from
   * the application: two callers who read the same value both write the same
   * total, and one consumption disappears.
   *
   * Every path is required to exist by the filter, so a limit that is not part
   * of the contract matches no document and is reported to the caller instead
   * of being created by the update - `$inc` would otherwise happily add the
   * field. That check and the increment are one operation, so a limit cannot be
   * validated and then vanish before the write.
   *
   * @param increments usage level path (`service.limit`) to amount to add.
   * @returns the contract as it is after the increment, or null when the filter
   *          matched nothing.
   */
  async incrementUsageLevels(
    userId: string,
    increments: Record<string, number>,
    organizationId: string
  ): Promise<LeanContract | null> {
    const filter: Record<string, unknown> = byUserId(userId, organizationId);
    const inc: Record<string, number> = {};

    for (const [path, amount] of Object.entries(increments)) {
      filter[`usageLevels.${path}.consumed`] = { $exists: true };
      inc[`usageLevels.${path}.consumed`] = amount;
    }

    const contract = await ContractMongoose.findOneAndUpdate(
      filter,
      { $inc: inc },
      { new: true }
    );

    return contract ? toPlainObject<LeanContract>(contract.toJSON()) : null;
  }

  async changeServiceName(oldServiceName: string, newServiceName: string, organizationId: string): Promise<number> {
    const oldServiceKey = oldServiceName.toLowerCase();
    const newServiceKey = newServiceName.toLowerCase();

    const result = await ContractMongoose.updateMany(
      {
        organizationId,
        [`contractedServices.${oldServiceKey}`]: { $exists: true }
      },
      [
        {
          $set: {
            contractedServices: {
              $arrayToObject: {
                $map: {
                  input: { $objectToArray: '$contractedServices' },
                  as: 'item',
                  in: {
                    k: { $cond: [{ $eq: ['$$item.k', oldServiceKey] }, newServiceKey, '$$item.k'] },
                    v: '$$item.v'
                  }
                }
              }
            },
            subscriptionPlans: {
              $arrayToObject: {
                $map: {
                  input: { $objectToArray: '$subscriptionPlans' },
                  as: 'item',
                  in: {
                    k: { $cond: [{ $eq: ['$$item.k', oldServiceKey] }, newServiceKey, '$$item.k'] },
                    v: '$$item.v'
                  }
                }
              }
            },
            subscriptionAddOns: {
              $arrayToObject: {
                $map: {
                  input: { $objectToArray: '$subscriptionAddOns' },
                  as: 'item',
                  in: {
                    k: { $cond: [{ $eq: ['$$item.k', oldServiceKey] }, newServiceKey, '$$item.k'] },
                    v: '$$item.v'
                  }
                }
              }
            }
          }
        }
      ]
    );

    return result.modifiedCount;
  }

  /**
   * Write several contracts, each addressed by `userId` within an organization:
   * `options.organizationId` (the organization the contracts belong to before
   * this write, for moves between organizations) or else each contract's own
   * `organizationId`. A contract of another organization never matches.
   *
   * Never upserts: a contract that is not there (deleted meanwhile, or of
   * another organization) is not created by an update. With userIds unique per
   * organization an upsert would otherwise create a second contract for the
   * same userId in another organization.
   */
  async bulkUpdate(
    contracts: LeanContract[],
    disable = false,
    options: { organizationId?: string } = {}
  ): Promise<number> {
    if (contracts.length === 0) {
      return 0;
    }

    const bulkOps = contracts.map(contract => ({
      updateOne: {
        filter: byUserId(contract.userContact.userId, options.organizationId ?? contract.organizationId),
        update: {
          $set: {
            ...contract,
            disable: disable,
          },
        },
        upsert: false,
      },
    }));

    const result = await ContractMongoose.bulkWrite(bulkOps);

    return result.modifiedCount;
  }

  /**
   * Write the novation fields of several contracts, each only while its stored
   * version satisfies its guard (see `contractVersionGuard`). An empty guard
   * applies an unconditional novation. Never upserts or overwrites consumption.
   *
   * @returns the userIds whose guard no longer held, so nothing was written.
   */
  async bulkUpdateGuarded(
    entries: { contract: LeanContract; guard: Record<string, unknown> }[]
  ): Promise<string[]> {
    const rejected: string[] = [];

    for (const { contract, guard } of entries) {
      const { userId } = contract.userContact;
      const result = await ContractMongoose.updateOne(
        { ...guard, ...byUserId(userId, contract.organizationId) },
        { $set: novationFields(contract) }
      );
      if (result.matchedCount === 0) rejected.push(userId);
    }

    return rejected;
  }

  /**
   * userIds of every contract of the organization that names any of these
   * services in `contractedServices`, `subscriptionPlans`,
   * `subscriptionAddOns` or `usageLevels`, compared case-insensitively (keys
   * are lowercased on write, but older documents may not be). Not paginated.
   */
  async findUserIdsReferencingServices(organizationId: string, serviceNames: string[]): Promise<string[]> {
    if (!organizationId) throw new Error('An organization is required to look for the contracts of a service');
    if (serviceNames.length === 0) return [];
    const names = serviceNames.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i'));
    const keysOf = (field: string) => ({
      $map: { input: { $objectToArray: { $ifNull: [`$${field}`, {}] } }, in: '$$this.k' },
    });
    const rows = await ContractMongoose.aggregate([
      { $match: { organizationId } },
      {
        $project: {
          userId: '$userContact.userId',
          keys: {
            $concatArrays: [
              keysOf('contractedServices'),
              keysOf('subscriptionPlans'),
              keysOf('subscriptionAddOns'),
              keysOf('usageLevels'),
            ],
          },
        },
      },
      { $match: { keys: { $in: names } } },
      { $project: { _id: 0, userId: 1 } },
    ]);
    return rows.map(row => String(row.userId));
  }

  /**
   * Remove services from one contract, as it was read (`contract`): their
   * entries in `contractedServices`, `subscriptionPlans`, `subscriptionAddOns`
   * and `usageLevels` (keys compared case-insensitively) are unset, the
   * previous subscription is recorded in `history`, and a contract left without
   * services ends now and stops renewing (it is kept: its user contact and
   * history stay, and it can be novated to other services).
   *
   * Targeted (`$unset`/`$push`/`$set` of those paths only) and conditional on
   * the version of the contract that was read (`contractVersionGuard`): when a
   * novation, renewal or synchronization changed the contract in between,
   * nothing is written and null is returned, so the caller re-reads and
   * retries. Consumption is not part of the version and is never overwritten.
   *
   * @returns the contract after the write, `contract` itself when it names
   *          none of the services, or null when the guard no longer held.
   */
  async removeServicesFromContract(contract: LeanContract, serviceNames: string[]): Promise<LeanContract | null> {
    const names = new Set(serviceNames.map(name => name.toLowerCase()));
    const plain = (value: any): Record<string, any> =>
      value instanceof Map ? Object.fromEntries(value) : value ?? {};
    const matching = (value: any) => Object.keys(plain(value)).filter(key => names.has(key.toLowerCase()));

    const $unset: Record<string, ''> = {};
    let subscriptionChanged = false;
    for (const field of ['contractedServices', 'subscriptionPlans', 'subscriptionAddOns', 'usageLevels'] as const) {
      for (const key of matching(contract[field])) {
        $unset[`${field}.${key}`] = '';
        if (field !== 'usageLevels') subscriptionChanged = true;
      }
    }
    if (Object.keys($unset).length === 0) return contract;

    const update: Record<string, any> = { $unset };
    const now = new Date();
    if (subscriptionChanged) {
      update.$push = {
        history: {
          startDate: contract.billingPeriod.startDate,
          endDate: now,
          contractedServices: plain(contract.contractedServices),
          subscriptionPlans: plain(contract.subscriptionPlans),
          subscriptionAddOns: plain(contract.subscriptionAddOns),
        },
      };
    }
    const remaining = Object.keys(plain(contract.contractedServices)).filter(key => !names.has(key.toLowerCase()));
    if (subscriptionChanged && remaining.length === 0) {
      const endDate = new Date(contract.billingPeriod.endDate);
      update.$set = {
        'billingPeriod.endDate': endDate.getTime() < now.getTime() ? endDate : now,
        'billingPeriod.autoRenew': false,
      };
    }

    const written = await ContractMongoose.findOneAndUpdate(
      { ...contractVersionGuard(contract), ...byUserId(contract.userContact.userId, contract.organizationId) },
      update,
      { new: true }
    );
    return written ? toPlainObject<LeanContract>(written.toJSON()) : null;
  }

  /** userId, organization and contracted services of every contract of an organization (for events). */
  async findEventSummaries(
    organizationId: string
  ): Promise<Pick<LeanContract, 'userContact' | 'organizationId' | 'contractedServices'>[]> {
    return ContractMongoose.find(
      { organizationId },
      { 'userContact.userId': 1, organizationId: 1, contractedServices: 1 }
    ).lean() as any;
  }

  async prune(organizationId?: string): Promise<number> {
    const filter = organizationId ? { organizationId } : {};
    const result = await ContractMongoose.deleteMany(filter);

    return result.deletedCount;
  }

  async destroy(userId: string, organizationId: string): Promise<void> {
    const result = await ContractMongoose.deleteOne(byUserId(userId, organizationId));
    if (result.deletedCount === 0) {
      throw new Error(`Contract with userId ${userId} not found`);
    }
  }

  async bulkDestroy(userIds: string[], organizationId: string): Promise<number> {
    if (!organizationId) throw new Error('An organization is required to delete contracts by userId');
    const result = await ContractMongoose.deleteMany({ organizationId, 'userContact.userId': { $in: userIds } });
    return result.deletedCount || 0;
  }
}

export default ContractRepository;
