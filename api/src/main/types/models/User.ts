import { UserRole } from '../../types/permissions';

export interface LeanUser {
  id: string;
  username: string;
  password?: string;
  apiKey: string;
  role: UserRole;
  orgRole?: string;
}