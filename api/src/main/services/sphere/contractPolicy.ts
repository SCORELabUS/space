import Service from '../../repositories/mongoose/models/ServiceMongoose';
import { resetEscapeVersion } from '../../utils/helpers';

export async function enforceSpherePolicy(organizationId: string, subscription: any, previous?: any) {
  const services: any[] = await Service.find({ organizationId, source: 'sphere', disabled: false }).lean();
  for (const service of services) {
    const key = Object.keys(subscription.contractedServices ?? {}).find(key => key.toLowerCase() === service.name.toLowerCase());
    if (!key) continue;
    const oldKey = Object.keys(previous?.contractedServices ?? {}).find(key => key.toLowerCase() === service.name.toLowerCase());
    if (service.sphere.status === 'applying') throw new Error('Synchronization is applying; retry shortly');
    subscription.contractedServices[key] = oldKey && service.sphere.policy.startsWith('new_')
      ? resetEscapeVersion(previous.contractedServices[oldKey]) : service.sphere.target.version;
  }
}
