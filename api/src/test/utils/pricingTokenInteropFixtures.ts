/** Synthetic SPACE-issued tokens for the SDK-independent .NET example. No database or private-key files. */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { SignJWT } from 'jose';
import { generateTokenFromEvalResult } from '../../main/utils/jwt';
import { initPricingTokenKeys } from '../../main/utils/pricingTokenKeys';

const destination = process.argv[2];
if (!destination) throw new Error('Provide an output fixture path.');
const organizationId = '0123456789abcdef01234567';
const userId = 'customer-42';
const issuer = process.env.JWT_ISSUER || 'space';
const key = (kid: string) => ({ ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid });
const oldKey = key('space-interop-original-kid');
const newKey = key('space-interop-next-kid');
const old = await initPricingTokenKeys({ ENVIRONMENT: 'testing', PRICING_TOKEN_PRIVATE_KEY: JSON.stringify(oldKey) });
if (old.signer.alg !== 'ES256') throw new Error('Expected ES256');
const original = await generateTokenFromEvalResult(userId, { features: {}, usageLimits: {} }, {}, {}, {
  contractedServices: { storage: '1.2.0' }, subscriptionPlans: { storage: 'PRO' },
  subscriptionAddOns: {}, contractVersion: 'synthetic-contract-version',
}, organizationId, ['paused-service']);
const payload = { userId, organizationId, features: {}, pricingContext: {}, subscriptionContext: {} };
const sign = (overrides: Record<string, unknown> = {}, header: Record<string, string> = {}) =>
  new SignJWT({ ...payload, iss: issuer, aud: organizationId, exp: Math.floor(Date.now() / 1000) + 3600, ...overrides })
    .setProtectedHeader({ alg: 'ES256', kid: old.jwks.keys[0].kid, ...header })
    .sign(old.signer.alg === 'ES256' ? old.signer.privateKey : new Uint8Array());
const pieces = original.split('.');
pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
const missingExpiry = await new SignJWT({ ...payload, iss: issuer, aud: organizationId })
  .setProtectedHeader({ alg: 'ES256', kid: old.jwks.keys[0].kid }).sign(old.signer.privateKey);
const hmac = await new SignJWT({ ...payload, iss: issuer, aud: organizationId })
  .setProtectedHeader({ alg: 'HS256', kid: old.jwks.keys[0].kid }).setExpirationTime('1h').sign(new Uint8Array(32));
const tokens = {
  valid: original,
  tampered: pieces.join('.'),
  expired: await sign({ exp: Math.floor(Date.now() / 1000) - 120 }),
  future: await sign({ nbf: Math.floor(Date.now() / 1000) + 600 }),
  missingExpiry,
  wrongIssuer: await sign({ iss: 'untrusted-issuer' }),
  wrongAudience: await sign({ aud: 'different-organization' }),
  wrongOrganization: await sign({ organizationId: 'different-organization' }),
  wrongUser: await sign({ userId: 'different-user' }),
  unknownKid: await sign({}, { kid: 'unknown-key' }),
  hmac,
};
// Retain the custom original kid: rotation must not replace it with a PEM-derived thumbprint.
const rotated = await initPricingTokenKeys({ ENVIRONMENT: 'testing', PRICING_TOKEN_PRIVATE_KEY: JSON.stringify(newKey),
  PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS: JSON.stringify(old.jwks) });
const next = await generateTokenFromEvalResult(userId, { features: {}, usageLimits: {} }, {}, {}, undefined, organizationId);
writeFileSync(destination, JSON.stringify({ organizationId, userId, issuer, jwks: old.jwks,
  rotatedJwks: rotated.jwks, tokens: { ...tokens, rotated: next } }, null, 2));
console.log('Synthetic public interoperability fixtures written.');
