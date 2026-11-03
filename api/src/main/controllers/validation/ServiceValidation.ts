import { check } from 'express-validator';

const update = [
  check('name')
    .optional()
    .isString()
    .withMessage('The name field must be a string')
    .isLength({ min: 1, max: 255 })
    .withMessage('The name must be between 1 and 255 characters long')
    .trim(),
  check('defaultVersion')
    .optional({ values: 'null' })
    .isString()
    .withMessage('The defaultVersion field must be a string (an active pricing version) or null')
    .isLength({ min: 1 })
    .withMessage('The defaultVersion field cannot be empty'),
  check('organizationId')
    .optional()
    .isString()
    .withMessage('The organizationId field must be a string')
    .isLength({ min: 24, max: 24 })
    .withMessage('The organizationId must be 24 characters long')
    .trim()
];

function validateLegalKeysInObject(object: any, objectName: string): void {
  for (const key of Object.keys(object)) {
    if (/[^\w-]/.test(key)) {
      throw new Error(`Invalid key in ${objectName}: "${key}". Keys must not contain "." or other invalid characters.`);
    }
  }
}

export { update, validateLegalKeysInObject };
