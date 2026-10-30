import RepositoryBase from '../RepositoryBase';
import PricingMongoose from './models/PricingMongoose';
import ServiceMongoose from './models/ServiceMongoose';
import { LeanService } from '../../types/models/Service';
import { LeanPricing } from '../../types/models/Pricing';

/** Escape a string for use as a literal inside a regular expression. */
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type ServiceQueryFilters = {
  disabled?: boolean;
  name?: string;
  page?: number;
  offset?: number;
  limit?: number;
  order?: 'asc' | 'desc';
};

class ServiceRepository extends RepositoryBase {
  async findAll(organizationId?: string, queryFilters?: ServiceQueryFilters, disabled = false) {
    const { name, page = 1, offset = 0, limit = 20, order = 'asc', disabled: selectedDisabled = disabled } = queryFilters || {};

    const query: any = {
      ...(name ? { name: { $regex: name, $options: 'i' } } : {}),
      disabled: selectedDisabled,
      ...(organizationId ? { organizationId: organizationId } : {}),
    };

    const services = await ServiceMongoose.find(query)
      .skip(offset == 0 ? (page - 1) * limit : offset)
      .limit(limit)
      .sort({ name: order === 'asc' ? 1 : -1 });

    return services.map(service => service.toObject() as unknown as LeanService);
  }

  async findAllNoQueries(
    organizationId?: string,
    disabled = false,
    projection: any = { name: 1, activePricings: 1, archivedPricings: 1 }
  ): Promise<LeanService[] | null> {
    const query: any = {
      disabled: disabled,
      ...(organizationId ? { organizationId: organizationId } : {}),
    };
    const services = await ServiceMongoose.find(query).select(projection);

    if (!services || (Array.isArray(services) && services.length === 0)) {
      return null;
    }

    return services.map(service => service.toObject() as unknown as LeanService);
  }

  async findByName(
    name: string,
    organizationId: string,
    disabled = false
  ): Promise<LeanService | null> {
    // Exact, case-insensitive: the name comes from the URL and is not a pattern.
    const query: any = {
      name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
      disabled: disabled,
      organizationId: organizationId,
    };
    const service = await ServiceMongoose.findOne(query);
    if (!service) {
      return null;
    }

    return service.toObject() as unknown as LeanService;
  }

  async findByNames(
    names: string[],
    organizationId: string,
    disabled = false
  ): Promise<LeanService[] | null> {
    // Exact, case-insensitive: contract service names are not patterns.
    const query: any = {
      name: { $in: names.map(name => new RegExp(`^${escapeRegex(name)}$`, 'i')) },
      disabled: disabled,
      organizationId: organizationId,
    };
    const services = await ServiceMongoose.find(query);
    if (!services || (Array.isArray(services) && services.length === 0)) {
      return null;
    }
    return services.map(service => service.toObject() as unknown as LeanService);
  }

  async findPricingsByServiceName(
    serviceName: string,
    versionsToRetrieve: string[],
    organizationId?: string,
    disabled = false
  ): Promise<LeanPricing[] | null> {
    const query: any = {
      _serviceName: { $regex: serviceName, $options: 'i' },
      version: { $in: versionsToRetrieve },
      _organizationId: organizationId,
    };
    const pricings = await PricingMongoose.find(query);
    if (!pricings || (Array.isArray(pricings) && pricings.length === 0)) {
      return null;
    }

    return pricings.map(p => p.toJSON() as unknown as LeanPricing);
  }

  async create(data: any) {
    const service = await ServiceMongoose.insertOne(data);

    return service.toObject() as unknown as LeanService;
  }

  async update(name: string, data: any, organizationId: string) {
    // Exact, case-insensitive and organization-bound.
    const query: any = { name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' }, organizationId };
    if (organizationId) {
      query.organizationId = organizationId;
    }

    // 1. Separate the $set operations (update) and $unset operations (delete)
    const $set: any = {};
    const $unset: any = {};

    Object.entries(data).forEach(([key, value]) => {
      if (value === undefined) {
        // If the value is undefined, add it to the delete list
        $unset[key] = '';
      } else {
        // If it has a value, update it
        $set[key] = value;
      }
    });

    // 2. Execute the atomic update
    // new: true returns the modified document
    const service = await ServiceMongoose.findOneAndUpdate(
      query,
      { $set, $unset },
      { new: true }
    );

    if (!service) {
      return null;
    }

    return service.toObject() as unknown as LeanService;
  }

  async disable(name: string, organizationId: string) {
    const query: any = { name: { $regex: name, $options: 'i' }, organizationId: organizationId };
    const service = await ServiceMongoose.findOne(query);

    if (!service) {
      return null;
    }

    // Normalize archived and active pricings to plain objects to avoid Mongoose Map cast issues
    const existingArchived = service.archivedPricings
      ? JSON.parse(JSON.stringify(service.archivedPricings))
      : {};
    const existingActive = service.activePricings
      ? JSON.parse(JSON.stringify(service.activePricings))
      : {};

    const mergedArchived: Record<string, any> = { ...existingArchived };

    // Move active pricings into archived, renaming collisions
    for (const key of Object.keys(existingActive)) {
      if (mergedArchived[key]) {
        const newKey = `${key}_${Date.now()}`;
        mergedArchived[newKey] = existingActive[key];
      } else {
        mergedArchived[key] = existingActive[key];
      }
    }

    service.set({
      disabled: true,
      activePricings: {},
      archivedPricings: mergedArchived,
    });

    await service.save();

    return service.toObject() as unknown as LeanService;
  }

  async destroy(name: string, organizationId: string, ...args: any) {
    const query: any = { name: { $regex: name, $options: 'i' }, organizationId: organizationId };
    const result = await ServiceMongoose.deleteOne(query);

    if (!result) {
      return null;
    }
    if (result.deletedCount === 0) {
      return null;
    }

    if (result.deletedCount === 1) {
      await PricingMongoose.deleteMany({ _serviceName: name });
    }

    return true;
  }

  async prune(organizationId?: string): Promise<number | null> {
    const query: any = {};
    if (organizationId) {
      query.organizationId = organizationId;
    }
    const result = await ServiceMongoose.deleteMany(query);

    if (result.deletedCount === 0) {
      return null;
    }

    return result.deletedCount;
  }
}

export default ServiceRepository;
