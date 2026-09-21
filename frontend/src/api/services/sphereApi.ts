import axios from '@/lib/axios';
import type { Service } from '@/types/Services';
export type Policy = 'all_last' | 'new_last' | 'all_pick' | 'new_pick';
export type PollingIntervalMinutes = 1 | 5 | 15;
export interface SphereConfig { permanentUrl: string; policy: Policy; selectedVersionId?: string; acceptedSyntaxUpgradeVersionId?: string; pollIntervalMinutes?: PollingIntervalMinutes }
export interface SphereVersion { versionId: string; version: string; createdAt: string; contentHash: string }
export interface SyntaxUpgrade { versionId: string; from: string; to: string }
export interface Manifest { pricingId: string; name: string; permanentUrl: string; versions: SphereVersion[]; latestVersionId: string; syntaxUpgrade?: SyntaxUpgrade }
export interface SyncState {
  source: 'manual' | 'sphere';
  configuration: (SphereConfig & { name: string; status: string; target: SphereVersion; lastCheckedAt?: string;
    lastSyncedAt?: string; error?: string; migrated?: number; replaced?: number }) | null;
  retainedVersions: { version: string }[];
  run?: { status: string; error?: string; migrated?: number; replaced?: number } | null;
}
const options = (apiKey: string) => ({ headers: { 'x-api-key': apiKey }, timeout: 30000 });
const base = (org: string) => `/organizations/${encodeURIComponent(org)}/services`;
export const sphereError = (error: unknown): string => {
  const e = error as { response?: { data?: { error?: string } }; message?: string };
  return e.response?.data?.error || e.message || 'Unable to contact SPHERE';
};
export async function previewSphere(key: string, org: string, config: SphereConfig): Promise<Manifest> {
  return (await axios.post(base(org) + '/sphere/preview', config, options(key))).data;
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
