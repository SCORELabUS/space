import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sphereAccessRequired, sphereError } from '../src/lib/sphereAccess';

test('only SPHERE access codes trigger a credential prompt', () => {
  for (const code of ['SPHERE_ACCESS_REQUIRED', 'SPHERE_KEY_REJECTED']) {
    assert.equal(sphereAccessRequired({ response: { data: { code } } }), true);
  }
  for (const error of [{ response: { status: 401 } }, { response: { status: 403 } }, { response: { status: 404 } }, { response: { status: 500 } }, new Error('Network Error')]) {
    assert.equal(sphereAccessRequired(error), false);
  }
});

test('credential storage errors give an actionable message without configuration internals', () => {
  const message = sphereError({ response: { data: { code: 'SPHERE_CREDENTIAL_STORAGE_UNAVAILABLE', error: 'SPHERE_KEY_ENCRYPTION_KEY is not configured' } } });
  assert.match(message, /administrator/);
  assert.doesNotMatch(message, /SPHERE_KEY_ENCRYPTION_KEY/);
  assert.equal(sphereError({ response: { data: { error: 'Check the key permissions.' } } }), 'Check the key permissions.');
});
