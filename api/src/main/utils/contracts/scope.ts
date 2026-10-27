/**
 * A request named a contract (or a group of contracts) without an organization,
 * and it exists in more than one: `userId` and `groupId` are chosen by each host
 * application and are only unique within an organization.
 *
 * Only platform ADMIN users on the direct `/contracts` routes can get here;
 * every other caller has an organization (its API key's or the route's). The
 * answer is 409 with `code` and the organizations, and nothing is changed.
 */
export class AmbiguousContractScopeError extends Error {
  readonly code: 'AMBIGUOUS_USER_ID' | 'AMBIGUOUS_GROUP_ID';
  readonly organizationIds: string[];

  constructor(kind: 'userId' | 'groupId', value: string, organizationIds: string[]) {
    const route =
      kind === 'userId'
        ? `/organizations/{organizationId}/contracts/${value}`
        : `/organizations/{organizationId}/contracts?groupId=${value}`;
    super(
      `AMBIGUOUS ${kind === 'userId' ? 'USER ID' : 'GROUP ID'}: contracts with ${kind} ${value} exist in ` +
        `${organizationIds.length} organizations. Name one with the organizationId query parameter ` +
        `(?organizationId=<id>) or use ${route}`
    );
    this.name = 'AmbiguousContractScopeError';
    this.code = kind === 'userId' ? 'AMBIGUOUS_USER_ID' : 'AMBIGUOUS_GROUP_ID';
    this.organizationIds = [...organizationIds].sort();
  }
}
