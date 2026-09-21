import Service from './models/ServiceMongoose';
import Pricing from './models/PricingMongoose';
import Contract from './models/ContractMongoose';
import { SphereRun } from './models/SphereSyncMongoose';

/** Persistence boundary for snapshot synchronization. Never performs external I/O. */
export default class SphereSyncRepository {
  service(filter: any): Promise<any> { return Service.findOne(filter).lean().exec(); }
  services(filter: any, limit = 0): Promise<any[]> { return Service.find(filter).limit(limit).lean().exec(); }
  serviceExists(filter: any) { return Service.exists(filter); }
  updateService(filter: any, update: any) { return Service.updateOne(filter, update); }
  deleteService(filter: any): Promise<{ deletedCount: number }> { return Service.deleteOne(filter).exec(); }
  async createService(data: any): Promise<any> {
    const doc = await Service.create(data);
    return { ...doc.toObject(), id: String(doc._id), _id: doc._id };
  }
  pricing(filter: any): Promise<any> { return Pricing.findOne(filter).lean().exec(); }
  pricings(filter: any): Promise<any[]> { return Pricing.find(filter).lean().exec(); }
  async createPricing(data: any): Promise<any> {
    const doc = await Pricing.create(data);
    return { ...doc.toObject({ flattenMaps: true }), _id: doc._id };
  }
  deletePricing(filter: any): Promise<{ deletedCount: number }> { return Pricing.deleteOne(filter).exec(); }
  contract(filter: any): Promise<any> { return Contract.findOne(filter).lean().exec(); }
  contracts(filter: any): Promise<any[]> { return Contract.find(filter).lean().exec(); }
  contractExists(filter: any) { return Contract.exists(filter); }
  updateContract(filter: any, update: any) { return Contract.updateOne(filter, update); }
  aggregateContracts(pipeline: any[]) { return Contract.aggregate(pipeline); }
  run(id: string): Promise<any> { return SphereRun.findById(id).lean().exec(); }
  async createRun(data: any): Promise<any> { return (await SphereRun.create(data)).toObject(); }
  updateRun(filter: any, update: any) { return SphereRun.updateOne(filter, update); }
}
