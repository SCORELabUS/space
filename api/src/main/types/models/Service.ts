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
  activePricings: Map<string, PricingEntry>;
  archivedPricings?: Map<string, PricingEntry>;
}

export type ServiceQueryFilters = {
  name?: string;
  page?: number;
  offset?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}