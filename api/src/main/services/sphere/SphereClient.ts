import fetch from 'node-fetch';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { SphereManifest } from './types';
import { escapeVersion } from '../../utils/helpers';

export function functionalHash(text: string): string {
  const value = yaml.load(text) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid YAML pricing');
  const { saasName: _name, ...functional } = value;
  const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) :
    v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(functional))).digest('hex');
}

export default class SphereClient {
  private base() {
    const url = new URL(process.env.SPHERE_PUBLIC_URL || 'https://sphere.score.us.es');
    if (url.protocol !== 'https:' && !(process.env.SPHERE_ALLOW_LOCAL_HTTP === 'true' &&
      process.env.ENVIRONMENT !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('Invalid SPHERE origin: HTTPS is required');
    }
    return url;
  }
  parseLink(input: string) {
    const base = this.base();
    const url = new URL(input);
    const prefix = base.pathname.replace(/\/$/, '');
    const match = url.pathname.slice(prefix.length).match(/^\/p\/([a-f\d]{24})\/?$/i);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix + '/') || url.username || url.password || url.search || url.hash || !match) {
      throw new Error('Invalid SPHERE pricing permanent link');
    }
    return { pricingId: match[1].toLowerCase(), permanentUrl: `${base.origin}${prefix}/p/${match[1].toLowerCase()}` };
  }
  private async request(path: string) {
    const base = this.base();
    const apiBase = process.env.SPHERE_API_URL || `${base.origin}${base.pathname.replace(/\/$/, '')}/api/v1`;
    const api = new URL(apiBase);
    // Local Vite and API development servers normally use different ports
    // (for example 5173 and 8080). The API remains pinned to the configured
    // SPHERE host and protocol; only its port may differ.
    if (api.protocol !== base.protocol || api.hostname !== base.hostname) {
      throw new Error('SPHERE API must use the configured host and protocol');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${apiBase.replace(/\/$/, '')}${path}`, {
        signal: controller.signal, redirect: 'error', size: 5 * 1024 * 1024,
      });
      if (!response.ok) throw new Error(`SPHERE unavailable (${response.status}); keeping local copies`);
      return await response.text();
    } finally { clearTimeout(timeout); }
  }
  async manifest(id: string): Promise<SphereManifest> {
    if (!/^[a-f\d]{24}$/i.test(id)) throw new Error('Invalid pricing identity');
    const result = JSON.parse(await this.request(`/public/pricings/${id}`));
    if (result.pricingId !== id || typeof result.name !== 'string' || !Array.isArray(result.versions) || !result.versions.length ||
      result.versions.some((v: any) => !/^[a-f\d]{24}$/i.test(v.versionId) || typeof v.version !== 'string' || !v.version || /[$\x00]/.test(v.version) ||
        !Number.isFinite(Date.parse(v.createdAt)) || !/^[a-f\d]{64}$/i.test(v.contentHash)) ||
      new Set(result.versions.map((v: any) => escapeVersion(v.version))).size !== result.versions.length) throw new Error('Invalid SPHERE manifest');
    return result;
  }
  async yaml(pricingId: string, versionId: string) {
    if (![pricingId, versionId].every(id => /^[a-f\d]{24}$/i.test(id))) throw new Error('Invalid version identity');
    return this.request(`/public/pricings/${pricingId}/versions/${versionId}/yaml`);
  }
}
