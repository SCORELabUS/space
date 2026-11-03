/**
 * A request addresses a contract by `userId` (or contracts by `groupId`) and
 * names no organization. `userId` and `groupId` are chosen by each host
 * application and are only unique within an organization, so the organization
 * is part of the contract's identity.
 *
 * Only platform ADMIN users on the direct `/contracts` routes can get here;
 * every other caller has an organization (its API key's or the route's). The
 * answer is 400 with `code: ORGANIZATION_ID_REQUIRED`, before anything is read,
 * locked or written.
 */
export class OrganizationRequiredError extends Error {
  readonly code = 'ORGANIZATION_ID_REQUIRED';

  constructor(kind: 'userId' | 'groupId', value: string) {
    const route =
      kind === 'userId'
        ? `/organizations/{organizationId}/contracts/${value}`
        : `/organizations/{organizationId}/contracts?groupId=${value}`;
    super(
      `ORGANIZATION ID REQUIRED: a ${kind} is only unique within an organization, so platform ADMIN users ` +
        `must name the organization on this route. Pass the organizationId query parameter ` +
        `(?organizationId=<id>) or use ${route}`
    );
    this.name = 'OrganizationRequiredError';
  }
}
