import { useEffect, useState } from 'react';
import { FiArrowUpRight, FiCheck, FiGlobe } from 'react-icons/fi';
import { sphereAvailable, sphereConnection, sphereError, startSphereSignIn } from '@/api/auth/sphereAuthApi';
import useAuth from '@/hooks/useAuth';

export default function SphereSignIn({ mode = 'login' }: { mode?: 'login' | 'link' }) {
  const { user } = useAuth();
  const [available, setAvailable] = useState(false);
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([sphereAvailable(), mode === 'link' ? sphereConnection(user.apiKey) : Promise.resolve(null)])
      .then(([enabled, connection]) => { if (active) { setAvailable(enabled); setLinked(connection?.linked ?? false); } })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [mode, user.apiKey]);
  if (!available) return null;
  async function start() {
    setBusy(true); setError('');
    try { await startSphereSignIn(mode, mode === 'link' ? user.apiKey : undefined); }
    catch (err) { setError(sphereError(err)); setBusy(false); }
  }
  if (mode === 'link') {
    return <section aria-label="Sign-in methods" className="w-full rounded-xl border border-indigo-100 bg-white/90 text-indigo-900 shadow-sm dark:border-gray-800 dark:bg-gray-900/90 dark:text-gray-100">
      <h3 className="border-b border-indigo-100 px-5 py-3 text-sm font-semibold dark:border-gray-800">Sign-in methods</h3>
      <div className="flex items-center justify-between gap-4 p-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-indigo-100 bg-indigo-50 text-indigo-600 dark:border-indigo-800/60 dark:bg-indigo-950/60 dark:text-indigo-300" aria-hidden="true">
            <FiGlobe size={20} strokeWidth={1.5} />
          </span>
          <span className="text-sm font-semibold tracking-wide">SPHERE</span>
        </div>
        <button
          type="button"
          disabled={linked || busy}
          onClick={start}
          aria-label={linked ? 'SPHERE connected' : 'Connect SPHERE'}
          className={`cursor-pointer inline-flex min-w-28 shrink-0 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 ${linked
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
            : 'border-indigo-200 bg-white text-indigo-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-indigo-300 dark:hover:border-indigo-600 dark:hover:bg-gray-800'}`}
        >
          {linked ? <FiCheck size={15} aria-hidden="true" /> : null}
          {linked ? 'Connected' : busy ? 'Connecting…' : 'Connect'}
          {!linked && !busy ? <FiArrowUpRight size={15} aria-hidden="true" /> : null}
        </button>
      </div>
      {error && <p role="alert" className="px-5 pb-4 text-sm text-indigo-700 dark:text-indigo-200">{error}</p>}
    </section>;
  }
  return <section aria-label="SPHERE sign-in" className="w-full rounded-xl border border-indigo-200 bg-white/80 p-4 text-indigo-900 dark:border-gray-700 dark:bg-gray-900/80 dark:text-gray-100">
    <button type="button" disabled={busy} onClick={start} className="cursor-pointer w-full rounded-lg border border-indigo-300 px-4 py-2.5 font-semibold transition hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50 dark:border-indigo-600 dark:hover:bg-gray-800">
      {busy ? 'Opening SPHERE…' : 'Continue with SPHERE'}
    </button>
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
  </section>;
}
