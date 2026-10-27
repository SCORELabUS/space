import dotenv from 'dotenv';
import { DetailedFeatureEvaluation, PricingContext, SubscriptionContext } from '../types/models/FeatureEvaluation';
import { SignJWT } from 'jose';
import { pbkdf2Sync } from 'crypto';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_SALT = process.env.JWT_SALT; // Will be used to generate a secure JWT secret from the one configured
const JWT_EXPIRATION = process.env.JWT_EXPIRATION ?? '1h'; // Time in duration format (e.g., "1h", "2d", "3m")
// `iss` of pricing tokens (RFC 7519 §4.1.1). Stable by default so that every
// replica issues the same value and verifiers can pin it; deployments that share
// a JWT secret between servers set a distinct one per server.
const JWT_ISSUER = process.env.JWT_ISSUER || 'space';

/**
 * The subscription a pricing token was computed from (optional claim
 * `subscription`): pricing versions (unescaped), plans and add-ons per service,
 * and the contractVersion of the contract.
 */
export interface PricingTokenSubscription {
  contractedServices: Record<string, string>;
  subscriptionPlans: Record<string, string>;
  subscriptionAddOns: Record<string, Record<string, number>>;
  contractVersion: string;
}

async function generateTokenFromEvalResult(
  userId: string,
  pricingContext: PricingContext,
  subscriptionContext: SubscriptionContext,
  evalResult: DetailedFeatureEvaluation,
  subscription: PricingTokenSubscription | undefined,
  organizationId: string
): Promise<string> {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is not defined!');
  }

  if (!JWT_SALT) {
    throw new Error('JWT_SALT environment variable is not defined!');
  }

  if (!organizationId) {
    throw new Error('INTERNAL ERROR: a pricing token is issued for a contract of an organization');
  }

  // A userId is only unique within an organization (RFC 7519 §4.1.2: `sub` is
  // unique within the issuer), so `sub` names both, as a URN (RFC 7519 §2: a
  // StringOrURI with ":" is a URI) whose last part is the percent-encoded userId
  // (any ":", "/", space or non-ASCII character in it stays unambiguous; the
  // organization id is 24 hex characters). Clients read the explicit `userId`
  // and `organizationId` claims, not `sub`. `aud` is the organization (RFC 8725 §3.9).
  const tokenSub = `urn:space:${organizationId}:${encodeURIComponent(userId)}`;

  const payload = {
    userId,
    organizationId,
    features: evalResult,
    pricingContext: pricingContext,
    subscriptionContext: subscriptionContext,
    ...(subscription ? { subscription } : {}),
  };

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt() // Automatically sets the 'iat' claim
    .setExpirationTime(JWT_EXPIRATION) // Sets the 'exp' claim
    .setSubject(tokenSub) // Sets the 'sub' claim
    .setIssuer(JWT_ISSUER)
    .setAudience(organizationId)
    .sign(encryptJWTSecret(JWT_SECRET));

  return token;
}

function encryptJWTSecret(secret: string): Buffer {
  return pbkdf2Sync(secret, JWT_SALT!, 100_000, 32, 'sha256');
}

export { generateTokenFromEvalResult, encryptJWTSecret };
