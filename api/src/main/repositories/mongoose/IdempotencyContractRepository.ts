import IdempotencyKeyRepository from './IdempotencyKeyRepository';
import mongoose from 'mongoose';
import Contract from './models/ContractMongoose';

/** A prepared write addresses one immutable contract identity, never an upsert by userId. */
export interface IdempotentContractWrite {
  contractId: string;
  organizationId: string;
  userId: string;
  create?: any;
  set?: Record<string, any>;
  increments?: Record<string, number>;
  guard?: Record<string, any>;
  refund?: { id: string; expiresAt: Date; services: string[]; absent: string[]; levels: { path: string; amount: number; resetTimeStamp: Date | null }[] };
  consume?: { id: string; expiresAt: Date; ceilings: Record<string, number>; resetTimeStamps: Record<string, Date | null> };
}

const publicFields = ['userContact', 'billingPeriod', 'usageLevels', 'organizationId', 'groupId', 'contractedServices',
  'subscriptionPlans', 'subscriptionAddOns', 'synchronizationHistory', 'history'];
const publicSnapshot = Object.fromEntries([...publicFields.map(field => [field, `$${field}`]), ['id', { $toString: '$_id' }]]);

export class IdempotencyStepBusyError extends Error {
  constructor() { super('A previous operation on this contract is awaiting recovery; retry shortly'); }
}

class IdempotencyContractRepository {
  async apply(write: IdempotentContractWrite, stepId: string, validUntil: Date,
    owner?: { operationId: string; key: string; organizationId: string }): Promise<any | null> {
    const identity = { _id: new mongoose.Types.ObjectId(write.contractId), organizationId: write.organizationId, 'userContact.userId': write.userId };
    const previous: any = await Contract.findOne(identity).select('+idempotencyReceipt').lean();
    if (previous?.idempotencyReceipt?.stepId === stepId) return previous.idempotencyReceipt.result;
    if (previous?.idempotencyReceipt && !previous.idempotencyReceipt.acknowledged) {
      const receipt = previous.idempotencyReceipt;
      const recovered = receipt.key && await new IdempotencyKeyRepository().recoverAppliedStep(
        receipt.organizationId, receipt.key, receipt.operationId, receipt.stepId, receipt.result);
      if (!recovered) throw new IdempotencyStepBusyError();
      await this.acknowledge(write, receipt.stepId);
    }
    if (write.create) {
      if (write.create.organizationId !== write.organizationId || write.create.userContact?.userId !== write.userId) throw new Error('CONFLICT: Prepared contract identity does not match its scope');
      // A stable preallocated _id and immutable document also fence an ambiguous
      // insert: an abandoned owner and its successor cannot create two contracts.
      const data = { ...write.create, _id: identity._id };
      const document = new Contract(data);
      const snapshot: any = document.toJSON({ minimize: false });
      document.set('idempotencyReceipt', { ...owner, stepId, acknowledged: false, result: snapshot });
      await document.validate();
      const persisted = document.toObject({ flattenMaps: true, virtuals: false, versionKey: false, minimize: false });
      try {
        // Upsert queries cannot contain $expr. Keep the lease test inside the
        // atomic replacement instead: its expired branch aborts the write,
        // rather than inserting a visible partial contract. The conversion
        // depends on DB time so it is evaluated only in the expired branch.
        await Contract.findOneAndUpdate({ ...identity, idempotencyReceipt: { $exists: false } }, [{ $replaceWith: {
          $cond: [{ $gt: [{ $literal: validUntil }, '$$NOW'] }, { $literal: persisted },
            { $toObjectId: { $toString: '$$NOW' } }],
        } }], { upsert: true, new: true, setDefaultsOnInsert: false });
      }
      catch (error: any) {
        const own: any = await Contract.findOne(identity).select('+idempotencyReceipt').lean();
        if (own?.idempotencyReceipt?.stepId === stepId) return own.idempotencyReceipt.result;
        if (validUntil <= new Date()) throw new Error('Idempotency lease lost; retry');
        if (error?.code === 11000) throw new Error(`CONFLICT: Contract for user ${write.userId} already exists`);
        throw error;
      }
      return snapshot;
    }
    const { $expr: guardExpression, ...guard } = write.guard ?? {};
    const filter: any = { ...guard, ...identity, $and: [
      { $or: [{ idempotencyReceipt: { $exists: false } }, { 'idempotencyReceipt.acknowledged': true }] },
    ] };
    // This deadline is read from MongoDB's renewable key lease. It is checked
    // by MongoDB at the business write, even if the process paused after its
    // ownership check and an abandoned operation has since been taken over.
    const expressions: any[] = [{ $gt: [{ $literal: validUntil }, '$$NOW'] }];
    if (guardExpression) expressions.push(guardExpression);
    const set: Record<string, any> = Object.fromEntries(Object.entries(write.set ?? {}).map(([path, value]) => [path, { $literal: value }]));
    for (const path of Object.keys(write.set ?? {})) {
      if (path.startsWith('usageLevels.') && path.endsWith('.consumed')) filter[path] = { $exists: true };
    }
    for (const [path, amount] of Object.entries(write.increments ?? {})) {
      filter[`usageLevels.${path}.consumed`] = { $exists: true };
      set[`usageLevels.${path}.consumed`] = { $add: [`$usageLevels.${path}.consumed`, amount] };
      if (write.consume && write.consume.ceilings[path] !== undefined) expressions.push({ $lte: [{ $add: [`$usageLevels.${path}.consumed`, amount] }, write.consume.ceilings[path]] });
      if (write.consume) filter[`usageLevels.${path}.resetTimeStamp`] = write.consume.resetTimeStamps[path] ?? null;
    }
    const prune: Record<string, any> = {};
    const { createHash } = await import('node:crypto');
    if (write.refund) {
      const refund = write.refund;
      const key = createHash('sha256').update(refund.id).digest('hex');
      filter[`usageRevertReceipts.${key}`] = { $exists: false };
      for (const service of refund.services) filter[`contractedServices.${service}`] = { $exists: true };
      for (const path of refund.absent) filter[`usageLevels.${path}`] = { $exists: false };
      for (const level of refund.levels) {
        const path = `usageLevels.${level.path}.consumed`;
        filter[path] = { $exists: true };
        set[path] = { $cond: [{ $eq: [{ $ifNull: [`$usageLevels.${level.path}.resetTimeStamp`, null] }, level.resetTimeStamp ?? null] },
          { $max: [0, { $subtract: [`$${path}`, level.amount] }] }, `$${path}`] };
      }
      expressions.push({ $gt: [{ $literal: refund.expiresAt }, '$$NOW'] });
      set[`usageRevertReceipts.${key}`] = { $literal: refund.expiresAt };
      prune.usageRevertReceipts = { $arrayToObject: { $filter: { input: { $objectToArray: { $ifNull: ['$usageRevertReceipts', {}] } }, as: 'receipt', cond: { $gt: ['$$receipt.v', '$$NOW'] } } } };
    }
    if (write.consume) {
      const { createHash } = await import('node:crypto');
      const receiptKey = createHash('sha256').update(write.consume.id).digest('hex');
      filter[`usageConsumptionReceipts.${receiptKey}`] = { $exists: false };
      expressions.push({ $gt: [{ $literal: write.consume.expiresAt }, '$$NOW'] });
      set[`usageConsumptionReceipts.${receiptKey}`] = { $literal: write.consume.expiresAt };
      prune.usageConsumptionReceipts = { $arrayToObject: { $filter: { input: { $objectToArray: { $ifNull: ['$usageConsumptionReceipts', {}] } }, as: 'receipt', cond: { $gt: ['$$receipt.v', '$$NOW'] } } } };
    }
    filter.$expr = { $and: expressions };
    const document: any = await Contract.findOneAndUpdate(filter, [
      ...(Object.keys(prune).length ? [{ $set: prune }] : []),
      ...(Object.keys(set).length ? [{ $set: set }] : []),
      { $set: { idempotencyReceipt: { ...(owner ? { operationId: { $literal: owner.operationId }, key: { $literal: owner.key }, organizationId: { $literal: owner.organizationId } } : {}), stepId: { $literal: stepId }, acknowledged: false, result: publicSnapshot } } },
    ], { new: true }).select('+idempotencyReceipt').lean();
    if (document) return document.idempotencyReceipt.result;
    const raced: any = await Contract.findOne(identity).select('+idempotencyReceipt').lean();
    if (raced?.idempotencyReceipt?.stepId === stepId) return raced.idempotencyReceipt.result;
    if (raced?.idempotencyReceipt && !raced.idempotencyReceipt.acknowledged) throw new IdempotencyStepBusyError();
    if (validUntil <= new Date()) throw new Error('Idempotency lease lost; retry');
    return null;
  }

  async acknowledge(write: IdempotentContractWrite, stepId: string): Promise<void> {
    // The result is now durable in the key journal. Keep only one bounded
    // marker in the contract; the next acknowledged operation may replace it.
    await Contract.updateOne({ _id: write.contractId, 'idempotencyReceipt.stepId': stepId },
      { $set: { 'idempotencyReceipt.acknowledged': true }, $unset: { 'idempotencyReceipt.result': '' } });
  }
}
export default IdempotencyContractRepository;
