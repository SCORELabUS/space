import RepositoryBase from '../RepositoryBase';
import PricingMongoose from './models/PricingMongoose';
import { toPlainObject } from '../../utils/mongoose';
import { LeanPricing } from '../../types/models/Pricing';
import { exactName } from './ServiceRepository';

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

  /**
   * Point stored pricings to the service they belong to after it was renamed
   * or moved (`_serviceName`, `_organizationId`), so that they are found under
   * its name and organization.
   */
  async reassignToService(ids: string[], serviceName: string, organizationId: string): Promise<void> {
    if (ids.length === 0) return;
    await PricingMongoose.updateMany(
      { _id: { $in: ids } },
      { $set: { _serviceName: serviceName, _organizationId: organizationId } }
    );
  }

  /**
   * The stored pricings of these services of the organization (ids and
   * `yamlPath` only): those with one of these ids, and those that carry one of
   * these names (exact, case-insensitive), which also finds pricings a service
   * no longer lists. Never another organization's, and never SPHERE snapshot
   * copies (SPHERE synchronization removes those, rechecking references).
   */
  async findOfServices(
    organizationId: string,
    serviceNames: string[],
    ids: string[]
  ): Promise<{ id: string; yamlPath?: string }[]> {
    if (serviceNames.length === 0 && ids.length === 0) return [];
    const pricings = await PricingMongoose.find(
      {
        _organizationId: organizationId,
        sphere: { $exists: false },
        $or: [
          { _id: { $in: ids } },
          { _serviceName: { $in: serviceNames.map(name => new RegExp(exactName(name).$regex, 'i')) } },
        ],
      },
      { _id: 1, yamlPath: 1 }
    ).lean();
    return pricings.map((pricing: any) => ({ id: String(pricing._id), yamlPath: pricing.yamlPath }));
  }

  /** Whether any stored pricing (of any organization) refers to this file. */
  async existsWithYamlPath(yamlPath: string): Promise<boolean> {
    return Boolean(await PricingMongoose.exists({ yamlPath }));
  }

  async destroyByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await PricingMongoose.deleteMany({ _id: { $in: ids } });
    return result.deletedCount;
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
