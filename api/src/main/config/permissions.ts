/**
 * Permission configuration for API routes
 * 
 * This file defines access control rules for both User API Keys and Organization API Keys.
 * 
 * Pattern matching:
 * - '*' matches any single path segment
 * - '**' matches any number of path segments (must be at the end)
 * 
 * Examples:
 * - '/users/*' matches '/users/john' but not '/users/john/profile'
 * - '/organizations/**' matches '/organizations/org1', '/organizations/org1/services', etc.
 */

import { RoutePermission } from "../types/permissions";


/**
 * Route permission configuration
 * 
 * Rules are evaluated in order. The first matching rule determines access.
 * If no rule matches, access is denied by default.
 */
export const ROUTE_PERMISSIONS: RoutePermission[] = [
  // SPHERE synchronization (before general service routes).
  { path: '/organizations/*/services/sphere/preview', methods: ['POST'], allowedUserRoles: ['ADMIN', 'USER'], requiresUser: true },
  { path: '/services/sphere/preview', methods: ['POST'], allowedUserRoles: [], allowedOrgRoles: ['ALL', 'MANAGEMENT'] },
  { path: '/organizations/*/services/*/synchronization', methods: ['GET', 'PUT'], allowedUserRoles: ['ADMIN', 'USER'], requiresUser: true },
  { path: '/services/*/synchronization', methods: ['GET'], allowedUserRoles: [], allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'] },
  { path: '/services/*/synchronization', methods: ['PUT'], allowedUserRoles: [], allowedOrgRoles: ['ALL', 'MANAGEMENT'] },
  { path: '/organizations/*/services/*/synchronization/run', methods: ['POST'], allowedUserRoles: ['ADMIN', 'USER'], requiresUser: true },
  { path: '/services/*/synchronization/run', methods: ['POST'], allowedUserRoles: [], allowedOrgRoles: ['ALL', 'MANAGEMENT'] },

  // ============================================
  // User Management Routes (User API Keys ONLY)
  // ============================================
  {
    path: '/users/authenticate',
    methods: ['POST'],
    isPublic: true,
  },
  {
    path: '/users',
    methods: ['POST'],
    isPublic: true,
  },
  {
    path: '/users/**',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedUserRoles: ['ADMIN', 'USER'],
    requiresUser: true, // Organization API keys cannot access user routes
  },

  // ============================================
  // Service Management Routes (Organization-scoped)
  // User API Keys can access via /organizations/:organizationId/services/**
  // ============================================
  {
    path: '/organizations/*/services',
    methods: ['GET', 'POST', 'DELETE'],
    allowedUserRoles: ['ADMIN', 'USER'],
    requiresUser: true,
  },
  {
    path: '/organizations/*/services/*',
    methods: ['GET', 'PUT', 'PATCH', 'DELETE'],
    allowedUserRoles: ['ADMIN', 'USER'],
    requiresUser: true,
  },
  {
    path: '/organizations/*/services/*/pricings',
    methods: ['GET', 'POST'],
    allowedUserRoles: ['ADMIN', 'USER'],
    requiresUser: true,
  },
  {
    path: '/organizations/*/services/*/pricings/*',
    methods: ['GET', 'PUT', 'PATCH', 'DELETE'],
    allowedUserRoles: ['ADMIN', 'USER'],
    requiresUser: true,
  },

  // ============================================
  // Contract Management Routes (Organization-scoped)
  // User API Keys can access via /organizations/:organizationId/contracts/**
  // ============================================
  {
    path: '/organizations/*/contracts',
    methods: ['GET', 'POST', 'DELETE'],
    allowedUserRoles: ['ADMIN', 'USER'],
    allowedOrgRoles: [],
  },
  {
    path: '/organizations/*/contracts/*',
    methods: ['GET', 'PUT', 'PATCH', 'DELETE'],
    allowedUserRoles: ['ADMIN', 'USER'],
    allowedOrgRoles: [],
  },

  // ============================================
  // Organization Management Routes (User API Keys ONLY)
  // ============================================
  {
    path: '/organizations/**',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedUserRoles: ['ADMIN', 'USER'],
    requiresUser: true, // Organization API keys cannot access these routes
  },

  // ============================================
  // Service Management Routes (Direct access)
  // Organization API Keys can access via /services/**
  // ============================================
  {
    path: '/services',
    methods: ['GET'],
    allowedUserRoles: ['ADMIN'],
    allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'],
  },
  {
    path: '/services',
    methods: ['POST'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT'],
  },
  {
    path: '/services',
    methods: ['DELETE'],
    allowedUserRoles: ['ADMIN'],
    allowedOrgRoles: ['ALL'],
  },
  {
    path: '/services/*',
    methods: ['GET'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'],
  },
  {
    path: '/services/*',
    methods: ['PUT', 'PATCH'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT'],
  },
  {
    path: '/services/*',
    methods: ['DELETE'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL'],
  },
  {
    path: '/services/*/pricings',
    methods: ['GET'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'],
  },
  {
    path: '/services/*/pricings',
    methods: ['POST'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT'],
  },
  {
    path: '/services/*/pricings/*',
    methods: ['GET'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'],
  },
  {
    path: '/services/*/pricings/*',
    methods: ['PUT', 'PATCH'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT'],
  },
  {
    path: '/services/*/pricings/*',
    methods: ['DELETE'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL'],
  },

  // ============================================
  // Contract Routes
  // ============================================
  {
    path: '/contracts',
    methods: ['GET', 'POST', 'PUT'],
    allowedUserRoles: ['ADMIN'],
    allowedOrgRoles: ['ALL', 'MANAGEMENT'],
  },
  {
    path: '/contracts',
    methods: ['DELETE'],
    allowedUserRoles: ['ADMIN'],
    allowedOrgRoles: ['ALL'],
  },
  {
    path: '/contracts/**',
    methods: ['GET', 'PUT', 'PATCH'],
    allowedUserRoles: ['ADMIN'],
    allowedOrgRoles: ['ALL', 'MANAGEMENT'],
  },
  {
    path: '/contracts/**',
    methods: ['DELETE'],
    allowedUserRoles: ['ADMIN'],
    allowedOrgRoles: ['ALL'],
  },

  // ============================================
  // Feature Evaluation Routes
  // ============================================
  {
    path: '/features/evaluate',
    methods: ['POST'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'],
  },
  {
    path: '/features',
    methods: ['GET'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'],
  },
  {
    path: '/features/**',
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    allowedUserRoles: [],
    allowedOrgRoles: ['ALL', 'MANAGEMENT'],
  },

  // ============================================
  // Analytics Routes
  // ============================================
  {
    path: '/analytics/**',
    methods: ['GET'],
    allowedUserRoles: ['ADMIN', 'USER'],
    allowedOrgRoles: ['ALL', 'MANAGEMENT', 'EVALUATION'],
  },

  // ============================================
  // Cache Routes (Admin Only)
  // ============================================
  {
    path: '/cache/**',
    methods: ['GET', 'POST'],
    allowedUserRoles: ['ADMIN'],
    requiresUser: true,
  },

  // ============================================
  // Event Routes (Public)
  // ============================================
  {
    path: '/events/**',
    methods: ['GET', 'POST'],
    isPublic: true,
  },

  // ============================================
  // Health Check (Public)
  // ============================================
  {
    path: '/healthcheck',
    methods: ['GET'],
    isPublic: true, // No authentication required
  },
];

/**
 * Default denial message when no permission is granted
 */
export const DEFAULT_PERMISSION_DENIED_MESSAGE = 'You do not have permission to access this resource';

/**
 * Message when organization API key tries to access user-only routes
 */
export const ORG_KEY_USER_ROUTE_MESSAGE = 'This route requires a user API key. Organization API keys are not allowed';
