import type { NextFunction, Request, Response } from 'express';

/**
 * Features of the pricing-renderer API design that this server implements,
 * advertised on every response as `X-Space-Capabilities: <token>,<token>...`.
 * Clients check a token before relying on the guarantee it stands for (for
 * example `contract-version` before sending `expectedContractVersion`).
 * Add the token of a feature here, once, when the feature is implemented.
 */
export const SPACE_CAPABILITIES: readonly string[] = Object.freeze([
  'contract-org-scope',
  'contract-version',
  'keep-billing-period',
  'reject-private',
  'pricing-yaml',
]);

export const CAPABILITIES_HEADER = 'X-Space-Capabilities';

const headerValue = SPACE_CAPABILITIES.join(',');

/** Sets the capability header; registered first, so errors, preflights and static files carry it too. */
export function capabilitiesMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(CAPABILITIES_HEADER, headerValue);
  next();
}
