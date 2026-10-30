import type { Agent, AgentOptions } from 'https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

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
