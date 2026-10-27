import RepositoryBase from '../RepositoryBase';
import PricingMongoose from './models/PricingMongoose';
import { toPlainObject } from '../../utils/mongoose';
import { LeanPricing } from '../../types/models/Pricing';

class PricingRepository extends RepositoryBase {
  async findById(id: string): Promise<any> {
    const pricing = await PricingMongoose.findById(id);
    if (!pricing) {
      return null;
    }
    return pricing.toJSON();
  }

  /** `createdAt` of the given pricings, by id (pricings without one are left out). */
  async findCreatedAtByIds(ids: string[]): Promise<Map<string, Date>> {
    if (ids.length === 0) return new Map();
    const pricings = await PricingMongoose.find({ _id: { $in: ids } }, { createdAt: 1 }).lean();
    return new Map(
      pricings
        .filter((pricing: any) => pricing.createdAt)
        .map((pricing: any) => [String(pricing._id), new Date(pricing.createdAt)])
    );
  }

  async create(data: any): Promise<LeanPricing | null> {
    const pricing = await PricingMongoose.create(data);
    if (!pricing) {
      return null;
    }
    return toPlainObject<LeanPricing>(pricing.toObject());
  }

  async addServiceNameToPricing(pricingId: string, serviceName: string): Promise<any> {
    const pricing = await PricingMongoose.updateOne(
      { _id: pricingId },
      { $set: { _serviceName: serviceName } }
    );

    if (!pricing) {
      return null;
    }

    return true;
  }

  async destroy(id: string): Promise<LeanPricing | null> {
    const pricing = await PricingMongoose.findByIdAndDelete(id);
    if (!pricing) {
      return null;
    }
    return toPlainObject<LeanPricing>(pricing.toObject());
  }
}

export default PricingRepository;
