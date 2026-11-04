import type { Agent, AgentOptions } from 'https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';
import nodeFetch from 'node-fetch';

/**
 * The agent that sends a request to `url` through the outbound proxy, when one
 * is set. Some servers only reach the internet through it, and node-fetch
 * ignores the http(s)_proxy variables, so they are honoured here, no_proxy
 * included. Without them it returns undefined and requests go out directly.
 */
export function proxyAgentFor(url: string, options: AgentOptions = {}): Agent | undefined {
  const proxy = getProxyForUrl(url);
  if (!proxy) return undefined;
  return new URL(url).protocol === 'http:'
    ? new HttpProxyAgent(proxy, options) as unknown as Agent
    : new HttpsProxyAgent(proxy, options);
}

type ProxyFetchOptions = Pick<RequestInit, 'method' | 'headers' | 'signal' | 'redirect'> & {
  body?: string | URLSearchParams;
};

/** WHATWG fetch response for OIDC/jose, using the configured proxy only when needed. */
export async function fetchWithOptionalProxy(url: string, options: ProxyFetchOptions = {}): Promise<Response> {
  const agent = proxyAgentFor(url);
  if (!agent) return globalThis.fetch(url, options);

  const response = await nodeFetch(url, {
    ...options,
    headers: Array.from(new Headers(options.headers).entries()),
    agent,
    size: 1024 * 1024,
  });
  const body = [204, 205, 304].includes(response.status) ? null : await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
  });
}
