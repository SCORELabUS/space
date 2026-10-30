export const sphereError = (error: unknown): string => {
  const e = error as { response?: { data?: { error?: string; code?: string } }; message?: string };
  if (e.response?.data?.code === 'SPHERE_CREDENTIAL_STORAGE_UNAVAILABLE' || e.response?.data?.error?.includes('SPHERE_KEY_ENCRYPTION_KEY')) {
    return 'SPACE cannot use secure key storage yet. Ask an administrator to enable it, then try again.';
  }
  return e.response?.data?.error || e.message || 'Unable to contact SPHERE';
};
export const sphereAccessRequired = (error: unknown): boolean => {
  const code = (error as { response?: { data?: { code?: string } } }).response?.data?.code;
  return code === 'SPHERE_ACCESS_REQUIRED' || code === 'SPHERE_KEY_REJECTED';
};
