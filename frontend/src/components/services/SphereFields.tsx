import { useId, useRef, useState } from 'react';
import { previewSphere, sphereError } from '@/api/services/sphereApi';
import type { Manifest, Policy, SphereConfig, SyntaxUpgrade, PollingIntervalMinutes } from '@/api/services/sphereApi';
import CustomSelect from '@/components/CustomSelect';
export const allWarning = 'All existing contracts will move to the target version. If their plan or add-ons are no longer valid, they will switch to the cheapest valid plan without add-ons. If no valid replacement exists, synchronization will be blocked.';
const input = 'mt-1 min-h-11 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 p-2 text-gray-900 dark:text-gray-100 focus-visible:outline-2 focus-visible:outline-indigo-500';
export default function SphereFields({ value, onChange, apiKey, organizationId, onValidated, onSyntaxUpgrade, locked = false }: {
  value: SphereConfig; onChange: (v: SphereConfig) => void; apiKey: string; organizationId: string;
  onValidated?: (valid: boolean) => void; onSyntaxUpgrade?: (upgrade?: SyntaxUpgrade) => void; locked?: boolean;
}) {
  const id = useId();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  async function check() {
    const request = ++revision.current;
    setBusy(true); setError(''); onValidated?.(false);
    try {
      const result = await previewSphere(apiKey, organizationId, value);
      if (request !== revision.current) return;
      setManifest(result);
      onSyntaxUpgrade?.(result.syntaxUpgrade);
      onValidated?.(true);
      if (value.policy.endsWith('_pick') && !result.versions.some(v => v.versionId === value.selectedVersionId)) {
        onChange({ ...value, selectedVersionId: result.versions[0].versionId, acceptedSyntaxUpgradeVersionId: undefined });
      }
    } catch (error) { if (request === revision.current) { setManifest(null); setError(sphereError(error)); } }
    finally { if (request === revision.current) setBusy(false); }
  }
  const target = manifest?.versions.find(v => v.versionId === (value.policy.endsWith('_pick') ? value.selectedVersionId : manifest.latestVersionId));
  return <div className="w-full space-y-4 text-sm text-gray-700 dark:text-gray-200">
    <p id={`${id}-help`}>Only public SPHERE versions can be synchronized. The pricing must have at least one public version.</p>
    <label className="block" htmlFor={`${id}-url`}>SPHERE permanent link
      <input id={`${id}-url`} type="url" readOnly={locked} value={value.permanentUrl} aria-describedby={`${id}-help`} placeholder="https://sphere.score.us.es/p/…" className={input} onChange={e => {
        revision.current++; setBusy(false); setManifest(null); onValidated?.(false);
        onSyntaxUpgrade?.(undefined);
        onChange({ ...value, permanentUrl: e.target.value, selectedVersionId: undefined, acceptedSyntaxUpgradeVersionId: undefined });
      }} />
    </label>
    <button type="button" disabled={busy || !value.permanentUrl} className="cursor-pointer min-h-11 rounded-lg border border-indigo-300 px-3 text-indigo-700 dark:text-indigo-300 disabled:opacity-50" onClick={check}>{busy ? 'Checking…' : 'Check pricing and versions'}</button>
    {error && <p role="alert" className="text-red-700 dark:text-red-300">{error}</p>}
    {manifest && <p role="status" className="rounded-lg bg-indigo-50 dark:bg-indigo-950 p-3 font-semibold">{manifest.name} · {manifest.versions.length} public versions</p>}
    <label className="block" htmlFor={`${id}-policy`}>Synchronization policy
      <CustomSelect id={`${id}-policy`} className={`${input}`} value={value.policy} onChange={e => {
        const policy = e.target.value as Policy;
        const isPick = policy.endsWith('_pick');
        const selectedVersionId = isPick
          ? (manifest?.versions.some(version => version.versionId === value.selectedVersionId)
            ? value.selectedVersionId
            : manifest?.latestVersionId ?? manifest?.versions[0]?.versionId)
          : undefined;
        // Changing only the policy does not invalidate an already checked
        // manifest. “Last” policies resolve their target automatically.
        onValidated?.(Boolean(manifest));
        onChange({ ...value, policy, selectedVersionId });
      }}>
        <option value="new_last">New last version</option><option value="all_last">All last version</option>
        <option value="new_pick">New pick version</option><option value="all_pick">All pick version</option>
      </CustomSelect>
    </label>
    <p>{value.policy.startsWith('new_') ? 'Existing contracts keep their version. New contracts use the target.' : 'Existing and new contracts use the target.'} Latest means the most recent pricing date.</p>
    <label className="block" htmlFor={`${id}-polling`}>Check for new versions
      <CustomSelect id={`${id}-polling`} className={`${input}`} value={value.pollIntervalMinutes ?? 5} onChange={e => onChange({ ...value, pollIntervalMinutes: Number(e.target.value) as PollingIntervalMinutes })}>
        <option value="1">Every minute</option>
        <option value="5">Every 5 minutes</option>
        <option value="15">Every 15 minutes</option>
      </CustomSelect>
    </label>
    {value.policy.endsWith('_pick') && <label className="block" htmlFor={`${id}-version`}>Public version
      <CustomSelect id={`${id}-version`} className={`${input}`} value={value.selectedVersionId ?? ''} onChange={e => {
        onValidated?.(false); onSyntaxUpgrade?.(undefined);
        onChange({ ...value, selectedVersionId: e.target.value, acceptedSyntaxUpgradeVersionId: undefined });
      }}>
        <option value="" disabled>Check pricing to select a version</option>
        {!manifest && value.selectedVersionId && <option value={value.selectedVersionId}>Current selection (check availability)</option>}
        {manifest?.versions.map(v => <option key={v.versionId} value={v.versionId}>{v.version} · {new Date(v.createdAt).toLocaleDateString()}</option>)}
      </CustomSelect>
    </label>}
    {value.policy.startsWith('all_') && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">{allWarning}</p>}
    {target && <p>Target version: <strong>{target.version}</strong></p>}
  </div>;
}
