import RepositoryBase from '../RepositoryBase';
import ContractMongoose from './models/ContractMongoose';
import { ContractToCreate, LeanContract } from '../../types/models/Contract';
import { toPlainObject } from '../../utils/mongoose';
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
 * Filter that addresses one contract by `userId`, optionally confined to an
 * organization. `userId` is chosen by the host application and is not secret,
 * so callers acting for an organization must always pass its id: a contract of
 * another organization then simply does not match.
 */
const byUserId = (userId: string, organizationId?: string): Record<string, unknown> => ({
  'userContact.userId': userId,
  ...(organizationId ? { organizationId } : {}),
});

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

  async findByUserId(userId: string, organizationId?: string): Promise<LeanContract | null> {
    const contract = await ContractMongoose.findOne(byUserId(userId, organizationId));
    return contract ? toPlainObject<LeanContract>(contract.toJSON()) : null;
  }

  async create(contractData: ContractToCreate): Promise<LeanContract> {
    const contract = new ContractMongoose(contractData);
    await contract.save();
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
    organizationId?: string,
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
    organizationId?: string
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
        upsert: true,
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

  async prune(organizationId?: string): Promise<number> {
    const filter = organizationId ? { organizationId } : {};
    const result = await ContractMongoose.deleteMany(filter);

    return result.deletedCount;
  }

  async destroy(userId: string, organizationId?: string): Promise<void> {
    const result = await ContractMongoose.deleteOne(byUserId(userId, organizationId));
    if (result.deletedCount === 0) {
      throw new Error(`Contract with userId ${userId} not found`);
    }
  }

  async bulkDestroy(userIds: string[]): Promise<number> {
    const result = await ContractMongoose.deleteMany({ 'userContact.userId': { $in: userIds } });
    return result.deletedCount || 0;
  }
}

export default ContractRepository;
