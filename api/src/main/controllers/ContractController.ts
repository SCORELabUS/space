import container from '../config/container';
import ContractService, { NovationOptions } from '../services/ContractService';
import {
  ContractQueryFilters,
  ContractToCreate,
  Subscription,
  UsageLevelsResetQuery,
} from '../types/models/Contract';
import { removeOptionalFieldsOfQueryParams } from '../utils/controllerUtils';
import { SubscriptionValidationError } from './validation/ContractValidation';
import {
  ContractChangedError,
  computeContractVersion,
  parseIfMatch,
} from '../utils/contracts/version';
import { AmbiguousContractScopeError } from '../utils/contracts/scope';

/** Add `contractVersion` to a contract response (see `computeContractVersion`). */
function withVersion<T extends object>(contract: T): T & { contractVersion: string } {
  return { ...contract, contractVersion: computeContractVersion(contract as any) };
}

/**
 * Send one contract with its version, also as `ETag`.
 *
 * The tag versions the subscription, for `If-Match` on novation. It is not a
 * cache validator for the whole representation - usage levels change under the
 * same version - so `If-None-Match` is not evaluated (Express would otherwise
 * answer 304 by itself).
 */
function sendContract(req: any, res: any, status: number, contract: any) {
  const body = withVersion(contract);
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.set('ETag', `"${body.contractVersion}"`);
  res.status(status).json(body);
}

function sendContractChanged(res: any, err: ContractChangedError) {
  if (typeof err.contractVersion === 'string') {
    res.set('ETag', `"${err.contractVersion}"`);
    res.status(412).send({ error: 'CONTRACT_CHANGED', contractVersion: err.contractVersion });
  } else {
    res.status(412).send({
      error: 'CONTRACT_CHANGED',
      contractVersions: err.contractVersion,
      ...(err.novated ? { novated: err.novated } : {}),
    });
  }
}

/**
 * Every validation problem, each with a stable `code`.
 *
 * Status: 400. Novations keep answering 404 when everything wrong is a missing
 * plan, add-on or pricing version, as they did before the codes existed.
 */
function sendInvalidSubscription(res: any, err: SubscriptionValidationError, novation = false) {
  const onlyMissing = err.errors.every(error => error.code.endsWith('_NOT_FOUND'));
  res.status(novation && onlyMissing ? 404 : 400).send({ error: err.message, errors: err.errors });
}

/**
 * A boolean option from the query (`name=true`) or the body (`name: true`).
 * The body field is removed so that only the subscription remains.
 */
function flagOf(req: any, name: string): boolean {
  const value = req.body?.[name];
  if (req.body && typeof req.body === 'object' && name in req.body) delete req.body[name];
  return req.query?.[name] === 'true' || value === true;
}

/** Novation options: `keepBillingPeriod` and the opt-in `rejectPrivate`. */
function novationOptionsOf(req: any): NovationOptions {
  return {
    keepBillingPeriod: flagOf(req, 'keepBillingPeriod'),
    rejectPrivate: flagOf(req, 'rejectPrivate'),
  };
}

/**
 * The versions a novation is conditional on: the strong tags of `If-Match`
 * (several may be listed; weak tags never match) or the body field
 * `expectedContractVersion` (removed from the body). Both may be given only if
 * the header lists the body's version (or is `*`).
 */
function expectedVersionOf(req: any): string[] | undefined {
  const header = parseIfMatch(req.get?.('If-Match'));
  const fromBody = req.body?.expectedContractVersion;
  if (req.body && 'expectedContractVersion' in req.body) delete req.body.expectedContractVersion;
  if (fromBody !== undefined) {
    if (header !== undefined && !header.includes(fromBody) && !header.includes('*')) {
      throw new Error('Invalid precondition: If-Match and expectedContractVersion differ');
    }
    return [fromBody];
  }
  return header;
}

/**
 * Answer the errors of resolving the organization of a request (see
 * `ContractController._scope`): 409 for an ambiguous userId or groupId, 403 for
 * an `organizationId` parameter that is not the caller's, 400 for a malformed
 * one. Returns whether it answered.
 */
function sendScopeError(res: any, err: any): boolean {
  if (err instanceof AmbiguousContractScopeError) {
    res.status(409).send({ error: err.message, code: err.code, organizationIds: err.organizationIds });
    return true;
  }
  const message = String(err?.message ?? '');
  if (message.startsWith('PERMISSION ERROR: organizationId')) {
    res.status(403).send({ error: message });
    return true;
  }
  if (message.startsWith('INVALID DATA: organizationId')) {
    res.status(400).send({ error: message });
    return true;
  }
  return false;
}

class ContractController {
  private readonly contractService: ContractService;

  constructor() {
    this.contractService = container.resolve('contractService');
    this._scope = this._scope.bind(this);
    this._groupScope = this._groupScope.bind(this);
    this.index = this.index.bind(this);
    this.show = this.show.bind(this);
    this.pricings = this.pricings.bind(this);
    this.create = this.create.bind(this);
    this.novate = this.novate.bind(this);
    this.previewNovation = this.previewNovation.bind(this);
    this.novateByGroupId = this.novateByGroupId.bind(this);
    this.novateUserContact = this.novateUserContact.bind(this);
    this.novateBillingPeriod = this.novateBillingPeriod.bind(this);
    this.novateBillingPeriodByGroupId = this.novateBillingPeriodByGroupId.bind(this);
    this.resetUsageLevels = this.resetUsageLevels.bind(this);
    this.prune = this.prune.bind(this);
    this.destroy = this.destroy.bind(this);
  }

  /**
   * The organization named by the `organizationId` query parameter, if any.
   *
   * It only selects an organization for a platform ADMIN on the direct routes.
   * Any other caller already has one (its API key's, or the route's, whose
   * membership `memberRole` checked): the parameter may repeat it and is
   * refused otherwise, never used to reach another organization.
   */
  _requestedOrganization(req: any): string | undefined {
    const requested = req.query?.organizationId;
    if (requested === undefined) return undefined;
    if (typeof requested !== 'string' || requested.length === 0) {
      throw new Error('INVALID DATA: organizationId must be one organization id');
    }
    const fixed = req.org?.id ?? req.params.organizationId;
    if (fixed && requested !== fixed) {
      throw new Error('PERMISSION ERROR: organizationId does not match the organization of this request');
    }
    return requested;
  }

  /**
   * Organization in which a request addresses the contract of `req.params.userId`.
   *
   * Organization API keys are confined to their own organization, and the
   * organization-scoped routes to the organization in the path. A platform
   * ADMIN on the direct routes names it with `?organizationId=`; without it,
   * the organization that has this userId, if only one has it (a userId is
   * only unique within an organization), and `AmbiguousContractScopeError`
   * (409) if several do.
   */
  async _scope(req: any): Promise<string | undefined> {
    const requested = this._requestedOrganization(req);
    const fixed = req.org?.id ?? req.params.organizationId;
    if (fixed) return fixed;
    if (requested) return requested;
    return this.contractService.organizationOfUserId(req.params.userId);
  }

  /** Like `_scope`, for the contracts of a `groupId`. */
  async _groupScope(req: any, groupId: string): Promise<string | undefined> {
    const requested = this._requestedOrganization(req);
    const fixed = req.org?.id ?? req.params.organizationId;
    if (fixed) return fixed;
    if (requested) return requested;
    return this.contractService.organizationOfGroupId(groupId);
  }

  async index(req: any, res: any) {
    try {
      const queryParams = this._transformIndexQueryParams(req.query);
      const filters = req.body?.filters;
      const merged = filters ? { ...queryParams, filters } : queryParams;
      // A platform ADMIN on the direct route lists every organization, or the one named with ?organizationId=.
      const organizationId = this._requestedOrganization(req) ?? req.org?.id ?? req.params.organizationId;

      const [contracts, total] = await Promise.all([
        this.contractService.index(merged, organizationId),
        this.contractService.count(merged, organizationId),
      ]);

      res.set('X-Total-Count', total.toString());
      res.json(contracts.map(contract => withVersion(contract)));
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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
      const contract = await this.contractService.show(userId, await this._scope(req));
      sendContract(req, res, 200, contract);
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  /** GET /contracts/{userId}/pricings */
  async pricings(req: any, res: any) {
    try {
      const { contract, services } = await this.contractService.pricings(
        req.params.userId,
        await this._scope(req),
        req.params.organizationId
      );
      const contractVersion = computeContractVersion(contract);
      delete req.headers['if-none-match'];
      res.set('ETag', `"${contractVersion}"`);
      res.json({ services, contractVersion });
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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

      const rejectPrivate = flagOf(req, 'rejectPrivate');
      const contract = await this.contractService.create(contractData, { rejectPrivate });
      sendContract(req, res, 201, contract);
    } catch (err: any) {
      if (err instanceof SubscriptionValidationError) {
        sendInvalidSubscription(res, err);
      } else if (err.message.toLowerCase().includes('invalid')) {
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
      const expectedContractVersion = expectedVersionOf(req);
      const options = novationOptionsOf(req);
      const newSubscription: Subscription = req.body;
      const contract = await this.contractService.novate(userId, newSubscription, await this._scope(req), {
        ...options,
        expectedContractVersion,
      });
      sendContract(req, res, 200, contract);
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
      if (err instanceof SubscriptionValidationError) {
        sendInvalidSubscription(res, err, true);
      } else if (err instanceof ContractChangedError) {
        sendContractChanged(res, err);
      } else if (err.message.toLowerCase().includes('invalid precondition')) {
        res.status(400).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (err.message.toLowerCase().includes('invalid subscription:')) {
        res.status(400).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  /** POST /contracts/{userId}/novation/preview: what PUT /contracts/{userId} would do, writing nothing. */
  async previewNovation(req: any, res: any) {
    try {
      const options = novationOptionsOf(req);
      // Preconditions are for writes; the preview reports the current version instead.
      if (req.body && 'expectedContractVersion' in req.body) delete req.body.expectedContractVersion;
      const preview = await this.contractService.previewNovation(req.params.userId, req.body, await this._scope(req), options);
      res.status(200).json(preview);
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
      if (err.message.toLowerCase().includes('not found')) {
        res.status(404).send({ error: err.message });
      } else if (/applying|busy/i.test(err.message)) {
        res.status(409).send({ error: err.message });
      } else {
        res.status(500).send({ error: err.message });
      }
    }
  }

  async novateByGroupId(req: any, res: any) {
    try {
      const groupId = req.query.groupId;
      if (!groupId) {
        res.status(400).send({ error: 'Missing groupId query parameter' });
        return;
      }
      if (req.get('If-Match') !== undefined) {
        res.status(400).send({
          error:
            'Invalid precondition: If-Match cannot name the versions of several contracts; use expectedContractVersions',
        });
        return;
      }
      if (req.body && 'expectedContractVersion' in req.body) {
        res.status(400).send({
          error:
            'Invalid precondition: expectedContractVersion names the version of one contract; use expectedContractVersions (userId -> contractVersion)',
        });
        return;
      }
      const expectedContractVersions = req.body?.expectedContractVersions;
      if (req.body && 'expectedContractVersions' in req.body) delete req.body.expectedContractVersions;
      const options = novationOptionsOf(req);
      const newSubscription: Subscription = req.body;
      const organizationId = await this._groupScope(req, groupId);
      if (!organizationId) {
        res.status(404).send({ error: `No contracts found with groupId ${groupId}` });
        return;
      }
      const contracts = await this.contractService.novateByGroupId(groupId, organizationId, newSubscription, {
        ...options,
        expectedContractVersions,
      });
      res.status(200).json(contracts.map(contract => withVersion(contract)));
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
      if (err instanceof SubscriptionValidationError) {
        sendInvalidSubscription(res, err, true);
      } else if (err instanceof ContractChangedError) {
        sendContractChanged(res, err);
      } else if (
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
        await this._scope(req)
      );
      sendContract(req, res, 200, contract);
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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
        await this._scope(req)
      );
      sendContract(req, res, 200, contract);
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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
      const billingPeriod = req.body;

      if (!groupId) {
        res.status(400).send({ error: 'Missing groupId query parameter' });
        return;
      }
      const organizationId = await this._groupScope(req, groupId);
      if (!organizationId) {
        res.status(404).send({ error: `No contracts found with groupId ${groupId}` });
        return;
      }

      const contracts = await this.contractService.novateBillingPeriodByGroupId(groupId, organizationId, billingPeriod);
      res.status(200).json(contracts.map(contract => withVersion(contract)));
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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
        await this._scope(req)
      );
      sendContract(req, res, 200, novatedContract);
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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
      // A platform ADMIN on the direct route prunes every organization, or the one named with ?organizationId=.
      const organizationId = this._requestedOrganization(req) ?? req.org?.id ?? req.params.organizationId;

      const result: number = await this.contractService.prune(organizationId, req.user);
      res.status(204).json({ message: `Deleted ${result} contracts successfully` });
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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
      await this.contractService.destroy(userId, await this._scope(req));
      res.status(204).json({ message: `Deleted contract with userId ${userId} successfully` });
    } catch (err: any) {
      if (sendScopeError(res, err)) return;
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
