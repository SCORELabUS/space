import path from 'node:path';

/**
 * Where SPACE keeps the Pricing2Yaml snapshots of SPHERE versions.
 *
 * Public versions keep their historical place under `public/static/pricings/sphere/`
 * (served by `express.static`, like uploaded pricings). Private versions
 * (SPHERE H11, `private: true` in the manifest) must never be reachable without
 * authorisation, so they are stored outside `public/`, under the private files
 * directory (`SPACE_PRIVATE_FILES_DIR`, default `./private`), and only served
 * through the authorised `GET .../pricings/{version}?format=yaml` route. Their
 * `yamlPath` is a logical path (`/private/sphere/...`), not a URL.
 */

export const PUBLIC_SNAPSHOT_PREFIX = '/static/pricings/sphere/';
export const PRIVATE_SNAPSHOT_PREFIX = '/private/sphere/';

/** Directory for files that must not be served statically. Refuses a directory inside `public/`. */
export function privateFilesRoot(): string {
  const root = path.resolve(process.env.SPACE_PRIVATE_FILES_DIR || 'private');
  const publicRoot = path.resolve('public');
  if (root === publicRoot || root.startsWith(publicRoot + path.sep)) {
    throw new Error('SPACE_PRIVATE_FILES_DIR must not be inside public/, which is served without authorisation');
  }
  return root;
}

export function isPrivateSnapshotPath(yamlPath?: string): boolean {
  return typeof yamlPath === 'string' && yamlPath.startsWith(PRIVATE_SNAPSHOT_PREFIX);
}

/** `yamlPath` of the snapshot of a SPHERE version. */
export function snapshotYamlPath(serviceId: string, versionId: string, isPrivate: boolean): string {
  return `${isPrivate ? PRIVATE_SNAPSHOT_PREFIX : PUBLIC_SNAPSHOT_PREFIX}${serviceId}/${versionId}.yaml`;
}

/**
 * The file a stored `yamlPath` refers to: private snapshots under the private
 * files directory, everything else under `public/static/pricings/`. Undefined
 * for paths that would leave those directories.
 */
export function storedYamlFile(yamlPath: string): string | undefined {
  const relative = yamlPath.startsWith('/') ? yamlPath : `/${yamlPath}`;
  if (isPrivateSnapshotPath(relative)) {
    const root = path.resolve(privateFilesRoot(), 'sphere');
    const file = path.resolve(root, `.${relative.slice(PRIVATE_SNAPSHOT_PREFIX.length - 1)}`);
    return file.startsWith(root + path.sep) ? file : undefined;
  }
  const root = path.resolve('public', 'static', 'pricings');
  const file = path.resolve('public', `.${relative}`);
  return file.startsWith(root + path.sep) ? file : undefined;
}
