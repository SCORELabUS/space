import { Request, Response, NextFunction } from 'express';
import container from '../config/container';
import {
  ROUTE_PERMISSIONS,
  DEFAULT_PERMISSION_DENIED_MESSAGE,
  ORG_KEY_USER_ROUTE_MESSAGE,
} from '../config/permissions';
import { matchPath, extractApiPath } from '../utils/routeMatcher';
import { LeanOrganization, OrganizationMember, OrganizationUserRole } from '../types/models/Organization';
import { HttpMethod, OrganizationApiKeyRole } from '../types/permissions';
import { LeanUser } from '../types/models/User';

/**
 * Middleware to authenticate API Keys (both User and Organization types)
 *
 * Supports two types of API Keys:
 * 1. User API Keys (prefix: "usr_") - Authenticates a specific user
 * 2. Organization API Keys (prefix: "org_") - Authenticates at organization level
 *
 * Sets req.user for User API Keys
 * Sets req.org for Organization API Keys
 */
/**
 * A credential that was read and found wanting.
 *
 * Distinguished from every other failure on purpose. Authentication reads the
 * database, so anything that can go wrong with the database - a dropped
 * connection, a replica-set election, a Mongo that is simply not running -
 * surfaces as an exception here too. Answering 401 to those says the caller
 * sent a bad key, which is untrue and sends whoever is debugging to look at
 * their credentials.
 */
class InvalidApiKeyError extends Error {}

const authenticateApiKeyMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'] as string;

  try {
    // Determine API Key type based on prefix
    if (!apiKey) {
      return checkPermissions(req, res, next);
    } else if (apiKey.startsWith('usr_')) {
      // User API Key authentication
      await authenticateUserApiKey(req, apiKey);
    } else if (apiKey.startsWith('org_')) {
      // Organization API Key authentication
      await authenticateOrgApiKey(req, apiKey);
    } else {
      return res.status(401).json({
        error: 'Invalid API Key format. API Keys must start with "usr_" or "org_"',
      });
    }

    return checkPermissions(req, res, next);
  } catch (err: any) {
    if (res.headersSent) {
      return;
    }

    if (err instanceof InvalidApiKeyError) {
      return res.status(401).json({
        error: err.message || 'Invalid API Key',
      });
    }

    // Anything else got as far as trying and could not finish - almost always
    // the database. 503 rather than 401, because the credential was never
    // judged, and Retry-After because it is worth trying again.
    console.error('Authentication could not be completed:', err);
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      error: 'Space cannot verify credentials right now.',
      details: err?.message ?? String(err),
    });
  }
};

/**
 * Authenticates a User API Key and populates req.user
 */
async function authenticateUserApiKey(req: Request, apiKey: string): Promise<void> {
  const userService = container.resolve('userService');

  const user = await rejectionOrOutage<LeanUser>(
    () => userService.findByApiKey(apiKey),
    'Invalid User API Key'
  );

  req.user = user;
  req.authType = 'user';
}

/**
 * Run a credential lookup, telling a refusal apart from a failure.
 *
 * `UserService.findByApiKey` reports an unknown key by throwing rather than by
 * returning nothing, using the `INVALID DATA:` prefix this codebase gives to a
 * caller's own mistake. That has to keep answering 401. Anything else thrown by
 * a lookup is the database being unable to answer, which is the case this
 * middleware exists to stop reporting as a bad credential.
 */
async function rejectionOrOutage<T>(lookup: () => Promise<T>, absent: string): Promise<T> {
  let found: T;

  try {
    found = await lookup();
  } catch (err: any) {
    if (typeof err?.message === 'string' && err.message.startsWith('INVALID DATA:')) {
      throw new InvalidApiKeyError(err.message);
    }
    throw err;
  }

  if (!found) {
    throw new InvalidApiKeyError(absent);
  }

  return found;
}

/**
 * Authenticates an Organization API Key and populates req.org
 */
async function authenticateOrgApiKey(req: Request, apiKey: string): Promise<void> {
  const organizationRepository = container.resolve('organizationRepository');

  // Find organization by API Key
  const result: LeanOrganization = await rejectionOrOutage(
    () => organizationRepository.findByApiKey(apiKey),
    'Invalid Organization API Key'
  );

  req.org = {
    id: result.id!,
    name: result.name,
    members: result.members,
    role: result.apiKeys.find(key => key.key === apiKey)!.scope as OrganizationApiKeyRole,
  };
  req.authType = 'organization';
}

/**
 * Middleware to verify permissions based on route configuration
 *
 * Checks if the authenticated entity (user or organization) has permission
 * to access the requested route with the specified HTTP method.
 *
 * Must be used AFTER authenticateApiKey middleware.
 */
const checkPermissions = (req: Request, res: Response, next: NextFunction) => {
  try {
    const method = req.method.toUpperCase() as HttpMethod;
    const baseUrlPath = '/api/v1';
    const apiPath = extractApiPath(req.path, baseUrlPath);

    // Find matching permission rule
    const matchingRule = ROUTE_PERMISSIONS.find(rule => {
      const methodMatches = rule.methods.includes(method);
      const pathMatches = matchPath(rule.path, apiPath);
      return methodMatches && pathMatches;
    });

    // If no rule matches, deny by default
    if (!matchingRule) {
      return res.status(403).json({
        error: DEFAULT_PERMISSION_DENIED_MESSAGE,
        details: `No permission rule found for ${method} ${apiPath}`,
      });
    }

    // Allow public routes without authentication
    if (matchingRule.isPublic) {
      return next();
    }

    // Protected route - require authentication
    if (!req.authType) {
      return res.status(401).json({
        error:
          'API Key not found. Please ensure to add an API Key as value of the "x-api-key" header.',
      });
    }

    // Check if this route requires a user API key
    if (matchingRule.requiresUser && req.authType === 'organization') {
      return res.status(403).json({
        error: ORG_KEY_USER_ROUTE_MESSAGE,
      });
    }

    // Verify permissions based on auth type
    if (req.authType === 'user' && req.user) {
      // User API Key - check user role
      if (
        !matchingRule.allowedUserRoles ||
        !matchingRule.allowedUserRoles.includes(req.user.role)
      ) {
        return res.status(403).json({
          error: `Your user role (${req.user.role}) does not have permission to ${method} ${apiPath}`,
        });
      }
    } else if (req.authType === 'organization' && req.org) {
      // Organization API Key - check org key role
      if (!matchingRule.allowedOrgRoles || !matchingRule.allowedOrgRoles.includes(req.org.role)) {
        return res.status(403).json({
          error: `Your organization API key role (${req.org.role}) does not have permission to ${method} ${apiPath}`,
        });
      }
    } else {
      // No valid authentication found
      return res.status(401).json({
        error: 'Authentication required',
      });
    }

    // Permission granted
    next();
  } catch (error) {
    return res.status(500).json({
      error: 'Internal error while verifying permissions',
    });
  }
};

const memberRole = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user && !req.org) {
    return res.status(401).json({
      error: 'Authentication required',
    });
  }

  if (req.authType === 'user') {
    try {
      const organizationService = container.resolve('organizationService');
      const organizationId = req.params.organizationId;
      const organization = await organizationService.findById(organizationId);

      if (!organization) {
        return res.status(404).json({
          error: 'Organization with ID ' + organizationId + ' not found',
        });
      }

      if (organization.owner === req.user!.username) {
        req.user!.orgRole = 'OWNER';
        return next();
      }
      
      const member = organization.members.find(
        (member: OrganizationMember) => member.username === req.user!.username
      );

      if (member) {
        req.user!.orgRole = member.role as OrganizationUserRole;
      }

      if (!req.user!.orgRole && req.user!.role !== 'ADMIN') {
        return res.status(403).json({
          error:
            'This route requires user authentication. Either you did not provide an user API key or your are not a member of this organization',
        });
      }

      next();
    } catch (error: any) {
      // Handle invalid organization ID or other errors
      return res.status(404).json({
        error: error.message || 'Organization not found',
      });
    }
  } else {
    next();
  }
};

const hasPermission = (requiredRoles: (OrganizationApiKeyRole | OrganizationUserRole)[]) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'ADMIN') {
      return next();
    }
    
    if (!req.user?.orgRole) {
      return res.status(401).json({
        error: 'This route requires user authentication. Either you did not provide an user API key or your are not a member of this organization',
      });
    }

    if (!requiredRoles.includes(req.user!.orgRole as OrganizationUserRole)) {
      return res.status(403).json({
        error:
          'You do not have permission to access this resource. Allowed roles: ' +
          requiredRoles.join(', '),
      });
    }

    next();
  };
};

export { authenticateApiKeyMiddleware, memberRole, hasPermission, rejectionOrOutage, InvalidApiKeyError };
