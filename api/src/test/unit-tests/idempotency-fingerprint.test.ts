import { describe, expect, it } from 'vitest';
import { canonicalJson, isStoredStatus, requestFingerprint } from '../../main/middlewares/IdempotencyMiddleware';

const request = {
  method: 'post',
  route: '/api/v1/features/:userId/:featureId',
  params: { userId: '42', featureId: 'petclinic-pets' },
  query: {},
  body: { 'petclinic-maxPets': 1 },
};

describe('requestFingerprint', () => {
  it('does not depend on the order of keys or the case of the method', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}'
    );
    expect(requestFingerprint(request)).toBe(
      requestFingerprint({ ...request, method: 'POST', params: { featureId: 'petclinic-pets', userId: '42' } })
    );
    expect(requestFingerprint(request)).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('changes with the method, route, path parameters, query, body or If-Match', () => {
    const base = requestFingerprint(request);
    for (const changed of [
      { ...request, method: 'PUT' },
      { ...request, route: '/api/v1/features/:userId' },
      { ...request, params: { ...request.params, userId: '43' } },
      { ...request, query: { revert: 'true' } },
      { ...request, body: { 'petclinic-maxPets': 2 } },
      { ...request, ifMatch: '"0-abc"' },
    ]) {
      expect(requestFingerprint(changed)).not.toBe(base);
    }
  });
});

describe('isStoredStatus', () => {
  it('stores outcomes of the operation, not server errors or caller-related answers', () => {
    for (const status of [200, 201, 204, 400, 404, 409, 412, 422]) expect(isStoredStatus(status)).toBe(true);
    for (const status of [401, 403, 408, 429, 500, 502, 503]) expect(isStoredStatus(status)).toBe(false);
  });
});
