import container from '../config/container';
import ContractService from '../services/ContractService';
import {
  ContractQueryFilters,
  ContractToCreate,
  Subscription,
  UsageLevelsResetQuery,
} from '../types/models/Contract';
import { removeOptionalFieldsOfQueryParams } from '../utils/controllerUtils';

class ContractController {
  private readonly contractService: ContractService;

  constructor() {
    this.contractService = container.resolve('contractService');
    this._scope = this._scope.bind(this);
    this.index = this.index.bind(this);
    this.show = this.show.bind(this);
    this.create = this.create.bind(this);
    this.novate = this.novate.bind(this);
    this.novateByGroupId = this.novateByGroupId.bind(this);
    this.novateUserContact = this.novateUserContact.bind(this);
    this.novateBillingPeriod = this.novateBillingPeriod.bind(this);
    this.novateBillingPeriodByGroupId = this.novateBillingPeriodByGroupId.bind(this);
    this.resetUsageLevels = this.resetUsageLevels.bind(this);
    this.prune = this.prune.bind(this);
    this.destroy = this.destroy.bind(this);
  }

  /**
   * Organization a request may address contracts in.
   *
   * Organization API keys are confined to their own organization, and the
   * organization-scoped routes to the organization in the path (membership is
   * checked by `memberRole`). Only a platform ADMIN using the direct routes is
   * not confined, as before.
   */
  _scope(req: any): string | undefined {
    return req.org?.id ?? req.params.organizationId;
  }

  async index(req: any, res: any) {
    try {
      const queryParams = this._transformIndexQueryParams(req.query);
      const filters = req.body?.filters;
      const merged = filters ? { ...queryParams, filters } : queryParams;
      let organizationId = req.org?.id ?? req.params.organizationId;

      if (!req.params.organizationId && req.user && req.user.role === 'ADMIN' && !req.org?.id) {
        organizationId = undefined;
      }

      const [contracts, total] = await Promise.all([
        this.contractService.index(merged, organizationId),
        this.contractService.count(merged, organizationId),
      ]);

      res.set('X-Total-Count', total.toString());
      res.json(contracts);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('validation of query params')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async show(req: any, res: any) {
    try {
      const userId = req.params.userId;
      const contract = await this.contractService.show(userId, this._scope(req));
      res.json(contract);
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
      const contractData: ContractToCreate = req.body;
      const authOrganizationId = req.org?.id ?? req.params.organizationId;

      if (
        contractData.organizationId &&
        authOrganizationId &&
        contractData.organizationId !== authOrganizationId &&
        !(req.user && req.user.role === 'ADMIN')
      ) {
        throw new Error('PERMISSION ERROR: Organization ID mismatch');
      }


      if (!(req.user && req.user.role === 'ADMIN')){
        contractData.organizationId = authOrganizationId;
      }else{
        if (!contractData.organizationId) {
          throw new Error('INVALID DATA: Organization ID is required for contract creation. Since you are an ADMIN, you must specify the organizationId in the request body.');
        }
      }

      const contract = await this.contractService.create(contractData);
      res.status(201).json(contract);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('invalid')) {
        res.status(400).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('permission error')) {
        res.status(403).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('conflict:')) {
        res.status(409).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async novate(req: any, res: any) {
    try {
      const userId = req.params.userId;
      const newSubscription: Subscription = req.body;
      const contract = await this.contractService.novate(userId, newSubscription, this._scope(req));
      res.status(200).json(contract);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid subscription:')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async novateByGroupId(req: any, res: any) {
    try {
      const groupId = req.query.groupId;
      const organizationId = req.org?.id ?? req.params.organizationId;
      if (!groupId) {
        res.status(400).send({ error: 'Missing groupId query parameter' });
        return;
      }
      const newSubscription: Subscription = req.body;
      const contracts = await this.contractService.novateByGroupId(groupId, organizationId, newSubscription);
      res.status(200).json(contracts);
    } catch (err: any) {
      if (
        err.message.toLowerCase().includes('not found') ||
        err.message.toLowerCase().includes('no contracts found')
      ) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid subscription:')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async novateUserContact(req: any, res: any) {
    try {
      const userId = req.params.userId;
      const userContact = req.body;
      const contract = await this.contractService.novateUserContact(
        userId,
        userContact,
        this._scope(req)
      );
      res.status(200).json(contract);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async novateBillingPeriod(req: any, res: any) {
    try {
      const userId = req.params.userId;
      const billingPeriod = req.body;

      const contract = await this.contractService.novateBillingPeriod(
        userId,
        billingPeriod,
        this._scope(req)
      );
      res.status(200).json(contract);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid data:')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async novateBillingPeriodByGroupId(req: any, res: any) {
    try {
      const groupId = req.query.groupId;
      const organizationId = req.org?.id ?? req.params.organizationId;
      const billingPeriod = req.body;

      if (!groupId) {
        res.status(400).send({ error: 'Missing groupId query parameter' });
        return;
      }

      const contracts = await this.contractService.novateBillingPeriodByGroupId(groupId, organizationId, billingPeriod);
      res.status(200).json(contracts);
    } catch (err: any) {
      if (
        err.message.toLowerCase().includes('not found') ||
        err.message.toLowerCase().includes('no contracts found')
      ) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid data:')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async resetUsageLevels(req: any, res: any) {
    try {
      const userId = req.params.userId;
      const queryParams = this._transformUsageLevelsResetQueryParams(req.query);
      const usageLevelsIncrements = req.body;
      const novatedContract = await this.contractService.resetUsageLevels(
        userId,
        queryParams,
        usageLevelsIncrements,
        this._scope(req)
      );
      res.status(200).json(novatedContract);
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid query:')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async prune(req: any, res: any) {
    try {
      const organizationId = req.org?.id ?? req.params.organizationId;

      const result: number = await this.contractService.prune(organizationId, req.user);
      res.status(204).json({ message: `Deleted ${result} contracts successfully` });
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('permission error')) {
        res.status(403).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async destroy(req: any, res: any) {
    try {
      const userId = req.params.userId;
      await this.contractService.destroy(userId, this._scope(req));
      res.status(204).json({ message: `Deleted contract with userId ${userId} successfully` });
    } catch (err: any) {
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  _transformIndexQueryParams(
    indexQueryParams: Record<string, string | number>
  ): ContractQueryFilters {
    const transformedData: ContractQueryFilters = {
      username: indexQueryParams.username as string,
      firstName: indexQueryParams.firstName as string,
      lastName: indexQueryParams.lastName as string,
      email: indexQueryParams.email as string,
      groupId: indexQueryParams.groupId as string,
      page: parseInt(indexQueryParams['page'] as string) || 1,
      offset: parseInt(indexQueryParams['offset'] as string) || 0,
      limit: parseInt(indexQueryParams['limit'] as string) || 20,
      sort: indexQueryParams.sort as 'firstName' | 'lastName' | 'username' | 'email',
      order: (indexQueryParams.order as 'asc' | 'desc') || 'asc',
    };

    const optionalFields: string[] = Object.keys(transformedData);

    removeOptionalFieldsOfQueryParams(transformedData, optionalFields);

    return transformedData;
  }

  _transformUsageLevelsResetQueryParams(
    indexQueryParams: Record<string, string>
  ): UsageLevelsResetQuery {
    const transformedData: UsageLevelsResetQuery = {
      reset: indexQueryParams.reset === 'true' || undefined,
      renewableOnly: indexQueryParams.renewableOnly !== 'false',
      usageLimit: indexQueryParams.usageLimit,
    };

    if (indexQueryParams.reset && indexQueryParams.usageLimit) {
      throw new Error(
        'Invalid query: Both reset and usageLimit cannot be provided at the same time'
      );
    }

    return transformedData;
  }
}

export default ContractController;
