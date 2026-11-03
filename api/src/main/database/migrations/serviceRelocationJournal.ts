import ServiceRelocationRepository from '../../repositories/mongoose/ServiceRelocationRepository';
/** Additive and idempotent: existing service/contract documents are unchanged. */
export async function initializeServiceRelocationJournal(): Promise<void> {
  await new ServiceRelocationRepository().initialize();
}
