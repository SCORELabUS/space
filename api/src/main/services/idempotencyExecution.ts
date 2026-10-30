import { AsyncLocalStorage } from 'node:async_hooks';
import type IdempotencyKeyRepository from '../repositories/mongoose/IdempotencyKeyRepository';

export interface IdempotencyExecution {
  organizationId: string;
  key: string;
  owner: string;
  operationId: string;
  repository: IdempotencyKeyRepository;
  record: any;
  inAction?: boolean;
}
const executions = new AsyncLocalStorage<IdempotencyExecution>();
export const currentIdempotencyExecution = () => executions.getStore();
export const runIdempotencyExecution = <T>(execution: IdempotencyExecution, work: () => T): T => executions.run(execution, work);

export async function assertIdempotencyOwnership(): Promise<IdempotencyExecution> {
  const execution = currentIdempotencyExecution();
  if (!execution) throw new Error('Missing idempotency execution');
  execution.record = await execution.repository.assertOwned(execution.organizationId, execution.key, execution.owner);
  return execution;
}
