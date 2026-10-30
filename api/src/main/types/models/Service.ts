import { SphereSource } from '../../services/sphere/types';
export interface PricingEntry {
  id?: string;
  url?: string;
}

export interface LeanService {
  source?: 'manual' | 'sphere';
  sphere?: SphereSource;
  id?: string;
  name: string;
  disabled: boolean;
  organizationId: string;
  /** Manual services: version assigned to new contracts that omit one (an active version). */
  defaultVersion?: string;
  activePricings: Map<string, PricingEntry>;
  archivedPricings?: Map<string, PricingEntry>;
}

export type ServiceQueryFilters = {
  disabled?: boolean;
  name?: string;
  page?: number;
  offset?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}