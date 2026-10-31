import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PricingContractCounts from '../src/components/services/PricingContractCounts';

test('keeps old contracted versions visible even when SPHERE no longer lists them', () => {
  const html = renderToStaticMarkup(createElement(PricingContractCounts, {
    counts: [{ version: '1.0', count: 7 }, { version: '2.0', count: 3 }],
    versions: ['2.0', '3.0'], target: '2.0',
  }));
  assert.match(html, /10 contracts/);
  assert.match(html, /1\.0<\/span>/);
  assert.match(html, />7<\/td>/);
  assert.match(html, />3<\/td>/);
  assert.match(html, />0<\/td>/);
  assert.match(html, /New contracts/);
});

test('distinguishes no contracts from counts unavailable on an older server', () => {
  const empty = renderToStaticMarkup(createElement(PricingContractCounts, { counts: [], versions: ['1.0'], target: '1.0' }));
  assert.match(empty, /0 contracts/);
  assert.match(empty, /No contracts currently use this service/);
  const unavailable = renderToStaticMarkup(createElement(PricingContractCounts, { versions: ['1.0'], target: '1.0' }));
  assert.match(unavailable, /counts are unavailable/);
  assert.doesNotMatch(unavailable, /0 contracts/);
});

test('keeps paused cohorts visible and labels the applied target without promising new contracts', () => {
  const html = renderToStaticMarkup(createElement(PricingContractCounts, {
    counts: [{ version: '1.0', count: 4 }], versions: ['1.0', '2.0'], target: '2.0', disabled: true,
  }));
  assert.match(html, /4 contracts/);
  assert.match(html, /Applied target/);
  assert.doesNotMatch(html, /New contracts/);
  assert.match(html, />4<\/td>/);
});
