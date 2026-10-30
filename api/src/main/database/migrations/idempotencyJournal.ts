import IdempotencyKeyRepository from '../../repositories/mongoose/IdempotencyKeyRepository';
/** Preserve unfinished requests and initialize the scoped unique and TTL indexes. */
export async function initializeIdempotencyJournal(): Promise<void> {
  await new IdempotencyKeyRepository().initialize();
}
