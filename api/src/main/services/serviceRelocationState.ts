import { ServiceRelocation } from '../repositories/mongoose/models/ServiceRelocationMongoose';
export class ServiceRelocationPendingError extends Error {
  readonly code = 'SERVICE_RELOCATION_PENDING';
  constructor(id: string) { super(`CONFLICT: Service relocation ${id} must be recovered before changing bindings; retry its original service update`); }
}
export const relocationGlobalLease = '__service_relocations__';
export async function assertNoPendingRelocation(organizationId?: string, allowedOperationId?: string): Promise<void> {
  const pending = await ServiceRelocation.findOne({ state: 'pending',
    ...(allowedOperationId ? { _id: { $ne: allowedOperationId } } : {}),
    ...(organizationId ? { $or: [{ sourceOrganizationId: organizationId }, { targetOrganizationId: organizationId }] } : {}),
  }).select('_id').lean();
  if (pending) throw new ServiceRelocationPendingError(pending._id);
}
