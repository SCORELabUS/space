export interface UsageLevel {
  resetTimeStamp?: Date; // o Date si no es serializado
  consumed: number;
}

export interface ContractHistoryEntry {
  startDate: Date;
  endDate: Date;
  contractedServices: Record<string, string>;
  subscriptionPlans: Record<string, string>;
  subscriptionAddOns: Record<string, Record<string, number>>;
}

export interface UserContact {
  userId: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}
export interface LeanContract {
  id?: string;
  userContact: UserContact;
  billingPeriod: {
    startDate: Date;
    endDate: Date;
    autoRenew: boolean;
    renewalDays: number;
  };
  usageLevels: Record<string, Record<string, UsageLevel>>;
  organizationId: string;
  groupId?: string;
  contractedServices: Record<string, string>;
  subscriptionPlans: Record<string, string>;
  subscriptionAddOns: Record<string, Record<string, number>>;
  history: ContractHistoryEntry[];
}

export interface ContractQueryFilters {
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  serviceName?: string; // Nuevo parámetro para filtrar por servicio contratado
  organizationId?: string;
  groupId?: string; // Nuevo parámetro para filtrar por grupo
  page?: number;
  offset?: number;
  limit?: number;
  sort?: 
    | 'firstName'
    | 'lastName'
    | 'username'
    | 'email'
  order?: 'asc' | 'desc';
}

export interface ContractToCreate {
  userContact: {
    userId: string;
    username: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
  };
  billingPeriod?: {
    autoRenew?: boolean;
    renewalDays?: number;
  };
  organizationId: string;
  groupId?: string;
  contractedServices: Record<string, string>; // service name → version
  subscriptionPlans: Record<string, string>; // service name → plan name
  subscriptionAddOns: Record<string, Record<string, number>>; // service name → { addOn: count }
}

export type Subscription = Pick<ContractToCreate, 'contractedServices' | 'subscriptionPlans' | 'subscriptionAddOns'>

export interface UsageLevelsResetQuery {
  reset?: boolean;
  renewableOnly: boolean;
  usageLimit?: string;
}

export interface FallBackSubscription {
  subscriptionPlan: string;
  subscriptionAddOns: Record<string, number>;
}