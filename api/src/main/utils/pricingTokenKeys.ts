import { KeyObject, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { calculateJwkThumbprint, decodeProtectedHeader } from 'jose';

/**
 * Keys of the pricing tokens.
 *
 * Pricing tokens are signed with ES256 (ECDSA P-256 / SHA-256). The public
 * keys are published as a JWKS (`GET /.well-known/jwks.json`), so that any
 * organization can verify a token without holding anything that lets it mint
 * one. The private key never leaves this module: it is not logged, not
 * included in error messages and never part of the JWKS.
 *
 * Configuration (see `api/.env.template` and `docs/pricing-tokens.md`):
 * - `PRICING_TOKEN_PRIVATE_KEY`: EC P-256 private key, PEM (PKCS#8 or SEC1;
 *   `\n` escapes accepted) or a private JWK (its `kid` is kept).
 * - `PRICING_TOKEN_PRIVATE_KEY_FILE`: path to a file with such a key. With
 *   `PRICING_TOKEN_GENERATE_KEY=true` a missing file is created once (0600).
 * - `PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS` / `..._FILE`: public keys published
 *   besides the current one (previous keys whose tokens have not expired, or
 *   the next key before switching): PEM blocks, a JWKS or an array of JWKs.
 * - `PRICING_TOKEN_ALG=HS256`: legacy mode, signs with the shared
 *   `JWT_SECRET` as before. Deprecated; publishes no signing key.
 *
 * Without a key, a throw-away key is generated in development and testing
 * (with a warning) and the server refuses to start anywhere else.
 */

export type PricingTokenAlgorithm = 'ES256' | 'HS256';

export interface PricingTokenPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  alg: 'ES256';
  use: 'sig';
}

export interface PricingTokenJwks {
  keys: PricingTokenPublicJwk[];
}

export type PricingTokenKeySource = 'configured' | 'file' | 'generated-file' | 'ephemeral';

export type PricingTokenSigner =
  | { alg: 'ES256'; kid: string; privateKey: KeyObject; source: PricingTokenKeySource }
  | { alg: 'HS256' };

export interface PricingTokenKeys {
  signer: PricingTokenSigner;
  jwks: PricingTokenJwks;
  /** Messages for the operator (logged by `initPricingTokenKeys`); never contain key material. */
  warnings: string[];
}

/** A configuration that cannot be used. Messages never contain key material. */
export class PricingTokenKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingTokenKeyConfigError';
  }
}

type Env = Record<string, string | undefined>;

const PRIVATE_KEY = 'PRICING_TOKEN_PRIVATE_KEY';
const PRIVATE_KEY_FILE = 'PRICING_TOKEN_PRIVATE_KEY_FILE';
const GENERATE_KEY = 'PRICING_TOKEN_GENERATE_KEY';
const PREVIOUS_KEYS = 'PRICING_TOKEN_PREVIOUS_PUBLIC_KEYS';
const ALGORITHM = 'PRICING_TOKEN_ALG';

const KEYGEN_COMMAND = 'openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out pricing-token-key.pem';
const DEVELOPMENT_ENVIRONMENTS = ['development', 'testing'];
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'];

const banner = (lines: string[]) => {
  const rule = '='.repeat(78);
  return [rule, ...lines, rule].join('\n');
};

const setting = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
};

function parseAlgorithm(env: Env): PricingTokenAlgorithm {
  const value = (setting(env, ALGORITHM) ?? 'ES256').trim().toUpperCase();
  if (value !== 'ES256' && value !== 'HS256') {
    throw new PricingTokenKeyConfigError(`${ALGORITHM} must be ES256 (default) or HS256 (legacy).`);
  }
  return value;
}

function assertP256(key: KeyObject, source: string): void {
  const type = key.asymmetricKeyType;
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (type !== 'ec' || curve !== 'prime256v1') {
    throw new PricingTokenKeyConfigError(
      `${source} must be an EC P-256 key (ES256), got ${type ?? 'unknown'}${curve ? ` ${curve}` : ''}. Generate one with: ${KEYGEN_COMMAND}`
    );
  }
}

function parseJson(text: string, source: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new PricingTokenKeyConfigError(`${source} is not valid JSON.`);
  }
}

const unescapeNewlines = (text: string) => text.replace(/\\n/g, '\n');

/** Parses a private key; errors name the setting, never the value. */
function parsePrivateKey(text: string, source: string): { privateKey: KeyObject; kid?: string } {
  const trimmed = text.trim();
  let privateKey: KeyObject;
  let kid: string | undefined;

  if (trimmed.startsWith('{')) {
    const jwk = parseJson(trimmed, source);
    try {
      privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
    } catch {
      throw new PricingTokenKeyConfigError(`${source} is not a usable private JWK.`);
    }
    if (typeof jwk.kid === 'string' && jwk.kid !== '') kid = jwk.kid;
  } else {
    const pem = unescapeNewlines(trimmed);
    if (!/-----BEGIN (EC )?PRIVATE KEY-----/.test(pem)) {
      throw new PricingTokenKeyConfigError(
        `${source} must be an EC P-256 private key: PEM (PKCS#8 or SEC1) or a private JWK.`
      );
    }
    try {
      privateKey = createPrivateKey({ key: pem, format: 'pem' });
    } catch {
      throw new PricingTokenKeyConfigError(`${source} could not be read as a PEM private key.`);
    }
  }

  assertP256(privateKey, source);
  return { privateKey, kid };
}

/** The public JWK as published: only `kty`, `crv`, `x`, `y`, plus `kid`, `alg` and `use`. */
async function publicJwk(publicKey: KeyObject, kid?: string): Promise<PricingTokenPublicJwk> {
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' }) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  return { kty, crv, x, y, kid: kid ?? (await calculateJwkThumbprint({ kty, crv, x, y })), alg: 'ES256', use: 'sig' };
}

/** Parses the previously used (or upcoming) public keys. Private material is refused, not stripped. */
async function parsePublicKeys(text: string, source: string): Promise<PricingTokenPublicJwk[]> {
  const trimmed = text.trim();
  const keys: PricingTokenPublicJwk[] = [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, source);
    const entries: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.keys) ? parsed.keys : [parsed];
    for (const [index, jwk] of entries.entries()) {
      const label = `${source} (key ${index + 1})`;
      if (typeof jwk !== 'object' || jwk === null) {
        throw new PricingTokenKeyConfigError(`${label} is not a JWK.`);
      }
      if (PRIVATE_JWK_MEMBERS.some(member => member in jwk)) {
        throw new PricingTokenKeyConfigError(`${label} contains private key material; list public keys only.`);
      }
      if (jwk.alg !== undefined && jwk.alg !== 'ES256') {
        throw new PricingTokenKeyConfigError(`${label} has alg ${String(jwk.alg)}; only ES256 keys can be published.`);
      }
      let publicKey: KeyObject;
      try {
        publicKey = createPublicKey({ key: jwk, format: 'jwk' });
      } catch {
        throw new PricingTokenKeyConfigError(`${label} is not a usable public JWK.`);
      }
      assertP256(publicKey, label);
      keys.push(await publicJwk(publicKey, typeof jwk.kid === 'string' && jwk.kid !== '' ? jwk.kid : undefined));
    }
    return keys;
  }

  const pem = unescapeNewlines(trimmed);
  if (/PRIVATE KEY-----/.test(pem)) {
    throw new PricingTokenKeyConfigError(`${source} contains a private key; list public keys only.`);
  }
  const blocks = pem.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g);
  if (!blocks) {
    throw new PricingTokenKeyConfigError(`${source} must hold PEM public keys ("BEGIN PUBLIC KEY"), a JWKS or a JSON array of JWKs.`);
  }
  for (const [index, block] of blocks.entries()) {
    const label = `${source} (key ${index + 1})`;
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey({ key: block, format: 'pem' });
    } catch {
      throw new PricingTokenKeyConfigError(`${label} could not be read as a PEM public key.`);
    }
    assertP256(publicKey, label);
    keys.push(await publicJwk(publicKey));
  }
  return keys;
}

function readFile(path: string, source: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: any) {
    throw new PricingTokenKeyConfigError(`${source}: cannot read ${path} (${error?.code ?? 'error'}).`);
  }
}

/** Creates the key file once. Concurrent starts (several replicas on one volume) settle on the first file. */
function generateKeyFile(path: string): 'created' | 'exists' {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    return 'created';
  } catch (error: any) {
    if (error?.code === 'EEXIST') return 'exists';
    throw new PricingTokenKeyConfigError(`${PRIVATE_KEY_FILE}: cannot create ${path} (${error?.code ?? 'error'}).`);
  }
}

function previousKeysText(env: Env, warnings: string[]): { text: string; source: string } | undefined {
  const inline = setting(env, PREVIOUS_KEYS);
  const file = setting(env, `${PREVIOUS_KEYS}_FILE`);
  if (inline !== undefined) {
    if (file !== undefined) warnings.push(`Both ${PREVIOUS_KEYS} and ${PREVIOUS_KEYS}_FILE are set; using ${PREVIOUS_KEYS}.`);
    return { text: inline, source: PREVIOUS_KEYS };
  }
  if (file !== undefined) {
    return { text: readFile(file, `${PREVIOUS_KEYS}_FILE`), source: `${PREVIOUS_KEYS}_FILE` };
  }
  return undefined;
}

function mergeKeys(keys: PricingTokenPublicJwk[]): PricingTokenPublicJwk[] {
  const byKid = new Map<string, PricingTokenPublicJwk>();
  for (const key of keys) {
    const known = byKid.get(key.kid);
    if (!known) {
      byKid.set(key.kid, key);
    } else if (known.x !== key.x || known.y !== key.y) {
      throw new PricingTokenKeyConfigError(`Two different pricing token keys use the kid "${key.kid}".`);
    }
  }
  return [...byKid.values()];
}

/** Reads the configuration. Pure apart from reading (and, when asked, creating) the key file. */
export async function loadPricingTokenKeys(env: Env = process.env): Promise<PricingTokenKeys> {
  const warnings: string[] = [];
  const alg = parseAlgorithm(env);
  const previousSetting = previousKeysText(env, warnings);
  const previous = previousSetting ? await parsePublicKeys(previousSetting.text, previousSetting.source) : [];

  if (alg === 'HS256') {
    warnings.push(
      banner([
        `WARNING: ${ALGORITHM}=HS256 (deprecated). Pricing tokens are signed with the shared JWT_SECRET:`,
        'anyone able to verify them can also forge them, for every organization of this server.',
        `Configure ${PRIVATE_KEY} or ${PRIVATE_KEY_FILE} and remove ${ALGORITHM} to sign with ES256.`,
      ])
    );
    return { signer: { alg }, jwks: { keys: mergeKeys(previous) }, warnings };
  }

  const inline = setting(env, PRIVATE_KEY);
  const file = setting(env, PRIVATE_KEY_FILE);
  const generate = (setting(env, GENERATE_KEY) ?? '').trim().toLowerCase() === 'true';
  let parsed: { privateKey: KeyObject; kid?: string };
  let source: PricingTokenKeySource;

  if (inline !== undefined) {
    if (file !== undefined) warnings.push(`Both ${PRIVATE_KEY} and ${PRIVATE_KEY_FILE} are set; using ${PRIVATE_KEY}.`);
    parsed = parsePrivateKey(inline, PRIVATE_KEY);
    source = 'configured';
  } else if (file !== undefined) {
    source = 'file';
    if (!existsSync(file)) {
      if (!generate) {
        throw new PricingTokenKeyConfigError(
          `${PRIVATE_KEY_FILE} points to ${file}, which does not exist. Create it with: ${KEYGEN_COMMAND} ` +
            `(or set ${GENERATE_KEY}=true to let SPACE create it on first start).`
        );
      }
      if (generateKeyFile(file) === 'created') source = 'generated-file';
    }
    parsed = parsePrivateKey(readFile(file, PRIVATE_KEY_FILE), `${PRIVATE_KEY_FILE} (${file})`);
  } else if (generate) {
    throw new PricingTokenKeyConfigError(`${GENERATE_KEY}=true needs ${PRIVATE_KEY_FILE}: the path where the key is kept.`);
  } else if (DEVELOPMENT_ENVIRONMENTS.includes(env.ENVIRONMENT ?? '')) {
    parsed = { privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey };
    source = 'ephemeral';
  } else {
    throw new PricingTokenKeyConfigError(
      `No pricing token signing key. Set ${PRIVATE_KEY} (PEM or JWK) or ${PRIVATE_KEY_FILE} (path) to an EC P-256 ` +
        `private key, generated with: ${KEYGEN_COMMAND}. ` +
        `(A throw-away key is only generated when ENVIRONMENT is development or testing.)`
    );
  }

  const current = await publicJwk(createPublicKey(parsed.privateKey), parsed.kid);

  if (source === 'ephemeral') {
    warnings.push(
      banner([
        `WARNING: no pricing token signing key (${PRIVATE_KEY} / ${PRIVATE_KEY_FILE}).`,
        `Using a throw-away ES256 key generated for this process (kid ${current.kid}), because`,
        `ENVIRONMENT=${env.ENVIRONMENT}. Its tokens stop verifying when the process restarts and differ`,
        'between instances. Configure a key for anything but local development:',
        `  ${KEYGEN_COMMAND}`,
      ])
    );
  } else if (source === 'generated-file') {
    warnings.push(
      banner([
        `WARNING: generated a new pricing token signing key at ${file} (kid ${current.kid}).`,
        'Keep that file (persistent volume, backups): tokens only verify while its public key is published.',
        'Every instance of this server must use the same key.',
      ])
    );
  }

  return {
    signer: { alg: 'ES256', kid: current.kid, privateKey: parsed.privateKey, source },
    jwks: { keys: mergeKeys([current, ...previous]) },
    warnings,
  };
}

let loading: Promise<PricingTokenKeys> | null = null;
let loaded: PricingTokenKeys | null = null;

/** Loads the keys for this process (at startup) and logs the warnings. Throws on a configuration that cannot be used. */
export function initPricingTokenKeys(env: Env = process.env): Promise<PricingTokenKeys> {
  loaded = null;
  loading = loadPricingTokenKeys(env).then(keys => {
    keys.warnings.forEach(warning => console.warn(warning));
    loaded = keys;
    return keys;
  });
  return loading;
}

/** The keys of this process, loading them from `process.env` on first use. */
export function getPricingTokenKeys(): Promise<PricingTokenKeys> {
  return loading ?? initPricingTokenKeys();
}

/** The algorithm pricing tokens are signed with (from the loaded keys, else from the environment). */
export function pricingTokenAlgorithm(): PricingTokenAlgorithm {
  if (loaded) return loaded.signer.alg;
  return (process.env[ALGORITHM] ?? '').trim().toUpperCase() === 'HS256' ? 'HS256' : 'ES256';
}

/** Whether a (cached) token was signed with the current key; tokens of a previous key or algorithm are re-issued. */
export async function isSignedWithCurrentPricingTokenKey(token: string): Promise<boolean> {
  const { signer } = await getPricingTokenKeys();
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return false;
  }
  return signer.alg === 'HS256' ? header.alg === 'HS256' : header.alg === 'ES256' && header.kid === signer.kid;
}

/** Forgets the loaded keys (tests). */
export function resetPricingTokenKeys(): void {
  loading = null;
  loaded = null;
}
