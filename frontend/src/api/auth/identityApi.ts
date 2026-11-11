import axios from '@/lib/axios';

export type AuthConfig = { provider: 'local' } | { provider: 'scoretech'; accountUrl: string; legacyPasswordLogin: boolean };
const options = { withCredentials: true, timeout: 15_000 };

export async function getAuthConfig(signal: AbortSignal) {
  const { data } = await axios.get<AuthConfig>('/auth/config', { timeout: 5000, signal });
  if (data?.provider !== 'local' && data?.provider !== 'scoretech') throw new Error('Invalid sign-in configuration');
  return data;
}

export async function startIdentitySignIn(password?: string) {
  const { data } = await axios.post<{ authorizationUrl: string }>('/auth/identity/start', { password }, options);
  window.location.assign(data.authorizationUrl);
}

export async function endIdentitySession() {
  await axios.post('/auth/identity/logout', {}, options);
}

export async function signInWithSpacePassword(username: string, password: string) {
  const { data } = await axios.post<{ username: string; role: string }>('/auth/identity/legacy', { username, password }, options);
  return data;
}

export async function getIdentityConnection(signal: AbortSignal) {
  const { data } = await axios.get<{ linked: boolean; canLink: boolean }>('/auth/identity/connection', { ...options, signal });
  return data;
}
