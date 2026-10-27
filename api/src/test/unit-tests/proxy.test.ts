import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { proxyAgentFor } from '../../main/utils/proxy';

const PROXY_VARIABLES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY', 'all_proxy', 'ALL_PROXY'];

describe('proxyAgentFor', () => {
  afterEach(() => vi.unstubAllEnvs());
  const withEnv = (env: Record<string, string>) => {
    PROXY_VARIABLES.forEach(name => vi.stubEnv(name, ''));
    Object.entries(env).forEach(([name, value]) => vi.stubEnv(name, value));
  };

  it('goes out directly when no proxy is set', () => {
    withEnv({});
    expect(proxyAgentFor('https://sphere.score.us.es/api/v1/public/pricings/x')).toBeUndefined();
  });

  it('uses the https proxy for https URLs, keeping the TLS options', () => {
    withEnv({ https_proxy: 'http://proxy.int.local:3128' });
    const agent = proxyAgentFor('https://sphere.score.us.es/api/v1', { rejectUnauthorized: false });
    expect(agent).toBeInstanceOf(HttpsProxyAgent);
    expect((agent as HttpsProxyAgent<string>).proxy.href).toBe('http://proxy.int.local:3128/');
    expect((agent as any).connectOpts.rejectUnauthorized).toBe(false);
  });

  it('uses the http proxy for http URLs', () => {
    withEnv({ http_proxy: 'http://proxy.int.local:3128' });
    expect(proxyAgentFor('http://example.org/pricing.yml')).toBeInstanceOf(HttpProxyAgent);
  });

  it('honours no_proxy', () => {
    withEnv({ https_proxy: 'http://proxy.int.local:3128', no_proxy: 'localhost,.int.local' });
    expect(proxyAgentFor('https://localhost/pricing.yml')).toBeUndefined();
    expect(proxyAgentFor('https://sphere.int.local/api/v1')).toBeUndefined();
    expect(proxyAgentFor('https://sphere.score.us.es/api/v1')).toBeInstanceOf(HttpsProxyAgent);
  });
});
