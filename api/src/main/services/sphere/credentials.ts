import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption at rest of the SPHERE API key of a linked service.
 *
 * AES-256-GCM with a 32-byte key from `SPHERE_KEY_ENCRYPTION_KEY` (strict
 * base64, 44 characters, or hex, 64 characters). The service id, the SPHERE
 * pricing id and the SPHERE origin the key is sent to are bound as additional
 * authenticated data, so a stored credential cannot be copied to another
 * service or pricing, and it is never released for another SPHERE origin.
 *
 * Rotation: set the new key as `SPHERE_KEY_ENCRYPTION_KEY` and the old one as
 * `SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS`. Credentials that only the previous key
 * decrypts are reported as `rotated`, and the caller re-encrypts them with the
 * current key. Once every service has been synchronized, remove the previous
 * key.
 */

export interface SphereCredential {
  v: 1;
  iv: string;
  tag: string;
  data: string;
  /** Origin of the SPHERE API the key may be sent to (authenticated). */
  origin: string;
  /** SPHERE pricing the key was entered for (authenticated). */
  pricingId: string;
}

/** What a credential is bound to. */
export interface SphereCredentialContext {
  serviceId: string;
  origin: string;
  pricingId: string;
}

/** Thrown when a SPHERE API key cannot be stored or used. Never contains the key. */
export class SphereCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SphereCredentialError';
  }
}

/** SPHERE API keys are opaque tokens: printable ASCII without spaces, at most 512 characters. */
export function isValidSphereApiKey(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value);
}

function parseEncryptionKey(name: string, raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) return Buffer.from(value, 'base64');
  throw new SphereCredentialError(`${name} must be 32 bytes, encoded as base64 (44 characters) or hex (64 characters)`);
}

function encryptionKey(): Buffer {
  const raw = process.env.SPHERE_KEY_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new SphereCredentialError(
      'SPHERE API keys cannot be stored: set SPHERE_KEY_ENCRYPTION_KEY (32 bytes, base64 or hex) first'
    );
  }
  return parseEncryptionKey('SPHERE_KEY_ENCRYPTION_KEY', raw);
}

function previousEncryptionKey(): Buffer | undefined {
  const raw = process.env.SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS?.trim();
  return raw ? parseEncryptionKey('SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS', raw) : undefined;
}

const additionalData = (context: SphereCredentialContext) =>
  Buffer.from(`space:sphere:${context.serviceId}:${context.pricingId}:${context.origin}`, 'utf8');

export function encryptSphereApiKey(apiKey: string, context: SphereCredentialContext): SphereCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(additionalData(context));
  const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    origin: context.origin,
    pricingId: context.pricingId,
  };
}

function decryptWith(key: Buffer, credential: SphereCredential, context: SphereCredentialContext): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(credential.iv, 'base64'));
  decipher.setAAD(additionalData(context));
  decipher.setAuthTag(Buffer.from(credential.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(credential.data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * The API key of a stored credential, for the SPHERE origin and pricing it is
 * about to be sent to. `rotated` is true when only
 * `SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS` could decrypt it: re-encrypt it then.
 */
export function decryptSphereApiKey(
  credential: SphereCredential,
  context: SphereCredentialContext
): { apiKey: string; rotated: boolean } {
  if (credential.origin !== context.origin) {
    throw new SphereCredentialError(
      `The SPHERE API key of this service was entered for the SPHERE origin ${credential.origin}, but the SPHERE origin is now ${context.origin}; the key is not sent there. Enter it again`
    );
  }
  if (credential.pricingId !== context.pricingId) {
    throw new SphereCredentialError('The SPHERE API key of this service was entered for another SPHERE pricing; enter it again');
  }
  const current = encryptionKey();
  try {
    return { apiKey: decryptWith(current, credential, context), rotated: false };
  } catch {
    // Fall through to the previous key, if any.
  }
  const previous = previousEncryptionKey();
  if (previous) {
    try {
      return { apiKey: decryptWith(previous, credential, context), rotated: true };
    } catch {
      // Reported below.
    }
  }
  throw new SphereCredentialError(
    'The stored SPHERE API key cannot be decrypted (was SPHERE_KEY_ENCRYPTION_KEY changed without SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS?); enter it again'
  );
}
