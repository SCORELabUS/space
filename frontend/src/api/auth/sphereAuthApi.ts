import axios from '@/lib/axios';
import type { UserData } from '@/contexts/AuthContext';

export type SpherePending = { kind: 'signup' | 'login' | 'link' | 'error'; suggestedUsername?: string; error?: string };
const options = { withCredentials: true, timeout: 15000 };
export async function sphereAvailable(): Promise<boolean> {
  return (await axios.get('/auth/sphere/status', options)).data.available;
}
export async function startSphereSignIn(mode: 'login' | 'link', apiKey?: string) {
  const response = await axios.post('/auth/sphere/start', { mode }, { ...options, headers: apiKey ? { 'x-api-key': apiKey } : {} });
  window.location.assign(response.data.authorizationUrl);
}
export async function pendingSphereSignIn(): Promise<SpherePending> {
  return (await axios.get('/auth/sphere/pending', options)).data;
}
export async function completeSphereSignIn(username?: string, apiKey?: string): Promise<UserData | { linked: true }> {
  return (await axios.post('/auth/sphere/complete', { username }, { ...options, headers: apiKey ? { 'x-api-key': apiKey } : {} })).data;
}
export async function sphereConnection(apiKey: string): Promise<{ linked: boolean; hasPassword: boolean }> {
  return (await axios.get('/auth/sphere/connection', { ...options, headers: { 'x-api-key': apiKey } })).data;
}
export function sphereError(error: unknown) {
  return (error as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Unable to continue with SPHERE. Please try again.';
}
