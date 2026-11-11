export const AUTH_PATH = '/api/v1/auth/identity';
export const SESSION_COOKIE = 'space_identity_session';
export const FLOW_COOKIE = 'space_identity_flow';

export function authProvider(): 'local' | 'scoretech' {
  const value = process.env.AUTH_PROVIDER ?? 'local';
  if (value !== 'local' && value !== 'scoretech') throw new Error('AUTH_PROVIDER must be local or scoretech');
  return value;
}

function publicUrl(value: string | undefined, name: string) {
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search ||
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error(`${name} must use HTTPS or HTTP on loopback`);
  }
  return url;
}

export function legacyPasswordLogin() {
  const value = process.env.SCORETECH_LEGACY_PASSWORD_LOGIN ?? 'true';
  if (value !== 'true' && value !== 'false') throw new Error('SCORETECH_LEGACY_PASSWORD_LOGIN must be true or false');
  return value === 'true';
}

export function identityConfig() {
  const frontend = publicUrl(process.env.SPACE_FRONTEND_URL, 'SPACE_FRONTEND_URL');
  if (!frontend.pathname.endsWith('/')) frontend.pathname += '/';
  const issuerUrl = publicUrl(process.env.SCORETECH_IDENTITY_ISSUER, 'SCORETECH_IDENTITY_ISSUER');
  const issuer = issuerUrl.href.replace(/\/$/, '');
  const apiPath = frontend.pathname.replace(/\/$/, '') + '/api/v1';
  const callbackPath = apiPath + '/auth/identity/callback';
  const callback = publicUrl(
    process.env.SCORETECH_IDENTITY_CALLBACK_URL ?? new URL(callbackPath, frontend).href,
    'SCORETECH_IDENTITY_CALLBACK_URL',
  );
  if (callback.origin !== frontend.origin || callback.pathname !== callbackPath) {
    throw new Error('SCORETECH_IDENTITY_CALLBACK_URL must use the public SPACE origin and identity callback path');
  }

  const clientId = process.env.SCORETECH_IDENTITY_CLIENT_ID?.trim();
  const clientSecret = process.env.SCORETECH_IDENTITY_CLIENT_SECRET;
  if (!clientId || !clientSecret?.trim()) throw new Error('SCORETech Identity client ID and secret are required');

  const account = process.env.SCORETECH_IDENTITY_ACCOUNT_URL ??
    issuer.replace(/\/auth\/realms\/[^/]+$/, '/account/');
  return {
    issuer, clientId, clientSecret, frontend, callback: callback.href, apiPath, legacyPasswordLogin: legacyPasswordLogin(),
    accountUrl: publicUrl(account, 'SCORETECH_IDENTITY_ACCOUNT_URL').href,
    secure: frontend.protocol === 'https:',
  };
}

export function readCookie(header: string | undefined, name: string) {
  const prefix = name + '=';
  const matches = (header ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  if (matches.length !== 1) return '';
  const value = matches[0].slice(prefix.length);
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}
