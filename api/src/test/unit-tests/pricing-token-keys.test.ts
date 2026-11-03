import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  JSONWebKeySet,
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  jwtVerify,
} from 'jose';
import {
  PricingTokenKeyConfigError,
  initPricingTokenKeys,
  isSignedWithCurrentPricingTokenKey,
  loadPricingTokenKeys,
  resetPricingTokenKeys,
} from '../../main/utils/pricingTokenKeys';
import { advertisedCapabilities, SPACE_CAPABILITIES } from '../../main/utils/capabilities';
import { encryptJWTSecret, generateTokenFromEvalResult } from '../../main/utils/jwt';

/**
 * Pricing tokens are signed with an ES256 (P-256) key whose public part is
 * published as a JWKS, so that an organization can verify a token without
 * holding anything that lets it mint tokens.
 */

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

const p256 = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pkcs8 = (key: KeyObject) => key.export({ type: 'pkcs8', format: 'pem' }) as string;
const spki = (key: KeyObject) => key.export({ type: 'spki', format: 'pem' }) as string;
const thumbprint = async (publicKey: KeyObject) => calculateJwkThumbprint(await exportJWK(publicKey));

const sign = (privateKey: KeyObject, kid: string, claims: Record<string, unknown> = { sub: 'user-1' }) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid }).setIssuedAt().setExpirationTime('5m').sign(privateKey);

const verifyWith = (token: string, jwks: JSONWebKeySet) =>
  jwtVerify(token, createLocalJWKSet(jwks), { algorithms: ['ES256'] });

const production = (extra: Record<string, string> = {}) => ({ ENVIRONMENT: 'production', ...extra });

/** Runs `fn` and returns everything written to the console meanwhile. */
async function captureConsole(fn: () => Promise<unknown>): Promise<{ output: string; error?: unknown }> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' '));
  };
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m =>
    vi.spyOn(console, m).mockImplementation(record)
  );
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    spies.forEach(s => s.mockRestore());
  }
  return { output: lines.join('\n'), error };
}

describe('Pricing token keys', function () {
  let dir: string;

  beforeAll(function () {
    dir = mkdtempSync(join(tmpdir(), 'space-pricing-token-keys-'));
  });

  afterAll(function () {
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(function () {
    resetPricingTokenKeys();
  });

  describe('missing key', function () {
    it.each(['development', 'testing'])('uses a throw-away key with a loud warning when ENVIRONMENT=%s', async function (env) {
      const keys = await loadPricingTokenKeys({ ENVIRONMENT: env });

      expect(keys.signer.alg).toBe('ES256');
      expect(keys.signer.alg === 'ES256' && keys.signer.source).toBe('ephemeral');
      expect(keys.jwks.keys).toHaveLength(1);
      expect(keys.warnings.join('\n')).toMatch(/WARNING/);
      expect(keys.warnings.join('\n')).toMatch(/openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256/);
    });

    it('generates a different throw-away key on every start', async function () {
      const first = await loadPricingTokenKeys({ ENVIRONMENT: 'development' });
      const second = await loadPricingTokenKeys({ ENVIRONMENT: 'development' });

      expect(first.jwks.keys[0].kid).not.toBe(second.jwks.keys[0].kid);
    });

    it.each([
      ['production', production()],
      ['an unset ENVIRONMENT', {}],
      ['an unknown ENVIRONMENT', { ENVIRONMENT: 'staging' }],
    ])('refuses to start in %s, saying how to configure one', async function (_label, env) {
      const error = await loadPricingTokenKeys(env).catch(e => e);

      expect(error).toBeInstanceOf(PricingTokenKeyConfigError);
      expect(error.message).toMatch(/PRICING_TOKEN_PRIVATE_KEY/);
      expect(error.message).toMatch(/PRICING_TOKEN_PRIVATE_KEY_FILE/);
      expect(error.message).toMatch(/openssl genpkey/);
    });

    it('fails at startup (initPricingTokenKeys) rather than on the first token', async function () {
      const { error } = await captureConsole(() => initPricingTokenKeys(production()));

      expect(error).toBeInstanceOf(PricingTokenKeyConfigError);
    });
  });

  describe('configured key', function () {
    it('signs ES256 with the RFC 7638 thumbprint as kid, verifiable with the published JWKS', async function () {
      const { privateKey, publicKey } = p256();
      const keys = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(privateKey) }));

      expect(keys.signer.alg).toBe('ES256');
      if (keys.signer.alg !== 'ES256') return;
      expect(keys.signer.kid).toBe(await thumbprint(publicKey));
      expect(keys.warnings).toEqual([]);
      expect(keys.jwks.keys).toEqual([
        { ...(await exportJWK(publicKey)), kid: keys.signer.kid, alg: 'ES256', use: 'sig' },
      ]);

      const token = await sign(keys.signer.privateKey, keys.signer.kid);
      const { protectedHeader, payload } = await verifyWith(token, keys.jwks);
      expect(protectedHeader).toEqual({ alg: 'ES256', kid: keys.signer.kid });
      expect(payload.sub).toBe('user-1');
    });

    it('accepts a PEM written on one line with \\n escapes (env files)', async function () {
      const { privateKey, publicKey } = p256();
      const oneLine = pkcs8(privateKey).trim().replace(/\n/g, '\\n');
      const keys = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: oneLine }));

      expect(keys.jwks.keys[0].kid).toBe(await thumbprint(publicKey));
    });

    it('accepts a SEC1 PEM (openssl ecparam -genkey) and a private JWK, keeping its kid', async function () {
      const { privateKey, publicKey } = p256();
      const sec1 = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
      const fromSec1 = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: sec1 }));
      expect(fromSec1.jwks.keys[0].kid).toBe(await thumbprint(publicKey));

      const jwk = { ...(await exportJWK(privateKey)), kid: 'space-2026-10' };
      const fromJwk = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: JSON.stringify(jwk) }));
      expect(fromJwk.signer.alg === 'ES256' && fromJwk.signer.kid).toBe('space-2026-10');
      expect(fromJwk.jwks.keys[0]).toMatchObject({ kid: 'space-2026-10', x: jwk.x, y: jwk.y });
    });

    it.each([
      ['an RSA key', () => pkcs8(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey)],
      ['a P-384 key', () => pkcs8(generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey)],
      ['an Ed25519 key', () => pkcs8(generateKeyPairSync('ed25519').privateKey)],
      ['a public key', () => spki(p256().publicKey)],
      ['garbage', () => 'not a key'],
      ['broken JSON', () => '{"kty":"EC",'],
      ['a truncated PEM', () => pkcs8(p256().privateKey).slice(0, 120)],
    ])('rejects %s without echoing it', async function (_label, make) {
      const value = make();
      const error = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: value })).catch(e => e);

      expect(error).toBeInstanceOf(PricingTokenKeyConfigError);
      expect(error.message).toMatch(/PRICING_TOKEN_PRIVATE_KEY/);
      expect(error.message).not.toContain(value.trim().split('\n')[1] ?? value.trim());
      expect(`${error.message}${error.stack}`).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    });

    it('rejects an unknown PRICING_TOKEN_ALG', async function () {
      for (const alg of ['none', 'RS256', 'EdDSA']) {
        const error = await loadPricingTokenKeys({ ENVIRONMENT: 'development', PRICING_TOKEN_ALG: alg }).catch(e => e);
        expect(error).toBeInstanceOf(PricingTokenKeyConfigError);
        expect(error.message).toMatch(/PRICING_TOKEN_ALG/);
      }
    });
  });

  describe('JWKS', function () {
    it('publishes only public members', async function () {
      const { privateKey } = p256();
      const previous = p256();
      const keys = await loadPricingTokenKeys(
        production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(privateKey), PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS: spki(previous.publicKey) })
      );
      const privateJwk = await exportJWK(privateKey);
      const serialized = JSON.stringify(keys.jwks);

      expect(keys.jwks.keys).toHaveLength(2);
      for (const key of keys.jwks.keys) {
        expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
        for (const member of PRIVATE_MEMBERS) expect(key).not.toHaveProperty(member);
      }
      expect(serialized).not.toContain(privateJwk.d);
    });

    it('rejects private key material in PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS', async function () {
      const { privateKey } = p256();
      const old = p256();
      const base = { PRICING_TOKEN_PRIVATE_KEY: pkcs8(privateKey) };

      for (const leaked of [pkcs8(old.privateKey), JSON.stringify({ keys: [await exportJWK(old.privateKey)] })]) {
        const error = await loadPricingTokenKeys(production({ ...base, PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS: leaked })).catch(e => e);
        expect(error).toBeInstanceOf(PricingTokenKeyConfigError);
        expect(error.message).toMatch(/private/i);
        expect(error.message).not.toContain((await exportJWK(old.privateKey)).d);
      }
    });
  });

  describe('rotation', function () {
    it('keeps publishing previous public keys, so tokens they signed still verify', async function () {
      const old = p256();
      const older = p256();
      const current = p256();
      const oldKid = await thumbprint(old.publicKey);
      const olderJwk = { ...(await exportJWK(older.publicKey)), kid: 'older' };
      const oldToken = await sign(old.privateKey, oldKid);
      const olderToken = await sign(older.privateKey, 'older');

      // Before: old key signs.
      const before = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(old.privateKey) }));
      await verifyWith(oldToken, before.jwks);

      // After rotating: current signs, old (PEM) and older (JWKS JSON) are still published.
      for (const previous of [
        spki(old.publicKey) + spki(older.publicKey),
        JSON.stringify({ keys: [await exportJWK(old.publicKey), olderJwk] }),
      ]) {
        const after = await loadPricingTokenKeys(
          production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(current.privateKey), PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS: previous })
        );
        if (after.signer.alg !== 'ES256') throw new Error('expected ES256');
        expect(after.jwks.keys[0].kid).toBe(after.signer.kid);
        expect(after.jwks.keys.map(k => k.kid)).toContain(oldKid);
        expect((await verifyWith(oldToken, after.jwks)).payload.sub).toBe('user-1');
        await verifyWith(await sign(after.signer.privateKey, after.signer.kid), after.jwks);
        if (previous.startsWith('{')) await verifyWith(olderToken, after.jwks);
      }

      // Once the old key is retired, its tokens no longer verify.
      const retired = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(current.privateKey) }));
      await expect(verifyWith(oldToken, retired.jwks)).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' });
    });

    it('reads previous keys from PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS_FILE and ignores a copy of the current key', async function () {
      const { privateKey, publicKey } = p256();
      const old = p256();
      const file = join(dir, 'previous.pem');
      writeFileSync(file, spki(old.publicKey) + '\n' + spki(publicKey));

      const keys = await loadPricingTokenKeys(
        production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(privateKey), PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS_FILE: file })
      );

      expect(keys.jwks.keys.map(k => k.kid)).toEqual([await thumbprint(publicKey), await thumbprint(old.publicKey)]);
    });

    it('rejects two different keys with the same kid', async function () {
      const { privateKey } = p256();
      const other = { ...(await exportJWK(p256().publicKey)), kid: 'k1' };
      const current = { ...(await exportJWK(privateKey)), kid: 'k1' };
      const error = await loadPricingTokenKeys(
        production({ PRICING_TOKEN_PRIVATE_KEY: JSON.stringify(current), PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS: JSON.stringify([other]) })
      ).catch(e => e);

      expect(error).toBeInstanceOf(PricingTokenKeyConfigError);
      expect(error.message).toMatch(/kid/);
    });

    it('does not verify a token signed by an unknown key that claims a published kid', async function () {
      const { privateKey } = p256();
      const keys = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(privateKey) }));
      const forged = await sign(p256().privateKey, keys.jwks.keys[0].kid);

      await expect(verifyWith(forged, keys.jwks)).rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
    });
  });

  describe('key file', function () {
    it('reads the key from PRICING_TOKEN_PRIVATE_KEY_FILE', async function () {
      const { privateKey, publicKey } = p256();
      const file = join(dir, 'configured.pem');
      writeFileSync(file, pkcs8(privateKey), { mode: 0o600 });

      const keys = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY_FILE: file }));

      expect(keys.signer.alg === 'ES256' && keys.signer.source).toBe('file');
      expect(keys.jwks.keys[0].kid).toBe(await thumbprint(publicKey));
    });

    it('refuses a missing file unless PRICING_TOKEN_GENERATE_KEY=true', async function () {
      const file = join(dir, 'missing.pem');
      const error = await loadPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY_FILE: file })).catch(e => e);

      expect(error).toBeInstanceOf(PricingTokenKeyConfigError);
      expect(error.message).toContain(file);
      expect(error.message).toMatch(/PRICING_TOKEN_GENERATE_KEY/);
    });

    it('generates the key once (mode 0600) and reuses it on the next start, never logging it', async function () {
      const file = join(dir, 'nested', 'generated.pem');
      const env = production({ PRICING_TOKEN_PRIVATE_KEY_FILE: file, PRICING_TOKEN_GENERATE_KEY: 'true' });

      let first: Awaited<ReturnType<typeof loadPricingTokenKeys>> | undefined;
      const { output, error } = await captureConsole(async () => {
        first = await initPricingTokenKeys(env);
      });
      expect(error).toBeUndefined();
      expect(first!.signer.alg === 'ES256' && first!.signer.source).toBe('generated-file');
      expect(output).toMatch(/WARNING/);
      expect(output).toContain(file);
      expect(statSync(file).mode & 0o777).toBe(0o600);

      const pem = readFileSync(file, 'utf8');
      expect(pem).toMatch(/BEGIN PRIVATE KEY/);
      expect(output).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
      expect(output).not.toContain(pem.split('\n')[1]);

      const second = await loadPricingTokenKeys(env);
      expect(second.signer.alg === 'ES256' && second.signer.source).toBe('file');
      expect(second.jwks.keys[0].kid).toBe(first!.jwks.keys[0].kid);
      expect(readFileSync(file, 'utf8')).toBe(pem);
    });

    it('prefers PRICING_TOKEN_PRIVATE_KEY over the file, with a warning', async function () {
      const inline = p256();
      const file = join(dir, 'ignored.pem');
      writeFileSync(file, pkcs8(p256().privateKey), { mode: 0o600 });

      const keys = await loadPricingTokenKeys(
        production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(inline.privateKey), PRICING_TOKEN_PRIVATE_KEY_FILE: file })
      );

      expect(keys.jwks.keys[0].kid).toBe(await thumbprint(inline.publicKey));
      expect(keys.warnings.join('\n')).toMatch(/PRICING_TOKEN_PRIVATE_KEY_FILE/);
    });
  });

  describe('legacy HS256 (PRICING_TOKEN_ALG=HS256)', function () {
    it('starts in production without an ES256 key, warns, and publishes no signing key', async function () {
      const keys = await loadPricingTokenKeys(production({ PRICING_TOKEN_ALG: 'HS256' }));

      expect(keys.signer.alg).toBe('HS256');
      expect(keys.jwks.keys).toEqual([]);
      expect(keys.warnings.join('\n')).toMatch(/HS256/);
    });

    it('signs with the derived JWT_SECRET and drops the pricing-token-jwks capability', async function () {
      await captureConsole(() => initPricingTokenKeys(production({ PRICING_TOKEN_ALG: 'hs256' })));

      const token = await generateTokenFromEvalResult('user-1', {} as any, {} as any, {} as any, undefined, '65f1c0ffee0000000000000a');
      const { protectedHeader } = await jwtVerify(token, encryptJWTSecret(process.env.JWT_SECRET!), { algorithms: ['HS256'] });

      expect(protectedHeader).toEqual({ alg: 'HS256' });
      expect(advertisedCapabilities()).not.toContain('pricing-token-jwks');
      expect(await isSignedWithCurrentPricingTokenKey(token)).toBe(true);
    });
  });

  describe('signing pricing tokens', function () {
    it('generateTokenFromEvalResult signs ES256 with the current kid', async function () {
      const { privateKey } = p256();
      const keys = await initPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(privateKey) }));

      const organizationId = '65f1c0ffee0000000000000a';
      const token = await generateTokenFromEvalResult('user-1', {} as any, {} as any, {} as any, undefined, organizationId);
      const { protectedHeader, payload } = await jwtVerify(token, createLocalJWKSet(keys.jwks), {
        algorithms: ['ES256'],
        issuer: process.env.JWT_ISSUER || 'space',
        audience: organizationId,
        requiredClaims: ['exp', 'iss', 'aud'],
      });

      expect(protectedHeader).toEqual({ alg: 'ES256', kid: keys.jwks.keys[0].kid });
      expect(payload).toMatchObject({
        sub: `urn:space:${organizationId}:user-1`,
        userId: 'user-1',
        organizationId,
        aud: organizationId,
        iss: process.env.JWT_ISSUER || 'space',
      });
      expect(typeof payload.exp).toBe('number');
      expect(advertisedCapabilities()).toEqual([...SPACE_CAPABILITIES]);
      expect(SPACE_CAPABILITIES).toContain('pricing-token-jwks');
    });

    it('tells tokens of the current key apart from older ones (for the token cache)', async function () {
      const { privateKey } = p256();
      const keys = await initPricingTokenKeys(production({ PRICING_TOKEN_PRIVATE_KEY: pkcs8(privateKey) }));
      const current = await generateTokenFromEvalResult('user-1', {} as any, {} as any, {} as any, undefined, '65f1c0ffee0000000000000a');
      const otherKid = await sign(p256().privateKey, 'other');
      const legacy = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(encryptJWTSecret('x'));

      expect(decodeProtectedHeader(current).kid).toBe(keys.jwks.keys[0].kid);
      expect(await isSignedWithCurrentPricingTokenKey(current)).toBe(true);
      expect(await isSignedWithCurrentPricingTokenKey(otherKid)).toBe(false);
      expect(await isSignedWithCurrentPricingTokenKey(legacy)).toBe(false);
      expect(await isSignedWithCurrentPricingTokenKey('not-a-token')).toBe(false);
    });
  });
});
