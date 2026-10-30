import UsageConsumptionMongoose from './models/UsageConsumptionMongoose';

export interface ConsumedLevel {
  serviceName: string;
  usageLimit: string;
  amount: number;
  resetTimeStamp: Date | null;
}

export interface UsageConsumption {
  id: string;
  contractId?: string;
  organizationId: string;
  userId: string;
  featureId: string;
  levels: ConsumedLevel[];
  createdAt: Date;
  expiresAt: Date;
  revertedAt?: Date;
}

/** Which consumption: always within one organization, user and feature. */
export interface ConsumptionScope {
  organizationId: string;
  userId: string;
  featureId: string;
}

const toConsumption = (doc: any): UsageConsumption => ({
  id: String(doc._id),
  ...(doc.contractId ? { contractId: doc.contractId } : {}),
  organizationId: doc.organizationId,
  userId: doc.userId,
  featureId: doc.featureId,
  levels: (doc.levels ?? []).map((level: any) => ({
    serviceName: level.serviceName,
    usageLimit: level.usageLimit,
    amount: level.amount,
    resetTimeStamp: level.resetTimeStamp ?? null,
  })),
  createdAt: doc.createdAt,
  expiresAt: doc.expiresAt,
  ...(doc.revertedAt ? { revertedAt: doc.revertedAt } : {}),
});

/** Escape a string for use as a literal inside a regular expression. */
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Records that consumed from a service: its feature (`<service>-<feature>`,
 * the service being what precedes the first `-`, as everywhere else) or one of
 * its usage levels, the name matched exactly and case-insensitively. A name
 * with a `-` is never the service of a feature id, only of a level.
 */
const ofServices = (serviceNames: string[]) => {
  const prefixed = serviceNames.filter(name => !name.includes('-'));
  return {
    $or: [
      ...(prefixed.length > 0
        ? [{ featureId: { $regex: `^(?:${prefixed.map(escapeRegex).join('|')})-`, $options: 'i' } }]
        : []),
      { 'levels.serviceName': { $in: serviceNames.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) } },
    ],
  };
};

const scopeFilter = (scope: ConsumptionScope) => {
  if (!scope.organizationId) throw new Error('An organization is required to address a consumption');
  return { organizationId: scope.organizationId, userId: scope.userId, featureId: scope.featureId };
};

/**
 * Records of applied consumptions (collection `usageConsumptions`).
 *
 * A request is separate from completion. A receipt in the atomic contract
 * decrement prevents duplicated refunds after a crash; revertedAt is only
 * set once that write is acknowledged.
 */
class UsageConsumptionRepository {
  async create(consumption: Omit<UsageConsumption, 'revertedAt'>): Promise<void> {
    await UsageConsumptionMongoose.create({
      _id: consumption.id,
      contractId: consumption.contractId,
      organizationId: consumption.organizationId,
      userId: consumption.userId,
      featureId: consumption.featureId,
      levels: consumption.levels,
      createdAt: consumption.createdAt,
      expiresAt: consumption.expiresAt,
    });
  }

  async find(id: string, scope: ConsumptionScope): Promise<UsageConsumption | null> {
    const doc = await UsageConsumptionMongoose.findOne({ _id: id, ...scopeFilter(scope) }).lean();
    return doc ? toConsumption(doc) : null;
  }

  /** Claim this consumption for a revert; null when it does not exist (in this scope) or was already completed. */
  async claim(id: string, scope: ConsumptionScope): Promise<UsageConsumption | null> {
    const doc = await UsageConsumptionMongoose.findOneAndUpdate(
      { _id: id, ...scopeFilter(scope), revertedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
      { $set: { revertRequestedAt: new Date() } },
      { new: true }
    ).lean();
    return doc ? toConsumption(doc) : null;
  }

  /**
   * Select the oldest (or, with `latest`, the most recent) unreverted
   * consumption of the scope made since `since` (legacy revert).
   */
  async claimRecent(scope: ConsumptionScope, since: Date, latest: boolean): Promise<UsageConsumption | null> {
    const doc = await UsageConsumptionMongoose.findOneAndUpdate(
      { ...scopeFilter(scope), revertedAt: { $exists: false }, createdAt: { $gte: since } },
      { $set: { revertRequestedAt: new Date() } },
      { new: true, sort: { createdAt: latest ? -1 : 1, _id: latest ? -1 : 1 } }
    ).lean();
    return doc ? toConsumption(doc) : null;
  }

  /** Give a claim back, when the revert could not be applied (so that it can be retried). */
  async complete(id: string): Promise<void> {
    await UsageConsumptionMongoose.updateOne({ _id: id, revertedAt: { $exists: false } }, { $set: { revertedAt: new Date() } });
  }

  async release(id: string): Promise<void> {
    await UsageConsumptionMongoose.updateOne({ _id: id }, { $unset: { revertRequestedAt: '' } });
  }

  async delete(id: string): Promise<void> {
    await UsageConsumptionMongoose.deleteOne({ _id: id });
  }

  /**
   * A service was renamed (`to`, the contract key: lowercased) and/or its
   * contract moved to another organization (`toOrganizationId`): rewrite the
   * unexpired records of that contract (`organizationId`, `userId`) so that
   * they keep addressing the same usage levels. Renaming changes the service
   * of the feature id and of each level that are this service (exact name,
   * case-insensitively); moving changes the organization of every record of
   * the contract, which leaves the organization with it.
   *
   * @returns how many records were rewritten.
   */
  async renameOrMoveService(
    organizationId: string,
    userId: string,
    serviceName: string,
    change: { name?: string; organizationId?: string }
  ): Promise<number> {
    if (!organizationId) throw new Error('An organization is required to address consumptions');
    const from = serviceName.toLowerCase();
    const to = change.name?.toLowerCase();
    if (!to && !change.organizationId) return 0;

    const $set: Record<string, unknown> = {};
    if (change.organizationId) $set.organizationId = change.organizationId;
    if (to) {
      if (!from.includes('-')) {
        $set.featureId = {
          $cond: [
            { $regexMatch: { input: '$featureId', regex: `^${escapeRegex(from)}-`, options: 'i' } },
            { $concat: [to, { $substrCP: ['$featureId', Array.from(from).length, { $strLenCP: '$featureId' }] }] },
            '$featureId',
          ],
        };
      }
      $set.levels = {
        $map: {
          input: '$levels',
          in: {
            $mergeObjects: [
              '$$this',
              { serviceName: { $cond: [{ $eq: [{ $toLower: '$$this.serviceName' }, from] }, to, '$$this.serviceName'] } },
            ],
          },
        },
      };
    }

    const result = await UsageConsumptionMongoose.updateMany(
      {
        organizationId,
        userId,
        expiresAt: { $gt: new Date() },
        ...(change.organizationId ? {} : ofServices([serviceName])),
      },
      [{ $set }]
    );
    return result.modifiedCount;
  }

  /**
   * Forget the records of services deleted from an organization (prune,
   * destroy), or of one contract (`userId`) that lost the service: their usage
   * levels are gone. Names are matched exactly, case-insensitively, and only
   * in that organization.
   */
  async deleteOfServices(organizationId: string, serviceNames: string[], userId?: string): Promise<void> {
    if (!organizationId) throw new Error('An organization is required to address consumptions');
    if (serviceNames.length === 0) return;
    await UsageConsumptionMongoose.deleteMany({
      organizationId,
      ...(userId !== undefined ? { userId } : {}),
      ...ofServices(serviceNames),
    });
  }

  /**
   * Forget the records of a deleted contract, of an organization's pruned
   * contracts, or (no organization) of every contract: a contract created
   * later with the same userId must not be reverted by an earlier id.
   */
  async deleteAll(organizationId?: string, userId?: string): Promise<void> {
    const filter: Record<string, string> = {};
    if (organizationId !== undefined) filter.organizationId = organizationId;
    if (userId !== undefined) filter.userId = userId;
    await UsageConsumptionMongoose.deleteMany(filter);
  }
}

export default UsageConsumptionRepository;
