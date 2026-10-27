import { body, check, query } from 'express-validator';
import { LeanPricing } from '../../types/models/Pricing';
import { LeanContract, Subscription } from '../../types/models/Contract';
import ServiceService from '../../services/ServiceService';
import container from '../../config/container';
import { convertKeysToLowercase, escapeVersion } from '../../utils/helpers';

const create = [
  // userContact (required)
  check('userContact')
    .exists({ checkNull: true })
    .withMessage('The userContact field is required')
    .isObject()
    .withMessage('The userContact field must be an object'),
  check('userContact.userId')
    .exists({ checkNull: true })
    .withMessage('The userContact.userId field is required')
    .isString()
    .withMessage('The userContact.userId field must be a string')
    .notEmpty()
    .withMessage('The userContact.userId field cannot be empty'),
  check('userContact.username')
    .exists({ checkNull: true })
    .withMessage('The userContact.username field is required')
    .isString()
    .withMessage('The userContact.username field must be a string'),
  check('userContact.firstName')
    .optional()
    .isString()
    .withMessage('The userContact.firstName field must be a string'),
  check('userContact.lastName')
    .optional()
    .isString()
    .withMessage('The userContact.lastName field must be a string'),
  check('userContact.email')
    .optional()
    .isEmail()
    .withMessage('The userContact.email field must be a valid email address'),
  check('userContact.phone')
    .optional()
    .isString()
    .withMessage('The userContact.phone field must be a string'),

  // billingPeriod (required)
  check('billingPeriod')
    .optional()
    .isObject()
    .withMessage('The billingPeriod field must be an object'),
  check('billingPeriod.autoRenew')
    .optional()
    .isBoolean()
    .withMessage('billingPeriod.autoRenew must be a boolean'),
  check('billingPeriod.renewalDays')
    .if(body('billingPeriod.autoRenew').equals('true'))
    .exists()
    .withMessage('billingPeriod.renewalDays is required when billingPeriod.autoRenew is true')
    .bail()
    .isInt({ min: 1 })
    .withMessage('billingPeriod.renewalDays must be a positive integer'),

  // contractedServices (optional): services of subscriptionPlans/subscriptionAddOns
  // that it omits get the version for new contracts of the service.
  check('contractedServices')
    .optional()
    .isObject()
    .withMessage(
      'contractedServices must be an object where keys are service names and values are pricing versions'
    ),

  check('contractedServices.*')
    .exists()
    .notEmpty()
    .withMessage('Each value in contractedServices must be a string (service name)')
    .isString()
    .withMessage('Each value in contractedServices must be a string (pricing version)'),

  // subscriptionPlans (required)
  check('subscriptionPlans')
    .exists({ checkNull: true })
    .withMessage('The subscriptionPlans field is required')
    .isObject()
    .withMessage(
      'subscriptionPlans must be an object where keys are service names and values are plan names'
    ),

  check('subscriptionPlans.*')
    .exists()
    .withMessage('Each value in subscriptionPlans must be a string (plan name)')
    .isString()
    .withMessage('Plan name must be a string')
    .isLength({ min: 1 })
    .withMessage('Plan name cannot be empty'),

  // subscriptionAddOns (required)
  check('subscriptionAddOns')
    .exists({ checkNull: true })
    .withMessage('The subscriptionAddOns field is required')
    .isObject()
    .withMessage('subscriptionAddOns must be an object'),

  check('subscriptionAddOns.*')
    .isObject()
    .withMessage('Each value in subscriptionAddOns must be an object of add-ons'),

  check('subscriptionAddOns.*.*')
    .isInt({ min: 0 })
    .withMessage('Each add-on quantity must be an integer greater than or equal to 0'),
];

const novate = [
  // contractedServices (optional)
  check('contractedServices')
    .exists({ checkNull: true })
    .withMessage('The contractedServices field is required')
    .isObject()
    .withMessage(
      'contractedServices must be an object where keys are service names and values are pricing versions'
    ),

  check('contractedServices.*')
    .exists()
    .withMessage('Each value in contractedServices must be a string (service name)')
    .isString()
    .withMessage('Each value in contractedServices must be a string (pricing version)'),

  // subscriptionPlans (required)
  check('subscriptionPlans')
    .exists({ checkNull: true })
    .withMessage('The subscriptionPlans field is required')
    .isObject()
    .withMessage(
      'subscriptionPlans must be an object where keys are service names and values are plan names'
    ),

  check('subscriptionPlans.*')
    .exists()
    .withMessage('Each value in subscriptionPlans must be a string (plan name)')
    .isString()
    .withMessage('Plan name must be a string')
    .isLength({ min: 1 })
    .withMessage('Plan name cannot be empty'),

  // subscriptionAddOns (required)
  check('subscriptionAddOns')
    .exists({ checkNull: true })
    .withMessage('The subscriptionAddOns field is required')
    .isObject()
    .withMessage('subscriptionAddOns must be an object'),

  check('subscriptionAddOns.*')
    .isObject()
    .withMessage('Each value in subscriptionAddOns must be an object of add-ons'),

  check('subscriptionAddOns.*.*')
    .isInt({ min: 0 })
    .withMessage('Each add-on quantity must be an integer greater than or equal to 0'),
];

const contractVersionPreconditions = [
  body('expectedContractVersion')
    .optional()
    .isString()
    .withMessage('expectedContractVersion must be a string (the contractVersion of the contract)'),
  body('expectedContractVersions')
    .optional()
    .isObject()
    .withMessage('expectedContractVersions must be an object of userId -> contractVersion'),
  body('expectedContractVersions.*')
    .optional()
    .isString()
    .withMessage('Each value in expectedContractVersions must be a string (contractVersion)'),
];

/** `rejectPrivate` (opt-in), as a query parameter or a body field. */
function rejectPrivateOption() {
  return [
    body('rejectPrivate')
      .optional()
      .isBoolean({ strict: true })
      .withMessage('rejectPrivate must be a boolean'),
    query('rejectPrivate')
      .optional()
      .isIn(['true', 'false'])
      .withMessage('rejectPrivate must be true or false'),
  ];
}

const novationOptions = [
  body('keepBillingPeriod')
    .optional()
    .isBoolean({ strict: true })
    .withMessage('keepBillingPeriod must be a boolean'),
  query('keepBillingPeriod')
    .optional()
    .isIn(['true', 'false'])
    .withMessage('keepBillingPeriod must be true or false'),
  ...rejectPrivateOption(),
];

novate.push(...contractVersionPreconditions, ...novationOptions);
create.push(...rejectPrivateOption());

const incrementUsageLevels = [
  body()
    .custom((value) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value)
      ) {
        throw new Error('The value must be an object');
      }

      for (const key in value) {
        if (
          typeof value[key] !== 'object' ||
          value[key] === null ||
          Array.isArray(value[key])
        ) {
          throw new Error(
            `The value for key "${key}" must be an object`
          );
        }

        for (const innerKey in value[key]) {
          if (typeof value[key][innerKey] !== 'number') {
            throw new Error(
              `The value for key "${key}.${innerKey}" must be a number`
            );
          }
        }
      }

      return true;
    })
    .withMessage(
      'The input must be an object with the structure: Record<string, Record<string, number>>'
    ),
];

const novateUserContact = [
  body()
    .notEmpty()
    .withMessage('The body cannot be empty'),
  check('username')
    .optional()
    .isString()
    .withMessage('The username field must be a string'),
  check('firstName')
    .optional()
    .isString()
    .withMessage('The firstName field must be a string'),
  check('lastName')
    .optional()
    .isString()
    .withMessage('The lastName field must be a string'),
  check('email')
    .optional()
    .isEmail()
    .withMessage('The email field must be a valid email address'),
  check('phone')
    .optional()
    .isString()
    .withMessage('The phone field must be a string'),
];

const novateBillingPeriod = [
  body()
    .notEmpty()
    .withMessage('The body cannot be empty'),
  
  check('endData')
    .optional()
    .isDate()
    .withMessage('The endDate field must be a valid date'),
  check('autoRenew')
    .optional()
    .isBoolean()
    .withMessage('The autoRenew field must be a boolean'),
  check('renewalDays')
    .optional()
    .isInt({ min: 1 })
    .withMessage('renewalDays must be a positive integer'),
];

async function isSubscriptionValid(subscription: Subscription, organizationId: string): Promise<void> {
  const selectedPricings: Record<string, LeanPricing> = {};
  const serviceService: ServiceService = container.resolve('serviceService');

  // Create an array of promises to fetch all pricing data in parallel
  const pricingPromises = Object.entries(subscription.contractedServices).map(
    async ([serviceName, pricingVersion]) => {
      try {
        const pricing = await serviceService.showPricing(serviceName, pricingVersion, organizationId);
        if (!pricing) {
          throw new Error(
            `Pricing version ${pricingVersion} for service ${serviceName} not found in the request organization`
          );
        }
        
        return { serviceName, pricing };
      } catch (error) {
        throw new Error(
          `Pricing version ${pricingVersion} for service ${serviceName} not found in the request organization`
        );
      }
    }
  );
  
  // Wait for all promises to resolve
  const results = await Promise.all(pricingPromises);
  
  // Populate the selectedPricings object with the results
  results.forEach(({ serviceName, pricing }) => {
    selectedPricings[serviceName] = pricing;
  });

  const serviceNames = Array.from(
    new Set([
      ...Object.keys(subscription.subscriptionPlans),
      ...Object.keys(subscription.subscriptionAddOns),
    ])
  );

  for (const serviceName of serviceNames) {
    const pricing = selectedPricings[serviceName];

    if (!pricing) {
      throw new Error(
        `NOT FOUND: Service with name ${serviceName} in the request organization. Please check the services declared in subscriptionPlans and subscriptionAddOns.`
      );
    }

    isSubscriptionValidInPricing(serviceName, subscription, pricing);
  }
}

/**
 * Stable codes of subscription validation errors (see `SubscriptionError`).
 * Clients may switch on them; the messages are for humans and may change.
 */
type SubscriptionErrorCode =
  | 'PLAN_NOT_FOUND'
  | 'ADDON_NOT_FOUND'
  | 'ADDON_NOT_AVAILABLE'
  | 'ADDON_DEPENDENCY_MISSING'
  | 'ADDON_EXCLUDED'
  | 'QUANTITY_OUT_OF_RANGE'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_ARCHIVED'
  | 'PRIVATE_PLAN'
  | 'PRIVATE_ADDON';

interface SubscriptionError {
  code: SubscriptionErrorCode;
  service: string;
  /** Location of the offending value in the request body, e.g. `subscriptionAddOns.acme.extraStorage`. */
  path: string;
  message: string;
}

/**
 * What the contract had before, for rules that only apply to selections made
 * now: a private plan or add-on the contract already has may be kept.
 */
interface SubscriptionValidationContext {
  /** Reject private plans and add-ons that the contract does not already have. */
  rejectPrivate?: boolean;
  previousPlan?: string;
  previousAddOns?: Record<string, number>;
}

/** A subscription failed validation; `errors` lists every problem found. */
class SubscriptionValidationError extends Error {
  constructor(public readonly errors: SubscriptionError[]) {
    super(`Invalid subscription: ${errors[0]?.message ?? 'unknown error'}`);
    this.name = 'SubscriptionValidationError';
  }
}

/**
 * Every problem of the selection of one service against one pricing version.
 *
 * The order (and the first message) is the one the original validation
 * reported, so `isSubscriptionValidInPricing` keeps its behaviour. Checks that
 * depend on an add-on existing are skipped for add-ons that do not.
 */
function subscriptionErrorsInPricing(
  serviceName: string,
  subscription: Subscription,
  pricing: LeanPricing,
  context: SubscriptionValidationContext = {}
): SubscriptionError[] {
  const errors: SubscriptionError[] = [];
  const selectedPlan: string | undefined = subscription.subscriptionPlans[serviceName];
  const selectedAddOns = subscription.subscriptionAddOns[serviceName];
  const pricingPlans = convertKeysToLowercase(pricing.plans || {});
  const planPath = `subscriptionPlans.${serviceName}`;

  if (!selectedPlan && !selectedAddOns) {
    // Nothing selected for the service: reported as PLAN_NOT_FOUND (documented
    // with the codes), since there is no dedicated code for an empty selection.
    errors.push({
      code: 'PLAN_NOT_FOUND',
      service: serviceName,
      path: planPath,
      message: `Service ${serviceName} must have either a plan or add-ons selected`,
    });
    return errors;
  }

  if (selectedPlan) {
    const plan = pricingPlans[selectedPlan.toLowerCase()];
    if (!plan) {
      errors.push({
        code: 'PLAN_NOT_FOUND',
        service: serviceName,
        path: planPath,
        message: `Plan ${selectedPlan} for service ${serviceName} not found in the request organization`,
      });
    } else if (
      context.rejectPrivate &&
      plan.private &&
      selectedPlan.toLowerCase() !== context.previousPlan?.toLowerCase()
    ) {
      errors.push({
        code: 'PRIVATE_PLAN',
        service: serviceName,
        path: planPath,
        message: `Plan ${selectedPlan} of service ${serviceName} is private and cannot be selected`,
      });
    }
  }

  if (!selectedAddOns) {
    return errors;
  }

  const pricingAddOns = convertKeysToLowercase(pricing.addOns || {});

  for (const addOnName in selectedAddOns) {
    const path = `subscriptionAddOns.${serviceName}.${addOnName}`;
    const addOn = pricing.addOns?.[addOnName];

    if (!addOn) {
      const otherCase = pricingAddOns[addOnName.toLowerCase()];
      errors.push({
        code: 'ADDON_NOT_FOUND',
        service: serviceName,
        path,
        message: otherCase
          ? `Add-on ${addOnName} declared in the subscription not found in pricing version ${pricing.version} in the request organization (add-on names are case-sensitive)`
          : `Add-on ${addOnName} declared in the subscription not found in pricing version ${pricing.version} in the request organization`,
      });
      continue;
    }

    const availableFor = addOn.availableFor ?? Object.keys(pricing.plans ?? {});
    if (selectedPlan && !availableFor.map(p => p.toLowerCase()).includes(selectedPlan.toLowerCase())) {
      errors.push({
        code: 'ADDON_NOT_AVAILABLE',
        service: serviceName,
        path,
        message: `Add-on ${addOnName} is not available for plan ${selectedPlan} in the request organization`,
      });
    }

    const dependentAddOns = addOn.dependsOn ?? [];
    if (!dependentAddOns.every(dependentAddOn => Object.prototype.hasOwnProperty.call(selectedAddOns, dependentAddOn))) {
      errors.push({
        code: 'ADDON_DEPENDENCY_MISSING',
        service: serviceName,
        path,
        message: `Add-on ${addOnName} requires the following add-ons to be selected in the request organization: ${dependentAddOns.join(', ')}`,
      });
    }

    const excludedAddOns = addOn.excludes ?? [];
    if (excludedAddOns.some(excludedAddOn => Object.prototype.hasOwnProperty.call(selectedAddOns, excludedAddOn))) {
      errors.push({
        code: 'ADDON_EXCLUDED',
        service: serviceName,
        path,
        message: `Add-on ${addOnName} cannot be selected with the following add-ons in the request organization: ${excludedAddOns.join(', ')}`,
      });
    }

    const quantity = selectedAddOns[addOnName];
    const minQuantity = addOn.subscriptionConstraints?.minQuantity ?? 1;
    const maxQuantity = addOn.subscriptionConstraints?.maxQuantity ?? Infinity;
    const quantityStep = addOn.subscriptionConstraints?.quantityStep ?? 1;
    const isValidQuantity =
      quantity >= minQuantity &&
      quantity <= maxQuantity &&
      (quantity - minQuantity) % quantityStep === 0;

    if (!isValidQuantity) {
      errors.push({
        code: 'QUANTITY_OUT_OF_RANGE',
        service: serviceName,
        path,
        message: `Add-on ${addOnName} quantity ${quantity} is not valid. It must be between ${minQuantity} and ${maxQuantity}, and a multiple of ${quantityStep} in the request organization`,
      });
    }

    if (
      context.rejectPrivate &&
      addOn.private &&
      !Object.prototype.hasOwnProperty.call(context.previousAddOns ?? {}, addOnName)
    ) {
      errors.push({
        code: 'PRIVATE_ADDON',
        service: serviceName,
        path,
        message: `Add-on ${addOnName} of service ${serviceName} is private and cannot be selected`,
      });
    }
  }

  return errors;
}

/** What a subscription is validated against, besides the pricings. */
interface SubscriptionValidationOptions {
  /**
   * The contract being novated (absent for a new contract). Keeping what it
   * already has - its pricing version of a service, even if archived since,
   * and its private plan or add-ons - stays allowed.
   */
  previous?: Pick<LeanContract, 'contractedServices' | 'subscriptionPlans' | 'subscriptionAddOns'>;
  /**
   * Opt-in: reject private plans and add-ons that the contract does not
   * already have (customer-facing changes). Off by default, so operators keep
   * assigning private plans as before.
   */
  rejectPrivate?: boolean;
}

const findKey = (record: Record<string, unknown> | undefined, key: string) =>
  Object.keys(record ?? {}).find(candidate => candidate.toLowerCase() === key.toLowerCase());

/**
 * Every problem of a subscription, with stable codes, and the pricings of the
 * services whose version could be loaded.
 *
 * Besides what `isSubscriptionValidInPricing` checks, it rejects pricing
 * versions that do not exist (`VERSION_NOT_FOUND`), archived versions for new
 * contracts and for version changes (`VERSION_ARCHIVED`), and private plans and
 * add-ons the contract does not already have (`PRIVATE_PLAN`, `PRIVATE_ADDON`),
 * only with `rejectPrivate`. Usage below consumption is not an error.
 */
async function collectSubscriptionErrors(
  subscription: Subscription,
  organizationId: string,
  options: SubscriptionValidationOptions = {}
): Promise<{ errors: SubscriptionError[]; pricings: Record<string, LeanPricing> }> {
  const serviceService: ServiceService = container.resolve('serviceService');
  const errors: SubscriptionError[] = [];
  const pricings: Record<string, LeanPricing> = {};
  const previous = options.previous;

  const loaded = await Promise.all(
    Object.entries(subscription.contractedServices ?? {}).map(async ([serviceName, pricingVersion]) => {
      const path = `contractedServices.${serviceName}`;
      const previousKey = findKey(previous?.contractedServices, serviceName);
      const unchanged =
        previousKey !== undefined &&
        escapeVersion(String(previous!.contractedServices[previousKey])) === escapeVersion(String(pricingVersion));
      const notFound: SubscriptionError = {
        code: 'VERSION_NOT_FOUND',
        service: serviceName,
        path,
        message: `Pricing version ${pricingVersion} for service ${serviceName} not found in the request organization`,
      };

      const status = await serviceService.pricingVersionStatus(serviceName, pricingVersion, organizationId);
      if (status === 'no-service') return { serviceName, error: notFound };
      if (status === 'archived' && !unchanged) {
        return {
          serviceName,
          error: {
            code: 'VERSION_ARCHIVED',
            service: serviceName,
            path,
            message: previous
              ? `Pricing version ${pricingVersion} of service ${serviceName} is archived; a contract can keep it but not change to it`
              : `Pricing version ${pricingVersion} of service ${serviceName} is archived and cannot be used for new contracts`,
          } as SubscriptionError,
        };
      }
      // Missing versions are only looked up further (SPHERE history) when kept.
      if (status === 'missing' && !unchanged) return { serviceName, error: notFound };

      try {
        const pricing = await serviceService.showPricing(serviceName, pricingVersion, organizationId);
        return pricing ? { serviceName, pricing } : { serviceName, error: notFound };
      } catch {
        return { serviceName, error: notFound };
      }
    })
  );

  for (const result of loaded) {
    if (result.error) errors.push(result.error);
    else pricings[result.serviceName] = result.pricing as LeanPricing;
  }

  const serviceNames = Array.from(
    new Set([
      ...Object.keys(subscription.subscriptionPlans ?? {}),
      ...Object.keys(subscription.subscriptionAddOns ?? {}),
    ])
  );

  for (const serviceName of serviceNames) {
    const pricing = pricings[serviceName];

    if (!pricing) {
      if (!Object.prototype.hasOwnProperty.call(subscription.contractedServices ?? {}, serviceName)) {
        errors.push({
          code: 'VERSION_NOT_FOUND',
          service: serviceName,
          path: Object.prototype.hasOwnProperty.call(subscription.subscriptionPlans ?? {}, serviceName)
            ? `subscriptionPlans.${serviceName}`
            : `subscriptionAddOns.${serviceName}`,
          message: `NOT FOUND: Service with name ${serviceName} in the request organization. Please check the services declared in subscriptionPlans and subscriptionAddOns.`,
        });
      }
      continue;
    }

    const previousPlanKey = findKey(previous?.subscriptionPlans, serviceName);
    const previousAddOnsKey = findKey(previous?.subscriptionAddOns, serviceName);
    errors.push(
      ...subscriptionErrorsInPricing(serviceName, subscription, pricing, {
        rejectPrivate: options.rejectPrivate === true,
        previousPlan: previousPlanKey ? previous!.subscriptionPlans[previousPlanKey] : undefined,
        previousAddOns: previousAddOnsKey ? previous!.subscriptionAddOns[previousAddOnsKey] : undefined,
      })
    );
  }

  return { errors, pricings };
}

/**
 * Validate a subscription for a new contract or a novation and throw a
 * `SubscriptionValidationError` listing every problem (see
 * `collectSubscriptionErrors`).
 */
async function validateSubscription(
  subscription: Subscription,
  organizationId: string,
  options: SubscriptionValidationOptions = {}
): Promise<Record<string, LeanPricing>> {
  const { errors, pricings } = await collectSubscriptionErrors(subscription, organizationId, options);
  if (errors.length > 0) {
    throw new SubscriptionValidationError(errors);
  }
  return pricings;
}

function isSubscriptionValidInPricing(
  serviceName: string,
  subscription: Subscription,
  pricing: LeanPricing
): void {
  const [first] = subscriptionErrorsInPricing(serviceName, subscription, pricing);
  if (first) {
    throw new Error(first.message);
  }
}

export {
  create,
  novate,
  incrementUsageLevels,
  novateUserContact,
  novateBillingPeriod,
  isSubscriptionValid,
  isSubscriptionValidInPricing,
  subscriptionErrorsInPricing,
  collectSubscriptionErrors,
  validateSubscription,
  SubscriptionValidationError,
};
export type {
  SubscriptionError,
  SubscriptionErrorCode,
  SubscriptionValidationContext,
  SubscriptionValidationOptions,
};
