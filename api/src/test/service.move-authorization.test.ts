import request from 'supertest';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import container from '../main/config/container';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import {
  addApiKeyToOrganization,
  addMemberToOrganization,
  createTestOrganization,
  deleteTestOrganization,
} from './utils/organization/organizationTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { LeanUser } from '../main/types/models/User';
import { LeanOrganization, OrganizationUserRole } from '../main/types/models/Organization';
import ContractMongoose from '../main/repositories/mongoose/models/ContractMongoose';
import ServiceMongoose from '../main/repositories/mongoose/models/ServiceMongoose';
import PricingMongoose from '../main/repositories/mongoose/models/PricingMongoose';
import { uploadPetclinicService, writePetclinicVariant } from './utils/services/petclinicVersions';

/**
 * Moving a service to another organization (`organizationId` in the body of
 * `PUT .../services/{serviceName}`) takes the service and its contracts out of
 * one organization and into another, so the caller must be allowed to manage
 * services in both: OWNER or ADMIN of each (a platform ADMIN may move any).
 * An organization API key belongs to one organization and cannot move
 * services out of it. An unknown target organization gets the same answer as
 * one the caller has no rights in. Nothing is written before the check.
 */

const B = 'vetclinic';
const FORBIDDEN = 'moving a service to another organization requires the OWNER or ADMIN role in both organizations';

describe('Moving a service to another organization: authorization', function () {
  let app: Server;
  let sourceOwner: LeanUser;
  let targetOwner: LeanUser;
  let caller: LeanUser;
  let source: LeanOrganization;
  let target: LeanOrganization;
  let sourceKey: string;
  let userId: string;
  const users: LeanUser[] = [];

  const newUser = async (role: 'USER' | 'ADMIN' = 'USER') => {
    const user = await createTestUser(role, `${role.toLowerCase()}_${uuidv4()}`);
    users.push(user);
    return user;
  };
  const member = (organization: LeanOrganization, user: LeanUser, role: OrganizationUserRole) =>
    addMemberToOrganization(organization.id!, { username: user.username, role });
  const moveAs = (user: LeanUser, organizationId: string = target.id!, name = 'Vetclinic') =>
    request(app)
      .put(`${baseUrl}/organizations/${source.id}/services/${name}`)
      .set('x-api-key', user.apiKey)
      .send({ organizationId });
  const moveWithKey = (key: string, organizationId: string = target.id!) =>
    request(app).put(`${baseUrl}/services/Vetclinic`).set('x-api-key', key).send({ organizationId });

  const state = async () => ({
    services: await ServiceMongoose.find({ organizationId: { $in: [source.id, target.id] } }).sort({ name: 1 }).lean(),
    pricings: await PricingMongoose.find({ _organizationId: { $in: [source.id, target.id] } }).sort({ _id: 1 }).lean(),
    contracts: await ContractMongoose.find({ organizationId: { $in: [source.id, target.id] } }).sort({ _id: 1 }).lean(),
  });

  /** A refused move: 403, and nothing was written or announced. */
  const expectRefused = async (response: request.Response, before: Awaited<ReturnType<typeof state>>, events: any) => {
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(await state()).toEqual(before);
    expect(events).not.toHaveBeenCalled();
  };
  const expectMoved = async (response: request.Response, organizationId: string = target.id!) => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.organizationId).toBe(organizationId);
    expect(await ServiceMongoose.exists({ organizationId: source.id, name: 'Vetclinic' })).toBeNull();
    const moved: any = await ContractMongoose.findOne({ 'userContact.userId': userId }).lean();
    expect(moved.organizationId).toBe(organizationId);
  };

  beforeAll(async function () {
    app = await getApp();
  });

  beforeEach(async function () {
    sourceOwner = await newUser();
    targetOwner = await newUser();
    caller = await newUser();
    source = await createTestOrganization(sourceOwner.username);
    target = await createTestOrganization(targetOwner.username);
    sourceKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(source.id!, { key: sourceKey, scope: 'ALL' });
    await uploadPetclinicService(
      app,
      sourceKey,
      writePetclinicVariant('1.0', '2025-01-01', pricing => {
        pricing.saasName = 'Vetclinic';
      })
    );
    userId = uuidv4();
    const created = await request(app)
      .post(`${baseUrl}/contracts`)
      .set('x-api-key', sourceKey)
      .send({
        userContact: { userId, username: 'moves-with-the-service' },
        billingPeriod: { autoRenew: true, renewalDays: 30 },
        contractedServices: { [B]: '1.0' },
        subscriptionPlans: { [B]: 'GOLD' },
        subscriptionAddOns: {},
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
  });

  afterEach(async function () {
    vi.restoreAllMocks();
    for (const organization of [source, target]) {
      await ContractMongoose.deleteMany({ organizationId: organization.id });
      await PricingMongoose.deleteMany({ _organizationId: organization.id });
      await ServiceMongoose.deleteMany({ organizationId: organization.id });
      await deleteTestOrganization(organization.id!);
    }
    for (const user of users.splice(0)) await deleteTestUser(user.username);
  });

  afterAll(async function () {
    await shutdownApp();
  });

  describe('refused (403) before anything is written', function () {
    let before: Awaited<ReturnType<typeof state>>;
    let events: any;
    let update: any;

    beforeEach(async function () {
      before = await state();
      events = vi.spyOn(container.resolve('eventService'), 'emitContractEvent');
      update = vi.spyOn(container.resolve('serviceService'), 'update');
    });

    it('with an organization API key (it belongs to the source organization only)', async function () {
      const response = await moveWithKey(sourceKey);

      await expectRefused(response, before, events);
      expect(response.body.error).toContain('organization API key');
      expect(update).not.toHaveBeenCalled();
    });

    it('with an organization API key, also for a target organization that has the same owner', async function () {
      // Same owner or not, the key is not a credential of the target organization.
      const sibling = await createTestOrganization(sourceOwner.username);
      try {
        const response = await moveWithKey(sourceKey, sibling.id!);

        expect(response.status, JSON.stringify(response.body)).toBe(403);
        expect(await state()).toEqual(before);
        expect(await ServiceMongoose.exists({ organizationId: sibling.id })).toBeNull();
      } finally {
        await deleteTestOrganization(sibling.id!);
      }
    });

    it('for a MANAGER of the source organization, even if OWNER of the target', async function () {
      await member(source, caller, 'MANAGER');
      await member(target, caller, 'OWNER');

      await expectRefused(await moveAs(caller), before, events);
      expect(update).not.toHaveBeenCalled();
    });

    it('for the OWNER of the source organization who is not a member of the target', async function () {
      const response = await moveAs(sourceOwner);

      await expectRefused(response, before, events);
      expect(response.body.error).toContain(FORBIDDEN);
      expect(update).not.toHaveBeenCalled();
    });

    it('for an ADMIN of the source organization who is MANAGER or EVALUATOR of the target', async function () {
      await member(source, caller, 'ADMIN');
      await member(target, caller, 'MANAGER');
      await expectRefused(await moveAs(caller), before, events);

      const evaluator = await newUser();
      await member(source, evaluator, 'ADMIN');
      await member(target, evaluator, 'EVALUATOR');
      await expectRefused(await moveAs(evaluator), before, events);
      expect(update).not.toHaveBeenCalled();
    });

    it('for an organization that does not exist, with the same answer as for one without rights', async function () {
      const noRights = await moveAs(sourceOwner);
      const missing = await moveAs(sourceOwner, '507f1f77bcf86cd799439012');

      await expectRefused(missing, before, events);
      expect(missing.body).toEqual(noRights.body);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('allowed', function () {
    it('for the OWNER of both organizations', async function () {
      const sibling = await createTestOrganization(sourceOwner.username);
      try {
        await expectMoved(await moveAs(sourceOwner, sibling.id!), sibling.id!);
      } finally {
        await ContractMongoose.deleteMany({ organizationId: sibling.id });
        await PricingMongoose.deleteMany({ _organizationId: sibling.id });
        await ServiceMongoose.deleteMany({ organizationId: sibling.id });
        await deleteTestOrganization(sibling.id!);
      }
    });

    it('for the OWNER of the source who is ADMIN of the target', async function () {
      await member(target, sourceOwner, 'ADMIN');

      await expectMoved(await moveAs(sourceOwner));
    });

    it('for an ADMIN of both organizations', async function () {
      await member(source, caller, 'ADMIN');
      await member(target, caller, 'ADMIN');

      await expectMoved(await moveAs(caller));
    });

    it('for a platform ADMIN', async function () {
      const admin = await newUser('ADMIN');

      await expectMoved(await moveAs(admin));
    });

    it('a platform ADMIN still gets 400 for an organization that does not exist', async function () {
      const admin = await newUser('ADMIN');

      const response = await moveAs(admin, '507f1f77bcf86cd799439012');

      expect(response.status).toBe(400);
      expect(response.body.error.toLowerCase()).toContain('not found');
    });
  });

  describe('not a move', function () {
    it('an organization API key may still rename, or name its own organization', async function () {
      const same = await moveWithKey(sourceKey, source.id!);
      expect(same.status, JSON.stringify(same.body)).toBe(200);
      expect(same.body.organizationId).toBe(source.id);

      const renamed = await request(app).put(`${baseUrl}/services/Vetclinic`).set('x-api-key', sourceKey).send({ name: 'Vetcare' });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
      expect(renamed.body.name).toBe('Vetcare');
    });

    it('a MANAGER of the source may still rename', async function () {
      await member(source, caller, 'MANAGER');

      const response = await request(app)
        .put(`${baseUrl}/organizations/${source.id}/services/Vetclinic`)
        .set('x-api-key', caller.apiKey)
        .send({ name: 'Vetcare' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.organizationId).toBe(source.id);
    });
  });
});
