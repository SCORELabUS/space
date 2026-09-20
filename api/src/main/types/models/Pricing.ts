import { AddOn, Feature, Plan, UsageLimit } from "pricing4ts";

export interface LeanPricing {
  id?: string;
  url?: string;
  yamlPath?: string;
  version: string;
  currency: string;
  createdAt: Date; // o Date si no haces `JSON.stringify`
  features: Record<string, LeanPricingFeature>;
  usageLimits?: Record<string, LeanUsageLimit>;
  plans?: Record<string, LeanPlan>;
  addOns?: Record<string, LeanAddOn>;
}

export interface ExpectedPricingType {
  url?: string;
  yamlPath?: string;
  version: string;
  currency: string;
  createdAt: Date;
  features: Record<string, LeanPricingFeature>;
  usageLimits?: Record<string, LeanUsageLimit>;
  plans?: Record<string, LeanPlan>;
  addOns?: Record<string, LeanAddOn>;
}


// ----------------------------------------
// -------------- Main Types --------------
// ----------------------------------------

export interface LeanPricingFeature {
  name: string;
  description?: string;
  valueType: "BOOLEAN" | "TEXT" | "NUMERIC";
  defaultValue: string | boolean;
  value?: string | boolean;
  type: "INFORMATION" | "INTEGRATION" | "DOMAIN" | "AUTOMATION" | "MANAGEMENT" | "GUARANTEE" | "SUPPORT" | "PAYMENT";
  integrationType?: "API" | "EXTENSION" | "IDENTITY_PROVIDER" | "WEB_SAAS" | "MARKETPLACE" | "EXTERNAL_DEVICE";
  pricingUrls?: string[];
  automationType?: "BOT" | "FILTERING" | "TRACKING" | "TASK_AUTOMATION";
  paymentType?: "CARD" | "GATEWAY" | "INVOICE" | "ACH" | "WIRE_TRANSFER" | "OTHER";
  docUrl?: string;
  expression?: string;
  serverExpression?: string;
  render: "auto" | "enabled" | "disabled";
  tag?: string;
}

export interface LeanUsageLimit {
  unit?: string;
  name: string;
  description?: string;
  valueType: "BOOLEAN" | "NUMERIC";
  defaultValue: number | boolean;
  value?: number | boolean;
  type: "RENEWABLE" | "NON_RENEWABLE";
  trackable?: boolean;
  period?: LeanPeriod;
  linkedFeatures?: string[];
}

export interface LeanPlan {
  name?: string;
  description?: string;
  price: string | number;
  private?: boolean;
  features: Record<string, string | boolean>;
  usageLimits?: Record<string, number | boolean>;
}

export interface LeanAddOn {
  name: string;
  description?: string;
  private?: boolean;
  price: string | number;
  availableFor?: string[];
  dependsOn?: string[];
  excludes?: string[];
  features?: Record<string, string | boolean>;
  usageLimits?: Record<string, number | boolean>;
  usageLimitsExtensions?: Record<string, number>;
  subscriptionConstraints?: LeanSubscriptionConstraint;
}


// ----------------------------------------
// ------------- Auxiliar Types -----------
// ----------------------------------------

export interface LeanPeriod {
  value: number;
  unit: "SEC" | "MIN" | "HOUR" | "DAY" | "MONTH" | "YEAR";
}

export interface LeanSubscriptionConstraint {
  minQuantity?: number;
  maxQuantity?: number;
  quantityStep?: number;
}
