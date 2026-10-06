export const policies = ['all_last', 'new_last', 'all_pick', 'new_pick'] as const;
export const pollingIntervals = [1, 5, 15] as const;
export type PollingIntervalMinutes = typeof pollingIntervals[number];
export type SyncPolicy = typeof policies[number];
export function isSphereSyncEnabled(
  value = process.env.SPHERE_SYNC_ENABLED,
  environment = process.env.ENVIRONMENT
) {
  if (value !== undefined) return value === 'true';
  return environment !== 'testing';
}
export interface SphereVersion { versionId: string; version: string; createdAt: string; contentHash: string }
export interface SyntaxUpgrade { versionId: string; from: string; to: string }
export interface SphereManifest { pricingId: string; name: string; permanentUrl: string; latestVersionId: string; versions: SphereVersion[]; syntaxUpgrade?: SyntaxUpgrade }
export interface SphereConfiguration {
  permanentUrl: string; policy: SyncPolicy; selectedVersionId?: string;
  pollIntervalMinutes?: PollingIntervalMinutes;
  /** One-time acknowledgement for the version inspected during service creation. */
  acceptedSyntaxUpgradeVersionId?: string;
}
export interface SphereSource extends SphereConfiguration {
  pricingId: string; name: string; revision: number; target: SphereVersion;
  status: 'ready' | 'queued' | 'checking' | 'applying' | 'degraded' | 'blocked';
  lastCheckedAt?: Date; lastSyncedAt?: Date; error?: string; nextCheckAt?: Date;
  runId?: string; migrated?: number; replaced?: number;
}
export function validateConfiguration(value: SphereConfiguration) {
  if (!value || !policies.includes(value.policy)) throw new Error('Invalid synchronization policy');
  if (value.pollIntervalMinutes !== undefined && !pollingIntervals.includes(value.pollIntervalMinutes)) throw new Error('Invalid polling interval');
  if (value.policy.endsWith('_pick') && !/^[a-f\d]{24}$/i.test(value.selectedVersionId ?? '')) throw new Error('Invalid selected version');
}
export function selectVersion(manifest: SphereManifest, config: SphereConfiguration, current?: SphereVersion): SphereVersion {
  const versions = [...manifest.versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.versionId.localeCompare(a.versionId));
  const selected = config.policy.endsWith('_pick') ? versions.find(v => v.versionId === config.selectedVersionId) : versions[0];
  if (!selected) throw new Error('The selected pricing version is no longer public');
  if (current && config.policy.endsWith('_last') &&
      (Date.parse(selected.createdAt) < Date.parse(current.createdAt) ||
       (Date.parse(selected.createdAt) === Date.parse(current.createdAt) && selected.versionId < current.versionId))) {
    throw new Error('The applied version is no longer public; keeping the local copy');
  }
  return selected;
}
/**
 * Pricing2Yaml's `createdAt` may be a date (UTC midnight) or a date-time. SPHERE
 * stamps the exact instant into the YAML, so they normally agree to the
 * millisecond. A YAML that only holds a date (versions published before date-times
 * were supported) can only be checked at day precision.
 */
export function sameSnapshotCreatedAt(yamlCreatedAt: string | Date, sphereCreatedAt: string): boolean {
  const fromYaml = new Date(yamlCreatedAt).getTime();
  const fromSphere = Date.parse(sphereCreatedAt);
  if (!Number.isFinite(fromYaml) || !Number.isFinite(fromSphere)) return false;
  const dayMs = 24 * 60 * 60 * 1000;
  return fromYaml % dayMs === 0 ? Math.floor(fromSphere / dayMs) === fromYaml / dayMs : fromYaml === fromSphere;
}
