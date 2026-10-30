import React from 'react';

export default function PricingContractCounts({ counts, versions, target }: {
  counts?: { version: string; count: number }[]; versions: string[]; target: string;
}): React.JSX.Element {
  const rows = [...new Set([target, ...versions, ...(counts ?? []).map(row => row.version)])]
    .filter(Boolean).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const byVersion = new Map(counts?.map(row => [row.version, row.count]));
  const total = counts?.reduce((sum, row) => sum + row.count, 0);

  return <section aria-label="Contracts by pricing version" className="overflow-hidden rounded-2xl border border-indigo-100 bg-white dark:border-gray-800 dark:bg-gray-900">
    <div className="flex flex-wrap items-center justify-between gap-3 p-6">
      <div><h2 className="font-bold text-indigo-700 dark:text-gray-100">Contracts by pricing version</h2><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Current assignments, including expired contracts. Updates automatically.</p></div>
      {total !== undefined && <span className="rounded-full bg-gray-100 px-3 py-1 text-sm font-semibold dark:bg-gray-800">{total} contracts</span>}
    </div>
    {counts === undefined ? <p role="status" className="px-6 pb-6 text-sm text-gray-500 dark:text-gray-400">Contract counts are unavailable. Refresh the page or try again later.</p> : <>
      {total === 0 && <p className="px-6 pb-4 text-sm text-gray-500 dark:text-gray-400">No contracts currently use this service.</p>}
      <div className="max-h-80 overflow-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Number of contracts currently assigned to each pricing version</caption>
        <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400"><tr><th scope="col" className="px-6 py-3 font-medium">Pricing version</th><th scope="col" className="px-6 py-3 text-right font-medium">Contracts</th></tr></thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">{rows.map(version => <tr key={version}><th scope="row" className="px-6 py-4 font-semibold text-gray-800 dark:text-gray-100"><span>{version}</span>{version === target && <span className="ml-3 inline-block rounded-full bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">New contracts</span>}</th><td className="px-6 py-4 text-right tabular-nums text-gray-700 dark:text-gray-200">{byVersion.get(version) ?? 0}</td></tr>)}</tbody>
      </table></div>
    </>}
  </section>;
}
