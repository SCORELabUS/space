import axios from '@/lib/axios';
import type { Service } from '@/types/Services';
export type Policy = 'all_last' | 'new_last' | 'all_pick' | 'new_pick';
export type PollingIntervalMinutes = 1 | 5 | 15;
export interface SphereConfig { permanentUrl: string; policy: Policy; selectedVersionId?: string; acceptedSyntaxUpgradeVersionId?: string; pollIntervalMinutes?: PollingIntervalMinutes; sphereApiKey?: string | null }
export interface SphereVersion { versionId: string; version: string; createdAt: string; contentHash: string; private?: boolean }
export interface SyntaxUpgrade { versionId: string; from: string; to: string }
export interface Manifest { pricingId: string; name: string; permanentUrl: string; versions: SphereVersion[]; latestVersionId: string; syntaxUpgrade?: SyntaxUpgrade }
export interface SyncState {
  source: 'manual' | 'sphere';
  disabled: boolean;
  configuration: (Omit<SphereConfig, 'sphereApiKey'> & { name: string; status: string; target: SphereVersion; hasApiKey?: boolean; lastCheckedAt?: string;
    lastSyncedAt?: string; error?: string; migrated?: number; replaced?: number }) | null;
  retainedVersions: { version: string }[];
  contractCounts?: { version: string; count: number }[];
  run?: { status: string; error?: string; migrated?: number; replaced?: number } | null;
}
const options = (apiKey: string) => ({ headers: { 'x-api-key': apiKey }, timeout: 30000 });
const base = (org: string) => `/organizations/${encodeURIComponent(org)}/services`;
export { sphereError, sphereAccessRequired } from '@/lib/sphereAccess';
export async function previewSphere(key: string, org: string, config: SphereConfig, serviceName?: string, signal?: AbortSignal): Promise<Manifest> {
  return (await axios.post(base(org) + '/sphere/preview', { ...config, ...(serviceName ? { serviceName } : {}) }, { ...options(key), signal })).data;
}
export async function createSphereService(key: string, org: string, config: SphereConfig): Promise<Service> {
  return (await axios.post(base(org), { ...config, source: 'sphere' }, options(key))).data;
}
export async function getSynchronization(key: string, org: string, service: string, signal?: AbortSignal): Promise<SyncState> {
  return (await axios.get(`${base(org)}/${encodeURIComponent(service)}/synchronization`, { ...options(key), signal })).data;
}
export async function updateSynchronization(key: string, org: string, service: string, config: SphereConfig): Promise<SyncState> {
  return (await axios.put(`${base(org)}/${encodeURIComponent(service)}/synchronization`, config, options(key))).data;
}
export async function runSynchronization(key: string, org: string, service: string): Promise<SyncState> {
  return (await axios.post(`${base(org)}/${encodeURIComponent(service)}/synchronization/run`, {}, options(key))).data;
}

export async function resumeSynchronization(key: string, org: string, service: string): Promise<SyncState> {
  return (await axios.post(`${base(org)}/${encodeURIComponent(service)}/synchronization/resume`, {}, options(key))).data;
}
