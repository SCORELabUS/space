import container from '../config/container';
import UserRepository from '../repositories/mongoose/UserRepository';
import { LeanUser } from '../types/models/User';
import { UserRole, USER_ROLES } from '../types/permissions';
import { hashPassword } from '../utils/users/helpers';
import OrganizationService from './OrganizationService';

class UserService {
  private userRepository: UserRepository;
  private organizationService: OrganizationService;

  private sanitizeUserForRequester(user: LeanUser, requester?: LeanUser, targetUsername?: string): LeanUser {
    if (!requester || requester.role === 'ADMIN') {
      return user;
    }

    const effectiveTargetUsername = targetUsername || user.username;
    const isOwnData = effectiveTargetUsername === requester.username;

    if (isOwnData) {
      return user;
    }

    const { role, apiKey, ...safeUser } = user as any;
    return safeUser as LeanUser;
  }

  constructor() {
    this.userRepository = container.resolve('userRepository');
    this.organizationService = container.resolve('organizationService');
  }

  async getUsers(reqUser: LeanUser, query: string = '', limit: number = 10, offset: number = 0): Promise<LeanUser[]> {
    
    const users = await this.userRepository.find(query.trim(), limit, offset);

    return users.map(user => this.sanitizeUserForRequester(user, reqUser, user.username));
  }

  async countUsers(query: string = '') {
    return this.userRepository.count(query.trim());
  }

  async findByUsername(username: string, reqUser: LeanUser): Promise<LeanUser> {
    const user = await this.userRepository.findByUsername(username);
    if (!user) {
      throw new Error('INVALID DATA: User not found');
    }
    return this.sanitizeUserForRequester(user, reqUser, username);
  }

  async findByApiKey(apiKey: string) {
    const user = await this.userRepository.findByApiKey(apiKey);
    if (!user) {
      throw new Error('INVALID DATA: Invalid API Key');
    }
    return user;
  }

  async create(userData: any, creatorData: LeanUser) {
    
    const existingUser = await this.userRepository.findByUsername(userData.username);
    if (existingUser) {
      throw new Error('INVALID DATA: There is already a user with the username that you are trying to set');
    }
    
    // Stablish a default role if not provided
    if (!creatorData || !userData.role) {
      userData.role = USER_ROLES[USER_ROLES.length - 1];
    }

    if (creatorData && (creatorData.role !== 'ADMIN' && userData.role === 'ADMIN')) {
      throw new Error('PERMISSION ERROR: Only admins can create other admins.');
    }

    const createdUser: LeanUser = await this.userRepository.create(userData);

    await this.organizationService.create(
      { name: `${createdUser.username}'s Organization`, owner: createdUser.username, default: true },
      createdUser
    );
    
    return this.sanitizeUserForRequester(createdUser, creatorData, createdUser.username);
  }

  async update(username: string, userData: any, creatorData: LeanUser) {
    
    if (creatorData && (creatorData.role !== 'ADMIN' && userData.role === 'ADMIN')) {
      throw new Error('PERMISSION ERROR: Only admins can change roles to admin.');
    }
    
    const user = await this.userRepository.findByUsername(username);
    if (!user) {
      throw new Error('INVALID DATA: User not found');
    }

    if (user.role === 'ADMIN' && creatorData && creatorData.role !== 'ADMIN') {
      throw new Error('PERMISSION ERROR: Only admins can update admin users.');
    }

    // Validación: no permitir degradar al último admin
    if (user.role === 'ADMIN' && userData.role && userData.role !== 'ADMIN') {
      const allUsers = await this.userRepository.findAll();
      const adminCount = allUsers.filter((u: LeanUser) => u.role === 'ADMIN' && u.username !== username).length;
      if (adminCount < 1) {
        throw new Error('PERMISSION ERROR: There must always be at least one ADMIN user in the system.');
      }
    }

    if (userData.username){
      const existingUser = await this.userRepository.findByUsername(userData.username);
      if (existingUser) {
        throw new Error('INVALID DATA: There is already a user with the username that you are trying to set');
      }
    }

    if (userData.password) {
      userData.password = await hashPassword(userData.password);
    }

    const updatedUser = await this.userRepository.update(username, userData);

    try {
      // If the username was changed, update the owner field in the organizations owned by the user
      if (userData.username && userData.username !== username) {
        await this.organizationService.updateUsername(username, userData.username);
      }
    } finally {
      await container.resolve('eventService').revalidateContractConnections();
    }

    return this.sanitizeUserForRequester(updatedUser, creatorData, username);
  }

  async regenerateApiKey(username: string, reqUser: LeanUser): Promise<string> {
    if (reqUser.username !== username && reqUser.role !== 'ADMIN') {
      throw new Error('PERMISSION ERROR: Only admins can regenerate API keys for other users.');
    }
    
    const newApiKey = await this.userRepository.regenerateApiKey(username);
    
    if (!newApiKey) {
      throw new Error('API Key could not be regenerated');
    }
    
    await container.resolve('eventService').revalidateContractConnections();
    return newApiKey;
  }

  async changeRole(username: string, role: UserRole, creatorData: LeanUser) {
    
    if (creatorData.role !== 'ADMIN' && role === 'ADMIN') {
      throw new Error('PERMISSION ERROR: Only admins can assign the role ADMIN.');
    }

    if (creatorData.role === 'USER' && creatorData.username !== username){
      throw new Error('PERMISSION ERROR: Only admins can change roles for other users.');
    }
    
    const user = await this.userRepository.findByUsername(username);
    if (!user) {
      throw new Error('INVALID DATA: User not found');
    }

    if (creatorData.role !== 'ADMIN' && user.role === 'ADMIN') {
      throw new Error('PERMISSION ERROR: Only admins can update admin users.');
    }

    // Validación: no permitir degradar al último admin
    if (user.role === 'ADMIN' && role !== 'ADMIN') {
      const allAdmins = await this.userRepository.findByRole("ADMIN");
      if (allAdmins.length < 2) {
        throw new Error('PERMISSION ERROR: There must always be at least one ADMIN user in the system.');
      }
    }

    const updatedUser = await this.userRepository.changeRole(username, role);
    await container.resolve('eventService').revalidateContractConnections();
    return this.sanitizeUserForRequester(updatedUser, creatorData, username);
  }

  async authenticate(username: string, password: string): Promise<LeanUser> {
    // Find user by username
    const user = await this.userRepository.authenticate(username, password);
    if (!user) {
      throw new Error('INVALID DATA: Invalid credentials');
    }

    return user;
  }

  async destroy(username: string, reqUser: LeanUser) {
    // Comprobar si el usuario a eliminar es admin
    const user = await this.userRepository.findByUsername(username);
    if (!user) {
      throw new Error('INVALID DATA: User not found');
    }
    
    if (reqUser.role !== 'ADMIN' && user.role === 'ADMIN') {
      throw new Error('PERMISSION ERROR: Only admins can delete admin users.');
    }

    if (user.role === 'ADMIN') {
      // Contar admins restantes
      const admins = await this.userRepository.findAll({role: 'ADMIN'});
      if (admins.length < 2) {
        throw new Error('PERMISSION ERROR: There must always be at least one ADMIN user in the system.');
      }
    }
    // Remove user from organizations and reassign/delete owned orgs when needed
    await this.organizationService.removeUserFromOrganizations(username, { allowDeleteDefault: true, actingUser: reqUser });

    const result = await this.userRepository.destroy(username);
    if (!result) {
      throw new Error('INVALID DATA: User not found');
    }
    await container.resolve('eventService').revalidateContractConnections();
    return true;
  }
}

export default UserService;
