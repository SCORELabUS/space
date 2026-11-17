import { OrganizationApiKeyRole } from "../../types/permissions";

export interface LeanOrganization {
  id?: string;
  name: string;
  owner: string;
  ownerAlias?: string;
  default?: boolean;
  apiKeys: LeanApiKey[];
  members: OrganizationMember[];
}

export interface LeanApiKey {
  key: string;
  scope: OrganizationApiKeyRole;
}

export type OrganizationUserRole = 'OWNER' | 'ADMIN' | 'MANAGER' | 'EVALUATOR';

export interface OrganizationFilter {
  owner?: string;
  username?: string;
  default?: boolean;
  name?: string;
}

export interface OrganizationMember {
  username: string;
  identityAlias?: string;
  role: OrganizationUserRole;
}