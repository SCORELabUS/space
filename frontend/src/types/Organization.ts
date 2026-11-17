export interface OrganizationMember {
  username: string;
  identityAlias?: string;
  role: 'ADMIN' | 'MANAGER' | 'EVALUATOR';
}

export interface OrganizationApiKey {
  key: string;
  scope: 'ALL' | 'MANAGEMENT' | 'EVALUATION';
}

export interface Organization {
  id: string;
  name: string;
  owner: string;
  ownerAlias?: string;
  default?: boolean;
  apiKeys: OrganizationApiKey[];
  members: OrganizationMember[];
}

export interface CreateOrganizationRequest {
  name: string;
  owner: string;
}

export interface UpdateOrganizationRequest {
  name?: string;
  owner?: string;
}

export interface AddMemberRequest {
  username: string;
  role: 'ADMIN' | 'MANAGER' | 'EVALUATOR';
}

export interface CreateApiKeyRequest {
  scope: 'ALL' | 'MANAGEMENT' | 'EVALUATION';
}
