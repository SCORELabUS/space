import { describe, expect, it } from 'vitest';
import { ROUTE_PERMISSIONS } from '../../main/config/permissions';
import { matchPath } from '../../main/utils/routeMatcher';
const rule = (path: string, method: string) => ROUTE_PERMISSIONS.find(r => r.methods.includes(method as any) && matchPath(r.path, path));
describe('SPHERE synchronization permissions', () => {
  it.each(['/services/sphere/preview', '/services/demo/synchronization/run'])('requires management scope for %s', path => {
    expect(rule(path, 'POST')?.allowedOrgRoles).toEqual(['ALL', 'MANAGEMENT']);
    expect(rule(path, 'POST')?.allowedUserRoles).toEqual([]);
  });
  it('separates read from write permissions', () => {
    expect(rule('/services/demo/synchronization', 'GET')?.allowedOrgRoles).toContain('EVALUATION');
    expect(rule('/services/demo/synchronization', 'PUT')?.allowedOrgRoles).not.toContain('EVALUATION');
  });
  it.each(['/organizations/org/services/sphere/preview', '/organizations/org/services/demo/synchronization/run'])('requires user authentication for %s', path => {
    expect(rule(path, 'POST')?.requiresUser).toBe(true);
    expect(rule(path, 'POST')?.isPublic).not.toBe(true);
  });
});
