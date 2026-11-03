import container from '../config/container';
import { OrganizationApiKeyRole } from '../types/permissions';
import OrganizationRepository from '../repositories/mongoose/OrganizationRepository';
import {
  LeanApiKey,
  LeanOrganization,
  OrganizationFilter,
  OrganizationMember,
} from '../types/models/Organization';
import { generateOrganizationApiKey } from '../utils/users/helpers';
import UserRepository from '../repositories/mongoose/UserRepository';
import { validateOrganizationData } from './validation/OrganizationServiceValidations';
import ServiceService from './ServiceService';

class OrganizationService {
  private organizationRepository: OrganizationRepository;
  private userRepository: UserRepository;
  private serviceService: ServiceService;

  constructor() {
    this.organizationRepository = container.resolve('organizationRepository');
    this.userRepository = container.resolve('userRepository');
    this.serviceService = container.resolve('serviceService');
  }

  async find(filters: OrganizationFilter, limit?: number, offset?: number): Promise<LeanOrganization[]> {
    const organizations = await this.organizationRepository.find(filters, limit, offset);
    return organizations;
  }

  async count(filters: OrganizationFilter): Promise<number> {
    return await this.organizationRepository.count(filters);
  }

  async findById(organizationId: string): Promise<LeanOrganization | null> {
    const organization = await this.organizationRepository.findById(organizationId);
    return organization;
  }

  async findByOwner(owner: string): Promise<LeanOrganization[]> {
    const organization = await this.organizationRepository.findByOwner(owner);
    return organization;
  }

  async findByUser(username: string): Promise<LeanOrganization[]> {
    const organizations = await this.organizationRepository.findByUser(username);
    return organizations;
  }

  async findByApiKey(
    apiKey: string
  ): Promise<{ organization: LeanOrganization; apiKeyData: LeanApiKey }> {
    const organization = await this.organizationRepository.findByApiKey(apiKey);

    if (!organization) {
      throw new Error('Invalid API Key');
    }

    // Find the specific API key data
    const apiKeyData = organization.apiKeys.find(key => key.key === apiKey);

    if (!apiKeyData) {
      throw new Error('Invalid API Key');
    }

    return {
      organization,
      apiKeyData,
    };
  }

  async create(organizationData: any, reqUser: any): Promise<LeanOrganization> {
    validateOrganizationData(organizationData);
    const proposedOwner = await this.userRepository.findByUsername(organizationData.owner);

    if (!proposedOwner) {
      throw new Error(`INVALID DATA: User with username ${organizationData.owner} does not exist.`);
    }

    if (proposedOwner.username !== reqUser.username && reqUser.role !== 'ADMIN') {
      throw new Error('Only admins can create organizations for other users.');
    }

    if (organizationData.default) {
      const proposedOwnerDefaultOrg = await this.organizationRepository.find({ owner: proposedOwner.username, default: true });
  
      if (proposedOwnerDefaultOrg.length > 0) {
        throw new Error(`CONFLICT: The proposed owner ${proposedOwner.username} already has a default organization.`);
      }
    }

    const organizationPayload: any = {
      name: organizationData.name,
      owner: organizationData.owner,
      apiKeys: [
        {
          key: generateOrganizationApiKey(),
          scope: 'ALL',
        },
      ],
      members: [],
      default: organizationData.default || false,
    };

    const organization = await this.organizationRepository.create(organizationPayload);
    return organization;
  }

  async addApiKey(
    organizationId: string,
    scope: OrganizationApiKeyRole,
    reqUser: any
  ): Promise<void> {
    // 1. Basic Input Validation
    const validScopes = ['ALL', 'MANAGEMENT', 'EVALUATION'];
    if (!scope || !validScopes.includes(scope)) {
      throw new Error(`INVALID DATA: scope must be one of ${validScopes.join(', ')}.`);
    }

    const organization = await this.organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error(`Organization with ID ${organizationId} does not exist.`);
    }

    // 2. Identify roles and context once (O(n) search)
    const isSpaceAdmin = reqUser.role === 'ADMIN';
    const isOwner = organization.owner === reqUser.username;

    // Find the requester within the organization members
    const reqMember = organization.members.find(m => m.username === reqUser.username);
    const reqMemberRole = reqMember?.role;

    // Define privilege tiers
    const hasManagerPrivileges = ['OWNER', 'ADMIN', 'MANAGER'].includes(reqMemberRole || '');
    const hasHighPrivileges = ['OWNER', 'ADMIN'].includes(reqMemberRole || '');

    // --- PERMISSION CHECKS ---

    // Rule 1: General permission to add API keys
    // Requires Space Admin, Org Owner, or Org Manager+
    if (!isSpaceAdmin && !isOwner && !hasManagerPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER, ADMIN and MANAGER can add API keys.'
      );
    }

    // Rule 2: Protection for 'ALL' scope keys
    // 'ALL' scope keys are powerful; only Space Admins or Org Owner/Admins can create them.
    if (scope === 'ALL' && !isSpaceAdmin && !isOwner && !hasHighPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER and ADMIN can add API keys with ALL scope.'
      );
    }

    // 3. Data Generation & Persistence
    // We generate the key only after all permissions are verified
    const apiKeyData: LeanApiKey = {
      key: generateOrganizationApiKey(),
      scope: scope,
    };

    await this.organizationRepository.addApiKey(organizationId, apiKeyData);
  }

  async addMember(
    organizationId: string,
    organizationMember: OrganizationMember,
    reqUser: any
  ): Promise<void> {
    // 1. Basic validation
    if (!organizationMember.username || !organizationMember.role) {
      throw new Error('INVALID DATA: organizationMember must have username and role.');
    }

    const organization = await this.organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error(`Organization with ID ${organizationId} does not exist.`);
    }

    // 2. Identify roles and context once
    const isSpaceAdmin = reqUser.role === 'ADMIN';
    const isOwner = organization.owner === reqUser.username;

    // Locate the requester within the organization's member list
    const reqMember = organization.members.find(m => m.username === reqUser.username);
    const reqMemberRole = reqMember?.role;

    // Define privilege tiers
    const hasManagerPrivileges = ['OWNER', 'ADMIN', 'MANAGER'].includes(reqMemberRole || '');
    const hasHighPrivileges = ['OWNER', 'ADMIN'].includes(reqMemberRole || '');

    // --- PERMISSION CHECKS ---

    // Rule 1: General permission to add members
    // Requires Space Admin, Org Owner, or Org Manager+
    if (!isSpaceAdmin && !isOwner && !hasManagerPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER, ADMIN and MANAGER can add members.'
      );
    }

    // Rule 2: Escalated permission for adding High-Level roles
    // Only Space Admins or Org Owner/Admins can grant OWNER or ADMIN roles
    const targetIsHighLevel = ['OWNER', 'ADMIN'].includes(organizationMember.role);
    if (targetIsHighLevel && !isSpaceAdmin && !isOwner && !hasHighPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER/ADMIN can add high-level members.'
      );
    }

    // 3. External dependency check (User existence)
    const userToAssign = await this.userRepository.findByUsername(organizationMember.username);

    if (!userToAssign) {
      throw new Error(`INVALID DATA: User with username ${organizationMember.username} does not exist.`);
    }

    // 4. Persistence
    await this.organizationRepository.addMember(organizationId, organizationMember);
  }
  
  async updateMemberRole(
    organizationId: string,
    username: string,
    role: string,
    reqUser: any
  ): Promise<void> {
    // 1. Basic validation
    if (!username || !role) {
      throw new Error('INVALID DATA: username and role are required.');

    }

    const organization = await this.organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error(`INVALID DATA: Organization with ID ${organizationId} does not exist.`);
    }

    if (!organization.members.some(member => member.username === username)) {
      throw new Error(`INVALID DATA: User with username ${username} is not a member of the organization.`);
    }

    // 2. Identify roles and context once
    const isSpaceAdmin = reqUser.role === 'ADMIN';
    
    // Locate the requester within the organization's member list
    const reqMemberRole = reqUser.orgRole;
    const isOwner = reqMemberRole === 'OWNER';
    
    // Locate user being updated within the organization's member list
    const userToUpdate = organization.members.find(m => m.username === username);

    if (!userToUpdate){
      throw new Error(`INVALID DATA: User with username ${username} is not a member of the organization.`);
    }

    if (userToUpdate.role === role) {
      throw new Error(`CONFLICT: User with username ${username} already has the role ${role}.`);
    }

    // Define privilege tiers
    const hasManagerPrivileges = ['OWNER', 'ADMIN', 'MANAGER'].includes(reqMemberRole || '');
    const hasHighPrivileges = ['OWNER', 'ADMIN'].includes(reqMemberRole || '');

    // --- PERMISSION CHECKS ---

    // Rule 1: General permission to add members
    // Requires Space Admin, Org Owner, or Org Manager+
    if (!isSpaceAdmin && !isOwner && !hasManagerPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER, ADMIN and MANAGER can update member roles.'
      );
    }

    // Rule 2: Escalated permission for adding High-Level roles
    // Only Space Admins or Org Owner/Admins can grant OWNER or ADMIN roles
    const targetIsHighLevel = ['OWNER', 'ADMIN'].includes(userToUpdate?.role || '');
    if (targetIsHighLevel && !isSpaceAdmin && !isOwner && !hasHighPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER/ADMIN can add high-level members.'
      );
    }

    const newRoleIsHighLevel = ['OWNER', 'ADMIN'].includes(role);
    if (newRoleIsHighLevel && !isSpaceAdmin && !isOwner && !hasHighPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER/ADMIN can add high-level members.'
      );
    }

    // 4. Persistence
    await this.organizationRepository.updateMemberRole(organizationId, username, role);
    await container.resolve('eventService').revalidateContractConnections();
  }

  async update(organizationId: string, updateData: any, reqUser: any): Promise<void> {
    const organization = await this.organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error(`INVALID DATA: Organization with ID ${organizationId} does not exist.`);
    }

    if (
      organization.owner !== reqUser.username &&
      reqUser.role !== 'ADMIN' &&
      !organization.members
        .filter(m => m.username && ['OWNER', 'ADMIN', 'MANAGER'].includes(m.role))
        .map(m => m.username)
        .includes(reqUser.username)
    ) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER, ADMIN and MANAGER can update organizations.'
      );
    }

    if (updateData.name) {
      if (typeof updateData.name !== 'string') {
        throw new Error('INVALID DATA: Invalid organization name.');
      }

      organization.name = updateData.name;
    }

    try {
      if (updateData.owner) {
        if (reqUser.role !== 'ADMIN' && organization.owner !== reqUser.username) {
          throw new Error(
            'PERMISSION ERROR: Only SPACE admins or organization owners can change organization ownership.'
          );
        }

        if (organization.default) {
          throw new Error('CONFLICT: Cannot transfer ownership of a default organization.');
        }

        const proposedOwner = await this.userRepository.findByUsername(updateData.owner);
        if (!proposedOwner) {
          throw new Error(`INVALID DATA: User with username ${updateData.owner} does not exist.`);
        }

        // Save the old owner to add them as ADMIN member
        const oldOwner = organization.owner;
        const newOwner = updateData.owner;

        // Check if new owner is currently a member - if so, remove them from members
        const newOwnerIsMember = organization.members.some(m => m.username === newOwner);
        if (newOwnerIsMember) {
          await this.organizationRepository.removeMember(organizationId, newOwner);
        }

        // Check if old owner is already a member
        const oldOwnerIsMember = organization.members.some(m => m.username === oldOwner);

        // Add old owner as ADMIN member if not already a member
        if (!oldOwnerIsMember) {
          await this.organizationRepository.addMember(organizationId, {
            username: oldOwner,
            role: 'ADMIN',
          });
        }

        organization.owner = newOwner;
      }

      if (updateData.default !== undefined) {
        if (typeof updateData.default !== 'boolean') {
          throw new Error('INVALID DATA: Invalid organization default flag.');
        }

        const proposedOwnerDefaultOrg = await this.organizationRepository.find({ owner: organization.owner, default: true });

        if (proposedOwnerDefaultOrg.length > 0) {
          throw new Error(`CONFLICT: The proposed owner ${organization.owner} already has a default organization.`);
        }

        organization.default = updateData.default;
      }

      await this.organizationRepository.update(organizationId, updateData);
    } finally {
      await container.resolve('eventService').revalidateContractConnections();
    }
  }

  async updateUsername(oldUsername: string, newUsername: string): Promise<void> {
    const organizations = await this.organizationRepository.findByUser(oldUsername);
    for (const org of organizations) {
      if (org.owner === oldUsername) {
        await this.organizationRepository.update(org.id!, { owner: newUsername });
      }else{
        await this.organizationRepository.update(org.id!, { members: org.members.map(m => m.username === oldUsername ? { ...m, username: newUsername } : m) });
      }
    }
  }

  async removeApiKey(organizationId: string, apiKey: string, reqUser: any): Promise<void> {
    const organization = await this.organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error(`Organization with ID ${organizationId} does not exist.`);
    }

    // 1. Identify the specific API key to be removed
    const targetKey = organization.apiKeys.find(k => k.key === apiKey);
    if (!targetKey) {
      throw new Error(`API Key not found in organization ${organizationId}.`);
    }

    // 2. Identify roles and context (O(n) search)
    const isSpaceAdmin = reqUser.role === 'ADMIN';
    const isOwner = organization.owner === reqUser.username;

    const reqMember = organization.members.find(m => m.username === reqUser.username);
    const reqMemberRole = reqMember?.role;

    // Define privilege tiers
    const hasManagerPrivileges = ['OWNER', 'ADMIN', 'MANAGER'].includes(reqMemberRole || '');
    const hasHighPrivileges = ['OWNER', 'ADMIN'].includes(reqMemberRole || '');

    // --- PERMISSION CHECKS ---

    // Rule 1: General removal permission
    // At minimum, you must be an Org Manager, Org Owner, or Space Admin to remove any key.
    if (!isSpaceAdmin && !isOwner && !hasManagerPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER, ADMIN and MANAGER can remove API keys.'
      );
    }

    // Rule 2: Protection for 'ALL' scope keys
    // If the key has 'ALL' scope, Managers are NOT allowed to remove it.
    if (targetKey.scope === 'ALL' && !isSpaceAdmin && !isOwner && !hasHighPrivileges) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization-level OWNER and ADMIN can remove API keys with ALL scope.'
      );
    }

    // 3. Execution
    await this.organizationRepository.removeApiKey(organizationId, apiKey);
    await container.resolve('eventService').revalidateContractConnections();
  }

  async removeMember(organizationId: string, username: string, reqUser: any): Promise<void> {
    const organization = await this.organizationRepository.findById(organizationId);

    if (!organization) {
      throw new Error(`Organization with ID ${organizationId} does not exist.`);
    }

    // 1. Identify key roles and context once (O(n) complexity instead of multiple loops)
    const isSpaceAdmin = reqUser.role === 'ADMIN';
    const isOwner = organization.owner === reqUser.username;

    // Find the requester and the target member within the organization's member list
    const reqMember = organization.members.find(m => m.username === reqUser.username);
    const targetMember = organization.members.find(m => m.username === username);

    const reqMemberRole = reqMember?.role;
    const targetMemberRole = targetMember?.role;

    // 2. Define permission flags based on hierarchy
    // High-level staff (Owner, Admin)
    const hasHighPrivileges = ['OWNER', 'ADMIN'].includes(reqMemberRole || '');

    // --- VALIDATION RULES ---

    // Rule 1: Protection for ADMIN members
    // Admin members are protected; they can only be removed by Space Admins, the Owner, or other Org Admins.
    if (targetMemberRole === 'ADMIN') {
      if (!isSpaceAdmin && !isOwner && !hasHighPrivileges) {
        throw new Error(
          'PERMISSION ERROR: Only SPACE admins or organization-level OWNER/ADMIN can remove ADMIN members.'
        );
      }
    }

    // Rule 2: Evaluator restrictions
    // Evaluators do not have management permissions; they can only opt-out (remove themselves).
    if (reqMemberRole === 'EVALUATOR' && username !== reqUser.username) {
      throw new Error('PERMISSION ERROR: Organization EVALUATOR can only remove themselves.');
    }

    // 3. Execute the atomic removal operation in the database
    await this.organizationRepository.removeMember(organizationId, username);
    await container.resolve('eventService').revalidateContractConnections();
  }

  async destroy(organizationId: string, reqUser: any): Promise<void> {
    const organization = await this.organizationRepository.findById(organizationId);
    
    if (!organization) {
      throw new Error(`INVALID DATA: Organization with ID ${organizationId} does not exist.`);
    }

    if (organization.default) {
      throw new Error('CONFLICT: The default organization for a user cannot be deleted.');
    }

    if (
      organization.owner !== reqUser.username &&
      reqUser.role !== 'ADMIN'
    ) {
      throw new Error(
        'PERMISSION ERROR: Only SPACE admins or organization owners can delete organizations.'
      );
    }

    await this.serviceService.prune(organizationId);
    await this.organizationRepository.delete(organizationId);
    await container.resolve('eventService').revalidateContractConnections();
  }

  /**
   * Force delete an organization (bypass default protection). Used when owner is being deleted.
   */
  async forceDelete(organizationId: string): Promise<void> {
    await this.serviceService.prune(organizationId);
    await this.organizationRepository.delete(organizationId);
    await container.resolve('eventService').revalidateContractConnections();
  }

  /**
   * Remove a user from all organizations.
   * - Removes user from members lists
   * - For organizations owned by the user: transfer ownership to next ADMIN, MANAGER, EVALUATOR (in that order)
   *   or delete the organization if no candidates. When `allowDeleteDefault` is true, default orgs can be deleted.
   */
  async removeUserFromOrganizations(username: string, options?: { allowDeleteDefault?: boolean, actingUser?: any }): Promise<void> {
    const allowDeleteDefault = options?.allowDeleteDefault || false;

    // Get organizations where the user is owner or member
    const allOrgs = await this.organizationRepository.findByUser(username);

    try {
      for (const org of allOrgs) {
        const orgId = (org as any).id as string | undefined;

        // If user is a member, remove them
        const isMember = (org.members || []).some(m => m.username === username);
        if (isMember && orgId) {
          try {
            await this.organizationRepository.removeMember(orgId, username);
          } catch (err) {
            // ignore if not present or race
          }
        }

        // If user is owner, handle transfer or deletion
        if (org.owner === username) {
          const members = org.members || [];
          // Candidates exclude owner
          const candidates = members.filter((m: any) => m.username !== username);

          let newOwner: string | undefined;
          if (candidates.length > 0) {
            const adminCandidate = candidates.find((m: any) => m.role === 'ADMIN');
            const managerCandidate = candidates.find((m: any) => m.role === 'MANAGER');
            const evaluatorCandidate = candidates.find((m: any) => m.role === 'EVALUATOR');

            newOwner = (adminCandidate || managerCandidate || evaluatorCandidate)?.username;
          }

          if (newOwner && orgId) {
            // change owner and ensure the old owner is removed from members
            await this.organizationRepository.changeOwner(orgId, newOwner);
            try {
              await this.organizationRepository.removeMember(orgId, username);
            } catch (err) {
              // ignore
            }
          } else if (orgId) {
            // No candidates: delete org. Allow deletion of default when explicitly permitted.
            if (org.default && !allowDeleteDefault) {
              // If default deletion is not allowed, skip transfer/delete — leave org owned by deleted user (edge case)
              continue;
            }
            await this.forceDelete(orgId);
          }
        }
      }
    } finally {
      await container.resolve('eventService').revalidateContractConnections();
    }
  }
}

export default OrganizationService;
