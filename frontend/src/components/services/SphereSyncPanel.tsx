import { useState } from 'react';
import { runSynchronization, updateSynchronization, sphereError } from '@/api/services/sphereApi';
import type { SphereConfig, SyncState } from '@/api/services/sphereApi';
import SphereFields, { allWarning } from './SphereFields';
export default function SphereSyncPanel({ state, apiKey, organizationId, service, onChange, canManage }: {
  state: SyncState; apiKey: string; organizationId: string; service: string; onChange: (state: SyncState) => void; canManage: boolean;
}) {
  const config = state.configuration!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SphereConfig>(config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function execute(save: boolean) {
    setBusy(true); setError('');
    try {
      onChange(await (save ? updateSynchronization(apiKey, organizationId, service, draft) : runSynchronization(apiKey, organizationId, service)));
      if (save) setEditing(false);
    } catch (error) { setError(sphereError(error)); } finally { setBusy(false); }
  }
  return <section aria-label="SPHERE synchronization" className="my-6 space-y-4 rounded-2xl border border-indigo-100 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-gray-700 dark:text-gray-200">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold text-indigo-700 dark:text-indigo-300">Linked to SPHERE</h2><span role="status" className="rounded-full bg-indigo-50 dark:bg-indigo-950 px-3 py-1 text-sm">{config.status}</span></div>
    <a className="cursor-pointer text-indigo-600 dark:text-indigo-300 underline" href={config.permanentUrl} target="_blank" rel="noreferrer">{config.name}</a>
    <dl className="grid gap-2 text-sm"><div><dt className="inline font-semibold">Applied target: </dt><dd className="inline">{config.target.version}</dd></div>
      <div><dt className="inline font-semibold">Policy: </dt><dd className="inline">{config.policy.replace(/_/g, ' ')} version</dd></div>
      <div><dt className="inline font-semibold">Version checks: </dt><dd className="inline">Every {config.pollIntervalMinutes ?? 5} minutes</dd></div>
      <div><dt className="inline font-semibold">Last check: </dt><dd className="inline">{config.lastCheckedAt ? new Date(config.lastCheckedAt).toLocaleString() : 'Pending'}</dd></div>
      <div><dt className="inline font-semibold">Last success: </dt><dd className="inline">{config.lastSyncedAt ? new Date(config.lastSyncedAt).toLocaleString() : 'Pending'}</dd></div>
      <div><dt className="inline font-semibold">Retained versions: </dt><dd className="inline">{state.retainedVersions.map(v => v.version).join(', ')}</dd></div>
      <div><dt className="inline font-semibold">Last completed migration: </dt><dd className="inline">{config.migrated ?? 0} contracts; {config.replaced ?? 0} switched to the cheapest valid plan.</dd></div></dl>
    {config.error && <p role="status" className="rounded-lg bg-amber-50 dark:bg-amber-950 p-3 text-amber-900 dark:text-amber-100">{config.error}. Local copies remain available.</p>}
    <p className="text-sm">SPACE keeps only the applied target and versions currently used by contracts. Historical details depend on availability in SPHERE.</p>
    {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    {config.policy.startsWith('all_') && <p className="rounded-lg bg-amber-50 dark:bg-amber-950 p-3 text-sm text-amber-900 dark:text-amber-100">{allWarning}</p>}
    {config.status === 'applying' && <p role="status">Migration in progress: {state.run?.migrated ?? 0} contracts updated.</p>}
    {canManage && <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} className="cursor-pointer min-h-11 rounded-lg bg-indigo-600 px-4 text-white disabled:opacity-50" onClick={() => execute(false)}>Synchronize now</button>
      <button type="button" disabled={busy || config.status === 'applying'} className="cursor-pointer min-h-11 rounded-lg border px-4 disabled:opacity-50" onClick={() => { setDraft(config); setEditing(!editing); }}>{editing ? 'Cancel editing' : 'Edit synchronization'}</button>
    </div>}
    {canManage && editing && <div className="space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4"><SphereFields value={draft} onChange={setDraft} apiKey={apiKey} organizationId={organizationId} locked />
      <button type="button" disabled={busy || (draft.policy.endsWith('_pick') && !draft.selectedVersionId)} className="cursor-pointer min-h-11 rounded-lg bg-indigo-600 px-4 text-white disabled:opacity-50" onClick={() => execute(true)}>Save policy</button></div>}
  </section>;
}
