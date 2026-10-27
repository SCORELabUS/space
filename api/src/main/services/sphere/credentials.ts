import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption at rest of the SPHERE API key of a linked service.
 *
 * AES-256-GCM with a 32-byte key from `SPHERE_KEY_ENCRYPTION_KEY` (base64 or
 * hex). The service id is bound as additional authenticated data, so a stored
 * credential cannot be copied to another service. The key is read when used,
 * so it can be rotated by re-entering the SPHERE keys after a restart.
 */

export interface SphereCredential {
  v: 1;
  iv: string;
  tag: string;
  data: string;
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

function encryptionKey(): Buffer {
  const raw = process.env.SPHERE_KEY_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new SphereCredentialError(
      'SPHERE API keys cannot be stored: set SPHERE_KEY_ENCRYPTION_KEY (32 bytes, base64 or hex) first'
    );
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new SphereCredentialError('SPHERE_KEY_ENCRYPTION_KEY must be 32 bytes, encoded as base64 or hex');
  }
  return key;
}

export function encryptSphereApiKey(apiKey: string, serviceId: string): SphereCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from(`space:sphere:${serviceId}`, 'utf8'));
  const data = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decryptSphereApiKey(credential: SphereCredential, serviceId: string): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(credential.iv, 'base64'));
    decipher.setAAD(Buffer.from(`space:sphere:${serviceId}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(credential.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(credential.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof SphereCredentialError) throw error;
    throw new SphereCredentialError(
      'The stored SPHERE API key cannot be decrypted (was SPHERE_KEY_ENCRYPTION_KEY changed?); enter it again'
    );
  }
}
