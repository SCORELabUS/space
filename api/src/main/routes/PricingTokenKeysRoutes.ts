import express from 'express';
import { getPricingTokenKeys } from '../utils/pricingTokenKeys';

/**
 * Public keys of the pricing tokens (JWKS, RFC 7517), so that organizations
 * can verify a token without a secret. Public: no API key. Served under the
 * API prefix (reachable through the bundled reverse proxies) and at the root
 * of the API server.
 *
 * Short cache lifetime: after a rotation, verifiers pick up a new key within
 * five minutes even behind HTTP caches (verifiers such as jose's
 * createRemoteJWKSet also refetch on an unknown `kid`).
 */
const JWKS_PATHS = ['/.well-known/jwks.json', '/api/v1/.well-known/jwks.json'];

const loadFileRoutes = function (app: express.Application) {
  app.get(JWKS_PATHS, async (_req: express.Request, res: express.Response) => {
    try {
      const { jwks } = await getPricingTokenKeys();
      res.set('Cache-Control', 'public, max-age=300');
      res.type('application/jwk-set+json').json(jwks);
    } catch {
      // The configuration is checked at startup; never echo it.
      res.status(503).json({ error: 'Pricing token keys are not available.' });
    }
  });
};

export default loadFileRoutes;
