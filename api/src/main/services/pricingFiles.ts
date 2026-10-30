import fs from 'node:fs';
import path from 'node:path';

/**
 * Where SPACE keeps Pricing2Yaml files.
 *
 * Pricing files hold an organization's whole pricing, private plans and add-ons
 * included, so they are never stored under `public/` (which `express.static`
 * serves without authentication). They live in the private files directory
 * (`SPACE_PRIVATE_FILES_DIR`, default `./private`) and are only served through
 * the authorised `GET .../pricings/{version}?format=yaml` route.
 *
 * A stored `yamlPath` is a logical reference, not a URL:
 * - `/private/pricings/<organization>-<service>-<version>.yaml`: uploaded pricings;
 * - `/private/sphere/<serviceId>/<versionId>.yaml`: SPHERE snapshots.
 *
 * Versions of SPACE before this change stored them under
 * `public/static/pricings/` with `yamlPath` `/static/pricings/...`. Those
 * legacy references are still understood (see `privateYamlPathFor`), and
 * `movePricingFilesOutOfPublic` moves the files and rewrites the references.
 */

export const PRIVATE_PRICINGS_PREFIX = '/private/pricings/';
export const PRIVATE_SPHERE_PREFIX = '/private/sphere/';
export const LEGACY_PRICINGS_PREFIX = '/static/pricings/';
export const LEGACY_SPHERE_PREFIX = '/static/pricings/sphere/';

/** URL prefixes that must never be answered by `express.static`. */
const PROTECTED_STATIC_PREFIXES = ['/static/pricings', '/private'];

export function publicRoot(): string {
  return path.resolve('public');
}

/** Legacy directory of pricing files inside `public/`. */
export function legacyPublicPricingsRoot(): string {
  return path.resolve('public', 'static', 'pricings');
}

/** Directory for files that must not be served statically. Refuses a directory inside `public/`. */
export function privateFilesRoot(): string {
  const root = path.resolve(process.env.SPACE_PRIVATE_FILES_DIR || 'private');
  const publicDirectory = publicRoot();
  if (root === publicDirectory || root.startsWith(publicDirectory + path.sep)) {
    throw new Error('SPACE_PRIVATE_FILES_DIR must not be inside public/, which is served without authorisation');
  }
  return root;
}

/** Temporary directory for pricing files received by multipart uploads. */
export function pricingUploadsDirectory(): string {
  return path.join(privateFilesRoot(), 'uploads');
}

/** `yamlPath` of an uploaded pricing file (`fileName` is already sanitised). */
export function uploadedPricingYamlPath(fileName: string): string {
  return `${PRIVATE_PRICINGS_PREFIX}${fileName}`;
}

/** `yamlPath` of the snapshot of a SPHERE version. */
export function sphereSnapshotYamlPath(serviceId: string, versionId: string): string {
  return `${PRIVATE_SPHERE_PREFIX}${serviceId}/${versionId}.yaml`;
}

export function isLegacyYamlPath(yamlPath?: string | null): yamlPath is string {
  return typeof yamlPath === 'string' && yamlPath.startsWith(LEGACY_PRICINGS_PREFIX);
}

export function isSphereSnapshotYamlPath(yamlPath?: string | null): yamlPath is string {
  return typeof yamlPath === 'string' && (yamlPath.startsWith(PRIVATE_SPHERE_PREFIX) || yamlPath.startsWith(LEGACY_SPHERE_PREFIX));
}

/** The private `yamlPath` a legacy `/static/pricings/...` reference moves to; other paths are returned unchanged. */
export function privateYamlPathFor(yamlPath: string): string {
  if (yamlPath.startsWith(LEGACY_SPHERE_PREFIX)) return PRIVATE_SPHERE_PREFIX + yamlPath.slice(LEGACY_SPHERE_PREFIX.length);
  if (yamlPath.startsWith(LEGACY_PRICINGS_PREFIX)) return PRIVATE_PRICINGS_PREFIX + yamlPath.slice(LEGACY_PRICINGS_PREFIX.length);
  return yamlPath;
}

/** `rest` resolved inside `root`, or undefined when it would leave it. */
function contained(root: string, rest: string): string | undefined {
  if (!rest || rest.includes('\0') || rest.includes('\\')) return undefined;
  const file = path.resolve(root, `.${path.sep}${rest}`);
  return file.startsWith(root + path.sep) ? file : undefined;
}

/**
 * The file a stored `yamlPath` refers to, in the private files directory, or
 * undefined for paths that are not pricing files or would leave their directory.
 * Legacy `/static/pricings/...` references resolve to where the migration moves them.
 */
export function pricingYamlFile(yamlPath: string): string | undefined {
  const logical = privateYamlPathFor(yamlPath);
  if (logical.startsWith(PRIVATE_SPHERE_PREFIX)) {
    return contained(path.join(privateFilesRoot(), 'sphere'), logical.slice(PRIVATE_SPHERE_PREFIX.length));
  }
  if (logical.startsWith(PRIVATE_PRICINGS_PREFIX)) {
    return contained(path.join(privateFilesRoot(), 'pricings'), logical.slice(PRIVATE_PRICINGS_PREFIX.length));
  }
  return undefined;
}

/** Where a legacy `/static/pricings/...` reference was stored inside `public/`, or undefined. */
export function legacyPublicYamlFile(yamlPath: string): string | undefined {
  if (!isLegacyYamlPath(yamlPath)) return undefined;
  return contained(legacyPublicPricingsRoot(), yamlPath.slice(LEGACY_PRICINGS_PREFIX.length));
}

/**
 * The stored bytes of a pricing file, or undefined when there is none. A legacy
 * reference whose file has not been moved yet is read from its old place, so
 * authorised reads keep working until the migration has run.
 */
export function readPricingYaml(yamlPath: string): Buffer | undefined {
  for (const file of [pricingYamlFile(yamlPath), legacyPublicYamlFile(yamlPath)]) {
    if (!file) continue;
    try {
      return fs.readFileSync(file);
    } catch {
      // try the next location
    }
  }
  return undefined;
}

/** Remove the stored file of a `yamlPath` (and its legacy copy in `public/`, if any). */
export function removePricingYaml(yamlPath: string): void {
  for (const file of [pricingYamlFile(yamlPath), legacyPublicYamlFile(yamlPath)]) {
    if (file) fs.rmSync(file, { force: true });
  }
}

/**
 * Whether a request path would make `express.static('public')` (send) serve a
 * file of a protected tree, or is too malformed to decide. Decided on the
 * decoded, normalised path, treating backslashes as separators and ignoring
 * case, so that `..`, `%2e%2e`, encoded slashes, doubled slashes and the like
 * cannot reach a pricing file.
 */
export function isProtectedStaticPath(rawPathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return true;
  }
  if (decoded.includes('\0')) return true;
  const normalized = path.posix.normalize(`/${decoded.replace(/\\/g, '/')}`).toLowerCase();
  return PROTECTED_STATIC_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
