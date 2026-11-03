import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SPHERE_OPENING_TITLE, sphereOpeningPage } from '../src/lib/sphereOpeningPage';

// The page written into the blank tab while SPACE reads an uploaded pricing's YAML.
test('the opening page says which pricing is being opened in SPHERE', () => {
  const html = sphereOpeningPage('2025-1');
  assert.equal(SPHERE_OPENING_TITLE, 'Opening in SPHERE…');
  assert.ok(html.includes(`<title>${SPHERE_OPENING_TITLE}</title>`));
  assert.match(html, /Opening pricing <strong>2025-1<\/strong> in SPHERE…/);
  // Announced to screen readers, with a spinner they skip.
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /class="spinner" aria-hidden="true"/);
});
test('the opening page is self-contained: inline CSS only, no scripts and nothing loaded', () => {
  const html = sphereOpeningPage('2025-1');
  assert.match(html, /<style>[^<]*@keyframes spin[^<]*<\/style>/);
  assert.ok(!/<script|javascript:|\bon[a-z]+=/i.test(html), 'no script');
  assert.ok(!/<(link|img|iframe|object|embed|base|meta http-equiv)\b/i.test(html), 'no external element');
  assert.ok(!/\b(src|href|srcset|action)=|url\(|@import|\/\/|https?:/i.test(html), 'no URL');
});
test('the opening page follows the reader\'s colour scheme and reduced-motion setting', () => {
  const html = sphereOpeningPage('2025-1');
  assert.match(html, /color-scheme: light dark/);
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*animation: none/);
});
test('the version is shown as text, never as markup', () => {
  const html = sphereOpeningPage(`<img src=x onerror="alert('1')">&`);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;'), html);
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('onerror="'));
});
test('a missing version still gives a readable page', () => {
  assert.match(sphereOpeningPage(''), /Opening the pricing in SPHERE…/);
  assert.match(sphereOpeningPage('   '), /Opening the pricing in SPHERE…/);
});
