import { withOrganizationLock } from './sphere/lock';
import ServiceModel from '../repositories/mongoose/models/ServiceMongoose';
import { retrievePricingFromPath, retrievePricingFromText } from 'pricing4ts/server';
import container from '../config/container';
import ServiceRepository, { ServiceQueryFilters } from '../repositories/mongoose/ServiceRepository';
import { parsePricingToSpacePricingObject } from '../utils/pricing-yaml2json';
import { Pricing } from 'pricing4ts';
import fetch from 'node-fetch';
import https from 'https';
import path from 'path';
import fs from 'fs';
import PricingRepository from '../repositories/mongoose/PricingRepository';
import { validatePricingData } from './validation/PricingServiceValidation';
import { LeanService } from '../types/models/Service';
import { ExpectedPricingType, LeanPricing } from '../types/models/Pricing';
import { FallBackSubscription, LeanContract } from '../types/models/Contract';
import ContractRepository from '../repositories/mongoose/ContractRepository';
import { performNovation } from '../utils/contracts/novation';
import { isSubscriptionValidInPricing } from '../controllers/validation/ContractValidation';
import { generateUsageLevels } from '../utils/contracts/helpers';
import { escapeVersion } from '../utils/helpers';
import { resetEscapeVersionInService } from '../utils/services/helpers';
import CacheService from './CacheService';
import OrganizationRepository from '../repositories/mongoose/OrganizationRepository';

class ServiceService {
  private readonly serviceRepository: ServiceRepository;
  private readonly pricingRepository: PricingRepository;
  private readonly contractRepository: ContractRepository;
  private readonly organizationRepository: OrganizationRepository;
  private readonly cacheService: CacheService;
  private readonly eventService;

  constructor() {
    this.serviceRepository = container.resolve('serviceRepository');
    this.pricingRepository = container.resolve('pricingRepository');
    this.contractRepository = container.resolve('contractRepository');
    this.organizationRepository = container.resolve('organizationRepository');
    this.eventService = container.resolve('eventService');
    this.cacheService = container.resolve('cacheService');
    for (const method of ['disable', 'destroy'] as const) {
      const original = this[method].bind(this);
      (this as any)[method] = async (name: string, organizationId: string) => {
        const linked: any = await ServiceModel.findOne({ name, organizationId, source: 'sphere' }).lean();
        if (!linked) return original(name, organizationId);
        return withOrganizationLock(organizationId, async assertOwned => {
          const current: any = await ServiceModel.findById(linked._id).lean();
          if (current?.sphere.status === 'applying') throw new Error('Synchronization is applying; retry after recovery');
          await assertOwned();
          return container.resolve('sphereSyncService').removeLinkedService(String(linked._id), method === 'disable', assertOwned);
        });
      };
    }
    for (const method of ['addPricingToService', 'updatePricingAvailability', 'destroyPricing', 'update'] as const) {
      const original = (this[method] as (...args: any[]) => Promise<any>).bind(this);
      (this as any)[method] = async (...args: any[]) => {
        const organizationId = args[args.length - 1];
        if (await ServiceModel.exists({ name: args[0], organizationId, source: 'sphere' })) {
          throw new Error('Invalid operation: manage linked pricing through SPHERE synchronization settings');
        }
        return original(...args);
      };
    }

  }

  async index(queryParams: ServiceQueryFilters, organizationId?: string) {
    const services = await this.serviceRepository.findAll(organizationId, queryParams);

    for (const service of services) {
      resetEscapeVersionInService(service);
    }

    return services;
  }

  async indexByNames(serviceNames: string[], organizationId: string) {
    if (!Array.isArray(serviceNames) || serviceNames.length === 0) {
      throw new Error('Invalid request: serviceNames must be a non-empty array');
    }

    const services = await this.serviceRepository.findByNames(serviceNames, organizationId);
    return services;
  }

  async indexPricings(serviceName: string, pricingStatus: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
      await this.cacheService.set(cacheKey, service, 3600, true);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    const pricingsToReturn =
      pricingStatus === 'active' ? service.activePricings : service.archivedPricings;

    if (!pricingsToReturn) {
      return [];
    }

    const versionsToRetrieve = Array.from(pricingsToReturn.keys()) as string[];

    const versionsToRetrieveLocally: string[] = versionsToRetrieve.filter(
      version => pricingsToReturn.get(version)?.id
    );
    const versionsToRetrieveRemotely: string[] = versionsToRetrieve.filter(
      version => !pricingsToReturn.get(version)?.id
    );

    const locallySavedPricings =
      (await this.serviceRepository.findPricingsByServiceName(
        service.name,
        versionsToRetrieveLocally,
        organizationId
      )) ?? [];

    const remotePricings = [];

    // Fetch remote pricings in parallel with a small concurrency limit and using cache
    const concurrency = 10;
    for (let i = 0; i < versionsToRetrieveRemotely.length; i += concurrency) {
      const batch = versionsToRetrieveRemotely.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map(async version => {
          const url = pricingsToReturn.get(version)?.url;
          if (!url) {
            return null;
          }
          // Try cache first
          let pricing = await this.cacheService.get(`pricing.url.${url}`);
          if (!pricing) {
            pricing = await this._getPricingFromUrl(url);
            try {
              await this.cacheService.set(`pricing.url.${url}`, pricing, 3600, true);
            } catch (err) {
              // Don't fail the pricing retrieval if cache set fails. Log for debugging.
              // eslint-disable-next-line no-console
              console.debug('Cache set failed for pricing.url.' + url, err);
            }
          }
          return { ...pricing, url };
        })
      );
      remotePricings.push(...batchResults.filter(Boolean));
    }

    return (locallySavedPricings as unknown as LeanPricing[]).concat(remotePricings);
  }

  async show(serviceName: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
      await this.cacheService.set(cacheKey, service, 3600, true);
      if (!service) {
        throw new Error(`NOT FOUND: Service with name ${serviceName}`);
      }
    }

    resetEscapeVersionInService(service);

    return service;
  }

  async showPricing(serviceName: string, pricingVersion: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    const formattedPricingVersion = escapeVersion(pricingVersion);
    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    const pricingLocator =
      service.activePricings.get(formattedPricingVersion) ??
      service.archivedPricings?.get(formattedPricingVersion);

    if (!pricingLocator) {
      if (service.source === 'sphere') return container.resolve('sphereSyncService').historicalPricing(organizationId, serviceName, pricingVersion);
      throw new Error(`Pricing version ${pricingVersion} not found for service ${serviceName}`);
    }

    if (!pricingLocator.id && !pricingLocator.url) {
      throw new Error(
        `Neither Pricing URL or id found for version ${pricingVersion} in service ${serviceName}`
      );
    }

    if (pricingLocator.id) {
      let pricing = await this.cacheService.get(`pricing.id.${pricingLocator.id}`);

      if (!pricing) {
        pricing = await this.pricingRepository.findById(pricingLocator.id);
        await this.cacheService.set(`pricing.id.${pricingLocator.id}`, pricing, 3600, true);
      }

      return pricing;
    } else {
      let pricing = await this.cacheService.get(`pricing.url.${pricingLocator.url}`);

      if (!pricing) {
        pricing = await this._getPricingFromUrl(pricingLocator.url);
        await this.cacheService.set(`pricing.url.${pricingLocator.url}`, pricing, 3600, true);
      }

      return { ...pricing, url: pricingLocator.url };
    }
  }

  async showPublicPricingUrl(serviceName: string, pricingVersion: string, organizationId: string) {
    const pricing = await this.showPricing(serviceName, pricingVersion, organizationId);

    if (pricing?.yamlPath) {
      return pricing.yamlPath;
    }

    throw new Error(
      `Pricing version ${pricingVersion} for service ${serviceName} does not have a persisted yamlPath`
    );
  }

  async create(receivedPricing: any, pricingType: 'file' | 'url', organizationId: string) {
    try {
      await this.cacheService.del('features.*');

      if (pricingType === 'file') {
        return await this._createFromFile(receivedPricing, organizationId, undefined);
      } else {
        return await this._createFromUrl(receivedPricing, organizationId, undefined);
      }
    } catch (err) {
      throw new Error((err as Error).message);
    }
  }

  async addPricingToService(
    serviceName: string,
    receivedPricing: any,
    pricingType: 'file' | 'url',
    organizationId: string
  ) {
    try {
      await this.cacheService.del('features.*');
      const cacheKey = `service.${organizationId}.${serviceName}`;
      await this.cacheService.del(cacheKey);

      if (pricingType === 'file') {
        return await this._createFromFile(receivedPricing, organizationId, serviceName);
      } else {
        return await this._createFromUrl(receivedPricing, organizationId, serviceName);
      }
    } catch (err) {
      throw new Error((err as Error).message);
    }
  }

  async _createFromFile(pricingFile: any, organizationId: string, serviceName?: string) {
    let service: LeanService | null = null;

    // Step 1: Parse and validate pricing

    const uploadedPricing: Pricing = await this._getPricingFromPath(pricingFile.path);
    const pricingYamlPath = this._savePricingYamlFile(
      pricingFile.path,
      organizationId,
      uploadedPricing.saasName,
      uploadedPricing.version
    );
    const formattedPricingVersion = escapeVersion(uploadedPricing.version);
    // Step 1.1: Load the service if already exists
    if (serviceName) {
      if (uploadedPricing.saasName !== serviceName) {
        throw new Error(
          `Invalid request: The service name in the pricing file (${uploadedPricing.saasName}) does not match the service name in the URL (${serviceName})`
        );
      }
      service = await this.serviceRepository.findByName(serviceName, organizationId);
      if (!service) {
        throw new Error(`NOT FOUND: Service with name ${serviceName}`);
      }

      if (
        (service.activePricings && service.activePricings.get(formattedPricingVersion)) ||
        (service.archivedPricings && service.archivedPricings.get(formattedPricingVersion))
      ) {
        throw new Error(
          `Pricing version ${uploadedPricing.version} already exists for service ${serviceName}`
        );
      }
    }

    const pricingData: ExpectedPricingType & { _serviceName: string; _organizationId: string } = {
      _serviceName: uploadedPricing.saasName,
      _organizationId: organizationId,
      yamlPath: pricingYamlPath,
      ...parsePricingToSpacePricingObject(uploadedPricing),
    };

    const validationErrors: string[] = validatePricingData(pricingData);

    if (validationErrors.length > 0) {
      throw new Error(`Validation errors: ${validationErrors.join(', ')}`);
    }

    // Step 2:
    // - If the service does not exist (enabled), creates it
    // - If an enabled service exists, updates it with the new pricing
    // - If a disabled service exists with the same name, re-enable it, make the
    //   uploaded pricing the only active pricing and move all previous active/archived
    //   entries into archivedPricings (renaming collisions by appending timestamp)
    if (!service) {
      // Check if an enabled service exists
      const existingEnabled = await this.serviceRepository.findByName(
        uploadedPricing.saasName,
        organizationId,
        false
      );
      const existingDisabled = await this.serviceRepository.findByName(
        uploadedPricing.saasName,
        organizationId,
        true
      );

      if (existingEnabled) {
        throw new Error(`Invalid request: Service ${uploadedPricing.saasName} already exists`);
      }

      // Step 3: Create the service as it does not exist and add the pricing
      const savedPricing = await this.pricingRepository.create(pricingData);

      if (!savedPricing) {
        throw new Error(`Pricing ${uploadedPricing.version} not saved`);
      }

      if (existingDisabled) {
        // Re-enable flow: archive existing active pricings and archived pricings
        const newArchived: Record<string, any> = { ...(existingDisabled.archivedPricings || {}) };

        // rename any archived entry that collides with the new version
        if (newArchived[formattedPricingVersion]) {
          const newKey = `${formattedPricingVersion}_${Date.now()}`;
          newArchived[newKey] = newArchived[formattedPricingVersion];
          delete newArchived[formattedPricingVersion];
        }

        // move previous active pricings into archived (renaming collisions)
        if (existingDisabled.activePricings) {
          for (const key of Object.keys(existingDisabled.activePricings)) {
            if (key === formattedPricingVersion) {
              const newKey = `${key}_${Date.now()}`;
              newArchived.set(newKey, existingDisabled.activePricings.get(key)!);
            } else {
              // if archived already has this key, append timestamp
              if (newArchived.has(key)) {
                const newKey = `${key}_${Date.now()}`;
                newArchived.set(newKey, existingDisabled.activePricings.get(key)!);
              } else {
                newArchived.set(key, existingDisabled.activePricings.get(key)!);
              }
            }
          }
        }

        const updateData: any = {
          disabled: false,
          activePricings: new Map([
            [
              formattedPricingVersion,
              {
                id: savedPricing.id,
              },
            ],
          ]),
          archivedPricings: newArchived,
        };

        const updated = await this.serviceRepository.update(
          existingDisabled.name,
          updateData,
          organizationId
        );
        if (!updated) {
          throw new Error(`Service ${uploadedPricing.saasName} not updated`);
        }

        service = updated;
      } else {
        const serviceData = {
          name: uploadedPricing.saasName,
          disabled: false,
          organizationId: organizationId,
          activePricings: new Map([
            [
              formattedPricingVersion,
              {
                id: savedPricing.id,
              },
            ],
          ]),
        };

        try {
          service = await this.serviceRepository.create(serviceData);
        } catch (err) {
          throw new Error(
            `Service ${uploadedPricing.saasName} not saved: ${(err as Error).message}`
          );
        }
      }
    } else {
      // service exists (serviceName provided)
      // If pricing already exists as ACTIVE, we disallow
      if (service.activePricings && service.activePricings.get(formattedPricingVersion)) {
        throw new Error(
          `Pricing version ${uploadedPricing.version} already exists for service ${serviceName}`
        );
      }

      // If pricing exists in archived, rename archived entry to free the key
      const archivedExists =
        service.archivedPricings && service.archivedPricings.get(formattedPricingVersion);
      const updatePayload: any = {};

      if (archivedExists) {
        const newKey = `${formattedPricingVersion}_${Date.now()}`;
        updatePayload[`archivedPricings.${newKey}`] =
          service.archivedPricings!.get(formattedPricingVersion);
        updatePayload[`archivedPricings.${formattedPricingVersion}`] = undefined;
      }

      // Step 3: Create the service as it does not exist and add the pricing
      const savedPricing = await this.pricingRepository.create(pricingData);

      if (!savedPricing) {
        throw new Error(`Pricing ${uploadedPricing.version} not saved`);
      }

      // If the service is disabled, re-enable it and move previous active/archived to archived
      if ((service as any).disabled) {
        const newArchived: Record<string, any> = { ...(service.archivedPricings || {}) };

        if (newArchived[formattedPricingVersion]) {
          const newKey = `${formattedPricingVersion}_${Date.now()}`;
          newArchived[newKey] = newArchived[formattedPricingVersion];
          delete newArchived[formattedPricingVersion];
        }

        if (service.activePricings) {
          for (const key of Object.keys(service.activePricings)) {
            if (key === formattedPricingVersion) {
              const newKey = `${key}_${Date.now()}`;
              newArchived.set(newKey, service.activePricings.get(key)!);
            } else {
              if (newArchived.has(key)) {
                const newKey = `${key}_${Date.now()}`;
                newArchived.set(newKey, service.activePricings.get(key)!);
              } else {
                newArchived.set(key, service.activePricings.get(key)!);
              }
            }
          }
        }

        updatePayload.disabled = false;
        updatePayload.activePricings = new Map([
          [
            formattedPricingVersion,
            {
              id: savedPricing.id,
            },
          ],
        ]);
        updatePayload.archivedPricings = newArchived;
      } else {
        // Normal update: keep existing active pricings and just add the new one
        updatePayload[`activePricings.${formattedPricingVersion}`] = {
          id: savedPricing.id,
        };
      }

      const updatedService = await this.serviceRepository.update(
        service.name,
        updatePayload,
        organizationId
      );

      service = updatedService;
    }

    if (!service) {
      throw new Error(`Service ${uploadedPricing.saasName} not saved`);
    }

    // Emit pricing creation event
    this.eventService.emitPricingCreatedMessage(service.name, uploadedPricing.version);

    // Step 4: Link the pricing to the service
    // await this.pricingRepository.addServiceNameToPricing(
    //   savedPricing.id!.toString(),
    //   service!.name.toString()
    // );

    // Step 5: If everythign was ok, remove the uploaded file

    const directory = path.dirname(pricingFile.path);
    if (fs.readdirSync(directory).length === 1) {
      fs.rmdirSync(directory, { recursive: true });
    } else {
      fs.rmSync(pricingFile.path);
    }

    resetEscapeVersionInService(service);

    // Step 6: Return the saved service
    return service;
  }

  async _createFromUrl(pricingUrl: string, organizationId: string, serviceName?: string) {
    const uploadedPricing: Pricing = await this._getPricingFromRemoteUrl(pricingUrl);
    const formattedPricingVersion = escapeVersion(uploadedPricing.version);

    if (!serviceName) {
      // Create a new service or re-enable a disabled one
      const existingEnabled = await this.serviceRepository.findByName(
        uploadedPricing.saasName,
        organizationId,
        false
      );
      const existingDisabled = await this.serviceRepository.findByName(
        uploadedPricing.saasName,
        organizationId,
        true
      );

      if (existingEnabled) {
        throw new Error(`Invalid request: Service ${uploadedPricing.saasName} already exists`);
      }

      if (existingDisabled) {
        const newArchived: Record<string, any> = { ...(existingDisabled.archivedPricings || {}) };

        if (newArchived[formattedPricingVersion]) {
          const newKey = `${formattedPricingVersion}_${Date.now()}`;
          newArchived[newKey] = newArchived[formattedPricingVersion];
          delete newArchived[formattedPricingVersion];
        }

        if (existingDisabled.activePricings) {
          for (const key of Object.keys(existingDisabled.activePricings)) {
            if (key === formattedPricingVersion) {
              const newKey = `${key}_${Date.now()}`;
              newArchived.set(newKey, existingDisabled.activePricings.get(key)!);
            } else {
              if (newArchived.has(key)) {
                const newKey = `${key}_${Date.now()}`;
                newArchived.set(newKey, existingDisabled.activePricings.get(key)!);
              } else {
                newArchived.set(key, existingDisabled.activePricings.get(key)!);
              }
            }
          }
        }

        const updateData: any = {
          disabled: false,
          organizationId: organizationId,
          activePricings: {
            [formattedPricingVersion]: {
              url: pricingUrl,
            },
          },
          archivedPricings: newArchived,
        };

        const updated = await this.serviceRepository.update(
          existingDisabled.name,
          updateData,
          organizationId
        );
        if (!updated) {
          throw new Error(`Service ${uploadedPricing.saasName} not updated`);
        }

        return updated;
      }

      const serviceData = {
        name: uploadedPricing.saasName,
        disabled: false,
        organizationId: organizationId,
        activePricings: {
          [formattedPricingVersion]: {
            url: pricingUrl,
          },
        },
      };

      const service = await this.serviceRepository.create(serviceData);

      // Emit pricing creation event
      this.eventService.emitPricingCreatedMessage(service.name, uploadedPricing.version);

      return service;
    } else {
      if (uploadedPricing.saasName !== serviceName) {
        throw new Error(
          `Invalid request: The service name in the pricing file (${uploadedPricing.saasName}) does not match the service name in the URL (${serviceName})`
        );
      }
      // Update an existing service
      const service = await this.serviceRepository.findByName(serviceName, organizationId);
      if (!service) {
        throw new Error(`NOT FOUND: Service with name ${serviceName}`);
      }

      // If already active, reject
      if (service.activePricings && service.activePricings.has(formattedPricingVersion)) {
        throw new Error(
          `Pricing version ${uploadedPricing.version} already exists for service ${serviceName}`
        );
      }

      const updatePayload: any = {};

      // If exists in archived, rename archived entry first
      if (service.archivedPricings && service.archivedPricings.has(formattedPricingVersion)) {
        const newKey = `${formattedPricingVersion}_${Date.now()}`;
        updatePayload[`archivedPricings.${newKey}`] =
          service.archivedPricings.get(formattedPricingVersion);
        updatePayload[`archivedPricings.${formattedPricingVersion}`] = undefined;
      }

      // If disabled, re-enable and move previous active into archived
      if ((service as any).disabled) {
        const newArchived: Record<string, any> = { ...(service.archivedPricings || {}) };

        if (newArchived[formattedPricingVersion]) {
          const newKey = `${formattedPricingVersion}_${Date.now()}`;
          newArchived[newKey] = newArchived[formattedPricingVersion];
          delete newArchived[formattedPricingVersion];
        }

        if (service.activePricings) {
          for (const key of Object.keys(service.activePricings)) {
            if (key === formattedPricingVersion) {
              const newKey = `${key}_${Date.now()}`;
              newArchived.set(newKey, service.activePricings.get(key)!);
            } else {
              if (newArchived.has(key)) {
                const newKey = `${key}_${Date.now()}`;
                newArchived.set(newKey, service.activePricings.get(key)!);
              } else {
                newArchived.set(key, service.activePricings.get(key)!);
              }
            }
          }
        }

        updatePayload.disabled = false;
        updatePayload.organizationId = organizationId;
        updatePayload.activePricings = {
          [formattedPricingVersion]: {
            url: pricingUrl,
          },
        };
        updatePayload.archivedPricings = newArchived;
      } else {
        updatePayload[`activePricings.${formattedPricingVersion}`] = {
          url: pricingUrl,
        };
      }

      const updatedService = await this.serviceRepository.update(
        service.name,
        updatePayload,
        organizationId
      );

      if (!updatedService) {
        throw new Error(
          `Service ${serviceName} not updated with pricing ${uploadedPricing.version}`
        );
      }

      resetEscapeVersionInService(updatedService);

      // Emit pricing creation event
      this.eventService.emitPricingCreatedMessage(service.name, uploadedPricing.version);

      return updatedService;
    }
  }

  async update(serviceName: string, newServiceData: any, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);
    const dataToUpdate: any = {};
    const contractsToRemoveService: LeanContract[] = [];
    const contractsToUpdateOrgId: LeanContract[] = [];

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    if (newServiceData.name && newServiceData.name !== service.name) {
      const existingService = await this.serviceRepository.findByName(
        newServiceData.name,
        organizationId
      );
      if (existingService) {
        throw new Error(`CONFLICT: Service name ${newServiceData.name} already exists`);
      }
      dataToUpdate.name = newServiceData.name;
    }

    if (newServiceData.organizationId && newServiceData.organizationId !== organizationId) {
      const organization = await this.organizationRepository.findById(
        newServiceData.organizationId
      );
      if (!organization) {
        throw new Error(
          `INVALID DATA: Organization with id ${newServiceData.organizationId} not found`
        );
      }

      const contracts = await this.contractRepository.findByFilters({
        filters: { services: [service.name] },
        organizationId,
      });

      for (const contract of contracts) {
        if (Object.keys(contract.contractedServices).length > 1) {
          contractsToRemoveService.push(contract);
        } else {
          if (dataToUpdate.name) {
            contract.contractedServices[dataToUpdate.name] =
              contract.contractedServices[service.name];
            delete contract.contractedServices[service.name];
          }
          contractsToUpdateOrgId.push(contract);
        }
      }

      dataToUpdate.organizationId = newServiceData.organizationId;
    }

    const updatedService = await this.serviceRepository.update(
      service.name,
      dataToUpdate,
      organizationId
    );

    if (dataToUpdate.name) {
      // If the service name has changed, we need to update the cache key
      await this.cacheService.del(cacheKey);
      serviceName = dataToUpdate.name;

      await this.contractRepository.changeServiceName(
        service.name,
        dataToUpdate.name,
        organizationId
      );
      const updatedContracts = await this.contractRepository.findByFilters({
        filters: { services: [dataToUpdate.name] },
        organizationId: dataToUpdate.organizationId || organizationId,
      });

      await this.cacheService.delMany(
        updatedContracts.map(c => `contracts.${c.userContact.userId}`)
      );
    }

    if (dataToUpdate.organizationId) {
      for (const contract of contractsToRemoveService) {
        delete contract.contractedServices[service.name];
      }
      await this.contractRepository.bulkUpdate(contractsToRemoveService);

      for (const contract of contractsToUpdateOrgId) {
        contract.organizationId = dataToUpdate.organizationId;
      }
      await this.contractRepository.bulkUpdate(contractsToUpdateOrgId);

      await this.cacheService.delMany(
        contractsToRemoveService.map(c => `contracts.${c.userContact.userId}`)
      );
      await this.cacheService.delMany(
        contractsToUpdateOrgId.map(c => `contracts.${c.userContact.userId}`)
      );
    }

    let newCacheKey = `service.${organizationId}.${serviceName}`;

    if (newServiceData.organizationId && newServiceData.organizationId !== organizationId) {
      newCacheKey = `service.${newServiceData.organizationId}.${serviceName}`;
    }

    await this.cacheService.set(newCacheKey, updatedService, 3600, true);

    return updatedService;
  }

  async updatePricingAvailability(
    serviceName: string,
    pricingVersion: string,
    newAvailability: 'active' | 'archived',
    fallBackSubscription: FallBackSubscription,
    organizationId: string
  ) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    const formattedPricingVersion = escapeVersion(pricingVersion);

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    // If newAvailability is the same as the current one, return the service
    if (
      (newAvailability === 'active' && service.activePricings.has(formattedPricingVersion)) ||
      (newAvailability === 'archived' &&
        service.archivedPricings &&
        service.archivedPricings.has(formattedPricingVersion))
    ) {
      return service;
    }

    if (
      newAvailability === 'archived' &&
      service.activePricings.size === 1 &&
      service.activePricings.has(formattedPricingVersion)
    ) {
      throw new Error(`You cannot archive the last active pricing for service ${serviceName}`);
    }

    if (newAvailability === 'archived' && Object.keys(fallBackSubscription).length === 0) {
      throw new Error(
        `Invalid request: Archiving pricing version ${formattedPricingVersion} of service ${serviceName} cannot be completed. To proceed, you must provide a fallback subscription in the request body. All active contracts will be novated to this new version upon archiving.`
      );
    }

    const pricingLocator =
      service.activePricings.get(formattedPricingVersion) ??
      service.archivedPricings.get(formattedPricingVersion);

    if (!pricingLocator) {
      throw new Error(`Pricing version ${pricingVersion} not found for service ${serviceName}`);
    }

    let updatedService;

    if (newAvailability === 'active') {
      updatedService = await this.serviceRepository.update(
        service.name,
        {
          [`activePricings.${formattedPricingVersion}`]: pricingLocator,
          [`archivedPricings.${formattedPricingVersion}`]: undefined,
        },
        organizationId
      );

      // Emitir evento de cambio de pricing (activación)
      this.eventService.emitPricingActivedMessage(service.name, pricingVersion);
      await this.cacheService.set(cacheKey, updatedService, 3600, true);
    } else {
      updatedService = await this.serviceRepository.update(
        service.name,
        {
          [`activePricings.${formattedPricingVersion}`]: undefined,
          [`archivedPricings.${formattedPricingVersion}`]: pricingLocator,
        },
        organizationId
      );

      // Emitir evento de cambio de pricing (archivado)
      this.eventService.emitPricingArchivedMessage(service.name, pricingVersion);
      await this.cacheService.set(cacheKey, updatedService, 3600, true);

      if (
        fallBackSubscription &&
        fallBackSubscription.subscriptionPlan === undefined &&
        fallBackSubscription.subscriptionAddOns === undefined
      ) {
        throw new Error(
          `Invalid request: In order to novate contracts to the latest version, the provided fallback subscription must contain at least a subscriptionPlan (if the pricing has plans), and optionally a subset of add-ons. If the pricing do not have plans, the set of add-ons is mandatory.`
        );
      }

      await this._novateContractsToLatestVersion(
        service.name.toLowerCase(),
        escapeVersion(pricingVersion),
        fallBackSubscription,
        organizationId
      );
    }

    if (updatedService) {
      resetEscapeVersionInService(updatedService);
    }

    return updatedService;
  }

  async prune(organizationId?: string) {
    const linked = await ServiceModel.find({ ...(organizationId ? { organizationId } : {}), source: 'sphere' }).lean();
    for (const service of linked) await this.destroy(service.name, service.organizationId);
    if (organizationId) {
      const organizationServices: LeanService[] = await this.index({}, organizationId);
      const organizationServiceNames: string[] = organizationServices.map(s => s.name) as string[];

      for (const serviceName of organizationServiceNames) {
        const cacheKey = `service.${organizationId}.${serviceName}`;
        await this.cacheService.del(cacheKey);
        const contractNovationResult = await this._removeServiceFromContracts(
          serviceName,
          organizationId
        );

        if (!contractNovationResult) {
          throw new Error(`Failed to remove service ${serviceName} from contracts`);
        }
      }
    }

    const result = await this.serviceRepository.prune(organizationId);
    return result;
  }

  async destroy(serviceName: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    const contractNovationResult = await this._removeServiceFromContracts(
      service.name,
      organizationId
    );

    if (!contractNovationResult) {
      throw new Error(`Failed to remove service ${serviceName} from contracts`);
    }

    const result = await this.serviceRepository.destroy(serviceName, organizationId);
    this.cacheService.del(cacheKey);

    return result;
  }

  async disable(serviceName: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    const contractNovationResult = await this._removeServiceFromContracts(
      service.name,
      organizationId
    );

    if (!contractNovationResult) {
      throw new Error(`Failed to remove service ${serviceName} from contracts`);
    }

    const result = await this.serviceRepository.disable(service.name, organizationId);

    this.eventService.emitServiceDisabledMessage(service.name);
    this.cacheService.del(cacheKey);

    return result;
  }

  async destroyPricing(serviceName: string, pricingVersion: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    const formattedPricingVersion = escapeVersion(pricingVersion);

    if (service.activePricings[formattedPricingVersion]) {
      throw new Error(
        `CONFLICT: You cannot delete an active pricing version ${pricingVersion} for service ${serviceName}. Please archive it first.`
      );
    }

    const pricingLocator = service.archivedPricings?.get(formattedPricingVersion);

    if (!pricingLocator) {
      throw new Error(
        `Invalid request: No archived version ${pricingVersion} found for service ${serviceName}. Remember that a pricing must be archived before it can be deleted.`
      );
    }

    if (pricingLocator.id) {
      await this.pricingRepository.destroy(pricingLocator.id);
      this.cacheService.del(`pricing.id.${pricingLocator.id}`);
      this.cacheService.del(`pricing.url.${pricingLocator.url}`);
    }

    const result = await this.serviceRepository.update(
      service.name,
      {
        [`activePricings.${formattedPricingVersion}`]: undefined,
        [`archivedPricings.${formattedPricingVersion}`]: undefined,
      },
      organizationId
    );
    await this.cacheService.set(`service.${serviceName}`, result, 3600, true);

    return result;
  }

  async _novateContractsToLatestVersion(
    serviceName: string,
    pricingVersion: string,
    fallBackSubscription: FallBackSubscription,
    organizationId: string
  ): Promise<void> {
    const serviceContracts: LeanContract[] = await this.contractRepository.findByFilters({
      filters: {
        services: [serviceName],
      },
      organizationId: organizationId,
    });

    if (Object.keys(fallBackSubscription).length === 0) {
      throw new Error(
        `No fallback subscription provided for service ${serviceName}. Novation to new version cannot be performed to affected contracts`
      );
    }

    const pricingVersionContracts: LeanContract[] = serviceContracts.filter(
      contract => contract.contractedServices[serviceName] === pricingVersion
    );

    if (pricingVersionContracts.length === 0) {
      return;
    }

    const serviceLatestPricing = await this._getLatestActivePricing(serviceName, organizationId);

    if (!serviceLatestPricing) {
      throw new Error(`No active pricing found for service ${serviceName}`);
    }

    const serviceUsageLevels = generateUsageLevels(serviceLatestPricing);

    if (serviceLatestPricing !== null) {
      pricingVersionContracts.forEach(contract => {
        contract.contractedServices[serviceName] = serviceLatestPricing.version;
        contract.subscriptionPlans[serviceName] = fallBackSubscription.subscriptionPlan;
        contract.subscriptionAddOns[serviceName] = fallBackSubscription.subscriptionAddOns ?? {};

        try {
          isSubscriptionValidInPricing(
            serviceName,
            {
              contractedServices: contract.contractedServices,
              subscriptionPlans: contract.subscriptionPlans,
              subscriptionAddOns: contract.subscriptionAddOns,
            },
            serviceLatestPricing
          );
        } catch (err) {
          throw new Error(
            `The configuration provided to novate affected contracts is not valid for version ${serviceLatestPricing.version} of service ${serviceName}. Error: ${err}`
          );
        }

        if (serviceUsageLevels) {
          contract.usageLevels[serviceName] = serviceUsageLevels;
        } else {
          delete contract.usageLevels[serviceName];
        }
      });

      const resultNovations = await this.contractRepository.bulkUpdate(pricingVersionContracts);

      if (!resultNovations) {
        throw new Error(`Failed to novate contracts for service ${serviceName}`);
      }
    }
  }

  async _getLatestActivePricing(
    serviceName: string,
    organizationId: string
  ): Promise<LeanPricing | null> {
    const pricings = await this.indexPricings(serviceName, 'active', organizationId);

    const sortedPricings = pricings.sort((a, b) => {
      // Sort by createdAt date (descending - newest first)
      if (a.createdAt && b.createdAt) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }

      return 0;
    });

    return sortedPricings.length > 0 ? sortedPricings[0] : null;
  }

  async _getPricingFromUrl(url: string) {
    const isLocalUrl = url.startsWith('public/');
    return parsePricingToSpacePricingObject(
      await (isLocalUrl ? this._getPricingFromPath(url) : this._getPricingFromRemoteUrl(url))
    );
  }

  async _getPricingFromPath(path: string) {
    try {
      const pricing = retrievePricingFromPath(path);
      return pricing;
    } catch (err) {
      throw new Error(`Pricing parsing error: ${(err as Error).message}`);
    }
  }

  _normalizePricingPathPart(value: string) {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .toLowerCase();
  }

  _buildPricingYamlRelativePath(organizationId: string, serviceName: string, version: string) {
    const safeOrganizationId = this._normalizePricingPathPart(organizationId);
    const safeServiceName = this._normalizePricingPathPart(serviceName);
    const safeVersion = this._normalizePricingPathPart(version);

    return `/static/pricings/${safeOrganizationId}-${safeServiceName}-${safeVersion}.yaml`;
  }

  _savePricingYamlContent(
    yamlContent: string,
    organizationId: string,
    serviceName: string,
    version: string
  ) {
    const relativePath = this._buildPricingYamlRelativePath(organizationId, serviceName, version);
    const absolutePath = path.resolve('public', `.${relativePath}`);

    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, yamlContent, 'utf8');

    return relativePath;
  }

  _savePricingYamlFile(
    sourcePath: string,
    organizationId: string,
    serviceName: string,
    version: string
  ) {
    const yamlContent = fs.readFileSync(sourcePath, 'utf8');
    return this._savePricingYamlContent(yamlContent, organizationId, serviceName, version);
  }

  async _fetchRemotePricingYaml(url: string) {
    const agent = new https.Agent({ rejectUnauthorized: false });
    const timeoutMs = 5000;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, { agent, signal: controller.signal });
    } catch (err) {
      if ((err as any).name === 'AbortError') {
        throw new Error(`Timeout fetching pricing from URL: ${url}`);
      }
      throw err;
    } finally {
      clearTimeout(id);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch pricing from URL: ${url}, status: ${response.status}`);
    }

    return response.text();
  }

  async _getPricingFromRemoteUrl(url: string) {
    const remotePricingYaml = await this._fetchRemotePricingYaml(url);
    return retrievePricingFromText(remotePricingYaml);
  }

  async _removeServiceFromContracts(serviceName: string, organizationId: string): Promise<boolean> {
    try {
      const contracts: LeanContract[] = await this.contractRepository.findByFilters({
        organizationId,
      });
      const novatedContracts: LeanContract[] = [];
      const contractsToDisable: LeanContract[] = [];

      for (const contract of contracts) {
        // Remove this service from the subscription objects
        const newSubscription: Record<string, any> = {
          contractedServices: {},
          subscriptionPlans: {},
          subscriptionAddOns: {},
        };

        // Rebuild subscription objects without the service to be removed
        for (const key in contract.contractedServices) {
          if (key !== serviceName) {
            newSubscription.contractedServices[key] = contract.contractedServices[key];
          }
        }

        for (const key in contract.subscriptionPlans) {
          if (key !== serviceName) {
            newSubscription.subscriptionPlans[key] = contract.subscriptionPlans[key];
          }
        }

        for (const key in contract.subscriptionAddOns) {
          if (key !== serviceName) {
            newSubscription.subscriptionAddOns[key] = contract.subscriptionAddOns[key];
          }
        }

        // Check if objects have the same content by comparing their JSON string representation
        const hasContractChanged =
          JSON.stringify(contract.contractedServices) !==
          JSON.stringify(newSubscription.contractedServices);

        // If objects are equal, skip this contract
        if (!hasContractChanged) {
          continue;
        }

        const newContract = performNovation(contract, newSubscription);

        if (contract.usageLevels[serviceName]) {
          delete contract.usageLevels[serviceName];
        }

        if (Object.keys(newSubscription.contractedServices).length === 0) {
          newContract.usageLevels = {};
          newContract.billingPeriod = {
            startDate: new Date(),
            endDate: new Date(),
            autoRenew: false,
            renewalDays: 0,
          };

          contractsToDisable.push(newContract);
          continue;
        }

        novatedContracts.push(newContract);
      }

      return true;
    } catch (err) {
      return false;
    }
  }
}

export default ServiceService;
