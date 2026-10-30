import { createHash } from 'node:crypto';
import container from '../config/container';
import type { IdempotentContractWrite } from '../repositories/mongoose/IdempotencyContractRepository';
import { assertIdempotencyOwnership } from './idempotencyExecution';
import Service from '../repositories/mongoose/models/ServiceMongoose';
import { assertNoPendingRelocation } from './serviceRelocationState';
import { withOrganizationLock } from './sphere/lock';
import { contractCacheKeys } from '../utils/contracts/cacheKeys';
import { resetEscapeContractedServiceVersions } from '../utils/contracts/helpers';
import { computeContractVersion, ContractChangedError } from '../utils/contracts/version';

export interface IdempotentAction {
  kind: 'create' | 'novate' | 'group' | 'usage' | 'consume' | 'revert';
  organizationId: string;
  writes?: IdempotentContractWrite[];
  expected?: boolean;
  consumption?: any;
  evaluation?: any;
  increments?: Record<string, number>;
  result?: any;
}

export function consumptionEvaluation(action: IdempotentAction, outcome: any): any {
  const used = { ...action.evaluation.used };
  for (const limit of Object.keys(used)) {
    const [service, name] = limit.split('-');
    const value = outcome.contract?.usageLevels?.[service]?.[name]?.consumed;
    if (typeof value === 'number') used[limit] = outcome.status === 'applied' ? value : value + (action.increments?.[`${service}.${name}`] ?? 0);
  }
  return outcome.status === 'limit'
    ? { eval: false, used, limit: action.evaluation.limit, error: null }
    : { ...action.evaluation, used, ...(outcome.consumptionId ? { consumptionId: outcome.consumptionId } : {}) };
}

/** Execute an immutable domain plan; the HTTP response is a separate final checkpoint. */
export async function executeIdempotentAction(proposed: IdempotentAction): Promise<any> {
  const execution = await assertIdempotencyOwnership();
  execution.record = await execution.repository.prepare(execution.organizationId, execution.key, execution.owner, proposed);
  const action: IdempotentAction = execution.record.plan;
  if (action.kind !== proposed.kind || action.organizationId !== execution.organizationId) throw new Error('Idempotency action mismatch');
  return withOrganizationLock(action.organizationId, async () => {
    await assertIdempotencyOwnership();
    if (execution.record.result !== undefined) return resultOf(execution.record.result);
    await assertNoPendingRelocation(action.organizationId);
    if (await Service.exists({ organizationId: action.organizationId, source: 'sphere', 'sphere.status': 'applying' })) throw new Error('Synchronization is applying; retry shortly');
    const cache: any = container.resolve('cacheService');
    const contracts: any = container.resolve('contractRepository');
    const receipts: any = container.resolve('idempotencyContractRepository');
    const consumptions: any = container.resolve('usageConsumptionRepository');
    let value: any;
    if (action.kind === 'revert') {
      execution.inAction = true;
      try {
        // The original legacy selection is frozen in the plan. #84 performs
        // its atomic refund/receipt and finishes any interrupted acknowledgement.
        await container.resolve('contractService').revertConsumption(action.consumption.userId,
          action.consumption.featureId, action.consumption.id, action.organizationId);
      } finally { execution.inAction = false; }
      value = action.result ?? null;
    } else {
      if (action.kind === 'consume') {
        const consumption = action.consumption;
        const existing = await consumptions.find(consumption.id, consumption);
        if (!existing) {
          try { await consumptions.create(consumption); }
          catch (error) { if (!await consumptions.find(consumption.id, consumption)) throw error; }
        }
      }
      const results: any[] = [];
      for (const [index, write] of (action.writes ?? []).entries()) {
        await assertIdempotencyOwnership();
        const stepId = createHash('sha256').update(`${execution.operationId}:${index}`).digest('hex');
        let step = execution.record.steps?.[stepId];
        if (!step) {
          const result = await receipts.apply(write, stepId, new Date(execution.record.lockedUntil));
          await execution.repository.checkpoint(execution.organizationId, execution.key, execution.owner, stepId, { result });
          step = { result };
        }
        await receipts.acknowledge(write, stepId);
        results.push(step.result);
      }
      if (action.kind === 'consume') {
        const contract = results[0];
        if (contract) {
          await consumptions.applied(action.consumption.id);
          value = { status: 'applied', contract, consumptionId: action.consumption.id };
        } else {
          await consumptions.delete(action.consumption.id);
          const latest = await contracts.findByUserId(action.consumption.userId, action.organizationId);
          if (!latest) throw new Error('Contract not found while recovering consumption');
          const oldVersion = computeContractVersion(action.consumption.source);
          if (oldVersion !== computeContractVersion(latest)) {
            // No accepted step exists. Re-evaluate the new subscription using a
            // fresh plan, while keeping this request's stable key reservation.
            await execution.repository.resetUnappliedPlan(execution.organizationId, execution.key, execution.owner);
            execution.record = await execution.repository.assertOwned(execution.organizationId, execution.key, execution.owner);
            return { status: 'changed' };
          }
          value = { status: 'limit', contract: latest };
        }
      } else {
        const rejected = results.flatMap((result, index) => result ? [] : [action.writes![index].userId]);
        if (rejected.length) {
          const changed: Record<string, string | null> = {};
          for (const userId of rejected) {
            const latest = await contracts.findByUserId(userId, action.organizationId);
            changed[userId] = latest ? computeContractVersion(latest) : null;
          }
          if (action.expected) {
            const failure = { error: 'contractChanged', versions: action.kind === 'group' ? changed : changed[rejected[0]],
              novated: action.kind === 'group' ? action.writes!.filter((_, index) => results[index]).map(write => write.userId) : undefined };
            for (const write of action.writes!) await cache.delMany(contractCacheKeys({ organizationId: write.organizationId, userContact: { userId: write.userId } }));
            for (const contract of results.filter(Boolean)) container.resolve('eventService').emitContractEvent('CONTRACT_NOVATED', contract);
            await execution.repository.saveResult(execution.organizationId, execution.key, execution.owner, failure);
            return resultOf(failure);
          }
          throw new Error('A prepared contract mutation no longer matches; retry after recovery');
        }
        for (const contract of results) contract.contractedServices = resetEscapeContractedServiceVersions(contract.contractedServices);
        value = action.kind === 'group' ? results : results[0];
      }
      for (const contract of results.filter(Boolean)) {
        await cache.delMany(contractCacheKeys(contract));
        if (['create', 'novate', 'group'].includes(action.kind)) {
          container.resolve('eventService').emitContractEvent(action.kind === 'create' ? 'CONTRACT_CREATED' : 'CONTRACT_NOVATED', contract);
        }
      }
    }
    await execution.repository.saveResult(execution.organizationId, execution.key, execution.owner, { value });
    return value;
  }, 2000);
}

function resultOf(result: any): any {
  if (result.error === 'contractChanged') throw new ContractChangedError(result.versions, result.novated);
  return result.value;
}
