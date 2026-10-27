import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SphereCredentialError,
  decryptSphereApiKey,
  encryptSphereApiKey,
  isValidSphereApiKey,
} from '../../main/services/sphere/credentials';

const KEY = randomBytes(32);
const API_KEY = 'sk-test-0123456789abcdef';
const SERVICE = '64b7f0c2a1b2c3d4e5f60718';

describe('SPHERE API key encryption', () => {
  const previous = process.env.SPHERE_KEY_ENCRYPTION_KEY;
  afterEach(() => {
    if (previous === undefined) delete process.env.SPHERE_KEY_ENCRYPTION_KEY;
    else process.env.SPHERE_KEY_ENCRYPTION_KEY = previous;
  });

  it('round-trips with base64 and hex encryption keys', () => {
    for (const encoded of [KEY.toString('base64'), KEY.toString('hex')]) {
      process.env.SPHERE_KEY_ENCRYPTION_KEY = encoded;
      const credential = encryptSphereApiKey(API_KEY, SERVICE);

      expect(JSON.stringify(credential)).not.toContain(API_KEY);
      expect(decryptSphereApiKey(credential, SERVICE)).toBe(API_KEY);
    }
  });

  it('uses a fresh IV for each encryption', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');

    const first = encryptSphereApiKey(API_KEY, SERVICE);
    const second = encryptSphereApiKey(API_KEY, SERVICE);

    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it('refuses to encrypt without a valid SPHERE_KEY_ENCRYPTION_KEY', () => {
    delete process.env.SPHERE_KEY_ENCRYPTION_KEY;
    expect(() => encryptSphereApiKey(API_KEY, SERVICE)).toThrow(/SPHERE_KEY_ENCRYPTION_KEY/);

    process.env.SPHERE_KEY_ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    expect(() => encryptSphereApiKey(API_KEY, SERVICE)).toThrow(SphereCredentialError);
  });

  it('detects tampering, another service and another encryption key', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');
    const credential = encryptSphereApiKey(API_KEY, SERVICE);

    const tampered = { ...credential, data: Buffer.from('x' + credential.data).toString('base64') };
    expect(() => decryptSphereApiKey(tampered, SERVICE)).toThrow(SphereCredentialError);
    expect(() => decryptSphereApiKey(credential, '000000000000000000000000')).toThrow(SphereCredentialError);

    process.env.SPHERE_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSphereApiKey(credential, SERVICE)).toThrow(/cannot be decrypted/);
  });

  it('never puts the API key in error messages', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');
    const credential = encryptSphereApiKey(API_KEY, SERVICE);
    process.env.SPHERE_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');

    try {
      decryptSphereApiKey(credential, SERVICE);
    } catch (error) {
      expect((error as Error).message).not.toContain(API_KEY);
    }
  });

  it('accepts opaque printable keys only', () => {
    expect(isValidSphereApiKey(API_KEY)).toBe(true);
    expect(isValidSphereApiKey('')).toBe(false);
    expect(isValidSphereApiKey('sk with spaces')).toBe(false);
    expect(isValidSphereApiKey('x'.repeat(513))).toBe(false);
    expect(isValidSphereApiKey(42)).toBe(false);
  });
});
