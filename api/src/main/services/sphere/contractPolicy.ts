import Service from '../../repositories/mongoose/models/ServiceMongoose';
import { resetEscapeVersion } from '../../utils/helpers';

/**
 * Pin the pricing version of every SPHERE-linked service of the subscription
 * to what its synchronization policy allows (in place).
 *
 * @returns the policy that decided the version, by subscription key, for each
 *          linked service of the subscription.
 */
export async function enforceSpherePolicy(organizationId: string, subscription: any, previous?: any): Promise<Record<string, string>> {
  const services: any[] = await Service.find({ organizationId, source: 'sphere', disabled: false }).lean();
  const decidedBy: Record<string, string> = {};
  for (const service of services) {
    const key = Object.keys(subscription.contractedServices ?? {}).find(key => key.toLowerCase() === service.name.toLowerCase());
    if (!key) continue;
    const oldKey = Object.keys(previous?.contractedServices ?? {}).find(key => key.toLowerCase() === service.name.toLowerCase());
    if (service.sphere.status === 'applying') throw new Error('Synchronization is applying; retry shortly');
    subscription.contractedServices[key] = oldKey && service.sphere.policy.startsWith('new_')
      ? resetEscapeVersion(previous.contractedServices[oldKey]) : service.sphere.target.version;
    decidedBy[key] = service.sphere.policy;
  }
  return decidedBy;
}
