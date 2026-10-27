import { withOrganizationLock } from './sphere/lock';
import ServiceModel from '../repositories/mongoose/models/ServiceMongoose';
import PricingModel from '../repositories/mongoose/models/PricingMongoose';
import { createHash } from 'node:crypto';
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
import ContractRepository, { SERVICE_MAPS } from '../repositories/mongoose/ContractRepository';
import { isSubscriptionValidInPricing } from '../controllers/validation/ContractValidation';
import { generateUsageLevels } from '../utils/contracts/helpers';
import { escapeVersion, resetEscapeVersion } from '../utils/helpers';
import { resetEscapeVersionInService } from '../utils/services/helpers';
import CacheService from './CacheService';
import OrganizationRepository from '../repositories/mongoose/OrganizationRepository';
import yaml from 'js-yaml';
import { SphereVersionNotListedError } from './sphere/errors';
import { isPrivateSnapshotPath, storedYamlFile } from './sphere/snapshots';
import { contractCacheKeys } from '../utils/contracts/cacheKeys';

/** A pricing version exists, but its Pricing2Yaml file cannot be provided. */
export class PricingYamlUnavailableError extends Error {
  constructor(serviceName: string, pricingVersion: string) {
    super(`PRICING_YAML_UNAVAILABLE: The Pricing2Yaml file of version ${pricingVersion} of service ${serviceName} is not available`);
    this.name = 'PricingYamlUnavailableError';
  }
}

/**
 * SPHERE could not provide a version it should have (unreachable, failing, or
 * content that does not match its manifest): a gateway failure, not a missing file.
 */
export class PricingYamlUpstreamError extends Error {
  constructor(serviceName: string, pricingVersion: string, cause: unknown) {
    super(`SPHERE_UNAVAILABLE: The Pricing2Yaml file of version ${pricingVersion} of service ${serviceName} could not be retrieved from SPHERE (${(cause as Error)?.message ?? cause})`);
    this.name = 'PricingYamlUpstreamError';
  }
}

/** Why a service of a contract is dormant (see `ServiceService.dormantServices`). */
export type DormantReason = 'SERVICE_DISABLED' | 'SERVICE_NOT_FOUND';

/**
 * The request needs a service of the contract that is dormant: disabled (it
 * comes back when a pricing with its saasName is uploaded again) or no longer
 * in the organization. Answered with 409 and `code`.
 */
export class DormantServiceError extends Error {
  constructor(
    public readonly service: string,
    public readonly code: DormantReason
  ) {
    super(dormantServiceMessage(service, code));
    this.name = 'DormantServiceError';
  }
}

export function dormantServiceMessage(service: string, code: DormantReason): string {
  return code === 'SERVICE_DISABLED'
    ? `Service ${service} is disabled in this organization: its features are not available and its usage levels cannot change until it is enabled again (upload a pricing with saasName ${service})`
    : `Service ${service} no longer exists in this organization: its features are not available`;
}

/**
 * The pricings of a disabled service that is enabled again with `version`:
 * every version it had stays archived (contracts keep pointing to them), and
 * an entry that has the key of `version` is renamed to make room for it, or,
 * with `reactivated`, left out (that archived version becomes the active one).
 */
function pricingsOnReenable(service: LeanService, version: string, reactivated = false): Record<string, any> {
  const plain = (value: any): Record<string, any> =>
    value instanceof Map ? Object.fromEntries(value) : { ...(value ?? {}) };
  const archived = plain(service.archivedPricings);
  const stamp = Date.now();
  const freeKey = (key: string) => {
    let candidate = `${key}_${stamp}`;
    for (let i = 1; candidate in archived; i++) candidate = `${key}_${stamp}_${i}`;
    return candidate;
  };

  if (archived[version]) {
    if (!reactivated) archived[freeKey(version)] = archived[version];
    delete archived[version];
  }
  for (const [key, locator] of Object.entries(plain(service.activePricings))) {
    archived[key === version || key in archived ? freeKey(key) : key] = locator;
  }
  return archived;
}

/**
 * `syntaxVersion` of a Pricing2Yaml document as written, without trusting the
 * rest of it. Parsed with the failsafe schema, so every scalar stays the string
 * of the file: an unquoted `3.0` is `3.0`, not the number 3.
 */
function readSyntaxVersion(body: Buffer): string | undefined {
  try {
    const document = yaml.load(body.toString('utf8'), { schema: yaml.FAILSAFE_SCHEMA }) as
      | { syntaxVersion?: unknown }
      | undefined;
    const value = document?.syntaxVersion;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Order pricing versions newest first: by `createdAt` (descending; versions
 * without a valid date last), then by version, descending and numeric-aware
 * (`10.0` before `2.0`), so that equal dates give the same answer every time.
 */
function compareNewestFirst(
  a: { version: string; createdAt?: Date | string | null },
  b: { version: string; createdAt?: Date | string | null }
): number {
  const timeA = a.createdAt ? new Date(a.createdAt).getTime() : NaN;
  const timeB = b.createdAt ? new Date(b.createdAt).getTime() : NaN;
  const datedA = Number.isFinite(timeA);
  const datedB = Number.isFinite(timeB);
  if (datedA && datedB && timeA !== timeB) return timeB - timeA;
  if (datedA !== datedB) return datedA ? -1 : 1;
  return resetEscapeVersion(String(b.version)).localeCompare(resetEscapeVersion(String(a.version)), undefined, { numeric: true });
}

/** What a stored pricing is made of (not where it is stored or whose it is). */
const PRICING_CONTENT_FIELDS = ['version', 'currency', 'createdAt', 'features', 'usageLimits', 'plans', 'addOns'] as const;

/**
 * Hash of the content of a pricing as SPACE stores and serves it: the fields
 * of `PRICING_CONTENT_FIELDS`, normalized by the pricing schema (so an upload
 * and a stored document get the same defaults and casts), with keys sorted and
 * document ids left out. Two uploads of the same pricing written differently
 * (layout, comments, key order) have the same hash.
 */
export function pricingContentHash(pricing: any): string {
  const picked = Object.fromEntries(PRICING_CONTENT_FIELDS.map(field => [field, pricing?.[field]]));
  const normalized: any = new PricingModel(picked).toJSON({ flattenMaps: true });
  const canonical = (value: any): any => {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .filter(key => key !== '_id' && key !== 'id' && value[key] !== undefined)
          .sort()
          .map(key => [key, canonical(value[key])])
      );
    }
    return value;
  };
  const material = canonical(Object.fromEntries(PRICING_CONTENT_FIELDS.map(field => [field, normalized[field]])));
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

/** A Map or plain object of a lean document, as a plain object. */
const plainMap = (value: any): Record<string, any> =>
  value instanceof Map ? Object.fromEntries(value) : value ?? {};

/** Ids of the stored pricings of a service (active and archived). */
function pricingIdsOf(service: LeanService): string[] {
  return [service.activePricings, service.archivedPricings]
    .flatMap(locators => Object.values(plainMap(locators)))
    .map((locator: any) => locator?.id)
    .filter(Boolean)
    .map(String);
}

/**
 * Whether a contract moves with a service that goes to another organization:
 * it has that service and no other one. Contracts with other services keep
 * them and lose this one.
 */
function movesWithService(contractedServices: string[], serviceKey: string): boolean {
  return contractedServices.length > 0 && contractedServices.every(key => key.toLowerCase() === serviceKey);
}

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
          if (method === 'update' && args[1] && 'defaultVersion' in args[1]) {
            throw new Error('INVALID DATA: the version for new contracts of a SPHERE-linked service is decided by its synchronization policy');
          }
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

  /**
   * The pricing version SPACE assigns to new contracts of a service:
   * - SPHERE-linked services: the target of the synchronization policy;
   * - manual services: `defaultVersion` when it is set (and still active);
   * - otherwise the most recently created active version (`createdAt`).
   * Versions are returned unescaped.
   */
  async newContractsPricing(
    serviceName: string,
    organizationId: string
  ): Promise<{ version: string; source: 'sphere-policy' | 'default' | 'latest-active'; serviceName: string }> {
    const service: LeanService | null = await this.serviceRepository.findByName(serviceName, organizationId);

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    if (service.source === 'sphere' && service.sphere?.target?.version) {
      return { version: service.sphere.target.version, source: 'sphere-policy', serviceName: service.name };
    }

    if (service.defaultVersion && service.activePricings?.has(escapeVersion(service.defaultVersion))) {
      return { version: resetEscapeVersion(escapeVersion(service.defaultVersion)), source: 'default', serviceName: service.name };
    }

    const latest = await this._latestActiveVersion(service);

    if (!latest) {
      throw new Error(`NOT FOUND: No active pricing version for service ${serviceName}`);
    }

    return { version: latest, source: 'latest-active', serviceName: service.name };
  }

  /**
   * The most recently created active version of a service (unescaped), without
   * loading the pricings: only `createdAt` of the locally stored ones is read.
   * Versions without a known creation date (remote URL pricings, legacy
   * documents) come after dated ones; ties are broken by version, descending
   * (see `compareNewestFirst`), so the answer is deterministic.
   */
  async _latestActiveVersion(service: LeanService): Promise<string | null> {
    const entries: [string, any][] = service.activePricings instanceof Map
      ? Array.from(service.activePricings.entries())
      : Object.entries(service.activePricings ?? {});
    if (entries.length === 0) return null;

    const ids = entries.map(([, entry]) => entry?.id).filter(Boolean).map(String);
    const createdAt = await this.pricingRepository.findCreatedAtByIds(ids);
    const candidates = entries.map(([version, entry]) => ({
      version: resetEscapeVersion(version),
      createdAt: entry?.id ? createdAt.get(String(entry.id)) : undefined,
    }));

    return candidates.sort(compareNewestFirst)[0].version;
  }

  /**
   * Where a pricing version of a service stands, without loading the pricing:
   * `active`, `archived`, `missing` (not a version of the service) or
   * `no-service` (no enabled service with that name in the organization).
   */
  async pricingVersionStatus(
    serviceName: string,
    pricingVersion: string,
    organizationId: string
  ): Promise<'active' | 'archived' | 'missing' | 'no-service'> {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      return 'no-service';
    }

    const formattedPricingVersion = escapeVersion(pricingVersion);
    if (service.activePricings?.get(formattedPricingVersion)) return 'active';
    if (service.archivedPricings?.get(formattedPricingVersion)) return 'archived';
    return 'missing';
  }

  /**
   * The stored Pricing2Yaml file of a pricing version, byte for byte.
   *
   * Uploaded versions and retained SPHERE snapshots are read from their
   * `yamlPath`. Historical SPHERE versions, of which SPACE keeps no copy, are
   * fetched from SPHERE and checked against the content hash of its manifest.
   * Versions that exist but whose file is not available raise
   * `PricingYamlUnavailableError`; unknown versions raise a `NOT FOUND` error.
   */
  async showPricingYaml(
    serviceName: string,
    pricingVersion: string,
    organizationId: string
  ): Promise<{ body: Buffer; syntaxVersion?: string }> {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    const formattedPricingVersion = escapeVersion(pricingVersion);
    const pricingLocator =
      service.activePricings?.get(formattedPricingVersion) ??
      service.archivedPricings?.get(formattedPricingVersion);

    let body: Buffer | undefined;

    if (pricingLocator?.id) {
      const pricing = await this.showPricing(serviceName, pricingVersion, organizationId);
      body = pricing?.yamlPath ? this._readStoredPricingYaml(pricing.yamlPath) : undefined;
    } else if (pricingLocator?.url) {
      body = pricingLocator.url.startsWith('public/')
        ? this._readStoredPricingYaml(pricingLocator.url.slice('public'.length))
        : undefined;
    } else if (service.source === 'sphere') {
      try {
        const text: string = await container
          .resolve('sphereSyncService')
          .historicalPricingYaml(organizationId, service.name, pricingVersion);
        body = Buffer.from(text, 'utf8');
      } catch (error) {
        // Not listed by SPHERE: unavailable (404). Anything else is SPHERE failing (502).
        if (!(error instanceof SphereVersionNotListedError)) {
          throw new PricingYamlUpstreamError(serviceName, pricingVersion, error);
        }
      }
    } else {
      throw new Error(`NOT FOUND: Pricing version ${pricingVersion} not found for service ${serviceName}`);
    }

    if (!body) {
      throw new PricingYamlUnavailableError(serviceName, pricingVersion);
    }

    return { body, syntaxVersion: readSyntaxVersion(body) };
  }

  /**
   * Read a stored Pricing2Yaml file by its `yamlPath`, or undefined: files under
   * `public/static/pricings`, and private SPHERE snapshots, which are stored
   * outside `public/` (see sphere/snapshots.ts).
   */
  _readStoredPricingYaml(publicPath: string): Buffer | undefined {
    const file = storedYamlFile(publicPath);
    if (!file) {
      return undefined;
    }
    try {
      return fs.readFileSync(file);
    } catch {
      return undefined;
    }
  }

  async showPublicPricingUrl(serviceName: string, pricingVersion: string, organizationId: string) {
    const pricing = await this.showPricing(serviceName, pricingVersion, organizationId);

    if (isPrivateSnapshotPath(pricing?.yamlPath)) {
      throw new Error(
        `NOT FOUND: Pricing version ${pricingVersion} of service ${serviceName} is private and has no public URL; read it with GET .../pricings/${pricingVersion}?format=yaml`
      );
    }

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

      if (service.activePricings && service.activePricings.get(formattedPricingVersion)) {
        throw new Error(
          `Pricing version ${uploadedPricing.version} already exists for service ${serviceName}`
        );
      }
    }

    // Not written yet: the file is only stored with a new pricing, never over
    // the file of a version the service already has.
    const pricingYamlPath = this._buildPricingYamlRelativePath(
      organizationId,
      uploadedPricing.saasName,
      uploadedPricing.version
    );
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
    // - If the version is archived (by the service, or by the disabled service),
    //   that version is active again when the content is the same, and the
    //   upload is refused otherwise (see `_reactivateArchivedVersion`).
    let existingDisabled: LeanService | null = null;
    if (!service) {
      // Check if an enabled service exists
      const existingEnabled = await this.serviceRepository.findByName(
        uploadedPricing.saasName,
        organizationId,
        false
      );
      existingDisabled = await this.serviceRepository.findByName(
        uploadedPricing.saasName,
        organizationId,
        true
      );

      if (existingEnabled) {
        throw new Error(`Invalid request: Service ${uploadedPricing.saasName} already exists`);
      }
    }

    const reactivated = await this._reactivateArchivedVersion(
      service ?? existingDisabled,
      formattedPricingVersion,
      pricingData,
      organizationId
    );

    if (reactivated) {
      service = reactivated;
    } else if (!service) {
      // Step 3: Create the service as it does not exist and add the pricing
      this._savePricingYamlFile(pricingFile.path, organizationId, uploadedPricing.saasName, uploadedPricing.version);
      const savedPricing = await this._createPricing(pricingData);

      if (existingDisabled) {
        // Versions of the disabled service stay archived: contracts may still use them.
        const newArchived = pricingsOnReenable(existingDisabled, formattedPricingVersion);

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
      // service exists (serviceName provided) and does not have this version:
      // add it to its active pricings.
      this._savePricingYamlFile(pricingFile.path, organizationId, uploadedPricing.saasName, uploadedPricing.version);
      const savedPricing = await this._createPricing(pricingData);

      const updatedService = await this.serviceRepository.update(
        service.name,
        { [`activePricings.${formattedPricingVersion}`]: { id: savedPricing.id } },
        organizationId
      );

      service = updatedService;
    }

    if (!service) {
      throw new Error(`Service ${uploadedPricing.saasName} not saved`);
    }

    // Emit pricing creation event (activation: emitted by _reactivateArchivedVersion)
    if (!reactivated) this.eventService.emitPricingCreatedMessage(service.name, uploadedPricing.version);

    // Step 4: If everything was ok, remove the uploaded file

    const directory = path.dirname(pricingFile.path);
    if (fs.readdirSync(directory).length === 1) {
      fs.rmdirSync(directory, { recursive: true });
    } else {
      fs.rmSync(pricingFile.path);
    }

    resetEscapeVersionInService(service);

    // Step 5: Return the saved service
    return service;
  }

  /**
   * Store a new pricing.
   *
   * @throws `CONFLICT:` when a stored pricing already has this service, version
   *         and organization (unique index) without the service listing it,
   *         instead of a duplicate key error.
   */
  async _createPricing(pricingData: any): Promise<LeanPricing> {
    let savedPricing: LeanPricing | null;
    try {
      savedPricing = await this.pricingRepository.create(pricingData);
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new Error(
          `CONFLICT: A stored pricing already has version ${resetEscapeVersion(pricingData.version)} of service ${pricingData._serviceName} in this organization, but the service does not list it`
        );
      }
      throw error;
    }
    if (!savedPricing) {
      throw new Error(`Pricing ${pricingData.version} not saved`);
    }
    return savedPricing;
  }

  /**
   * An upload of a version that `service` (enabled, or disabled and being
   * enabled again) has archived. Versions are immutable once contracts may
   * use them, so the archived version is never replaced:
   * - same content (`pricingContentHash`, compared with the stored version):
   *   the archived version is active again, the same pricing document (or
   *   URL) as before, so contracts on it work as they did. A disabled service
   *   is enabled with it as its only active version; its other versions stay
   *   archived. PRICING_ACTIVED is announced.
   * - other content, or stored content that cannot be read: `CONFLICT:`.
   *
   * @returns the updated service, or null when the version is not archived.
   */
  async _reactivateArchivedVersion(
    service: LeanService | null,
    version: string,
    uploaded: any,
    organizationId: string
  ): Promise<LeanService | null> {
    const locator: any = service ? plainMap(service.archivedPricings)[version] : undefined;
    if (!service || !locator) return null;

    const shown = resetEscapeVersion(version);
    let stored: any = null;
    try {
      stored = locator.id
        ? await this.pricingRepository.findById(String(locator.id))
        : locator.url
          ? await this._getPricingFromUrl(locator.url)
          : null;
    } catch {
      stored = null;
    }
    if (!stored) {
      throw new Error(
        `CONFLICT: Version ${shown} of service ${service.name} is archived and its stored content cannot be read to compare it with this upload; upload it as another version`
      );
    }
    if (pricingContentHash(stored) !== pricingContentHash(uploaded)) {
      throw new Error(
        `CONFLICT: Version ${shown} of service ${service.name} is archived with other content; a version cannot change once contracts may use it. Upload it as another version, or activate the archived one (PUT .../pricings/${shown}?availability=active)`
      );
    }

    const update: any = service.disabled
      ? {
          disabled: false,
          activePricings: new Map([[version, locator]]),
          archivedPricings: pricingsOnReenable(service, version, true),
        }
      : {
          [`activePricings.${version}`]: locator,
          [`archivedPricings.${version}`]: undefined,
        };
    const updated = await this.serviceRepository.update(service.name, update, organizationId);
    if (!updated) {
      throw new Error(`NOT FOUND: Service with name ${service.name}`);
    }

    await this.cacheService.del(`service.${organizationId}.${service.name}`);
    this.eventService.emitPricingActivedMessage(service.name, shown);
    return updated;
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
        const reactivated = await this._reactivateArchivedVersion(
          existingDisabled,
          formattedPricingVersion,
          parsePricingToSpacePricingObject(uploadedPricing),
          organizationId
        );
        if (reactivated) return reactivated;

        // Versions of the disabled service stay archived: contracts may still use them.
        const newArchived = pricingsOnReenable(existingDisabled, formattedPricingVersion);

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

      // Archived: active again with the same content, refused otherwise.
      const reactivated = await this._reactivateArchivedVersion(
        service,
        formattedPricingVersion,
        parsePricingToSpacePricingObject(uploadedPricing),
        organizationId
      );
      if (reactivated) {
        resetEscapeVersionInService(reactivated);
        return reactivated;
      }

      const updatedService = await this.serviceRepository.update(
        service.name,
        { [`activePricings.${formattedPricingVersion}`]: { url: pricingUrl } },
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

  /**
   * Update a service: `defaultVersion`, its name and/or its organization.
   *
   * Renaming renames it in every contract of the organization (the keys of
   * `contractedServices`, `subscriptionPlans`, `subscriptionAddOns` and
   * `usageLevels`, compared case-insensitively). Moving it to another
   * organization moves the contracts that only have this service, and removes
   * it from the contracts that have other services too (they stay; the
   * previous subscription goes to their history). Its pricings follow it.
   *
   * Everything that can refuse the request is checked before anything is
   * written (`409`): the name is free in the organization the service ends up
   * in (disabled services included), no contract would end up with two
   * subscriptions under the same name, and no contract would move into an
   * organization that already has its userId. Contracts are written one by
   * one, each conditional on the version that was read (retried when it
   * changed meanwhile), with contract events and cache invalidation; the
   * service itself is written last, so a failure can be repeated. Contracts
   * created with the old name while the request runs are handled after the
   * service is written.
   */
  async update(serviceName: string, newServiceData: any, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    const dataToUpdate: any = {};

    // From the database: the name and organization are about to change.
    const service: LeanService | null = await this.serviceRepository.findByName(serviceName, organizationId);

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    if (newServiceData.name && newServiceData.name !== service.name) {
      dataToUpdate.name = newServiceData.name;
    }

    if (newServiceData.defaultVersion === null) {
      dataToUpdate.defaultVersion = undefined; // removes it
    } else if (newServiceData.defaultVersion !== undefined) {
      const escaped = escapeVersion(String(newServiceData.defaultVersion));
      const active = service.activePricings instanceof Map
        ? service.activePricings.has(escaped)
        : Object.prototype.hasOwnProperty.call(service.activePricings ?? {}, escaped);
      if (!active) {
        throw new Error(
          `INVALID DATA: defaultVersion ${newServiceData.defaultVersion} is not an active pricing version of service ${service.name}`
        );
      }
      dataToUpdate.defaultVersion = resetEscapeVersion(escaped);
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
      dataToUpdate.organizationId = newServiceData.organizationId;
    }

    const finalName: string = dataToUpdate.name ?? service.name;
    const finalOrganizationId: string = dataToUpdate.organizationId ?? organizationId;
    // Contract keys are lowercased: a change of case only is not a rename for them.
    const change = {
      ...(finalName.toLowerCase() !== service.name.toLowerCase() ? { name: finalName } : {}),
      ...(dataToUpdate.organizationId ? { organizationId: dataToUpdate.organizationId as string } : {}),
    };
    const relocated = Boolean(dataToUpdate.name || dataToUpdate.organizationId);

    if (relocated) {
      await this._assertServiceNameFree(finalName, finalOrganizationId, service);
    }

    if (change.name || change.organizationId) {
      // Checks every contract (409) before anything is written.
      const plan = await this._planServiceInContracts(service.name, organizationId, change);
      await this.pricingRepository.reassignToService(pricingIdsOf(service), finalName, finalOrganizationId);
      await this._renameOrMoveServiceInContracts(plan);
    } else if (relocated) {
      await this.pricingRepository.reassignToService(pricingIdsOf(service), finalName, finalOrganizationId);
    }

    const updatedService = await this.serviceRepository.update(
      service.name,
      dataToUpdate,
      organizationId
    );

    if (!updatedService) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    if (relocated) {
      await this.cacheService.delMany([cacheKey, `service.${organizationId}.${service.name}`]);
    }

    if (change.name || change.organizationId) {
      // Contracts created with the old name while the contracts were written.
      await this._renameOrMoveServiceInContracts(
        await this._planServiceInContracts(service.name, organizationId, change)
      );
    }

    await this.cacheService.set(`service.${finalOrganizationId}.${finalName}`, updatedService, 3600, true);

    return updatedService;
  }

  /**
   * @throws `CONFLICT:` when the organization has another service (enabled or
   *         disabled) with this name, compared case-insensitively.
   */
  async _assertServiceNameFree(name: string, organizationId: string, service: LeanService) {
    for (const disabled of [false, true]) {
      const existing = await this.serviceRepository.findByName(name, organizationId, disabled);
      if (existing && existing.id !== service.id) {
        throw new Error(
          disabled
            ? `CONFLICT: Service name ${existing.name} is taken by a disabled service of organization ${organizationId}; delete that service first`
            : `CONFLICT: Service name ${existing.name} already exists in organization ${organizationId}`
        );
      }
    }
  }

  /**
   * What renaming a service and/or moving it to another organization does to
   * the contracts of `organizationId` that name it (all of them), checked
   * before anything is written.
   *
   * @throws `CONFLICT:` when a contract would end up with two subscriptions
   *         under the new name, or when a contract that would move has a userId
   *         the target organization already uses.
   */
  async _planServiceInContracts(
    serviceName: string,
    organizationId: string,
    change: { name?: string; organizationId?: string }
  ): Promise<{ serviceName: string; organizationId: string; change: typeof change; userIds: string[] }> {
    const rows = await this.contractRepository.findServiceKeysOfContracts(organizationId, serviceName);
    const from = serviceName.toLowerCase();
    const isService = (key: string) => key.toLowerCase() === from;

    if (change.name) {
      const to = change.name.toLowerCase();
      const clashes = rows
        .filter(row =>
          SERVICE_MAPS.some(
            field => row.keys[field].filter(isService).length > 1 || row.keys[field].some(key => key.toLowerCase() === to)
          )
        )
        .map(row => row.userId);
      if (clashes.length > 0) {
        throw new Error(
          `CONFLICT: Contracts of userIds ${clashes.join(', ')} already have a service named ${change.name} ` +
            `(or name service ${serviceName} more than once); renaming would merge two subscriptions`
        );
      }
    }

    if (change.organizationId) {
      // userIds are unique per organization (see ContractRepository).
      const moving = rows.filter(row => movesWithService(row.keys.contractedServices, from)).map(row => row.userId);
      const taken = await this.contractRepository.findExistingUserIds(change.organizationId, moving);
      if (taken.length > 0) {
        throw new Error(
          `CONFLICT: Organization ${change.organizationId} already has contracts for userIds ${taken.join(', ')}; ` +
            `moving service ${serviceName} would move contracts with the same userIds into it`
        );
      }
    }

    return { serviceName, organizationId, change, userIds: rows.map(row => row.userId) };
  }

  /**
   * Apply a plan of `_planServiceInContracts`, contract by contract:
   * - renamed in place (no move): CONTRACT_NOVATED (`contractVersion` changes
   *   with the name);
   * - moved (the contract only has this service): CONTRACT_DELETED in the
   *   organization it leaves and CONTRACT_CREATED in the one it joins, whose
   *   consumers did not know it;
   * - service removed (the contract has other services, and stays):
   *   CONTRACT_NOVATED.
   * Each write is conditional on the version that was read; a contract that
   * changed meanwhile is read again and retried. The cached contract,
   * evaluations and pricing token are dropped in every organization concerned.
   *
   * @returns how many contracts were changed.
   */
  async _renameOrMoveServiceInContracts(plan: {
    serviceName: string;
    organizationId: string;
    change: { name?: string; organizationId?: string };
    userIds: string[];
  }): Promise<number> {
    const { serviceName, organizationId, change } = plan;
    const from = serviceName.toLowerCase();
    const attempts = 5;
    let changed = 0;

    for (const userId of plan.userIds) {
      let done = false;
      for (let attempt = 0; attempt < attempts && !done; attempt++) {
        const contract = await this.contractRepository.findByUserId(userId, organizationId);
        if (!contract) {
          done = true; // Deleted meanwhile.
          break;
        }
        const names = SERVICE_MAPS.flatMap(field => Object.keys(plainMap(contract[field])));
        if (!names.some(name => name.toLowerCase() === from)) {
          done = true; // Nothing of the service left in it.
          break;
        }

        const moves = Boolean(change.organizationId) && movesWithService(Object.keys(plainMap(contract.contractedServices)), from);
        const written =
          change.organizationId && !moves
            ? await this.contractRepository.removeServicesFromContract(contract, [serviceName])
            : await this.contractRepository.renameOrMoveServiceInContract(contract, serviceName, change);
        if (!written) continue; // Changed after it was read: read it again.
        done = true;
        changed++;

        await this.cacheService.delMany(contractCacheKeys(contract));
        if (moves) {
          await this.cacheService.delMany(contractCacheKeys(written));
          this.eventService.emitContractEvent?.('CONTRACT_DELETED', contract, { deleted: true });
          this.eventService.emitContractEvent?.('CONTRACT_CREATED', written);
        } else {
          this.eventService.emitContractEvent?.('CONTRACT_NOVATED', written);
        }
      }
      if (!done) {
        throw new Error(
          `CONFLICT: The contract of user ${userId} kept changing while service ${serviceName} was renamed or moved in it; retry`
        );
      }
    }

    return changed;
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
          // An archived version cannot be the version for new contracts.
          ...(service.defaultVersion && escapeVersion(service.defaultVersion) === formattedPricingVersion
            ? { defaultVersion: undefined }
            : {}),
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

  /**
   * Delete every service of the organization (of every organization when none
   * is given), irreversibly: SPHERE-linked services through their own removal,
   * the others after they have been removed from every contract of their
   * organization (see `_removeServicesFromContracts`). Disabled services are
   * deleted too, and removed from the contracts that still hold them. The
   * contracts are updated first, so a failure leaves the services in place and
   * the prune can be retried.
   */
  async prune(organizationId?: string) {
    const linked = await ServiceModel.find({ ...(organizationId ? { organizationId } : {}), source: 'sphere' }).lean();
    for (const service of linked) await this.destroy(service.name, service.organizationId);

    // Every remaining service, enabled or disabled, of every page.
    const remaining: { name: string; organizationId: string }[] = await ServiceModel.find(
      organizationId ? { organizationId } : {},
      { name: 1, organizationId: 1 }
    ).lean() as any;
    const byOrganization = new Map<string, string[]>();
    for (const { name, organizationId: org } of remaining) {
      byOrganization.set(String(org), [...(byOrganization.get(String(org)) ?? []), name]);
    }

    for (const [org, names] of byOrganization) {
      await this._removeServicesFromContracts(names, org);
      await this.cacheService.delMany(names.map(name => `service.${org}.${name}`));
    }

    const result = await this.serviceRepository.prune(organizationId);
    return result;
  }

  /** Delete a service irreversibly, after removing it from every contract of the organization. */
  async destroy(serviceName: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      // A disabled service can be deleted too.
      service = await this.serviceRepository.findByName(serviceName, organizationId, true);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    await this._removeServicesFromContracts([service.name], organizationId);

    const result = await this.serviceRepository.destroy(service.name, organizationId);
    await this.cacheService.del(cacheKey);

    return result;
  }

  /**
   * Disable a service (reversible: uploading a pricing with its saasName
   * enables it again). Its pricings are archived and SERVICE_DISABLED is
   * announced. Contracts are not changed: the service is dormant in them (see
   * `dormantServices`), so its features evaluate as not available while the
   * rest of each contract keeps working, and the subscription and usage levels
   * are there again when the service is enabled. Removing it from contracts
   * would make disabling irreversible; deleting a service (`destroy`, `prune`)
   * does that.
   */
  async disable(serviceName: string, organizationId: string) {
    const cacheKey = `service.${organizationId}.${serviceName}`;
    let service = await this.cacheService.get(cacheKey);

    if (!service) {
      service = await this.serviceRepository.findByName(serviceName, organizationId);
    }

    if (!service) {
      throw new Error(`NOT FOUND: Service with name ${serviceName}`);
    }

    const result = await this.serviceRepository.disable(service.name, organizationId);

    this.eventService.emitServiceDisabledMessage(service.name);
    await this.cacheService.del(cacheKey);
    await this.cacheService.del(`service.${organizationId}.${service.name}`);
    // Cached evaluations and pricing tokens of the organization still include
    // the features of the service. (Tokens already handed out stay valid until
    // they expire: a signed token cannot be withdrawn.)
    await this.cacheService.del(`features.${organizationId}.*`);

    return result;
  }

  /**
   * Which of these services of a contract are dormant in the organization:
   * `SERVICE_DISABLED` for a disabled service, `SERVICE_NOT_FOUND` for a
   * service the organization no longer has (contracts written before deletions
   * removed services from them). Names are compared case-insensitively and
   * returned lowercased; enabled services are not listed.
   */
  async dormantServices(serviceNames: string[], organizationId: string): Promise<Record<string, DormantReason>> {
    const names = Array.from(new Set(serviceNames.map(name => name.toLowerCase())));
    if (names.length === 0) return {};

    const enabled = new Set(
      ((await this.serviceRepository.findByNames(names, organizationId, false)) ?? []).map(service =>
        service.name.toLowerCase()
      )
    );
    const missing = names.filter(name => !enabled.has(name));
    if (missing.length === 0) return {};

    const disabled = new Set(
      ((await this.serviceRepository.findByNames(missing, organizationId, true)) ?? []).map(service =>
        service.name.toLowerCase()
      )
    );
    return Object.fromEntries(
      missing.map(name => [name, disabled.has(name) ? 'SERVICE_DISABLED' : 'SERVICE_NOT_FOUND'] as const)
    );
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

      // The cached copies still have the archived version.
      await this.cacheService.delMany(pricingVersionContracts.flatMap(contract => contractCacheKeys(contract)));
      for (const contract of pricingVersionContracts) {
        this.eventService.emitContractEvent?.('CONTRACT_NOVATED', contract);
      }
    }
  }

  async _getLatestActivePricing(
    serviceName: string,
    organizationId: string
  ): Promise<LeanPricing | null> {
    const pricings = await this.indexPricings(serviceName, 'active', organizationId);

    // Newest first, with a deterministic tie-breaker (see compareNewestFirst).
    const sortedPricings = pricings.sort(compareNewestFirst);

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

  /**
   * Remove services that are being deleted from every contract of the
   * organization (all of them, not a page), case-insensitively: their entries
   * in `contractedServices`, `subscriptionPlans`, `subscriptionAddOns` and
   * `usageLevels`. The previous subscription goes to the contract history; a
   * contract left without services is kept, ends now and no longer renews (see
   * `ContractRepository.removeServicesFromContract`).
   *
   * Each write is conditional on the version of the contract that was read, so
   * a novation that lands in between is never overwritten: the contract is
   * read again and the removal retried. Every changed contract gets its cached
   * copy, evaluations and pricing token dropped and a CONTRACT_NOVATED event.
   *
   * @returns how many contracts were changed.
   * @throws on any failure (nothing is reported as done that was not).
   */
  async _removeServicesFromContracts(serviceNames: string[], organizationId: string): Promise<number> {
    const userIds = await this.contractRepository.findUserIdsReferencingServices(organizationId, serviceNames);
    const names = new Set(serviceNames.map(name => name.toLowerCase()));
    const attempts = 5;
    let changed = 0;

    for (const userId of userIds) {
      let done = false;
      for (let attempt = 0; attempt < attempts && !done; attempt++) {
        const contract = await this.contractRepository.findByUserId(userId, organizationId);
        if (!contract) {
          done = true; // Deleted meanwhile.
          break;
        }
        const written = await this.contractRepository.removeServicesFromContract(contract, Array.from(names));
        if (!written) continue; // Changed after it was read: read it again.
        done = true;
        if (written === contract) break; // Nothing of these services left in it.

        changed++;
        await this.cacheService.delMany(contractCacheKeys(written));
        this.eventService.emitContractEvent?.('CONTRACT_NOVATED', written);
      }
      if (!done) {
        throw new Error(
          `CONFLICT: The contract of user ${userId} kept changing while services ${Array.from(names).join(', ')} were removed from it; retry`
        );
      }
    }

    return changed;
  }
}

export default ServiceService;
