import request from 'supertest';
import { Server } from 'http';
import { JSONWebKeySet, createLocalJWKSet, jwtVerify } from 'jose';
import { baseUrl } from './testApp';

/** The JWKS the server publishes (`GET /api/v1/.well-known/jwks.json`, no API key). */
export async function fetchPricingTokenJwks(app: Server): Promise<JSONWebKeySet> {
  const response = await request(app).get(`${baseUrl}/.well-known/jwks.json`);
  if (response.status !== 200) {
    throw new Error(`GET ${baseUrl}/.well-known/jwks.json answered ${response.status}`);
  }
  return response.body as JSONWebKeySet;
}

/**
 * Verifies a pricing token the way an organization does: published public
 * keys, ES256 only, with `exp`, `iss` and `aud` required and, when given, the
 * issuer and the organization (audience) pinned.
 */
export async function verifyPricingToken(
  app: Server,
  token: string,
  options: { issuer?: string; audience?: string } = {}
) {
  return jwtVerify(token, createLocalJWKSet(await fetchPricingTokenJwks(app)), {
    algorithms: ['ES256'],
    requiredClaims: ['exp', 'iss', 'aud'],
    ...(options.issuer !== undefined ? { issuer: options.issuer } : {}),
    ...(options.audience !== undefined ? { audience: options.audience } : {}),
  });
}
