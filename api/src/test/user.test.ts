import { Server } from 'http';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { USER_ROLES } from '../main/types/permissions';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import UserMongoose from '../main/repositories/mongoose/models/UserMongoose';
import OrganizationService from '../main/services/OrganizationService';
import container from '../main/config/container';
import { addMemberToOrganization, createTestOrganization, deleteTestOrganization } from './utils/organization/organizationTestUtils';

describe('User API routes', function () {
  let app: Server;
  let adminUser: any;
  let adminApiKey: string;
  let organizationService: OrganizationService;
  const usersToCleanup: Set<string> = new Set();
  const orgToCleanup: Set<string> = new Set();

  const trackUserForCleanup = (user?: any) => {
    if (user?.username && user.username !== adminUser?.username) {
      usersToCleanup.add(user.username);
    }
  };
  const trackOrganizationForCleanup = (organization?: any) => {
    if (organization?.id) {
      orgToCleanup.add(organization.id);
    }
  };

  const expectNoSensitiveUserFields = (user: any) => {
    expect(user.role).toBeUndefined();
    expect(user.apiKey).toBeUndefined();
  };

  const expectNoSensitiveFieldsForOtherUsers = (users: any[], requesterUsername: string) => {
    users
      .filter(user => user?.username && user.username !== requesterUsername)
      .forEach(user => expectNoSensitiveUserFields(user));
  };

  beforeAll(async function () {
    app = await getApp();
    adminUser = await createTestUser('ADMIN');
    adminApiKey = adminUser.apiKey;
    organizationService = container.resolve('organizationService');
  });

  afterEach(async function () {
    for (const username of usersToCleanup) {
      await deleteTestUser(username);
    }
    
    for (const id of orgToCleanup) {
      await deleteTestOrganization(id);
    }
    usersToCleanup.clear();
    orgToCleanup.clear();
  });

  afterAll(async function () {
    if (adminUser?.username) {
      await deleteTestUser(adminUser.username);
    }
    await shutdownApp();
  });

  describe('POST /users/authenticate', function () {
    it('returns 200 when credentials are valid', async function () {
      const response = await request(app)
        .post(`${baseUrl}/users/authenticate`)
        .send({ username: adminUser.username, password: 'password123' });

      expect(response.status).toBe(200);
      expect(response.body.apiKey).toBeDefined();
      expect(response.body.apiKey).toBe(adminApiKey);
      expect(response.body.username).toBe(adminUser.username);
      expect(response.body.role).toBe('ADMIN');
    });

    it('returns 401 when password is invalid', async function () {
      const response = await request(app)
        .post(`${baseUrl}/users/authenticate`)
        .send({ username: adminUser.username, password: 'wrong-password' });

      expect(response.status).toBe(401);
      expect(response.body.error).toBeDefined();
    });

    it('returns 422 when required fields are missing', async function () {
      const response = await request(app)
        .post(`${baseUrl}/users/authenticate`)
        .send({ username: adminUser.username });

      expect(response.status).toBe(422);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('GET /users', function () {
    it('returns 401 when api key is missing', async function () {
      const response = await request(app).get(`${baseUrl}/users`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });

    // ============================================
    // List All Mode (without q parameter)
    // ============================================
    describe('List all mode (without q parameter)', function () {
      it('returns 200 with paginated data structure', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('data');
        expect(response.body).toHaveProperty('pagination');
        expect(Array.isArray(response.body.data)).toBeTruthy();
        expect(response.body.data.length).toBeGreaterThan(0);
      });

      it('returns correct pagination metadata', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?offset=0&limit=5`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.pagination).toEqual({
          offset: 0,
          limit: 5,
          total: expect.any(Number),
          page: 1,
          pages: expect.any(Number),
        });
      });

      it('respects offset and limit parameters', async function () {
        const testUser1 = await createTestUser('USER', 'listuser1');
        const testUser2 = await createTestUser('USER', 'listuser2');
        const testUser3 = await createTestUser('USER', 'listuser3');
        
        trackUserForCleanup(testUser1);
        trackUserForCleanup(testUser2);
        trackUserForCleanup(testUser3);

        const page1 = await request(app)
          .get(`${baseUrl}/users?offset=0&limit=2`)
          .set('x-api-key', adminApiKey);

        expect(page1.status).toBe(200);
        expect(page1.body.data.length).toBeLessThanOrEqual(2);
        expect(page1.body.pagination.offset).toBe(0);
        expect(page1.body.pagination.limit).toBe(2);

        const page2 = await request(app)
          .get(`${baseUrl}/users?offset=2&limit=2`)
          .set('x-api-key', adminApiKey);

        expect(page2.status).toBe(200);
        expect(page2.body.pagination.offset).toBe(2);
        expect(page2.body.pagination.page).toBe(2);
      });

      it('returns 400 when limit exceeds maximum (50)', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?limit=100`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Limit must be between 1 and 50');
      });

      it('returns 400 when limit is less than 1', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?limit=0`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Limit must be between 1 and 50');
      });

      it('returns 400 when offset is negative', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?offset=-5`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Offset must be a non-negative number');
      });

      it('returns 400 when limit is not a valid number', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?limit=abc`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Limit must be between 1 and 50');
      });

      it('returns 400 when offset is not a valid number', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?offset=xyz`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Offset must be a non-negative number');
      });

      it('uses default pagination values (limit=10, offset=0)', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.pagination.offset).toBe(0);
        expect(response.body.pagination.limit).toBe(10);
      });

      it('calculates correct page number from offset and limit', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?offset=20&limit=10`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.pagination.page).toBe(3); // (20 / 10) + 1 = 3
      });
    });

    // ============================================
    // Search Mode (with q parameter)
    // ============================================
    describe('Search mode (with q parameter)', function () {
      it('returns 200 with matching users when query is provided', async function () {
        const testUser1 = await createTestUser('USER', 'searchuser1');
        const testUser2 = await createTestUser('USER', 'searchuser2');
        const testUser3 = await createTestUser('USER', 'otheruser');
        
        trackUserForCleanup(testUser1);
        trackUserForCleanup(testUser2);
        trackUserForCleanup(testUser3);

        const response = await request(app)
          .get(`${baseUrl}/users?q=searchuser`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('data');
        expect(response.body).toHaveProperty('pagination');
        expect(Array.isArray(response.body.data)).toBeTruthy();
        expect(response.body.data.length).toBeGreaterThanOrEqual(2);
      });

      it('returns only users matching the query (not including non-matching)', async function () {
        const testUser1 = await createTestUser('USER', 'alphauser');
        const testUser2 = await createTestUser('USER', 'betauser');

        trackUserForCleanup(testUser1);
        trackUserForCleanup(testUser2);

        const response = await request(app)
          .get(`${baseUrl}/users?q=alpha`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.data.some((u: any) => u.username === 'alphauser')).toBeTruthy();
        expect(response.body.data.some((u: any) => u.username === 'betauser')).toBeFalsy();
      });

      it('returns empty array when no users match search', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?q=nonexistent_user_xyz123`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual([]);
        expect(response.body.pagination.total).toBe(0);
      });

      it('applies limit to search results', async function () {
        const testUser1 = await createTestUser('USER', 'test_alpha_1');
        const testUser2 = await createTestUser('USER', 'test_alpha_2');
        const testUser3 = await createTestUser('USER', 'test_alpha_3');
        
        trackUserForCleanup(testUser1);
        trackUserForCleanup(testUser2);
        trackUserForCleanup(testUser3);

        const response = await request(app)
          .get(`${baseUrl}/users?q=test_alpha&limit=2`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.data.length).toBeLessThanOrEqual(2);
      });

      it('applies offset to search results', async function () {
        const testUser1 = await createTestUser('USER', 'query_user_01');
        const testUser2 = await createTestUser('USER', 'query_user_02');
        const testUser3 = await createTestUser('USER', 'query_user_03');
        
        trackUserForCleanup(testUser1);
        trackUserForCleanup(testUser2);
        trackUserForCleanup(testUser3);

        const allResults = await request(app)
          .get(`${baseUrl}/users?q=query_user&limit=100`)
          .set('x-api-key', adminApiKey);

        const page2 = await request(app)
          .get(`${baseUrl}/users?q=query_user&offset=1&limit=1`)
          .set('x-api-key', adminApiKey);

        expect(page2.status).toBe(200);
        expect(page2.body.pagination.offset).toBe(1);
        expect(page2.body.pagination.page).toBe(2);
      });

      it('performs case-insensitive search', async function () {
        const testUser = await createTestUser('USER', 'CaseSensitiveUser');
        trackUserForCleanup(testUser);

        const response = await request(app)
          .get(`${baseUrl}/users?q=casesensitive`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.data.some((u: any) => u.username === 'CaseSensitiveUser')).toBeTruthy();
      });

      it('supports partial username matching (regex)', async function () {
        const testUser = await createTestUser('USER', 'john_developer_123');
        trackUserForCleanup(testUser);

        const response = await request(app)
          .get(`${baseUrl}/users?q=develop`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.data.some((u: any) => u.username === 'john_developer_123')).toBeTruthy();
      });

      it('returns 400 when limit exceeds maximum (50)', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?q=test&limit=75`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Limit must be between 1 and 50');
      });

      it('returns 400 when offset is negative in search mode', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?q=test&offset=-1`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(400);
        expect(response.body.error).toContain('Offset must be a non-negative number');
      });

      it('includes pagination metadata in search results', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?q=admin`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body.pagination).toEqual({
          offset: expect.any(Number),
          limit: expect.any(Number),
          total: expect.any(Number),
          page: expect.any(Number),
          pages: expect.any(Number),
        });
      });
    });

    // ============================================
    // Empty Query String Edge Case
    // ============================================
    describe('Empty query string (q="")', function () {
      it('treats empty query as list all (pagination mode)', async function () {
        const response = await request(app)
          .get(`${baseUrl}/users?q=`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('data');
        expect(response.body).toHaveProperty('pagination');
      });
    });

    describe('ACCESS CONTROL: USER role restrictions', function () {
      it('returns 403 when USER tries to list users without q parameter', async function () {
        const user = await createTestUser('USER', `user_no_q_${Date.now()}`);
        trackUserForCleanup(user);

        const response = await request(app)
          .get(`${baseUrl}/users`)
          .set('x-api-key', user.apiKey);

        expect(response.status).toBe(403);
        expect(response.body.error).toBeDefined();
      });

      it('returns 403 when USER provides q with fewer than 4 characters', async function () {
        const user = await createTestUser('USER', `user_short_q_${Date.now()}`);
        trackUserForCleanup(user);

        const response = await request(app)
          .get(`${baseUrl}/users?q=abc`)
          .set('x-api-key', user.apiKey);

        expect(response.status).toBe(403);
        expect(response.body.error).toBeDefined();
      });

      it('returns 200 when USER provides q with 4 or more characters', async function () {
        const requester = await createTestUser('USER', `user_q_ok_${Date.now()}`);
        const match1 = await createTestUser('USER', `match_user_01_${Date.now()}`);
        const match2 = await createTestUser('USER', `match_user_02_${Date.now()}`);

        trackUserForCleanup(requester);
        trackUserForCleanup(match1);
        trackUserForCleanup(match2);

        const response = await request(app)
          .get(`${baseUrl}/users?q=match_user`)
          .set('x-api-key', requester.apiKey);

        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('data');
        expect(Array.isArray(response.body.data)).toBeTruthy();
        expect(response.body.data.length).toBeGreaterThanOrEqual(2);
      });
    });
  });


  describe('POST /users', function () {
    it('returns 201 when creating a user with explicit role', async function () {
      const userData = {
        username: `test_user_${Date.now()}`,
        password: 'password123',
        role: USER_ROLES[USER_ROLES.length - 1],
      };

      const response = await request(app).post(`${baseUrl}/users`).send(userData);

      expect(response.status).toBe(201);
      expect(response.body.username).toBe(userData.username);
      expect(response.body.role).toBe(userData.role);
      expect(response.body.apiKey).toBeDefined();
      trackUserForCleanup(response.body);

      const organizations = await organizationService.findByOwner(userData.username);

      expect(organizations.length).toBe(1);
      expect(organizations[0].name).toBe(`${userData.username}'s Organization`);
    });
    
    it('returns 201 when ADMIN tries to create ADMIN', async function () {
      const userData = {
        username: `test_user_${Date.now()}`,
        password: 'password123',
        role: USER_ROLES[0],
      };

      const response = await request(app).post(`${baseUrl}/users`).set('x-api-key', adminApiKey).send(userData);

      expect(response.status).toBe(201);
      expect(response.body.username).toBe(userData.username);
      expect(response.body.role).toBe(userData.role);
      expect(response.body.apiKey).toBeDefined();
      trackUserForCleanup(response.body);

      const organizations = await organizationService.findByOwner(userData.username);

      expect(organizations.length).toBe(1);
      expect(organizations[0].name).toBe(`${userData.username}'s Organization`);
    });

    it('returns 201 and assigns default role when role is missing', async function () {
      const userData = {
        username: `test_user_${Date.now()}`,
        password: 'password123',
      };

      const response = await request(app).post(`${baseUrl}/users`).send(userData);

      expect(response.status).toBe(201);
      expect(response.body.username).toBe(userData.username);
      expect(response.body.role).toBe(USER_ROLES[USER_ROLES.length - 1]);
      expect(response.body.apiKey).toBeDefined();
      trackUserForCleanup(response.body);

      const organizations = await organizationService.findByOwner(userData.username);

      expect(organizations.length).toBe(1);
      expect(organizations[0].name).toBe(`${userData.username}'s Organization`);
    });

    it('returns 201 and creates a default organization for the new user', async function () {
      const userData = {
        username: `test_user_${Date.now()}`,
        password: 'password123',
        role: USER_ROLES[USER_ROLES.length - 1],
      };

      const response = await request(app).post(`${baseUrl}/users`).send(userData);

      expect(response.status).toBe(201);
      expect(response.body.username).toBe(userData.username);
      expect(response.body.apiKey).toBeDefined();
      trackUserForCleanup(response.body);

      const organizations = await organizationService.findByOwner(userData.username);

      expect(organizations.length).toBe(1);
      expect(organizations[0].name).toBe(`${userData.username}'s Organization`);
      expect(organizations[0].owner).toBe(userData.username);
      expect(organizations[0].default).toBe(true);
    });

    it('returns 403 when non-admin tries to create an admin', async function () {
      const creator = await createTestUser('USER');
      trackUserForCleanup(creator);

      const userData = {
        username: `test_user_${Date.now()}`,
        password: 'password123',
        role: USER_ROLES[0],
      };

      const response = await request(app)
        .post(`${baseUrl}/users`)
        .set('x-api-key', creator.apiKey)
        .send(userData);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION ERROR: Only admins can create other admins.');
    });

    it('returns 422 when role is invalid', async function () {
      const response = await request(app)
        .post(`${baseUrl}/users`)
        .send({ username: `test_user_${Date.now()}`, password: 'password123', role: 'INVALID_ROLE' });

      expect(response.status).toBe(422);
      expect(response.body.error).toBeDefined();
    });

    it('returns 422 when password is missing', async function () {
      const response = await request(app)
        .post(`${baseUrl}/users`)
        .send({ username: `test_user_${Date.now()}` });

      expect(response.status).toBe(422);
      expect(response.body.error).toBeDefined();
    });

    it('returns 404 when creating a duplicated username', async function () {
      const existingUser = await createTestUser('USER');
      trackUserForCleanup(existingUser);

      const response = await request(app)
        .post(`${baseUrl}/users`)
        .send({ username: existingUser.username, password: 'password123' });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('already');
    });
  });

  describe('GET /users/:username', function () {
    it('returns 200 when user exists', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const response = await request(app)
        .get(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.username).toBe(testUser.username);
    });

    it('returns 404 when user does not exist', async function () {
      const response = await request(app)
        .get(`${baseUrl}/users/non_existing_user`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    it('returns 401 when api key is missing', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const response = await request(app).get(`${baseUrl}/users/${testUser.username}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('PUT /users/:username', function () {
    it('returns 200 when admin updates username', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const updatedUsername = `updated_${Date.now()}`;
      const response = await request(app)
        .put(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey)
        .send({ username: updatedUsername });

      expect(response.status).toBe(200);
      expect(response.body.username).toBe(updatedUsername);
      trackUserForCleanup(response.body);
    });

    it('returns 404 when target user is not found', async function () {
      const response = await request(app)
        .put(`${baseUrl}/users/non_existing_user`)
        .set('x-api-key', adminApiKey)
        .send({ username: `updated_${Date.now()}` });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    it('returns 404 when updating username to an existing one', async function () {
      const firstUser = await createTestUser('USER');
      const secondUser = await createTestUser('USER');
      trackUserForCleanup(firstUser);
      trackUserForCleanup(secondUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${firstUser.username}`)
        .set('x-api-key', adminApiKey)
        .send({ username: secondUser.username });

      expect(response.status).toBe(404);
      expect(response.body.error).toContain('already');
    });

    it('returns 403 when non-admin tries to promote to admin', async function () {
      const creator = await createTestUser('USER');
      const targetUser = await createTestUser('USER');
      trackUserForCleanup(creator);
      trackUserForCleanup(targetUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${targetUser.username}`)
        .set('x-api-key', creator.apiKey)
        .send({ role: USER_ROLES[0] });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION ERROR: Only admins can change roles to admin.');
    });

    it('returns 403 when non-admin updates an admin', async function () {
      const creator = await createTestUser('USER');
      const adminTarget = await createTestUser('ADMIN');
      trackUserForCleanup(creator);
      trackUserForCleanup(adminTarget);

      const response = await request(app)
        .put(`${baseUrl}/users/${adminTarget.username}`)
        .set('x-api-key', creator.apiKey)
        .send({ username: `updated_${Date.now()}` });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION ERROR: Only admins can update admin users.');

      await deleteTestUser(adminTarget.username);
    });

    it('returns 401 when api key is missing', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${testUser.username}`)
        .send({ username: `updated_${Date.now()}` });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('PUT /users/:username/api-key', function () {
    it('returns 200 and regenerates api key', async function () {
      const oldApiKey = adminApiKey;
      const response = await request(app)
        .put(`${baseUrl}/users/${adminUser.username}/api-key`)
        .set('x-api-key', oldApiKey);

      expect(response.status).toBe(200);
      expect(response.body.apiKey).toBeDefined();
      expect(response.body.apiKey).not.toBe(oldApiKey);
      adminApiKey = response.body.apiKey;

      const refreshed = await request(app)
        .get(`${baseUrl}/users/${adminUser.username}`)
        .set('x-api-key', adminApiKey);
      expect(refreshed.status).toBe(200);
    });

    it('returns 401 when api key is missing', async function () {
      const response = await request(app)
        .put(`${baseUrl}/users/${adminUser.username}/api-key`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
    
    it('returns 403 when USER tries to regenerate API Key for another user', async function () {
      
      const testUser = await createTestUser('USER');
      const sandboxUser = await createTestUser('USER');

      
      const response = await request(app)
        .put(`${baseUrl}/users/${sandboxUser.username}/api-key`)
        .set('x-api-key', testUser.apiKey);

      expect(response.status).toBe(403);
      expect(response.body.error).toBeDefined();
    });

    it('returns 404 when user does not exist', async function () {
      const response = await request(app)
        .put(`${baseUrl}/users/non_existing_user/api-key`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });
  });

  describe('PUT /users/:username/role', function () {
    it('returns 200 when admin promotes a user to admin', async function () {
      const testUser = await createTestUser(USER_ROLES[USER_ROLES.length - 1]);
      trackUserForCleanup(testUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${testUser.username}/role`)
        .set('x-api-key', adminApiKey)
        .send({ role: 'ADMIN' });

      expect(response.status).toBe(200);
      expect(response.body.role).toBe('ADMIN');
      trackUserForCleanup(response.body);
    });

    it('returns 403 when non-admin assigns ADMIN', async function () {
      const creator = await createTestUser('USER');
      const targetUser = await createTestUser('USER');
      trackUserForCleanup(creator);
      trackUserForCleanup(targetUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${targetUser.username}/role`)
        .set('x-api-key', creator.apiKey)
        .send({ role: 'ADMIN' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION ERROR: Only admins can assign the role ADMIN.');
    });

    it('returns 403 when non-admin modifies an admin', async function () {
      const creator = await createTestUser('USER');
      const adminTarget = await createTestUser('ADMIN');
      trackUserForCleanup(creator);
      trackUserForCleanup(adminTarget);

      const response = await request(app)
        .put(`${baseUrl}/users/${adminTarget.username}/role`)
        .set('x-api-key', creator.apiKey)
        .send({ role: USER_ROLES[USER_ROLES.length - 1] });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION ERROR: Only admins can change roles for other users.');

      await deleteTestUser(adminTarget.username);
    });

    it('returns 403 when trying to demote the last admin', async function () {
      // Remove every other admin directly in the DB (the API list is paginated and may not include all of them)
      const otherAdmins = await UserMongoose.find({ role: 'ADMIN', username: { $ne: adminUser.username } }).lean();
      await UserMongoose.deleteMany({ role: 'ADMIN', username: { $ne: adminUser.username } });

      try {
        const response = await request(app)
          .put(`${baseUrl}/users/${adminUser.username}/role`)
          .set('x-api-key', adminApiKey)
          .send({ role: USER_ROLES[USER_ROLES.length - 1] });

        expect(response.status).toBe(403);
        expect(response.body.error).toContain('There must always be at least one ADMIN');
      } finally {
        if (otherAdmins.length > 0) {
          await UserMongoose.collection.insertMany(otherAdmins as any[]);
        }
      }
    });

    it('returns 422 when role is invalid', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${testUser.username}/role`)
        .set('x-api-key', adminApiKey)
        .send({ role: 'INVALID_ROLE' });

      expect(response.status).toBe(422);
      expect(response.body.error).toBeDefined();
    });

    it('returns 404 when user does not exist', async function () {
      const response = await request(app)
        .put(`${baseUrl}/users/non_existing_user/role`)
        .set('x-api-key', adminApiKey)
        .send({ role: USER_ROLES[USER_ROLES.length - 1] });

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    it('returns 401 when api key is missing', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${testUser.username}/role`)
        .send({ role: USER_ROLES[USER_ROLES.length - 1] });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('DELETE /users/:username', function () {
    it('returns 204 when admin deletes a user', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const response = await request(app)
        .delete(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(204);

      const getResponse = await request(app)
        .get(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey);
      expect(getResponse.status).toBe(404);
    });
    
    it('returns 204 when deleting a user and remove organization', async function () {
      const testUser = await createTestUser('USER');
      const testOrg = await createTestOrganization(testUser.username);
      
      trackUserForCleanup(testUser);
      trackOrganizationForCleanup(testOrg);

      await request(app)
        .delete(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey).expect(204);
      
      const response = await request(app)
        .get(`${baseUrl}/organizations/${testOrg.id}`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(404);
    });
    
    it('returns 204 when deleting a user and transfer organization ownership to ADMIN', async function () {
      const testUser = await createTestUser('USER');
      const testUserAdmin = await createTestUser('USER');
      const testUserManager = await createTestUser('USER');
      const testOrg = await createTestOrganization(testUser.username);
      await addMemberToOrganization(testOrg.id!, { username: testUserAdmin.username, role: 'ADMIN' });
      await addMemberToOrganization(testOrg.id!, { username: testUserManager.username, role: 'MANAGER' });
      
      trackUserForCleanup(testUser);
      trackUserForCleanup(testUserAdmin);
      trackUserForCleanup(testUserManager);
      trackOrganizationForCleanup(testOrg);

      await request(app)
        .delete(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey).expect(204);
      
      const response = await request(app)
        .get(`${baseUrl}/organizations/${testOrg.id}`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.owner).toBe(testUserAdmin.username);
    });
    
    it('returns 204 when deleting a user and transfer organization ownership to MANAGER', async function () {
      const testUser = await createTestUser('USER');
      const testUserManager = await createTestUser('USER');
      const testUserEvaluator = await createTestUser('USER');
      const testOrg = await createTestOrganization(testUser.username);
      await addMemberToOrganization(testOrg.id!, { username: testUserManager.username, role: 'MANAGER' });
      await addMemberToOrganization(testOrg.id!, { username: testUserEvaluator.username, role: 'EVALUATOR' });
      
      trackUserForCleanup(testUser);
      trackUserForCleanup(testUserManager);
      trackUserForCleanup(testUserEvaluator);
      trackOrganizationForCleanup(testOrg);

      await request(app)
        .delete(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey).expect(204);
      
      const response = await request(app)
        .get(`${baseUrl}/organizations/${testOrg.id}`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.owner).toBe(testUserManager.username);
    });
    
    it('returns 204 when deleting a user and transfer organization ownership to EVALUATOR', async function () {
      const testUser = await createTestUser('USER');
      const testUserEvaluator = await createTestUser('USER');
      const testOrg = await createTestOrganization(testUser.username);
      await addMemberToOrganization(testOrg.id!, { username: testUserEvaluator.username, role: 'EVALUATOR' });
      
      trackUserForCleanup(testUser);
      trackUserForCleanup(testUserEvaluator);
      trackOrganizationForCleanup(testOrg);

      await request(app)
        .delete(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey).expect(204);
      
      const response = await request(app)
        .get(`${baseUrl}/organizations/${testOrg.id}`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(200);
      expect(response.body.owner).toBe(testUserEvaluator.username);
    });
    
    it('returns 204 when deleting a user, removing organization and transfer organization ownership to EVALUATOR', async function () {
      const testUser = await createTestUser('USER');
      const testUserAdmin = await createTestUser('USER');
      const testOrg1 = await createTestOrganization(testUser.username);
      const testOrg2 = await createTestOrganization(testUser.username);
      await addMemberToOrganization(testOrg2.id!, { username: testUserAdmin.username, role: 'ADMIN' });
      
      trackUserForCleanup(testUser);
      trackUserForCleanup(testUserAdmin);
      trackOrganizationForCleanup(testOrg1);
      trackOrganizationForCleanup(testOrg2);

      await request(app)
        .delete(`${baseUrl}/users/${testUser.username}`)
        .set('x-api-key', adminApiKey).expect(204);
      
      const responseOrg1 = await request(app)
        .get(`${baseUrl}/organizations/${testOrg1.id}`)
        .set('x-api-key', adminApiKey);

      expect(responseOrg1.status).toBe(404);

      const responseOrg2 = await request(app)
        .get(`${baseUrl}/organizations/${testOrg2.id}`)
        .set('x-api-key', adminApiKey);

      expect(responseOrg2.status).toBe(200);
      expect(responseOrg2.body.owner).toBe(testUserAdmin.username);
    });

    it('returns 404 when deleting a non-existent user', async function () {
      const response = await request(app)
        .delete(`${baseUrl}/users/non_existing_user`)
        .set('x-api-key', adminApiKey);

      expect(response.status).toBe(404);
      expect(response.body.error).toBeDefined();
    });

    it('returns 403 when non-admin tries to delete an admin', async function () {
      const regularUser = await createTestUser('USER');
      const targetAdmin = await createTestUser('ADMIN');
      trackUserForCleanup(regularUser);
      trackUserForCleanup(targetAdmin);

      const response = await request(app)
        .delete(`${baseUrl}/users/${targetAdmin.username}`)
        .set('x-api-key', regularUser.apiKey);

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('PERMISSION ERROR: Only admins can delete admin users.');

      await deleteTestUser(targetAdmin.username);
    });

    it('returns 403 when trying to delete the last admin', async function () {
      // Remove every other admin directly in the DB (the API list is paginated and may not include all of them)
      const otherAdmins = await UserMongoose.find({ role: 'ADMIN', username: { $ne: adminUser.username } }).lean();
      await UserMongoose.deleteMany({ role: 'ADMIN', username: { $ne: adminUser.username } });

      try {
        const response = await request(app)
          .delete(`${baseUrl}/users/${adminUser.username}`)
          .set('x-api-key', adminApiKey);

        expect(response.status).toBe(403);
        expect(response.body.error).toBeDefined();

        // Verify the last admin still exists
        const getResponse = await request(app)
          .get(`${baseUrl}/users/${adminUser.username}`)
          .set('x-api-key', adminApiKey);
        expect(getResponse.status).toBe(200);
      } finally {
        if (otherAdmins.length > 0) {
          await UserMongoose.collection.insertMany(otherAdmins as any[]);
        }
      }
    });

    it('returns 401 when api key is missing', async function () {
      const testUser = await createTestUser('USER');
      trackUserForCleanup(testUser);

      const response = await request(app)
        .delete(`${baseUrl}/users/${testUser.username}`);

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('API Key');
    });
  });

  describe('USER privacy on user endpoints', function () {
    it('GET /users with search never exposes role or apiKey for other users', async function () {
      const requester = await createTestUser('USER', `privacy_viewer_${Date.now()}`);
      const otherUser1 = await createTestUser('USER', `privacy_target_1_${Date.now()}`);
      const otherUser2 = await createTestUser('USER', `privacy_target_2_${Date.now()}`);

      trackUserForCleanup(requester);
      trackUserForCleanup(otherUser1);
      trackUserForCleanup(otherUser2);

      const response = await request(app)
        .get(`${baseUrl}/users?q=privacy_target_`)
        .set('x-api-key', requester.apiKey);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body.data)).toBeTruthy();
      expect(response.body.data.length).toBeGreaterThanOrEqual(2);
      expectNoSensitiveFieldsForOtherUsers(response.body.data, requester.username);
    });

    it('GET /users/:username never exposes role or apiKey when USER requests another user', async function () {
      const requester = await createTestUser('USER', `privacy_reader_${Date.now()}`);
      const targetUser = await createTestUser('USER', `privacy_profile_target_${Date.now()}`);

      trackUserForCleanup(requester);
      trackUserForCleanup(targetUser);

      const response = await request(app)
        .get(`${baseUrl}/users/${targetUser.username}`)
        .set('x-api-key', requester.apiKey);

      expect(response.status).toBe(200);
      expect(response.body.username).toBe(targetUser.username);
      expectNoSensitiveUserFields(response.body);
    });

    it('POST /users never exposes role or apiKey when USER creates another user', async function () {
      const creator = await createTestUser('USER', `privacy_creator_${Date.now()}`);
      trackUserForCleanup(creator);

      const userData = {
        username: `privacy_created_${Date.now()}`,
        password: 'password123',
        role: USER_ROLES[USER_ROLES.length - 1],
      };

      const response = await request(app)
        .post(`${baseUrl}/users`)
        .set('x-api-key', creator.apiKey)
        .send(userData);

      expect(response.status).toBe(201);
      expect(response.body.username).toBe(userData.username);
      expectNoSensitiveUserFields(response.body);
      trackUserForCleanup(response.body);
    });

    it('PUT /users/:username never exposes role or apiKey when USER updates another user', async function () {
      const requester = await createTestUser('USER', `privacy_updater_${Date.now()}`);
      const targetUser = await createTestUser('USER', `privacy_update_target_${Date.now()}`);
      const updatedUsername = `upd_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

      trackUserForCleanup(requester);
      trackUserForCleanup(targetUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${targetUser.username}`)
        .set('x-api-key', requester.apiKey)
        .send({ username: updatedUsername });

      expect([200, 403, 404, 422]).toContain(response.status);
      expect(response.body.role).toBeUndefined();
      expect(response.body.apiKey).toBeUndefined();

      if (response.status === 200) {
        expect(response.body.username).toBe(updatedUsername);
        trackUserForCleanup(response.body);
      }
    });

    it('PUT /users/:username/api-key forbidden response does not expose sensitive user fields', async function () {
      const requester = await createTestUser('USER', `privacy_apikey_req_${Date.now()}`);
      const targetUser = await createTestUser('USER', `privacy_apikey_target_${Date.now()}`);

      trackUserForCleanup(requester);
      trackUserForCleanup(targetUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${targetUser.username}/api-key`)
        .set('x-api-key', requester.apiKey);

      expect(response.status).toBe(403);
      expect(response.body.role).toBeUndefined();
      expect(response.body.apiKey).toBeUndefined();
    });

    it('PUT /users/:username/role forbidden response does not expose sensitive user fields', async function () {
      const requester = await createTestUser('USER', `privacy_role_req_${Date.now()}`);
      const targetUser = await createTestUser('USER', `privacy_role_target_${Date.now()}`);

      trackUserForCleanup(requester);
      trackUserForCleanup(targetUser);

      const response = await request(app)
        .put(`${baseUrl}/users/${targetUser.username}/role`)
        .set('x-api-key', requester.apiKey)
        .send({ role: USER_ROLES[USER_ROLES.length - 1] });

      expect(response.status).toBe(403);
      expect(response.body.role).toBeUndefined();
      expect(response.body.apiKey).toBeUndefined();
    });

    it('DELETE /users/:username returns no body for USER deleting another non-admin user', async function () {
      const requester = await createTestUser('USER', `privacy_delete_req_${Date.now()}`);
      const targetUser = await createTestUser('USER', `privacy_delete_target_${Date.now()}`);

      trackUserForCleanup(requester);
      trackUserForCleanup(targetUser);

      const response = await request(app)
        .delete(`${baseUrl}/users/${targetUser.username}`)
        .set('x-api-key', requester.apiKey);

      expect(response.status).toBe(204);
      expect(response.body).toEqual({});
    });
  });
});
