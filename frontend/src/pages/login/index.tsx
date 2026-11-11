import ScoretechSignIn from '@/components/auth/ScoretechSignIn';
import SphereSignIn from '@/components/auth/SphereSignIn';
import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router';
import SpaceCard from '../../components/space-card';
import LightBackground from '../../layouts/background';
import loginImage from '../../static/images/login-image.webp';
import useAuth from '../../hooks/useAuth';
import FormError from '../../components/FormError';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showLegacy, setShowLegacy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const { login, config } = useAuth();
  const navigate = useNavigate();
  const managed = config.provider === 'scoretech';
  const legacyEnabled = managed && config.legacyPasswordLogin;

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!username || !password) {
      setError('Please enter both username and password.');
      return;
    }
    setSigningIn(true);
    try {
      await login(username, password);
    } catch (error) {
      setError(managed || (error as Error).message.toLowerCase().includes('unauthorized')
        ? (error as Error).message
        : 'Login failed. Please check your credentials and try again.');
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <LightBackground>
      <SpaceCard image={loginImage} imageAlt="Login illustration">
        <motion.h1
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.7, type: 'spring' }}
          className="text-3xl sm:text-4xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 via-blue-400 to-purple-400 dark:from-indigo-300 dark:via-blue-300 dark:to-purple-400 mb-6 drop-shadow-lg text-center"
        >
          Welcome to SPACE
        </motion.h1>
        {managed && <div className="flex w-full flex-col gap-4">
          <ScoretechSignIn allowLegacy={legacyEnabled} />
          {legacyEnabled && <button
            type="button"
            aria-expanded={showLegacy}
            aria-controls="space-password-form"
            className="cursor-pointer self-center rounded-sm text-sm font-medium text-indigo-700 underline focus-visible:outline-2 dark:text-indigo-200"
            onClick={() => { setShowLegacy(value => !value); setPassword(''); setError(''); }}
          >
            Use an existing SPACE password
          </button>}
        </div>}
        {(!managed || legacyEnabled && showLegacy) && <motion.form
          id="space-password-form"
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.4, duration: 0.5 }}
          className="w-full flex flex-col gap-6"
          onSubmit={handleLogin}
        >
          {!managed && <SphereSignIn />}
          <FormError message={error} />
          <div>
            <label className="block text-indigo-800 dark:text-indigo-200 text-sm font-bold mb-2" htmlFor="username">
              Username
            </label>
            <input
              className="shadow appearance-none border border-indigo-200 dark:border-gray-700 rounded-lg w-full py-2 px-3 text-indigo-900 dark:text-gray-100 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-indigo-800 focus:border-blue-300 dark:focus:border-indigo-700 bg-white/80 dark:bg-gray-900/80 placeholder-indigo-300 dark:placeholder-gray-500 transition-all"
              id="username"
              type="text"
              placeholder="Enter your username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <label className="block text-indigo-800 dark:text-indigo-200 text-sm font-bold mb-2" htmlFor="password">
              Password
            </label>
            <input
              className="shadow appearance-none border border-indigo-200 dark:border-gray-700 rounded-lg w-full py-2 px-3 text-indigo-900 dark:text-gray-100 leading-tight focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-indigo-800 focus:border-blue-300 dark:focus:border-indigo-700 bg-white/80 dark:bg-gray-900/80 placeholder-indigo-300 dark:placeholder-gray-500 transition-all"
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.97 }}
            className="cursor-pointer mt-2 bg-gradient-to-r from-indigo-400 via-blue-400 to-purple-400 dark:from-indigo-600 dark:via-blue-700 dark:to-purple-700 hover:from-indigo-300 hover:to-purple-300 dark:hover:from-indigo-500 dark:hover:to-purple-500 text-white font-bold py-2 px-6 rounded-lg shadow-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:focus:ring-indigo-800 focus:ring-offset-2"
            type="submit"
            disabled={signingIn}
          >
            {signingIn ? 'Signing in…' : 'Log In'}
          </motion.button>
          {!managed && <div className="text-center mt-4">
            <button
              type="button"
              onClick={() => navigate(`/register`)}
              className="cursor-pointer text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 text-sm font-medium transition-colors"
            >
              Don't have an account? Register here
            </button>
          </div>}
        </motion.form>}
      </SpaceCard>
    </LightBackground>
  );
}