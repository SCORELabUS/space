import { describe, it, expect } from 'vitest';
import nock from 'nock';
import { isSphereSyncEnabled, selectVersion, validateConfiguration, SphereManifest } from '../../main/services/sphere/types';
import { migrateSubscription, migrateUsage, numericPrice } from '../../main/services/sphere/migration';
import SphereClient, { functionalHash } from '../../main/services/sphere/SphereClient';
const a = { versionId: '111111111111111111111111', version: '2030', createdAt: '2024-01-01', contentHash: 'a'.repeat(64) };
const b = { versionId: '222222222222222222222222', version: '2019', createdAt: '2025-01-01', contentHash: 'b'.repeat(64) };
const manifest: SphereManifest = { pricingId: a.versionId, name: 'demo', permanentUrl: '', latestVersionId: b.versionId, versions: [a, b] };
describe('SPHERE policy', () => {
  it.each(['all_last', 'new_last'] as const)('%s selects by pricing date, not label or input order', policy => {
    expect(selectVersion(manifest, { policy, permanentUrl: '' })).toEqual(b);
  });
  it.each(['all_pick', 'new_pick'] as const)('%s selects the exact immutable version', policy => {
    expect(selectVersion(manifest, { policy, permanentUrl: '', selectedVersionId: a.versionId })).toEqual(a);
  });
  it('rejects a missing selected version and missing policy', () => {
    expect(() => selectVersion(manifest, { policy: 'all_pick', permanentUrl: '', selectedVersionId: 'gone' })).toThrow();
    expect(() => validateConfiguration({ policy: 'all_pick', permanentUrl: '' })).toThrow();
  });
  it('accepts only supported polling intervals', () => {
    expect(() => validateConfiguration({ policy: 'new_last', permanentUrl: '', pollIntervalMinutes: 1 })).not.toThrow();
    expect(() => validateConfiguration({ policy: 'new_last', permanentUrl: '', pollIntervalMinutes: 15 })).not.toThrow();
    expect(() => validateConfiguration({ policy: 'new_last', permanentUrl: '', pollIntervalMinutes: 10 as any })).toThrow('polling interval');
  });
  it('enables the periodic worker unless explicitly disabled', () => {
    expect(isSphereSyncEnabled(undefined)).toBe(true);
    expect(isSphereSyncEnabled('true')).toBe(true);
    expect(isSphereSyncEnabled('false')).toBe(false);
  });
  it('never downgrades automatically when the current public version disappears', () => {
    expect(() => selectVersion({ ...manifest, versions: [a] }, { policy: 'all_last', permanentUrl: '' }, b)).toThrow();
  });
  it('uses a deterministic identity tie-break', () => {
    expect(selectVersion({ ...manifest, versions: [a, { ...b, createdAt: a.createdAt }] }, { policy: 'new_last', permanentUrl: '' }).versionId).toBe(b.versionId);
  });
});
describe('fallback and usage', () => {
  const contract = { contractedServices: { demo: 'old', other: 'same' }, subscriptionPlans: { demo: 'removed', other: 'plan' }, subscriptionAddOns: { demo: { removed: 1 }, other: { addon: 2 } } };
  const pricing: any = { version: 'new', plans: { sales: { price: 'Contact sales' }, hidden: { price: 0, private: true }, expensive: { price: 12 }, cheap: { price: '2.5' } } };
  it('preserves a compatible subscription', () => {
    const result = migrateSubscription(contract, 'demo', pricing, () => {});
    expect(result.replaced).toBe(false); expect(result.subscription.subscriptionAddOns.demo).toEqual({ removed: 1 });
    expect(contract.contractedServices.demo).toBe('old');
  });
  it('selects cheapest valid public numeric plan with no add-ons and preserves other services', () => {
    const result = migrateSubscription(contract, 'demo', pricing, s => { if (!pricing.plans[s.subscriptionPlans.demo]) throw Error(); });
    expect(result.replaced).toBe(true); expect(result.subscription.subscriptionPlans).toEqual({ demo: 'cheap', other: 'plan' });
    expect(result.subscription.subscriptionAddOns).toEqual({ demo: {}, other: { addon: 2 } });
  });
  it('tries the next valid candidate and rejects impossible migrations', () => {
    expect(migrateSubscription(contract, 'demo', pricing, s => { if (s.subscriptionPlans.demo !== 'expensive') throw Error(); }).subscription.subscriptionPlans.demo).toBe('expensive');
    expect(() => migrateSubscription(contract, 'demo', pricing, () => { throw Error(); })).toThrow('No valid');
    expect(() => migrateSubscription(contract, 'demo', { version: 'new' } as any, () => { throw Error(); })).toThrow('No valid');
  });
  it.each(['', ' ', 'free', '-2', '1 + 2', 'Infinity', NaN, Infinity, -1])('does not invent numeric prices for %s', value => {
    expect(numericPrice(value)).toBeNull();
  });
  it('preserves consumption above the new limit, initializes new limits and removes disappeared limits', () => {
    const limit = { name: 'calls', type: 'NON_RENEWABLE', valueType: 'NUMERIC', trackable: true };
    const old: any = { usageLimits: { calls: limit } };
    const next: any = { usageLimits: { calls: { ...limit, defaultValue: 2 }, extra: { ...limit, name: 'extra' } } };
    expect(migrateUsage(old, next, { calls: { consumed: 15 }, gone: { consumed: 9 } })).toEqual({ calls: { consumed: 15 }, extra: { consumed: 0 } });
  });
  it('blocks incompatible consumption semantics', () => {
    const limit = { name: 'calls', type: 'RENEWABLE', valueType: 'NUMERIC', trackable: true, period: { unit: 'DAY', value: 1 } };
    expect(() => migrateUsage({ usageLimits: { calls: limit } } as any, { usageLimits: { calls: { ...limit, period: { unit: 'MONTH', value: 1 } } } } as any, { calls: { consumed: 1 } })).toThrow('Incompatible');
  });
});
describe('trusted source and immutable content', () => {
  it('only accepts permanent pricing links on the configured origin', () => {
    const client = new SphereClient();
    expect(client.parseLink('https://sphere.score.us.es/p/' + a.versionId).pricingId).toBe(a.versionId);
    for (const link of ['http://localhost/p/', 'https://evil.example/p/', 'https://sphere.score.us.es/c/', 'https://sphere.score.us.es@evil.example/p/']) {
      expect(() => client.parseLink(link + a.versionId)).toThrow();
    }
  });
  it('accepts a separately ported local API on the configured SPHERE host', async () => {
    const previous = {
      publicUrl: process.env.SPHERE_PUBLIC_URL,
      apiUrl: process.env.SPHERE_API_URL,
      allowHttp: process.env.SPHERE_ALLOW_LOCAL_HTTP,
      environment: process.env.ENVIRONMENT,
    };
    try {
      process.env.SPHERE_PUBLIC_URL = 'http://localhost:5173';
      process.env.SPHERE_API_URL = 'http://localhost:8080/api/v1';
      process.env.SPHERE_ALLOW_LOCAL_HTTP = 'true';
      process.env.ENVIRONMENT = 'development';
      nock('http://localhost:8080').get(`/api/v1/public/pricings/${a.versionId}`).reply(200, {
        pricingId: a.versionId, name: 'demo', permanentUrl: `http://localhost:5173/p/${a.versionId}`,
        latestVersionId: a.versionId, versions: [a],
      });
      await expect(new SphereClient().manifest(a.versionId)).resolves.toMatchObject({ pricingId: a.versionId });
    } finally {
      for (const [key, value] of Object.entries({
        SPHERE_PUBLIC_URL: previous.publicUrl,
        SPHERE_API_URL: previous.apiUrl,
        SPHERE_ALLOW_LOCAL_HTTP: previous.allowHttp,
        ENVIRONMENT: previous.environment,
      })) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      nock.cleanAll();
    }
  });
  it('hashes functional changes but not SaaS renames or YAML field order', () => {
    expect(functionalHash('saasName: A\nversion: 1\nplans: {free: {price: 0}}')).toBe(functionalHash('plans: {free: {price: 0}}\nversion: 1\nsaasName: B'));
    expect(functionalHash('version: 1')).not.toBe(functionalHash('version: 2'));
  });
});
