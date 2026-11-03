import { describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../../main/config/permissions';
import { matchPath } from '../../main/utils/routeMatcher';

// The first matching rule decides (AuthMiddleware.checkPermissions).
const rule = (path: string, method: string) =>
  ROUTE_PERMISSIONS.find(r => r.methods.includes(method as any) && matchPath(r.path, path));

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

describe('EVALUATION scope permissions', () => {
  it.each([
    ['/features/user-1', 'all features'],
    ['/features/user-1/pricing-token', 'pricing token'],
    ['/features/user-1/petclinic-visits', 'one feature'],
  ])('allows POST %s (%s)', path => {
    expect(rule(path, 'POST')?.allowedOrgRoles).toContain('EVALUATION');
    expect(rule(path, 'POST')?.allowedUserRoles).toEqual([]);
  });

  it('lets EVALUATION write only through the three evaluation routes', () => {
    const writable = ROUTE_PERMISSIONS.filter(
      r =>
        r.allowedOrgRoles?.includes('EVALUATION') &&
        r.methods.some(method => WRITE_METHODS.includes(method))
    ).map(r => ({ path: r.path, methods: r.methods }));

    expect(writable).toEqual([
      { path: '/features/*', methods: ['POST'] },
      { path: '/features/*/pricing-token', methods: ['POST'] },
      { path: '/features/*/*', methods: ['POST'] },
    ]);
  });

  it.each([
    ['PUT', '/features/user-1'],
    ['PATCH', '/features/user-1/petclinic-visits'],
    ['DELETE', '/features/user-1'],
    ['POST', '/features/user-1/petclinic-visits/extra'],
    ['POST', '/contracts'],
    ['PUT', '/contracts/user-1'],
    ['PUT', '/contracts/user-1/usageLevels'],
    ['PATCH', '/contracts/user-1/billingPeriod'],
    ['DELETE', '/contracts/user-1'],
    ['POST', '/services'],
    ['PUT', '/services/petclinic'],
    ['DELETE', '/services/petclinic'],
    ['POST', '/services/petclinic/pricings'],
    ['PUT', '/services/petclinic/pricings/2025'],
    ['DELETE', '/services/petclinic/pricings/2025'],
  ])('refuses %s %s', (method, path) => {
    expect(rule(path, method)?.allowedOrgRoles ?? []).not.toContain('EVALUATION');
  });

  it('has no rule for a /features/evaluate route, which does not exist', () => {
    expect(ROUTE_PERMISSIONS.some(r => r.path === '/features/evaluate')).toBe(false);
  });
});
