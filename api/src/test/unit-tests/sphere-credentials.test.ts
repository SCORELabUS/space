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
const CONTEXT = {
  serviceId: '64b7f0c2a1b2c3d4e5f60718',
  origin: 'https://sphere.score.us.es',
  pricingId: '777777777777777777777777',
};

describe('SPHERE API key encryption', () => {
  const previous = process.env.SPHERE_KEY_ENCRYPTION_KEY;
  const previousOld = process.env.SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS;
  afterEach(() => {
    if (previous === undefined) delete process.env.SPHERE_KEY_ENCRYPTION_KEY;
    else process.env.SPHERE_KEY_ENCRYPTION_KEY = previous;
    if (previousOld === undefined) delete process.env.SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS;
    else process.env.SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS = previousOld;
  });

  it('round-trips with base64 and hex encryption keys', () => {
    for (const encoded of [KEY.toString('base64'), KEY.toString('hex')]) {
      process.env.SPHERE_KEY_ENCRYPTION_KEY = encoded;
      const credential = encryptSphereApiKey(API_KEY, CONTEXT);

      expect(JSON.stringify(credential)).not.toContain(API_KEY);
      expect(credential).toMatchObject({ v: 1, origin: CONTEXT.origin, pricingId: CONTEXT.pricingId });
      expect(decryptSphereApiKey(credential, CONTEXT)).toEqual({ apiKey: API_KEY, rotated: false });
    }
  });

  it('uses a fresh IV for each encryption', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');

    const first = encryptSphereApiKey(API_KEY, CONTEXT);
    const second = encryptSphereApiKey(API_KEY, CONTEXT);

    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
  });

  it('refuses to encrypt without a valid SPHERE_KEY_ENCRYPTION_KEY', () => {
    delete process.env.SPHERE_KEY_ENCRYPTION_KEY;
    expect(() => encryptSphereApiKey(API_KEY, CONTEXT)).toThrow(/SPHERE_KEY_ENCRYPTION_KEY/);

    process.env.SPHERE_KEY_ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    expect(() => encryptSphereApiKey(API_KEY, CONTEXT)).toThrow(SphereCredentialError);
  });

  it('accepts only strict base64 (44 characters) or hex (64 characters) encryption keys', () => {
    const base64 = KEY.toString('base64');
    for (const loose of [`*${base64}`, `${base64.slice(0, 20)} ${base64.slice(20)}`, base64.replace(/\+/g, '-').replace(/\//g, '_'), base64.slice(0, -1)]) {
      if (loose === base64) continue;
      process.env.SPHERE_KEY_ENCRYPTION_KEY = loose;
      expect(() => encryptSphereApiKey(API_KEY, CONTEXT), loose).toThrow(SphereCredentialError);
    }
  });

  it('detects tampering, another service, pricing or origin, and another encryption key', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');
    const credential = encryptSphereApiKey(API_KEY, CONTEXT);

    const tampered = { ...credential, data: Buffer.from('x' + credential.data).toString('base64') };
    expect(() => decryptSphereApiKey(tampered, CONTEXT)).toThrow(SphereCredentialError);
    expect(() => decryptSphereApiKey(credential, { ...CONTEXT, serviceId: '000000000000000000000000' })).toThrow(SphereCredentialError);
    expect(() => decryptSphereApiKey(credential, { ...CONTEXT, pricingId: '000000000000000000000000' })).toThrow(SphereCredentialError);
    // The stored origin is authenticated too: rewriting it does not help.
    const moved = { ...credential, origin: 'https://evil.example.org' };
    expect(() => decryptSphereApiKey(moved, { ...CONTEXT, origin: 'https://evil.example.org' })).toThrow(SphereCredentialError);

    process.env.SPHERE_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(() => decryptSphereApiKey(credential, CONTEXT)).toThrow(/cannot be decrypted/);
  });

  it('refuses to release the key for another SPHERE origin', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');
    const credential = encryptSphereApiKey(API_KEY, CONTEXT);

    expect(() => decryptSphereApiKey(credential, { ...CONTEXT, origin: 'https://other-sphere.example.org' })).toThrow(
      /origin/
    );
  });

  it('decrypts with SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS during a rotation and says so', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');
    const credential = encryptSphereApiKey(API_KEY, CONTEXT);

    process.env.SPHERE_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS = KEY.toString('base64');

    expect(decryptSphereApiKey(credential, CONTEXT)).toEqual({ apiKey: API_KEY, rotated: true });
    const reencrypted = encryptSphereApiKey(API_KEY, CONTEXT);
    delete process.env.SPHERE_KEY_ENCRYPTION_KEY_PREVIOUS;
    expect(decryptSphereApiKey(reencrypted, CONTEXT)).toEqual({ apiKey: API_KEY, rotated: false });
  });

  it('never puts the API key in error messages', () => {
    process.env.SPHERE_KEY_ENCRYPTION_KEY = KEY.toString('base64');
    const credential = encryptSphereApiKey(API_KEY, CONTEXT);
    process.env.SPHERE_KEY_ENCRYPTION_KEY = randomBytes(32).toString('base64');

    expect(() => decryptSphereApiKey(credential, CONTEXT)).toThrow();
    try {
      decryptSphereApiKey(credential, CONTEXT);
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
