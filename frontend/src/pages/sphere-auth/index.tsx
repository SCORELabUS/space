import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { completeSphereSignIn, pendingSphereSignIn, sphereError, type SpherePending } from '@/api/auth/sphereAuthApi';
import useAuth from '@/hooks/useAuth';
import LightBackground from '@/layouts/background';

export default function SphereAuthPage() {
  const { user, acceptSession, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState<SpherePending | null>(null);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    pendingSphereSignIn().then(value => {
      if (active) { setPending(value); setUsername(value.suggestedUsername || ''); setError(value.error || ''); }
    }).catch(err => { if (active) setError(sphereError(err)); });
    return () => { active = false; };
  }, []);
  async function complete(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await completeSphereSignIn(pending?.kind === 'signup' ? username : undefined, pending?.kind === 'link' ? user.apiKey : undefined);
      if ('linked' in result) navigate('/settings', { replace: true });
      else { acceptSession(result); navigate('/', { replace: true }); }
    } catch (err) { setError(sphereError(err)); setBusy(false); }
  }
  const link = pending?.kind === 'link';
  return <LightBackground><main className="mx-4 w-full max-w-lg rounded-2xl border border-indigo-100 bg-white/95 p-6 shadow-xl sm:p-8 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100">
    <p className="mb-3 text-sm font-semibold text-indigo-600 dark:text-indigo-300">SPACE / SPHERE</p>
    <h1 className="text-3xl font-bold text-indigo-900 dark:text-gray-100">{pending?.kind === 'signup' ? 'Choose your SPACE username' : link ? 'Connect your SPHERE account' : 'Sign in to SPACE'}</h1>
    {error && <p role="alert" className="my-4 rounded-lg border border-indigo-200 p-3 text-sm dark:border-gray-700">{error}</p>}
    {!pending && !error && <p role="status" className="mt-5">Checking your sign-in…</p>}
    {pending && pending.kind !== 'error' && <form onSubmit={complete} className="mt-5 flex flex-col gap-5">
      {pending.kind === 'signup' && <>
        <p className="text-sm text-indigo-700 dark:text-indigo-200">This name belongs to your SPACE account. Changing your username in SPHERE will leave it unchanged.</p>
        <div><label htmlFor="space-username" className="mb-2 block text-sm font-semibold">SPACE username</label>
          <input id="space-username" value={username} onChange={event => setUsername(event.target.value)} required minLength={3} maxLength={30} pattern="[A-Za-z0-9_-]{3,30}" aria-describedby="username-help" autoComplete="username" className="w-full rounded-lg border border-indigo-200 bg-white px-3 py-2.5 text-indigo-900 focus:outline-2 focus:outline-indigo-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
          <p id="username-help" className="mt-2 text-xs text-indigo-700 dark:text-indigo-200">3–30 letters, digits, underscores or hyphens.</p>
        </div>
      </>}
      {link && <p className="text-sm">{isAuthenticated ? <>Connect SPHERE to <strong>{user.username}</strong> in SPACE. Your local username, organizations and permissions stay the same.</> : 'Sign in to your existing SPACE account and restart the connection from Settings.'}</p>}
      <button type="submit" disabled={busy || (link && !isAuthenticated)} className="cursor-pointer rounded-lg bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-50 dark:bg-indigo-500 dark:hover:bg-indigo-600">{busy ? 'Continuing…' : pending.kind === 'signup' ? 'Create SPACE account' : link ? 'Confirm connection' : 'Sign in'}</button>
      {pending.kind === 'signup' && <p className="text-sm text-indigo-700 dark:text-indigo-200">Already have a SPACE account? <Link to="/" className="cursor-pointer underline">Sign in with your existing method</Link>, then connect SPHERE in Settings.</p>}
    </form>}
    <Link to={link && isAuthenticated ? '/settings' : '/'} className="mt-6 inline-block cursor-pointer text-sm text-indigo-700 underline dark:text-indigo-200">{link ? 'Back to SPACE' : 'Back to login'}</Link>
  </main></LightBackground>;
}
