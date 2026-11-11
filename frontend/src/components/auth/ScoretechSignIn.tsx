import { useState } from 'react';
import { startIdentitySignIn } from '@/api/auth/identityApi';
import FormError from '@/components/FormError';

const messages: Record<string, string> = {
  invalid: 'Sign-in could not be verified. Please try again.',
  unavailable: 'SCORETech Identity is temporarily unavailable. Please try again.',
};

export default function ScoretechSignIn({ allowLegacy }: { allowLegacy: boolean }) {
  const [error, setError] = useState(() => {
    const code = new URLSearchParams(window.location.search).get('identityError');
    if (code === 'unlinked') {
      return allowLegacy
        ? 'This SCORETech Identity account is not linked to SPACE. Sign in with your SPACE password and connect your identity in Settings, or contact your SPACE administrator.'
        : 'This SCORETech Identity account is not linked to SPACE. Contact your SPACE administrator.';
    }
    return code && Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : '';
  });
  const [pending, setPending] = useState(false);

  async function start() {
    setError('');
    setPending(true);
    try {
      await startIdentitySignIn();
    } catch {
      setError('Could not start sign-in. Please try again.');
      setPending(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <div role="alert"><FormError message={error} /></div>
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 font-bold text-white hover:bg-indigo-700 dark:hover:bg-indigo-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-60"
      >
        {pending ? 'Opening SCORETech Identity…' : 'Continue with SCORETech Identity'}
      </button>
    </div>
  );
}
