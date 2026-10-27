import { decodeJwt, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Registered claims of the pricing token (RFC 7519 §4.1, RFC 8725 §3.9): a
 * `userId` is only unique within an organization, so `sub` is the URN
 * `urn:space:<organizationId>:<encodeURIComponent(userId)>` (a valid URI, as
 * RFC 7519 §2 requires of a StringOrURI with ":"), `aud` is the organization,
 * `iss` names the SPACE server, and `userId` / `organizationId` carry the two
 * parts explicitly (the claims clients read; `sub` is not meant to be parsed).
 */
describe('Pricing token claims', function () {
  const organizationId = '65f1c0ffee0000000000000a';
  const otherOrganizationId = '65f1c0ffee0000000000000b';
  const originalIssuer = process.env.JWT_ISSUER;

  afterEach(function () {
    if (originalIssuer === undefined) delete process.env.JWT_ISSUER;
    else process.env.JWT_ISSUER = originalIssuer;
    vi.resetModules();
  });

  /** jwt.ts reads its configuration when it is loaded. */
  async function loadJwt(issuer?: string) {
    if (issuer === undefined) delete process.env.JWT_ISSUER;
    else process.env.JWT_ISSUER = issuer;
    vi.resetModules();
    return import('../../main/utils/jwt');
  }

  async function issue(userId: string, orgId: string | undefined, issuer?: string) {
    const jwt = await loadJwt(issuer);
    const token = await jwt.generateTokenFromEvalResult(
      userId,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      orgId as string
    );
    return { token, key: jwt.encryptJWTSecret(process.env.JWT_SECRET!) };
  }

  it('namespaces sub by organization and carries userId and organizationId explicitly', async function () {
    const { token } = await issue('42', organizationId);
    const claims: any = decodeJwt(token);

    expect(claims.sub).toBe(`urn:space:${organizationId}:42`);
    expect(claims.userId).toBe('42');
    expect(claims.organizationId).toBe(organizationId);
    expect(claims.aud).toBe(organizationId);
    expect(typeof claims.iat).toBe('number');
    expect(typeof claims.exp).toBe('number');
  });

  it('uses the stable default issuer "space" when JWT_ISSUER is not set', async function () {
    const { token, key } = await issue('42', organizationId);

    expect(decodeJwt(token).iss).toBe('space');
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], issuer: 'space', audience: organizationId });
    expect(payload.sub).toBe(`urn:space:${organizationId}:42`);
  });

  it('takes the issuer from JWT_ISSUER', async function () {
    const { token, key } = await issue('42', organizationId, 'https://space.example.com');

    expect(decodeJwt(token).iss).toBe('https://space.example.com');
    await expect(
      jwtVerify(token, key, { algorithms: ['HS256'], issuer: 'space', audience: organizationId })
    ).rejects.toThrow(/iss/);
  });

  it('is rejected by a verifier that expects another organization as audience', async function () {
    const { token, key } = await issue('42', organizationId);

    await expect(
      jwtVerify(token, key, { algorithms: ['HS256'], issuer: 'space', audience: otherOrganizationId })
    ).rejects.toThrow(/aud/);
  });

  it('makes sub a URN whose last part is the percent-encoded userId', async function () {
    const userIds = ['urn:user:7', 'a/b', 'with space', 'Ñandú 用户 🙂', 'x%3Ay', '?#[]@!$&\'()*+,;='];
    for (const userId of userIds) {
      const { token } = await issue(userId, organizationId);
      const claims: any = decodeJwt(token);

      expect(claims.sub).toBe(`urn:space:${organizationId}:${encodeURIComponent(userId)}`);
      // RFC 8141 URN syntax: NID "space", then only unreserved, sub-delims, ":", "@", "/" and %XX.
      expect(claims.sub).toMatch(/^urn:space:[0-9a-f]{24}:(?:[A-Za-z0-9\-._~!$&'()*+,;=:@\/]|%[0-9A-F]{2})+$/);
      expect(() => new URL(claims.sub)).not.toThrow();
      // The userId part round-trips, but clients read the userId claim instead.
      const encoded = claims.sub.slice(`urn:space:${organizationId}:`.length);
      expect(encoded).not.toMatch(/[:/ ]/);
      expect(decodeURIComponent(encoded)).toBe(userId);
      expect(claims.userId).toBe(userId);
    }
  });

  it('gives distinct subjects to the same userId in two organizations and to distinct userIds', async function () {
    const subjects = [
      ['42', organizationId],
      ['42', otherOrganizationId],
      ['a:b', organizationId],
      ['a%3Ab', organizationId],
      ['a', organizationId],
      ['A', organizationId],
    ];
    const subs = new Set<string>();
    for (const [userId, orgId] of subjects) {
      const { token } = await issue(userId, orgId);
      subs.add((decodeJwt(token) as any).sub);
    }
    expect(subs.size).toBe(subjects.length);
  });

  it('refuses to issue a token without an organization', async function () {
    await expect(issue('42', undefined)).rejects.toThrow(/organization/i);
  });
});
