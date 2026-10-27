import container from '../config/container.js';
import { createHash } from 'node:crypto';
import ServiceService, { PricingYamlUnavailableError, PricingYamlUpstreamError } from '../services/ServiceService.js';
import { ServiceQueryFilters } from '../repositories/mongoose/ServiceRepository.js';
import { removeOptionalFieldsOfQueryParams } from '../utils/controllerUtils.js';
import { FallBackSubscription } from '../types/models/Contract.js';
import { pricingYamlUrl, resetEscapePricingVersion } from '../utils/services/helpers.js';

class ServiceController {
  private readonly serviceService: ServiceService;

  constructor() {
    this.serviceService = container.resolve('serviceService');
    this.index = this.index.bind(this);
    this.indexPricings = this.indexPricings.bind(this);
    this.show = this.show.bind(this);
    this.showPricing = this.showPricing.bind(this);
    this.showNewContractsPricing = this.showNewContractsPricing.bind(this);
    this.showPublicPricingUrl = this.showPublicPricingUrl.bind(this);
    this.create = this.create.bind(this);
    this.update = this.update.bind(this);
    this.updatePricingAvailability = this.updatePricingAvailability.bind(this);
    this.addPricingToService = this.addPricingToService.bind(this);
    this.prune = this.prune.bind(this);
    this.disable = this.disable.bind(this);
    this.destroyPricing = this.destroyPricing.bind(this);
  }

  async index(req: any, res: any) {
    try {
      const queryParams = this._transformIndexQueryParams(req.query);
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId && req.user && req.user.role !== "ADMIN"){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const services = await this.serviceService.index(queryParams, organizationId);

      res.json(services);
    } catch (err: any) {
      res.status(500).send({ error: err.message });
    }
  }

  async indexPricings(req: any, res: any) {
    try {
      let { pricingStatus } = req.query;
      const serviceName = req.params.serviceName;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      if (!pricingStatus) {
        pricingStatus = 'active';
      } else if (pricingStatus !== 'active' && pricingStatus !== 'archived') {
        res.status(400).send({ error: 'Invalid pricing status' });
        return;
      }

      const pricings = await this.serviceService.indexPricings(serviceName, pricingStatus, organizationId);

      for (const pricing of pricings) {
        resetEscapePricingVersion(pricing);
      }

      return res.json(pricings);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async show(req: any, res: any) {
    try {
      const serviceName = req.params.serviceName;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }
      
      const service = await this.serviceService.show(serviceName, organizationId);

      return res.json(service);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async showPricing(req: any, res: any) {
    try {
      const serviceName = req.params.serviceName;
      const pricingVersion = req.params.pricingVersion;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const format = req.query.format ?? 'json';
      if (format !== 'json' && format !== 'yaml') {
        return res.status(400).send({ error: 'Invalid format: use "json" (default) or "yaml"' });
      }

      if (format === 'yaml') {
        return await this._sendPricingYaml(req, res, serviceName, pricingVersion, organizationId);
      }

      const pricing = await this.serviceService.showPricing(serviceName, pricingVersion, organizationId);

      resetEscapePricingVersion(pricing);

      return res.json(pricing);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  /**
   * The Pricing2Yaml file of a version: `application/yaml`, a strong ETag
   * (sha256 of the body), `X-Pricing-Syntax-Version`, and 304 for a matching
   * `If-None-Match`.
   */
  async _sendPricingYaml(req: any, res: any, serviceName: string, pricingVersion: string, organizationId: string) {
    try {
      const { body, syntaxVersion } = await this.serviceService.showPricingYaml(
        serviceName,
        pricingVersion,
        organizationId
      );
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;

      res.set('ETag', etag);
      res.set('Cache-Control', 'private, no-cache');
      if (syntaxVersion) res.set('X-Pricing-Syntax-Version', syntaxVersion);

      const ifNoneMatch: string | undefined = req.get('If-None-Match');
      const tags = (ifNoneMatch ?? '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
      if (ifNoneMatch && (tags.includes(etag) || tags.includes('*'))) {
        return res.status(304).end();
      }

      res.status(200).type('application/yaml; charset=utf-8').send(body);
    } catch (err: any) {
      if (err instanceof PricingYamlUnavailableError) {
        res.status(404).send({ error: 'PRICING_YAML_UNAVAILABLE', message: err.message });
      } else if (err instanceof PricingYamlUpstreamError) {
        res.status(502).send({ error: 'SPHERE_UNAVAILABLE', message: err.message });
      } else if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  /** GET .../pricings/new-contracts: `{ version, yamlUrl, source }`. */
  async showNewContractsPricing(req: any, res: any) {
    try {
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId) {
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const { version, source, serviceName } = await this.serviceService.newContractsPricing(
        req.params.serviceName,
        organizationId
      );

      res.json({ version, yamlUrl: pricingYamlUrl(req.params.organizationId, serviceName, version), source });
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async showPublicPricingUrl(req: any, res: any) {
    try {
      const serviceName = req.params.serviceName;
      const pricingVersion = req.params.pricingVersion;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId) {
        return res.status(400).send({
          error:
            'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths',
        });
      }

      const pricingPath = await this.serviceService.showPublicPricingUrl(
        serviceName,
        pricingVersion,
        organizationId
      );

      return res.json({
        path: pricingPath,
        url: `${req.protocol}://${req.get('host')}${pricingPath}`,
      });
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async create(req: any, res: any) {
    try {
      const receivedFile = req.file;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      if (req.body.source === 'sphere') {
        if (receivedFile || req.body.pricing) return res.status(400).json({ error: 'Invalid mixed pricing sources' });
        const linked = await container.resolve('sphereSyncService').create(req.body, organizationId);
        return res.status(201).json(linked);
      }
      let service;

      if (!receivedFile) {
        if (!req.body.pricing) {
          res.status(400).send({ error: 'No file or URL provided' });
          return;
        }
        service = await this.serviceService.create(req.body.pricing, 'url', organizationId);
      } else {
        service = await this.serviceService.create(req.file, 'file', organizationId);
      }
      res.status(201).json(service);
    } catch (err: any) {
      if (
        err.message.toLowerCase().includes('parsing') ||
        err.message.toLowerCase().includes('already exists') ||
        err.message.toLowerCase().includes('invalid')
      ) {
        res.status(400).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async addPricingToService(req: any, res: any) {
    try {
      const serviceName = req.params.serviceName;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const receivedFile = req.file;
      let service;

      if (!receivedFile) {
        if (!req.body.pricing) {
          res.status(400).send({ error: 'No file or URL provided' });
          return;
        }
        service = await this.serviceService.addPricingToService(
          serviceName,
          req.body.pricing,
          'url',
          organizationId
        );
      } else {
        service = await this.serviceService.addPricingToService(serviceName, req.file, 'file', organizationId);
      }

      res.status(201).json(service);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('exists')) {
        res.status(400).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid')) {
        res.status(400).send({ error: err.message });
      }else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async update(req: any, res: any) {
    try {
      const newServiceData = req.body;
      const serviceName = req.params.serviceName;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const service = await this.serviceService.update(serviceName, newServiceData, organizationId);

      res.json(service);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('invalid data')) {
        return res.status(400).send({ error: err.message });
      }
      if (err.message.toLowerCase().includes('not found')) {
        return res.status(404).send({ error: err.message });
      }
      if (err.message.toLowerCase().includes('conflict')) {
        return res.status(409).send({ error: err.message });
      }
      res.status(500).send({ error: err.message });
    }
  }

  async updatePricingAvailability(req: any, res: any) {
    try {
      const serviceName = req.params.serviceName;
      const pricingVersion = req.params.pricingVersion;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const newAvailability = req.query.availability ?? 'archived';
      const fallBackSubscription: FallBackSubscription = req.body ?? {};

      if (!newAvailability) {
        res.status(400).send({ error: 'No availability provided' });
        return;
      } else if (newAvailability !== 'active' && newAvailability !== 'archived') {
        res
          .status(400)
          .send({ error: 'Invalid availability status. Either provide "active" or "archived"' });
        return;
      } else {
        const service = await this.serviceService.updatePricingAvailability(
          serviceName,
          pricingVersion,
          newAvailability,
          fallBackSubscription,
          organizationId
        );

        res.json(service);
      }
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('last active pricing')) {
        res.status(400).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async prune(req: any, res: any) {
    try {
      let organizationId = req.org ? req.org.id : req.params.organizationId;
      if (!organizationId && req.user && req.user.role !== "ADMIN"){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      if (req.user && req.user.orgRole !== "OWNER" && req.user.orgRole !== "ADMIN" && req.user.role !== "ADMIN"){
        return res.status(403).send({ error: 'Forbidden: You do not have permission to prune services' });
      }

      if (req.user && req.user.role === "ADMIN"){
        organizationId = undefined;        
      }

      const result = await this.serviceService.prune(organizationId);
      res.json({ message: `Pruned ${result} services` });
    } catch (err: any) {
      res.status(500).send({ error: err.message });
    }
  }

  async disable(req: any, res: any) {
    try {
      const serviceName = req.params.serviceName;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const result = await this.serviceService.disable(serviceName, organizationId);

      if (result) {
        res.status(204).send();
      } else {
        res.status(404).send({ error: 'Service not found' });
      }
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async destroyPricing(req: any, res: any) {
    try {
      const serviceName = req.params.serviceName;
      const pricingVersion = req.params.pricingVersion;
      const organizationId = req.org ? req.org.id : req.params.organizationId;

      if (!organizationId){
        return res.status(400).send({ error: 'Organization ID is required. You can either provide an organization scoped API key or use the /organizations/*/services/** paths' });
      }

      const result = await this.serviceService.destroyPricing(serviceName, pricingVersion, organizationId);

      if (result) {
        res.status(204).send();
      } else {
        res.status(404).send({ error: 'Pricing not found' });
      }
    } catch (err: any) {
      if (
        err.message.toLowerCase().includes('not found') ||
        err.message.toLowerCase().includes('invalid')
      ) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('last active pricing')) {
        res.status(400).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('conflict')) {
        res.status(409).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  _transformIndexQueryParams(
    indexQueryParams: Record<string, string | number>
  ): ServiceQueryFilters {
    const transformedData: ServiceQueryFilters = {
      name: indexQueryParams.name as string,
      page: parseInt(indexQueryParams['page'] as string) || 1,
      offset: parseInt(indexQueryParams['offset'] as string) || 0,
      limit: parseInt(indexQueryParams['limit'] as string) || 20,
      order: (indexQueryParams.order as 'asc' | 'desc') || 'asc',
    };

    const optionalFields = Object.keys(transformedData);

    removeOptionalFieldsOfQueryParams(transformedData, optionalFields);

    return transformedData;
  }
}

export default ServiceController;
