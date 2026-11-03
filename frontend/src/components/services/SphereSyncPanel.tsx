import { useEffect, useState } from 'react';
import { FiArrowUpRight, FiCheck, FiClock, FiExternalLink, FiGitBranch, FiLayers, FiRefreshCw, FiRotateCcw, FiSettings, FiShield, FiUsers, FiAlertCircle, FiLock, FiPlay, FiPause } from 'react-icons/fi';
import { previewSphere, runSynchronization, updateSynchronization, resumeSynchronization, sphereAccessRequired, sphereError } from '@/api/services/sphereApi';
import type { Manifest, Policy, SphereConfig, SyncState, SphereVersion } from '@/api/services/sphereApi';
import SphereFields, { allWarning } from './SphereFields';
import { disableService } from '@/api/services/servicesApi';
import { spherePricingUrl } from '@/lib/sphereUrl';
import { useCustomConfirm } from '@/hooks/useCustomConfirm';
import PricingContractCounts from './PricingContractCounts';

const surface = 'rounded-2xl border border-indigo-100 bg-white dark:border-gray-800 dark:bg-gray-900';
const secondary = 'text-sm text-gray-500 dark:text-gray-400';
const button = 'cursor-pointer inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-wait disabled:opacity-50';
const statusLabels: Record<string, string> = { ready: 'Up to date', queued: 'Update queued', checking: 'Checking for updates', applying: 'Updating contracts', degraded: 'Connection issue', blocked: 'Needs attention' };
const date = (value?: string) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not yet available';

export default function SphereSyncPanel({ state, apiKey, organizationId, service, onChange, canManage, canDisable }: {
  state: SyncState; apiKey: string; organizationId: string; service: string; onChange: (state: SyncState) => void; canManage: boolean; canDisable: boolean;
}) {
  const config = state.configuration!;
  const pricingUrl = spherePricingUrl(config.permanentUrl, import.meta.env.SPHERE_PUBLIC_URL);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SphereConfig>(config);
  const [busy, setBusy] = useState(false);
  const [draftValidated, setDraftValidated] = useState(false);
  const [accessRevision, setAccessRevision] = useState(0);
  const [error, setError] = useState('');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  const { showConfirm, confirmElement } = useCustomConfirm();
  const { permanentUrl, policy, selectedVersionId } = config;
  const targetId = config.target.versionId;

  useEffect(() => {
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryError('');
    previewSphere(apiKey, organizationId, { permanentUrl, policy, selectedVersionId }, service)
      .then(result => { if (!cancelled) setManifest(result); })
      .catch(error => { if (!cancelled) { setManifest(null); setHistoryError(sphereError(error)); } })
      .finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [apiKey, organizationId, permanentUrl, policy, selectedVersionId, targetId, config.lastCheckedAt, config.lastSyncedAt, historyRevision, service]);

  async function execute(save: boolean) {
    setBusy(true); setError('');
    try {
      const result = await (save ? updateSynchronization(apiKey, organizationId, service, draft) : runSynchronization(apiKey, organizationId, service));
      onChange(result);
      if (save) { setEditing(false); setDraft(result.configuration!); setDraftValidated(false); }
      setHistoryRevision(value => value + 1);
    } catch (error) {
      if (save && sphereAccessRequired(error)) {
        setDraftValidated(false); setAccessRevision(revision => revision + 1);
      }
      setError(sphereError(error));
    } finally { setBusy(false); }
  }

  async function changeAvailability(resume: boolean) {
    if (!resume && !await showConfirm('Disable this service? Its features will be unavailable. Contracts, usage, billing dates and pricing versions will be preserved.', 'warning')) return;
    setBusy(true); setError('');
    try {
      if (resume) onChange(await resumeSynchronization(apiKey, organizationId, service));
      else {
        await disableService(apiKey, organizationId, service);
        onChange({ ...state, disabled: true });
      }
      setEditing(false); setDraft(config); setDraftValidated(false);
      setHistoryRevision(value => value + 1);
    } catch (error) { setError(sphereError(error)); } finally { setBusy(false); }
  }

  async function switchVersion(version: { version: string; versionId: string }) {
    const all = config.policy.startsWith('all_');
    const latestId = manifest?.latestVersionId;
    const followLatest = version.versionId === latestId;
    const scope = all
      ? 'All contracts will be moved to this version; incompatible subscriptions fall back to the cheapest valid plan.'
      : 'New contracts will use this version. Existing contracts keep their current pricing.';
    const mode = followLatest ? 'SPACE will keep following the latest accessible version.' : `SPACE will stay pinned to v${version.version} and ignore newer releases until you change it.`;
    if (!await showConfirm(`Switch to v${version.version}? ${mode} ${scope}`, 'warning')) return;
    setBusy(true); setError('');
    try {
      onChange(await updateSynchronization(apiKey, organizationId, service, {
        permanentUrl, pollIntervalMinutes: config.pollIntervalMinutes,
        policy: `${all ? 'all' : 'new'}_${followLatest ? 'last' : 'pick'}` as Policy,
        selectedVersionId: followLatest ? undefined : version.versionId,
      }));
      setHistoryRevision(value => value + 1);
    } catch (error) { setError(sphereError(error)); } finally { setBusy(false); }
  }

  const allContracts = config.policy.startsWith('all_');
  const latest = config.policy.endsWith('_last');
  const healthy = !state.disabled && config.status === 'ready';
  const attention = state.disabled || ['degraded', 'blocked'].includes(config.status);
  const versions: Pick<SphereVersion, 'version' | 'versionId' | 'createdAt' | 'private'>[] = manifest
    ? [...manifest.versions].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : state.retainedVersions.map(v => ({ version: v.version, versionId: v.version, createdAt: '' }));

  return <section aria-label="SPHERE synchronization" className="space-y-6 text-gray-700 dark:text-gray-200">
    {state.disabled && <div role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/40">
      <div className="flex items-center gap-2 font-semibold text-amber-950 dark:text-amber-100"><FiPause aria-hidden="true" />Service disabled</div>
      <p className="mt-2 text-sm leading-6 text-amber-900 dark:text-amber-200">Contracts, usage and pricing versions are preserved. Reactivate this service to restore feature availability and resume synchronization using its existing policy.</p>
      {canManage && <div className="mt-4 flex justify-end"><button type="button" disabled={busy} className={`${button} bg-indigo-600 text-white hover:bg-indigo-700 dark:hover:bg-indigo-800`} onClick={() => changeAvailability(true)}><FiPlay aria-hidden="true" />{busy ? 'Reactivating…' : 'Reactivate service'}</button></div>}
    </div>}
    <div className="grid gap-5 lg:grid-cols-3">
      <div className={`${surface} relative overflow-hidden p-6 sm:p-8 lg:col-span-2`}>
        <div className="absolute -right-12 -top-16 h-56 w-56 rounded-full bg-indigo-50 dark:bg-indigo-950/40" aria-hidden="true" />
        <div className="relative">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-semibold text-indigo-600 dark:text-indigo-300"><FiGitBranch aria-hidden="true" /> SPHERE connected</span>
            <span role="status" className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${healthy ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : attention ? 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'}`}>
              {state.disabled ? <FiPause aria-hidden="true" /> : healthy ? <FiCheck aria-hidden="true" /> : attention ? <FiAlertCircle aria-hidden="true" /> : <FiRefreshCw aria-hidden="true" />} {state.disabled ? 'Disabled' : statusLabels[config.status] ?? config.status}
            </span>
          </div>
          <p className="mt-7 text-sm text-gray-500 dark:text-gray-400">Applied pricing version</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-3"><h2 className="text-5xl font-bold tracking-tight text-indigo-800 dark:text-gray-100">v{config.target.version}</h2><span className="rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-600 dark:bg-indigo-950 dark:text-indigo-300">Applied target</span></div>
          <p className="mt-3 max-w-lg text-sm leading-6 text-gray-500 dark:text-gray-400">{state.disabled ? 'Existing contracts keep their pricing versions while this service is disabled.' : allContracts ? 'Existing and new contracts follow this pricing version.' : 'New contracts use this version. Existing contracts keep their current pricing.'}</p>
          <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-indigo-100 pt-5 dark:border-gray-800">
            <div className="flex items-center gap-2 text-sm"><FiLayers className="text-indigo-500" aria-hidden="true" /><span className="font-semibold">{config.name}</span></div>
            <span className={secondary}>Published {date(config.target.createdAt)}</span>
            <a href={pricingUrl} target="_blank" rel="noreferrer" className="cursor-pointer inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-indigo-600 hover:text-indigo-800 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300">Open in SPHERE <FiArrowUpRight aria-hidden="true" /></a>
          </div>
        </div>
      </div>
      <div className={`${surface} flex flex-col p-6`}>
        <h2 className="flex items-center gap-2 font-bold text-indigo-700 dark:text-gray-100"><FiRefreshCw aria-hidden="true" /> Synchronization</h2>
        <dl className="mt-5 space-y-5">
          <div><dt className={secondary}>Version selection</dt><dd className="mt-1 font-semibold">{latest ? 'Latest accessible version' : 'Selected version'}</dd></div>
          <div><dt className={secondary}>Contract scope</dt><dd className="mt-1 font-semibold">{allContracts ? 'All contracts' : 'New contracts only'}</dd></div>
          <div><dt className={secondary}>Automatic checks</dt><dd className="mt-1 flex items-center gap-2 font-semibold"><FiClock className="text-indigo-500" aria-hidden="true" />{state.disabled ? 'Paused' : `Every ${config.pollIntervalMinutes ?? 5} ${(config.pollIntervalMinutes ?? 5) === 1 ? 'minute' : 'minutes'}`}</dd></div>
        </dl>
        {canManage && !state.disabled && <div className="mt-6 grid gap-2">
          <button type="button" disabled={busy || config.status === 'applying'} className={`${button} bg-indigo-600 text-white hover:bg-indigo-700 dark:hover:bg-indigo-800`} onClick={() => execute(false)}><FiRefreshCw className={busy ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />{busy ? 'Synchronizing…' : 'Synchronize now'}</button>
          <button type="button" disabled={busy || config.status === 'applying'} aria-expanded={editing} className={`${button} bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700`} onClick={() => { setDraft(config); setDraftValidated(false); setEditing(!editing); }}><FiSettings aria-hidden="true" />{editing ? 'Cancel editing' : 'Edit synchronization'}</button>
        </div>}
        {canDisable && !state.disabled && <div className="mt-3 flex justify-end"><button type="button" disabled={busy || config.status === 'applying'} className={`${button} border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800`} onClick={() => changeAvailability(false)}><FiPause aria-hidden="true" />Disable service</button></div>}
      </div>
    </div>

    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{error} Try synchronizing again or review your settings.</div>}
    {(config.error || state.run?.error) && <div role="status" className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"><FiAlertCircle className="mt-0.5 shrink-0" aria-hidden="true" /><div><p className="font-semibold">Synchronization needs attention</p><p className="mt-1">{config.error || state.run?.error}. Current pricing copies remain available. Review your settings and try again.</p></div></div>}
    {config.status === 'applying' && <p role="status" className="rounded-xl bg-indigo-50 p-4 text-sm text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200">Updating contracts · {state.run?.migrated ?? 0} updated so far. The applied version will change when the update completes.</p>}

    <PricingContractCounts counts={state.contractCounts} versions={versions.map(version => version.version)} target={config.target.version} disabled={state.disabled} />

    {canManage && !state.disabled && editing && <div className={`${surface} p-6 sm:p-8`}>
      <h2 className="mb-5 text-lg font-bold text-indigo-700 dark:text-gray-100">Synchronization settings</h2>
      <SphereFields key={accessRevision} value={draft} onChange={setDraft} apiKey={apiKey} organizationId={organizationId} serviceName={service} hasApiKey={config.hasApiKey} disabled={busy} onValidated={setDraftValidated} locked />
      <div className="mt-5 flex justify-end"><button type="button" disabled={busy || !draftValidated || (draft.policy.endsWith('_pick') && !draft.selectedVersionId)} className={`${button} bg-indigo-600 text-white hover:bg-indigo-700 dark:hover:bg-indigo-800`} onClick={() => execute(true)}>Save synchronization</button></div>
    </div>}

    <div className="grid items-start gap-5 lg:grid-cols-3">
      <div className={`${surface} overflow-hidden lg:col-span-2`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-100 p-6 dark:border-gray-800"><div><h2 className="font-bold text-indigo-700 dark:text-gray-100">Pricing versions</h2><p className={`${secondary} mt-1`}>Versions accessible in SPHERE and their availability in SPACE.</p></div><span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold dark:bg-gray-800">{versions.length} {manifest ? 'accessible' : 'retained'}</span></div>
        {historyLoading ? <p role="status" className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading versions…</p> : <>
          {historyError && <div role="status" className="border-b border-amber-100 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"><p>SPHERE history is unavailable. Showing versions retained in SPACE.</p><p className="mt-1 break-words text-xs">{historyError}</p><div className="flex justify-end"><button type="button" onClick={() => setHistoryRevision(value => value + 1)} className={`${button} mt-2 border border-amber-300 dark:border-amber-800`}>Retry loading versions</button></div></div>}
          <div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Accessible pricing versions and local availability</caption><thead className="sticky top-0 bg-gray-50 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"><tr><th scope="col" className="px-6 py-3 font-medium">Version</th><th scope="col" className="px-4 py-3 font-medium">Published</th><th scope="col" className="px-4 py-3 font-medium">Availability</th>{canManage && <th scope="col" className="px-4 py-3 text-right font-medium">Actions</th>}</tr></thead><tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {versions.map(version => {
              const applied = version.version === config.target.version;
              const retained = state.retainedVersions.some(v => v.version === version.version);
              return <tr key={version.versionId} className={applied ? 'bg-indigo-50/60 dark:bg-indigo-950/30' : ''}><th scope="row" className="whitespace-nowrap px-6 py-4 font-semibold text-gray-800 dark:text-gray-100"><span className="inline-flex items-center gap-2"><FiGitBranch className={applied ? 'text-indigo-600 dark:text-indigo-300' : 'text-gray-400'} aria-hidden="true" />v{version.version}{version.private && <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300"><FiLock aria-hidden="true" />Private</span>}</span></th><td className="whitespace-nowrap px-4 py-4 text-xs text-gray-500 dark:text-gray-400">{version.createdAt ? date(version.createdAt) : 'Unavailable'}</td><td className="whitespace-nowrap px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${applied ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300'}`}>{applied ? 'Applied target' : retained ? 'Retained in SPACE' : 'SPHERE only'}</span></td>{canManage && <td className="whitespace-nowrap px-4 py-4 text-right">{!state.disabled && !applied && manifest && <button type="button" disabled={busy || config.status === 'applying'} aria-label={`Switch to version ${version.version}`} onClick={() => switchVersion(version)} className="cursor-pointer inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-wait disabled:opacity-50 dark:text-indigo-300 dark:hover:bg-indigo-950"><FiRotateCcw aria-hidden="true" />Use this version</button>}</td>}</tr>;
            })}
          </tbody></table>{versions.length === 0 && <p className="p-6 text-sm text-gray-500 dark:text-gray-400">No versions available. Open SPHERE to review public releases.</p>}</div>
        </>}
        <p className="border-t border-indigo-100 px-6 py-4 text-xs leading-5 text-gray-500 dark:border-gray-800 dark:text-gray-400">SPACE retains the applied target and versions used by contracts. Other releases remain listed in SPHERE while accessible.</p>
      </div>
      <div className={`${surface} p-6`}>
        <h2 className="font-bold text-indigo-700 dark:text-gray-100">Latest synchronization</h2>
        <dl className="mt-5 space-y-5">
          <div><dt className={`flex items-center gap-2 ${secondary}`}><FiClock aria-hidden="true" />Last version check</dt><dd className="mt-1.5 text-sm font-medium">{date(config.lastCheckedAt)}</dd></div>
          <div><dt className={`flex items-center gap-2 ${secondary}`}><FiCheck aria-hidden="true" />Last successful update</dt><dd className="mt-1.5 text-sm font-medium">{date(config.lastSyncedAt)}</dd></div>
        </dl>
        <div className="mt-6 border-t border-indigo-100 pt-5 dark:border-gray-800"><h3 className="flex items-center gap-2 text-sm font-semibold"><FiUsers className="text-indigo-500" aria-hidden="true" />Last completed migration</h3><div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800"><p className="text-2xl font-bold text-indigo-800 dark:text-gray-100">{config.migrated ?? 0}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Contracts updated</p></div><div className="rounded-xl bg-gray-50 p-3 dark:bg-gray-800"><p className="text-2xl font-bold text-indigo-800 dark:text-gray-100">{config.replaced ?? 0}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Plans replaced</p></div></div><p className="mt-3 text-xs leading-5 text-gray-500 dark:text-gray-400">Replaced subscriptions use the cheapest valid plan, with no add-ons.</p></div>
      </div>
    </div>
    {allContracts && <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-5 py-4 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"><FiShield className="mt-0.5 shrink-0" aria-hidden="true" /><div><h3 className="text-sm font-semibold">How contract updates work</h3><p className="mt-1 text-xs leading-5">{allWarning}</p></div></div>}
    <a href={pricingUrl} target="_blank" rel="noreferrer" className="cursor-pointer inline-flex min-h-11 items-center gap-2 text-sm font-medium text-indigo-600 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300">Manage pricing and publish new versions in SPHERE <FiExternalLink aria-hidden="true" /></a>
    {confirmElement}
  </section>;
}
