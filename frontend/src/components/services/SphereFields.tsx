import { useEffect, useId, useRef, useState } from 'react';
import { FiCheck, FiCheckCircle, FiEye, FiEyeOff, FiKey, FiLink, FiLock, FiRefreshCw } from 'react-icons/fi';
import { previewSphere, sphereAccessRequired, sphereError } from '@/api/services/sphereApi';
import type { Manifest, Policy, SphereConfig, SyntaxUpgrade, PollingIntervalMinutes } from '@/api/services/sphereApi';
import CustomSelect from '@/components/CustomSelect';
export const allWarning = 'All existing contracts will move to the target version. If their plan or add-ons are no longer valid, they will switch to the cheapest valid plan without add-ons. If no valid replacement exists, synchronization will be blocked.';
const input = 'mt-2 min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-gray-900 placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500';
const button = 'cursor-pointer inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';
const secondary = `${button} border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800`;
const primary = `${button} bg-indigo-600 text-white hover:bg-indigo-700 dark:hover:bg-indigo-800`;

export default function SphereFields({ value, onChange, apiKey, organizationId, onValidated, onSyntaxUpgrade, locked = false, hasApiKey = false, serviceName, disabled = false }: {
  value: SphereConfig; onChange: (v: SphereConfig) => void; apiKey: string; organizationId: string;
  onValidated?: (valid: boolean) => void; onSyntaxUpgrade?: (upgrade?: SyntaxUpgrade) => void;
  locked?: boolean; hasApiKey?: boolean; serviceName?: string; disabled?: boolean;
}) {
  const id = useId();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsKey, setNeedsKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [verifiedIdentity, setVerifiedIdentity] = useState('');
  const revision = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const callbacks = useRef({ onValidated, onSyntaxUpgrade });
  callbacks.current = { onValidated, onSyntaxUpgrade };
  const identity = JSON.stringify([apiKey, organizationId, serviceName, value.permanentUrl, value.sphereApiKey]);
  const ready = Boolean(manifest && verifiedIdentity === identity);
  const usesSavedKey = hasApiKey && value.sphereApiKey === undefined;
  const enteringKey = needsKey || typeof value.sphereApiKey === 'string';

  useEffect(() => {
    const lifecycle = revision;
    const requestController = pending;
    lifecycle.current++;
    requestController.current?.abort();
    setBusy(false); setManifest(null); setVerifiedIdentity(''); setError(''); setNeedsKey(false);
    callbacks.current.onValidated?.(false);
    callbacks.current.onSyntaxUpgrade?.(undefined);
    return () => { lifecycle.current++; requestController.current?.abort(); };
  }, [identity]);

  function invalidate() {
    revision.current++; pending.current?.abort(); setBusy(false); setError('');
    setManifest(null); setVerifiedIdentity('');
    onValidated?.(false); onSyntaxUpgrade?.(undefined);
  }

  function changeCredential(key: string | null | undefined) {
    invalidate();
    setNeedsKey(false);
    if (!key) setShowKey(false);
    const { sphereApiKey: _old, ...rest } = value;
    onChange({ ...rest, ...(key !== undefined ? { sphereApiKey: key } : {}), selectedVersionId: undefined, acceptedSyntaxUpgradeVersionId: undefined });
  }

  async function check(config = value) {
    if (disabled || !organizationId || !config.permanentUrl) return;
    const request = ++revision.current;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const requestIdentity = JSON.stringify([apiKey, organizationId, serviceName, config.permanentUrl, config.sphereApiKey]);
    setBusy(true); setError(''); onValidated?.(false); onSyntaxUpgrade?.(undefined);
    // Discover versions before asking for a specific selection when none exists yet.
    const query = config.policy.endsWith('_pick') && !config.selectedVersionId
      ? { ...config, policy: `${config.policy.startsWith('all_') ? 'all' : 'new'}_last` as Policy }
      : config;
    try {
      const result = await previewSphere(apiKey, organizationId, query, serviceName, controller.signal);
      if (request !== revision.current || controller.signal.aborted) return;
      const selection = result.versions.find(v => v.versionId === result.latestVersionId) ?? result.versions[0];
      setManifest(result); setVerifiedIdentity(requestIdentity); setNeedsKey(false);
      onSyntaxUpgrade?.(result.syntaxUpgrade);
      if (config.policy.endsWith('_pick') && !config.selectedVersionId) {
        onChange({ ...config, selectedVersionId: selection.versionId, acceptedSyntaxUpgradeVersionId: undefined });
      }
      onValidated?.(true);
    } catch (error) {
      if (request !== revision.current || controller.signal.aborted) return;
      setManifest(null); setVerifiedIdentity('');
      const accessRequired = sphereAccessRequired(error);
      if (accessRequired) setNeedsKey(true);
      // The access card explains anonymous restrictions; reserve the alert for failed keys and other errors.
      setError(accessRequired && !config.sphereApiKey && !usesSavedKey ? '' : sphereError(error));
    } finally { if (request === revision.current) setBusy(false); }
  }

  function changePolicy(policy: Policy) {
    const selectedVersionId = policy.endsWith('_pick')
      ? (manifest?.versions.some(v => v.versionId === value.selectedVersionId) ? value.selectedVersionId : manifest?.latestVersionId ?? manifest?.versions[0]?.versionId)
      : undefined;
    const next = { ...value, policy, selectedVersionId };
    const priorTarget = value.policy.endsWith('_pick') ? value.selectedVersionId : manifest?.latestVersionId;
    const nextTarget = policy.endsWith('_pick') ? selectedVersionId : manifest?.latestVersionId;
    onChange(next);
    if (priorTarget !== nextTarget) { onValidated?.(false); void check(next); }
  }

  const target = manifest?.versions.find(v => v.versionId === (value.policy.endsWith('_pick') ? value.selectedVersionId : manifest.latestVersionId));
  const privateCount = manifest?.versions.filter(v => v.private).length ?? 0;
  return <div className="mt-5 w-full space-y-5 text-sm text-gray-700 dark:text-gray-200">
    <section aria-labelledby={`${id}-link-title`} className="rounded-2xl border border-gray-200 bg-gray-50/70 p-4 sm:p-5 dark:border-gray-800 dark:bg-gray-950/40">
      <div className="mb-4 flex items-center gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"><FiLink aria-hidden="true" /></span><div><h3 id={`${id}-link-title`} className="font-semibold text-gray-900 dark:text-gray-100">Find your pricing</h3><p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Use the permanent link from SPHERE.</p></div></div>
      <label className="block font-medium" htmlFor={`${id}-url`}>SPHERE permanent link</label>
      <input id={`${id}-url`} type="url" readOnly={locked} disabled={disabled} value={value.permanentUrl} placeholder="https://sphere.score.us.es/p/…" className={input} onChange={event => {
        invalidate(); setNeedsKey(false); setShowKey(false);
        const { sphereApiKey: _key, ...rest } = value;
        onChange({ ...rest, permanentUrl: event.target.value, selectedVersionId: undefined, acceptedSyntaxUpgradeVersionId: undefined });
      }} />
      {!enteringKey && <div className="mt-4 flex justify-end"><button type="button" disabled={busy || disabled || !value.permanentUrl || !organizationId} className={secondary} onClick={() => check()}>{busy ? <FiRefreshCw className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FiLink aria-hidden="true" />}{busy ? 'Checking…' : 'Check pricing'}</button></div>}
    </section>

    {(enteringKey || usesSavedKey) && <section aria-labelledby={`${id}-access-title`} className={`rounded-2xl border p-4 sm:p-5 ${ready ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-indigo-200 bg-indigo-50/60 dark:border-indigo-900 dark:bg-indigo-950/30'}`}>
      <div className="flex items-start gap-3"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-indigo-600 dark:bg-gray-900 dark:text-indigo-300"><FiLock aria-hidden="true" /></span><div><h3 id={`${id}-access-title`} className="font-semibold text-gray-900 dark:text-gray-100">{ready ? 'Access verified' : usesSavedKey && !enteringKey ? 'Saved SPHERE key' : 'SPHERE access'}</h3><p id={`${id}-key-help`} className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">{usesSavedKey && !enteringKey ? 'The saved key will be used to check this pricing. Its value stays hidden.' : ready ? 'This key can read the pricing. It will be stored encrypted when you save.' : needsKey ? 'This pricing may be private. Enter a SPHERE API key with access to continue.' : 'Use a key with access to include private pricing versions.'}</p></div></div>
      {enteringKey && <div className="mt-4">
        <label className="block font-medium" htmlFor={`${id}-key`}>SPHERE API key</label>
        <div className="relative"><input id={`${id}-key`} type={showKey ? 'text' : 'password'} value={typeof value.sphereApiKey === 'string' ? value.sphereApiKey : ''} disabled={disabled} autoComplete="off" spellCheck={false} aria-describedby={`${id}-key-help`} className={`${input} pr-12 font-mono text-sm`} placeholder="sk-…" onChange={event => changeCredential(event.target.value)} />
          <button type="button" aria-label={showKey ? 'Hide API key' : 'Show API key'} aria-pressed={showKey} disabled={disabled} onClick={() => setShowKey(shown => !shown)} className="cursor-pointer absolute right-1 top-3 flex h-9 w-10 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:bg-gray-800"><span aria-hidden="true">{showKey ? <FiEyeOff /> : <FiEye />}</span></button>
        </div>
      </div>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {hasApiKey && value.sphereApiKey !== undefined && <button type="button" disabled={disabled || busy} className={secondary} onClick={() => changeCredential(undefined)}>Keep saved key</button>}
        {usesSavedKey && !enteringKey && <><button type="button" disabled={disabled || busy} className={secondary} onClick={() => changeCredential('')}>Replace key</button><button type="button" disabled={disabled || busy} className={secondary} onClick={() => changeCredential(null)}>Remove key</button></>}
        {enteringKey && <button type="button" disabled={disabled || busy} className={secondary} onClick={() => changeCredential(hasApiKey ? null : undefined)}>Use public access</button>}
        {enteringKey && <button type="button" disabled={busy || disabled || !value.sphereApiKey?.trim()} className={primary} onClick={() => check()}>{busy ? <FiRefreshCw className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FiKey aria-hidden="true" />}{busy ? 'Validating…' : 'Validate key'}</button>}
      </div>
    </section>}

    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{error}</p>}
    {value.sphereApiKey === null && <p role="status" className="text-xs text-gray-500 dark:text-gray-400">The saved key will be removed when you save. Check public access before continuing.</p>}

    {ready && manifest && <>
      <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/30"><FiCheckCircle className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" /><div><p className="font-semibold text-emerald-900 dark:text-emerald-100">{manifest.name}</p><p className="mt-1 text-xs text-emerald-800 dark:text-emerald-200">{manifest.versions.length} accessible {manifest.versions.length === 1 ? 'version' : 'versions'}{privateCount > 0 ? ` · ${privateCount} private` : ''}</p></div></div>
      {!enteringKey && !usesSavedKey && <div className="flex justify-end"><button type="button" disabled={disabled || busy} className={secondary} onClick={() => changeCredential('')}><FiKey aria-hidden="true" />Use a SPHERE API key</button></div>}
      <fieldset disabled={disabled || busy} className="space-y-4 rounded-2xl border border-gray-200 p-4 disabled:opacity-60 sm:p-5 dark:border-gray-800">
        <legend className="px-2 font-semibold text-gray-900 dark:text-gray-100">Configure synchronization</legend>
        <label className="block font-medium" htmlFor={`${id}-policy`}>Synchronization policy</label>
        <CustomSelect id={`${id}-policy`} className={input} value={value.policy} onChange={event => changePolicy(event.target.value as Policy)}>
          <option value="new_last">New last version</option><option value="all_last">All last version</option><option value="new_pick">New pick version</option><option value="all_pick">All pick version</option>
        </CustomSelect>
        <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">{value.policy.startsWith('new_') ? 'Existing contracts keep their version. New contracts use the target.' : 'Existing and new contracts use the target.'} Latest means the newest pricing date you can access.</p>
        {value.policy.endsWith('_pick') && <div><label className="block font-medium" htmlFor={`${id}-version`}>Pricing version</label><CustomSelect id={`${id}-version`} className={input} value={value.selectedVersionId ?? ''} onChange={event => {
          const next = { ...value, selectedVersionId: event.target.value, acceptedSyntaxUpgradeVersionId: undefined };
          onChange(next); onValidated?.(false); void check(next);
        }}><option value="" disabled>Select a version</option>{manifest.versions.map(version => <option key={version.versionId} value={version.versionId}>{version.version}{version.private ? ' · Private' : ''} · {new Date(version.createdAt).toLocaleDateString()}</option>)}</CustomSelect></div>}
        <div><label className="block font-medium" htmlFor={`${id}-polling`}>Check for new versions</label><CustomSelect id={`${id}-polling`} className={input} value={value.pollIntervalMinutes ?? 5} onChange={event => onChange({ ...value, pollIntervalMinutes: Number(event.target.value) as PollingIntervalMinutes })}><option value="1">Every minute</option><option value="5">Every 5 minutes</option><option value="15">Every 15 minutes</option></CustomSelect></div>
        {value.policy.startsWith('all_') && <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">{allWarning}</p>}
        {target && <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-3 dark:border-gray-800"><span className="text-xs text-gray-500 dark:text-gray-400">Target pricing version</span><span className="inline-flex items-center gap-2 rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"><FiCheck aria-hidden="true" />{target.version}{target.private ? ' · Private' : ''}</span></div>}
      </fieldset>
    </>}
  </div>;
}
