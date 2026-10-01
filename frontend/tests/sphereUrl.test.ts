import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spherePricingUrl } from '../src/lib/sphereUrl';

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
