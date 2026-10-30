import {
  ServiceRelocation,
  ServiceRelocationStage,
  ServiceRelocationStep,
} from './models/ServiceRelocationMongoose';

const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`INTERNAL ERROR: service relocation requires ${field}`);
  }
  return value;
};
const exactName = (name: string) => ({
  $regex: `^${required(name, 'service name').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
  $options: 'i',
});

/** Private persistence boundary for resumable service moves; never performs external I/O. */
export default class ServiceRelocationRepository {
  async initialize(): Promise<void> {
    await Promise.all([ServiceRelocation.init(), ServiceRelocationStep.init()]);
  }

  pendingForIdentity(organizationId: string, name: string): Promise<any> {
    const organization = required(organizationId, 'organization');
    return ServiceRelocation.findOne({
      state: 'pending',
      $or: [
        { sourceOrganizationId: organization, sourceName: exactName(name) },
        { targetOrganizationId: organization, targetName: exactName(name) },
      ],
    }).lean().exec();
  }

  pendingForOrganization(organizationId: string): Promise<any[]> {
    const organization = required(organizationId, 'organization');
    return ServiceRelocation.find({
      state: 'pending',
      $or: [{ sourceOrganizationId: organization }, { targetOrganizationId: organization }],
    }).lean().exec();
  }

  get(id: string): Promise<any> {
    return ServiceRelocation.findById(required(id, 'operation id')).lean().exec();
  }

  async create(data: any): Promise<any> {
    required(data?.sourceOrganizationId, 'source organization');
    required(data?.targetOrganizationId, 'target organization');
    required(data?.sourceName, 'source service name');
    required(data?.targetName, 'target service name');
    return (await ServiceRelocation.create(data)).toObject();
  }

  stage(id: string, stage: ServiceRelocationStage) {
    return ServiceRelocation.updateOne(
      { _id: required(id, 'operation id'), state: 'pending' },
      { $set: { stage }, $unset: { lastError: '' } },
      { runValidators: true }
    );
  }

  fail(id: string, message: string) {
    return ServiceRelocation.updateOne(
      { _id: required(id, 'operation id'), state: 'pending' },
      { $set: { lastError: message } }
    );
  }

  complete(id: string) {
    return ServiceRelocation.updateOne(
      { _id: required(id, 'operation id'), state: 'pending' },
      { $set: { state: 'complete', finishedAt: new Date() }, $unset: { lastError: '' } }
    );
  }

  ensureStep(operationId: string, before: any): Promise<any> {
    const operation = required(operationId, 'operation id');
    const contractId = before?._id ?? before?.id;
    if (!contractId) throw new Error('INTERNAL ERROR: service relocation requires the contract id');
    const id = `${operation}:${String(contractId)}`;
    return ServiceRelocationStep.findOneAndUpdate(
      { _id: id },
      { $setOnInsert: { operationId: operation, contractId, before: { id: String(contractId), organizationId: before.organizationId, userContact: { userId: before.userContact.userId }, contractedServices: before.contractedServices }, applied: false, effectsDone: false } },
      { upsert: true, new: true, runValidators: true }
    ).lean().exec();
  }

  steps(operationId: string): Promise<any[]> {
    return ServiceRelocationStep.find({ operationId: required(operationId, 'operation id') }).lean().exec();
  }

  applied(stepId: string, changed = true) {
    return ServiceRelocationStep.updateOne({ _id: required(stepId, 'step id') }, { $set: { applied: true, changed } });
  }

  effectsDone(stepId: string) {
    return ServiceRelocationStep.updateOne({ _id: required(stepId, 'step id') }, { $set: { effectsDone: true } });
  }
}
