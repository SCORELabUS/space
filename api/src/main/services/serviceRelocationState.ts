import { ServiceRelocation } from '../repositories/mongoose/models/ServiceRelocationMongoose';
export const relocationGlobalLease = '__service_relocations__';
export async function assertNoPendingRelocation(organizationId?: string, allowedOperationId?: string): Promise<void> {
  const pending = await ServiceRelocation.findOne({ state: 'pending',
    ...(allowedOperationId ? { _id: { $ne: allowedOperationId } } : {}),
    ...(organizationId ? { $or: [{ sourceOrganizationId: organizationId }, { targetOrganizationId: organizationId }] } : {}),
  }).select('_id').lean();
  if (pending) throw new Error(`CONFLICT: Service relocation ${pending._id} must be recovered before changing bindings; retry its original service update`);
}
