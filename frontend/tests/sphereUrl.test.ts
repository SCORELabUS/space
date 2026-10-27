import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import LZString from 'lz-string';
import {
  DEFAULT_SPHERE_URL,
  SPHERE_FRAGMENT_MAX_ENCODED,
  sphereEditorContentUrl,
  sphereEditorFragmentUrl,
  sphereEditorFragmentEnabled,
  sphereViewLink,
  spherePricingUrl,
} from '../src/lib/sphereUrl';

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
const uploaded = { yamlPath: '/private/pricings/org-zoom-2025.yaml' };
const fragment = { editorFragment: true };
test('a pricing file stored by SPACE is not offered while SPHERE\'s editor does not read #pricing=', () => {
  assert.equal(sphereViewLink(uploaded), null);
  assert.equal(sphereViewLink(uploaded, 'https://sphere.score.us.es', {}), null);
  assert.equal(sphereViewLink(uploaded, 'https://sphere.score.us.es', { editorFragment: false }), null);
});
test('the SPHERE_EDITOR_FRAGMENT setting is on only when it is true', () => {
  for (const value of ['true', 'TRUE', ' true ']) assert.equal(sphereEditorFragmentEnabled(value), true, value);
  for (const value of [undefined, '', 'false', '1', 'yes', true]) assert.equal(sphereEditorFragmentEnabled(value), false, String(value));
});
test('a pricing file stored by SPACE opens the bare SPHERE editor when it reads #pricing=', () => {
  assert.deepEqual(sphereViewLink(uploaded, undefined, fragment), { kind: 'content', url: 'https://sphere.score.us.es/editor' });
  assert.deepEqual(sphereViewLink(uploaded, 'http://localhost:5173/', fragment), { kind: 'content', url: 'http://localhost:5173/editor' });
  assert.equal(sphereViewLink(uploaded, 'https://example.org/sphere', fragment)?.url, 'https://example.org/sphere/editor');
  assert.equal(sphereViewLink(uploaded, 'not a url', fragment)?.url, `${DEFAULT_SPHERE_URL}/editor`);
  const url = new URL(sphereViewLink(uploaded, 'https://sphere.score.us.es', fragment)!.url);
  assert.equal(url.search + url.hash, '');
  assert.ok(!/private|pricings|yaml|zoom/i.test(url.href), url.href);
});
test('snapshots and external URL pricings keep their own links even with a stored file', () => {
  assert.equal(sphereViewLink(snapshot, undefined, fragment)?.kind, 'permalink');
  assert.deepEqual(sphereViewLink({ ...uploaded, url: 'https://example.org/pricings/zoom.yaml' }, undefined, fragment), {
    kind: 'editor', url: 'https://sphere.score.us.es/editor?pricingUrl=https%3A%2F%2Fexample.org%2Fpricings%2Fzoom.yaml' });
  // A snapshot whose SPHERE ID is unusable is still a file SPACE can read and hand over.
  assert.equal(sphereViewLink({ ...uploaded, sphere: { pricingId: 'not-an-id' } }, undefined, fragment)?.kind, 'content');
});
test('a pricing with no stored file and no usable link is not offered in SPHERE', () => {
  for (const options of [{}, fragment]) {
    assert.equal(sphereViewLink({}, undefined, options), null);
    assert.equal(sphereViewLink({ yamlPath: '  ' }, undefined, options), null);
    // Relative or non-HTTP locations are not external URLs.
    assert.equal(sphereViewLink({ url: '/private/pricings/org-zoom-2025.yaml' }, undefined, options), null);
    assert.equal(sphereViewLink({ url: 'file:///etc/passwd' }, undefined, options), null);
    assert.equal(sphereViewLink({ sphere: { pricingId: 'not-an-id' } }, undefined, options), null);
  }
});

// The content of an uploaded pricing goes in the editor's URL fragment.
const github = readFileSync(new URL('../../api/src/test/data/pricings/github-2025.yml', import.meta.url), 'utf8');
const editor = 'https://sphere.score.us.es/editor';
function fragmentValue(url: string): string {
  const prefix = `${editor}#pricing=`;
  assert.ok(url.startsWith(prefix), url.slice(0, 80));
  return url.slice(prefix.length);
}
test('the YAML travels only in #pricing=, encoded like SPHERE\'s share links, and decodes whole', () => {
  const result = sphereEditorContentUrl(editor, github);
  assert.ok(result.ok);
  const url = new URL(result.url);
  assert.equal(url.origin + url.pathname, editor);
  assert.equal(url.search, '');
  assert.ok(!result.url.includes('?'));
  const value = fragmentValue(result.url);
  // Only the encoding alphabet after `#pricing=`: no other parameter, nothing re-encoded.
  assert.match(value, /^[A-Za-z0-9+\-$]+$/);
  assert.equal(url.hash, `#pricing=${value}`);
  assert.equal(result.encodedLength, value.length);
  assert.equal(LZString.decompressFromEncodedURIComponent(value), github);
});
test('the editor gets the YAML back when it reads #pricing= as a form-encoded parameter', () => {
  // SPHERE's editor reads the fragment with URLSearchParams, which turns `+` into a space;
  // lz-string's decoder turns it back.
  const yaml = 'saasName: Zoom\n'.repeat(400) + github;
  const result = sphereEditorContentUrl(editor, yaml);
  assert.ok(result.ok);
  const read = new URLSearchParams(new URL(result.url).hash.slice(1)).get('pricing');
  assert.ok(read);
  assert.equal(LZString.decompressFromEncodedURIComponent(read), yaml);
});
test('a query or fragment already in the editor URL is dropped, never kept beside the content', () => {
  const result = sphereEditorContentUrl(`${editor}?pricing=abc&x=1#old`, 'saasName: Zoom\n');
  assert.ok(result.ok);
  assert.ok(!result.url.includes('?pricing='));
  assert.equal(LZString.decompressFromEncodedURIComponent(fragmentValue(result.url)), 'saasName: Zoom\n');
});
test('the content is accepted up to the cap and refused one character above it, never truncated', () => {
  const encodedLength = (sphereEditorContentUrl(editor, github) as { encodedLength: number }).encodedLength;
  const atCap = sphereEditorContentUrl(editor, github, encodedLength);
  assert.ok(atCap.ok);
  assert.equal(LZString.decompressFromEncodedURIComponent(fragmentValue(atCap.url)), github);
  assert.deepEqual(sphereEditorContentUrl(editor, github, encodedLength - 1), {
    ok: false, reason: 'too-large', encodedLength, maxEncodedLength: encodedLength - 1 });
});
test('the default cap is 512 KiB encoded: accepted at the cap, refused one byte above it', () => {
  assert.equal(SPHERE_FRAGMENT_MAX_ENCODED, 524_288);
  // `A` is in the encoding alphabet, so the value is exactly as long as it looks.
  const atCap = sphereEditorFragmentUrl(editor, 'A'.repeat(SPHERE_FRAGMENT_MAX_ENCODED));
  assert.ok(atCap.ok);
  assert.equal(atCap.encodedLength, SPHERE_FRAGMENT_MAX_ENCODED);
  assert.equal(fragmentValue(atCap.url).length, SPHERE_FRAGMENT_MAX_ENCODED);
  assert.deepEqual(sphereEditorFragmentUrl(editor, 'A'.repeat(SPHERE_FRAGMENT_MAX_ENCODED + 1)), {
    ok: false, reason: 'too-large', encodedLength: SPHERE_FRAGMENT_MAX_ENCODED + 1, maxEncodedLength: SPHERE_FRAGMENT_MAX_ENCODED });
  assert.deepEqual(sphereEditorFragmentUrl(editor, ''), { ok: false, reason: 'empty' });
});
test('real pricings fit the default cap, and a YAML that encodes above it is refused', () => {
  // About the largest real pricing (53,107 bytes of YAML): far below the cap.
  let large = github;
  while (Buffer.byteLength(large) < 53_107) large += `\n# ${'x'.repeat(60)}`;
  const fits = sphereEditorContentUrl(editor, large);
  assert.ok(fits.ok && fits.encodedLength < SPHERE_FRAGMENT_MAX_ENCODED);
  // Pseudo-random text barely compresses.
  let seed = 7;
  const noise = Array.from({ length: 600_000 }, () => String.fromCharCode(33 + ((seed = (seed * 48271) % 2147483647) % 90))).join('');
  const refused = sphereEditorContentUrl(editor, noise);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.reason === 'too-large' && refused.encodedLength > SPHERE_FRAGMENT_MAX_ENCODED);
});
test('an empty YAML file is not handed to SPHERE', () => {
  assert.deepEqual(sphereEditorContentUrl(editor, ''), { ok: false, reason: 'empty' });
  assert.deepEqual(sphereEditorContentUrl(editor, ' \n'), { ok: false, reason: 'empty' });
});
test('an unusable SPHERE address falls back to the public SPHERE', () => {
  assert.equal(sphereViewLink({ url: 'https://example.org/p.yaml' }, 'not a url')!.url.startsWith(`${DEFAULT_SPHERE_URL}/editor?`), true);
  assert.equal(sphereViewLink(snapshot, 'not a url')!.url, `https://sphere.score.us.es/p/${pricingId}`);
});
