import { body, check } from 'express-validator';
import { LeanPricing } from '../../types/models/Pricing';
import { Subscription } from '../../types/models/Contract';
import ServiceService from '../../services/ServiceService';
import container from '../../config/container';
import { convertKeysToLowercase } from '../../utils/helpers';

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
  check('expectedContractVersion')
    .optional()
    .isString()
    .withMessage('expectedContractVersion must be a string (the contractVersion of the contract)'),
  check('expectedContractVersions')
    .optional()
    .isObject()
    .withMessage('expectedContractVersions must be an object of userId -> contractVersion'),
  check('expectedContractVersions.*')
    .optional()
    .isString()
    .withMessage('Each value in expectedContractVersions must be a string (contractVersion)'),
];

novate.push(...contractVersionPreconditions);

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

    isSubscriptionValidInPricing(serviceName, subscription, pricing)
  }
}

function isSubscriptionValidInPricing(
  serviceName: string,
  subscription: Subscription,
  pricing: LeanPricing
): void {  
  const selectedPlan: string | undefined = subscription.subscriptionPlans[serviceName];
  const selectedAddOns = subscription.subscriptionAddOns[serviceName];
  const pricingPlans = convertKeysToLowercase(pricing.plans || {});

  if (!selectedPlan && !selectedAddOns) {
    throw new Error(
      `Service ${serviceName} must have either a plan or add-ons selected`
    );
  }

  if (selectedPlan && !pricingPlans[selectedPlan.toLowerCase()]) {
    throw new Error(
      `Plan ${selectedPlan} for service ${serviceName} not found in the request organization`
    );
  }

  _validateAddOns(selectedAddOns, selectedPlan, pricing);
}

function _validateAddOns(
  selectedAddOns: Record<string, number>,
  selectedPlan: string | undefined,
  pricing: LeanPricing
): void {
  if (!selectedAddOns) {
    return;
  }

  const pricingAddOns = convertKeysToLowercase(pricing.addOns || {});

  for (const addOnName in selectedAddOns) {

    if (!pricingAddOns[addOnName.toLowerCase()]){
      throw new Error(`Add-on ${addOnName} declared in the subscription not found in pricing version ${pricing.version} in the request organization`);
    }

    _validateAddOnAvailability(addOnName, selectedPlan, pricing);
    _validateDependentAddOns(addOnName, selectedAddOns, pricing);
    _validateExcludedAddOns(addOnName, selectedAddOns, pricing);
    _validateAddOnQuantity(addOnName, selectedAddOns, pricing);
  }
}

function _validateAddOnAvailability(
  addOnName: string,
  selectedPlan: string | undefined,
  pricing: LeanPricing
): void {
  if (
    selectedPlan && pricing.addOns![addOnName] &&
    !(pricing.addOns![addOnName].availableFor ?? Object.keys(pricing.plans!))?.map(p => p.toLowerCase()).includes(selectedPlan.toLowerCase())
  ) {
    throw new Error(
      `Add-on ${addOnName} is not available for plan ${selectedPlan} in the request organization`
    );
  }
}

function _validateDependentAddOns(
  addOnName: string,
  selectedAddOns: Record<string, number>,
  pricing: LeanPricing
): void {

  const dependentAddOns = pricing.addOns![addOnName].dependsOn ?? [];
  if (!dependentAddOns.every(dependentAddOn => selectedAddOns.hasOwnProperty(dependentAddOn))) {
    throw new Error(
      `Add-on ${addOnName} requires the following add-ons to be selected in the request organization: ${dependentAddOns.join(', ')}`
    );
  }
}

function _validateExcludedAddOns(
  addOnName: string,
  selectedAddOns: Record<string, number>,
  pricing: LeanPricing
): void {
  const excludedAddOns = pricing.addOns![addOnName].excludes ?? [];
  if (excludedAddOns.some(excludedAddOn => selectedAddOns.hasOwnProperty(excludedAddOn))) {
    throw new Error(
      `Add-on ${addOnName} cannot be selected with the following add-ons in the request organization: ${excludedAddOns.join(', ')}`
    );
  }
}

function _validateAddOnQuantity(
  addOnName: string,
  selectedAddOns: Record<string, number>,
  pricing: LeanPricing
): void {
  const quantity = selectedAddOns[addOnName];
  const minQuantity = pricing.addOns![addOnName].subscriptionConstraints?.minQuantity ?? 1;
  const maxQuantity = pricing.addOns![addOnName].subscriptionConstraints?.maxQuantity ?? Infinity;
  const quantityStep = pricing.addOns![addOnName].subscriptionConstraints?.quantityStep ?? 1;

  const isValidQuantity =
    quantity >= minQuantity &&
    quantity <= maxQuantity &&
    (quantity - minQuantity) % quantityStep === 0;

  if (!isValidQuantity) {
    throw new Error(
      `Add-on ${addOnName} quantity ${quantity} is not valid. It must be between ${minQuantity} and ${maxQuantity}, and a multiple of ${quantityStep} in the request organization`
    );
  }
}

export { create, novate, incrementUsageLevels, novateUserContact, novateBillingPeriod, isSubscriptionValid, isSubscriptionValidInPricing };
