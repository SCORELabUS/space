import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SPHERE_URL, sphereViewLink, spherePricingUrl } from '../src/lib/sphereUrl';

const internal = 'http://sphere-server:8080/p/pricing-id';
test('uses the browser-facing address while keeping the pricing ID', () => {
  assert.equal(spherePricingUrl(internal, 'http://localhost:5402'), 'http://localhost:5402/p/pricing-id');
});
test('accepts a trailing slash and preserves query and fragment', () => {
  assert.equal(spherePricingUrl(internal + '?version=2.4.0#versions', 'https://sphere.example/'), 'https://sphere.example/p/pricing-id?version=2.4.0#versions');
});
test('supports SPHERE hosted under a path prefix', () => {
  assert.equal(spherePricingUrl(internal, 'https://example.org/sphere/'), 'https://example.org/sphere/p/pricing-id');
});
test('keeps the permanent link when no public address is configured', () => {
  assert.equal(spherePricingUrl(internal), internal);
  assert.equal(spherePricingUrl(internal, '  '), internal);
});

// "View in SPHERE" for each kind of pricing.
const pricingId = '65f0c1a2b3c4d5e6f7a8b9c0';
const versionId = '66a1b2c3d4e5f6a7b8c9d0e1';
const snapshot = { yamlPath: `/private/sphere/svc/${versionId}.yaml`,
  sphere: { pricingId, versionId, permanentUrl: `https://sphere.score.us.es/p/${pricingId}` } };

test('a SPHERE snapshot opens the permanent link of its SPHERE pricing', () => {
  assert.deepEqual(sphereViewLink(snapshot), { kind: 'permalink', url: `https://sphere.score.us.es/p/${pricingId}` });
  assert.deepEqual(sphereViewLink(snapshot, 'https://sphere.score.us.es'), { kind: 'permalink', url: `https://sphere.score.us.es/p/${pricingId}` });
});
test('a SPHERE snapshot uses the browser-facing SPHERE address', () => {
  const internal = { sphere: { pricingId, versionId, permanentUrl: `http://sphere-server:8080/p/${pricingId}` } };
  assert.equal(sphereViewLink(internal, 'http://localhost:5402/')?.url, `http://localhost:5402/p/${pricingId}`);
});
test('a SPHERE snapshot without a usable permanent link builds it from the pricing ID', () => {
  assert.equal(sphereViewLink({ sphere: { pricingId: pricingId.toUpperCase(), versionId } })?.url, `https://sphere.score.us.es/p/${pricingId}`);
  assert.equal(sphereViewLink({ sphere: { pricingId, versionId, permanentUrl: 'javascript:alert(1)' } }, 'https://example.org/sphere')?.url,
    `https://example.org/sphere/p/${pricingId}`);
  // A permanent link of another pricing is not trusted.
  assert.equal(sphereViewLink({ sphere: { pricingId, versionId, permanentUrl: `https://sphere.score.us.es/p/${versionId}` } })?.url,
    `https://sphere.score.us.es/p/${pricingId}`);
});
test('a SPHERE link never carries a YAML URL or the pricing content', () => {
  const url = sphereViewLink({ ...snapshot, url: 'https://example.org/pricing.yaml' }, 'https://sphere.score.us.es')!.url;
  assert.ok(!/editor|pricingUrl|pricing=|yaml/i.test(url), url);
});
test('a pricing defined by an external URL opens in the SPHERE editor', () => {
  assert.deepEqual(sphereViewLink({ url: 'https://example.org/pricings/zoom.yaml' }), {
    kind: 'editor', url: 'https://sphere.score.us.es/editor?pricingUrl=https%3A%2F%2Fexample.org%2Fpricings%2Fzoom.yaml' });
});
test('the external URL is passed whole, query and fragment included', () => {
  const remote = 'https://example.org/p.yaml?a=1&b=2#x';
  const url = new URL(sphereViewLink({ url: remote }, 'http://localhost:5173')!.url);
  assert.equal(url.origin + url.pathname, 'http://localhost:5173/editor');
  assert.equal(url.searchParams.get('pricingUrl'), remote);
  assert.equal([...url.searchParams.keys()].length, 1);
});
test('a pricing file stored by SPACE is not offered in SPHERE', () => {
  assert.equal(sphereViewLink({ yamlPath: '/private/pricings/org-zoom-2025.yaml' } as never), null);
  assert.equal(sphereViewLink({}), null);
  // Relative or non-HTTP locations are not external URLs.
  assert.equal(sphereViewLink({ url: '/private/pricings/org-zoom-2025.yaml' }), null);
  assert.equal(sphereViewLink({ url: 'file:///etc/passwd' }), null);
  assert.equal(sphereViewLink({ sphere: { pricingId: 'not-an-id' } }), null);
});
test('an unusable SPHERE address falls back to the public SPHERE', () => {
  assert.equal(sphereViewLink({ url: 'https://example.org/p.yaml' }, 'not a url')!.url.startsWith(`${DEFAULT_SPHERE_URL}/editor?`), true);
  assert.equal(sphereViewLink(snapshot, 'not a url')!.url, `https://sphere.score.us.es/p/${pricingId}`);
});
