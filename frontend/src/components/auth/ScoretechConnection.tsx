import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import FormError from '@/components/FormError';
import { getIdentityConnection, startIdentitySignIn } from '@/api/auth/identityApi';

export default function ScoretechConnection({ accountUrl }: { accountUrl: string }) {
  const [searchParams] = useSearchParams();
  const [connection, setConnection] = useState<{ linked: boolean; canLink: boolean }>();
  const [expanded, setExpanded] = useState(false);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const callbackError = searchParams.get('identityError');
  const callbackMessage = callbackError === 'conflict'
    ? 'That SCORETech Identity account is already connected to SPACE. Choose a different account.'
    : callbackError ? 'Could not connect SCORETech Identity. Please try again.' : '';

  useEffect(() => {
    const controller = new AbortController();
    getIdentityConnection(controller.signal)
      .then(setConnection)
      .catch(() => { if (!controller.signal.aborted) setError('Could not check your connection. Reload and try again.'); });
    return () => controller.abort();
  }, []);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await startIdentitySignIn(password);
    } catch (error: any) {
      setError(error.response?.data?.error ?? 'Could not start the connection. Please try again.');
      setPending(false);
    }
  }

  return (
    <section aria-label="SCORETech Identity" className="flex flex-col gap-3 rounded-xl border border-indigo-100 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      {!connection && !error && <p role="status" className="text-sm text-gray-600 dark:text-gray-300">Checking connection…</p>}
      <div role="alert"><FormError message={error || callbackMessage} /></div>
      {connection?.linked && <>
        <p role="status" className="font-medium text-indigo-800 dark:text-indigo-200">SCORETech Identity connected</p>
        <a href={accountUrl} target="_blank" rel="noopener noreferrer"
          className="cursor-pointer rounded-sm text-sm text-indigo-700 underline focus-visible:outline-2 dark:text-indigo-200">
          Manage your SCORETech Identity account
        </a>
      </>}
      {connection?.canLink && <>
        <p className="text-sm text-gray-600 dark:text-gray-300">Connect SCORETech Identity to keep using this SPACE account. Once connected, use SCORETech Identity to sign in.</p>
        {!expanded ? <button type="button" onClick={() => setExpanded(true)}
          className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2">
          Connect SCORETech Identity
        </button> : <form className="flex flex-col gap-3" onSubmit={connect}>
          <label htmlFor="connect-space-password" className="text-sm font-semibold text-indigo-800 dark:text-indigo-200">Current SPACE password</label>
          <input id="connect-space-password" type="password" autoComplete="current-password" required
            value={password} onChange={event => setPassword(event.target.value)}
            className="min-h-11 rounded-lg border border-indigo-200 px-3 text-gray-900 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
          <button type="submit" disabled={pending}
            className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 disabled:opacity-60">
            {pending ? 'Opening SCORETech Identity…' : 'Continue to SCORETech Identity'}
          </button>
        </form>}
      </>}
    </section>
  );
}
