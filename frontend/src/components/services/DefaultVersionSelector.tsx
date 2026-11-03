import { useEffect, useId, useState } from 'react';
import { getNewContractsPricing, getService, setDefaultVersion } from '@/api/services/servicesApi';
import type { Pricing } from '@/types/Services';

export default function DefaultVersionSelector({ apiKey, organizationId, serviceName, activePricings, canManage }: {
  apiKey: string; organizationId: string; serviceName: string; activePricings: Pricing[]; canManage: boolean;
}) {
  const id = useId();
  const [selected, setSelected] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const [effective, setEffective] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setNotice('');
    Promise.all([
      getService(apiKey, organizationId, serviceName, controller.signal),
      getNewContractsPricing(apiKey, organizationId, serviceName, controller.signal),
    ]).then(([service, pricing]) => {
      if (controller.signal.aborted) return;
      setSaved(service.defaultVersion ?? '');
      setSelected(service.defaultVersion ?? '');
      setEffective(pricing.version);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Unable to load the version for new contracts. Please retry.');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [apiKey, organizationId, serviceName, activePricings, retry]);

  async function save() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const service = await setDefaultVersion(apiKey, organizationId, serviceName, selected || null);
      setSaved(service.defaultVersion ?? '');
      setSelected(service.defaultVersion ?? '');
      const pricing = await getNewContractsPricing(apiKey, organizationId, serviceName);
      setEffective(pricing.version);
      setNotice('Version for new contracts saved. Existing contracts are unchanged.');
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } }).response?.data?.error;
      setError(message || 'Unable to confirm the version for new contracts. Please reload and try again.');
    } finally { setSaving(false); }
  }

  return <section aria-labelledby={`${id}-title`} className="mb-6 rounded-2xl border border-indigo-100 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
    <h2 id={`${id}-title`} className="font-bold text-indigo-700 dark:text-gray-100">Version for new contracts</h2>
    <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Choose an active pricing version or automatically use the latest active version. Existing contracts keep their current pricing.</p>
    {loading ? <p role="status" className="mt-4 text-sm text-gray-500 dark:text-gray-400">Loading version…</p> : <>
      <label htmlFor={id} className="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-200">Pricing version</label>
      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
        <select id={id} value={selected} onChange={event => { setSelected(event.target.value); setNotice(''); }} disabled={!canManage || saving || !!error} aria-describedby={`${id}-effective`} className="cursor-pointer min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-gray-800 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
          <option value="">Automatic: latest active version</option>
          {activePricings.map(pricing => <option key={pricing.version} value={pricing.version}>{pricing.version}</option>)}
        </select>
        {canManage && <button type="button" onClick={save} disabled={saving || saved === null || selected === saved || !!error} className="cursor-pointer min-h-11 rounded-lg bg-indigo-600 px-5 font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50 dark:hover:bg-indigo-800">{saving ? 'Saving…' : 'Save'}</button>}
      </div>
      <p id={`${id}-effective`} className="mt-3 text-sm text-gray-500 dark:text-gray-400">{effective ? `Currently offered to new contracts: ${effective}` : 'Current version unavailable.'}{!canManage && ' An organization manager can change this setting.'}</p>
    </>}
    {notice && <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
    {error && <div role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)} className="cursor-pointer mt-2 min-h-11 rounded-lg border border-red-300 px-3 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-red-800">Reload setting</button></div>}
  </section>;
}
