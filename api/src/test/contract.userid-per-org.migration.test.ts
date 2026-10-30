import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getApp, shutdownApp } from './utils/testApp';
import {
  CONTRACT_USERID_INDEX_NAME,
  LEGACY_CONTRACT_USERID_INDEX_NAME,
  migrateContractUserIdPerOrganization,
} from '../main/database/migrations/contractUserIdPerOrganization';

/**
 * Migration of the contracts collection from a globally unique `userId`
 * (index `userContact.userId_1`) to a `userId` unique per organization
 * (index `{ organizationId, userContact.userId }`).
 */
describe('Contract userId index migration', function () {
  const contracts = () => mongoose.connection.db!.collection('contracts');

  const indexState = async () => {
    const indexes = await contracts().listIndexes().toArray();
    const byName = Object.fromEntries(indexes.map(index => [index.name, index]));
    return {
      perOrganization: byName[CONTRACT_USERID_INDEX_NAME]
        ? { key: byName[CONTRACT_USERID_INDEX_NAME].key, unique: !!byName[CONTRACT_USERID_INDEX_NAME].unique }
        : null,
      legacy: !!byName[LEGACY_CONTRACT_USERID_INDEX_NAME],
    };
  };

  const dropIfPresent = async (name: string) => {
    if ((await contracts().listIndexes().toArray()).some(index => index.name === name)) {
      await contracts().dropIndex(name);
    }
  };

  /** The state of a database of a SPACE version before this change. */
  const legacyDatabase = async () => {
    await dropIfPresent(CONTRACT_USERID_INDEX_NAME);
    await contracts().createIndex({ 'userContact.userId': 1 }, { unique: true, name: LEGACY_CONTRACT_USERID_INDEX_NAME });
  };

  const rawContract = (organizationId: string, userId: string) => ({
    organizationId,
    userContact: { userId, username: userId },
    billingPeriod: { startDate: new Date(), endDate: new Date(), autoRenew: false, renewalDays: 30 },
    contractedServices: {},
    subscriptionPlans: {},
    subscriptionAddOns: {},
    usageLevels: {},
    history: [],
  });

  beforeAll(async function () {
    await getApp();
  });

  afterAll(async function () {
    // Leave the collection as the application expects it.
    await migrateContractUserIdPerOrganization();
    await shutdownApp();
  });

  it('has been applied when the server starts', async function () {
    expect(await indexState()).toEqual({
      perOrganization: { key: { organizationId: 1, 'userContact.userId': 1 }, unique: true },
      legacy: false,
    });
  });

  it('replaces the global unique index by the per-organization one, and a second run changes nothing', async function () {
    await legacyDatabase();
    expect((await indexState()).legacy).toBe(true);

    const first = await migrateContractUserIdPerOrganization();
    expect(first).toMatchObject({ createdIndex: true, droppedLegacyIndex: true, blocked: false, conflicts: [] });
    const after = await indexState();
    expect(after).toEqual({
      perOrganization: { key: { organizationId: 1, 'userContact.userId': 1 }, unique: true },
      legacy: false,
    });

    const second = await migrateContractUserIdPerOrganization();
    expect(second).toMatchObject({ createdIndex: false, droppedLegacyIndex: false, blocked: false, conflicts: [] });
    expect(await indexState()).toEqual(after);
  });

  it('keeps the existing contracts, which then may share a userId across organizations', async function () {
    await legacyDatabase();
    const userId = `migrated-${uuidv4()}`;
    const [orgA, orgB] = [new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString()];
    await contracts().insertOne(rawContract(orgA, userId));
    await expect(contracts().insertOne(rawContract(orgB, userId))).rejects.toMatchObject({ code: 11000 });

    await migrateContractUserIdPerOrganization();

    await contracts().insertOne(rawContract(orgB, userId));
    await expect(contracts().insertOne(rawContract(orgB, userId))).rejects.toMatchObject({ code: 11000 });
    expect(await contracts().countDocuments({ 'userContact.userId': userId })).toBe(2);
    await contracts().deleteMany({ 'userContact.userId': userId });
  });

  it('is safe when several instances run it at the same time', async function () {
    await legacyDatabase();

    const reports = await Promise.all([1, 2, 3].map(() => migrateContractUserIdPerOrganization()));

    expect(reports.every(report => !report.blocked)).toBe(true);
    expect(reports.filter(report => report.droppedLegacyIndex).length).toBeGreaterThanOrEqual(1);
    expect(await indexState()).toEqual({
      perOrganization: { key: { organizationId: 1, 'userContact.userId': 1 }, unique: true },
      legacy: false,
    });
  });

  it('reports data the new index would reject and changes nothing', async function () {
    // Impossible while the global index exists; a database that lost it could have it.
    await dropIfPresent(CONTRACT_USERID_INDEX_NAME);
    await dropIfPresent(LEGACY_CONTRACT_USERID_INDEX_NAME);
    const userId = `duplicate-${uuidv4()}`;
    const organizationId = new mongoose.Types.ObjectId().toString();
    await contracts().insertMany([rawContract(organizationId, userId), rawContract(organizationId, userId)]);

    try {
      const report = await migrateContractUserIdPerOrganization();

      expect(report.blocked).toBe(true);
      expect(report.createdIndex).toBe(false);
      expect(report.conflicts).toContainEqual({ organizationId, userId, count: 2 });
      expect(await indexState()).toEqual({ perOrganization: null, legacy: false });
    } finally {
      await contracts().deleteMany({ 'userContact.userId': userId });
    }

    const fixed = await migrateContractUserIdPerOrganization();
    expect(fixed).toMatchObject({ blocked: false, createdIndex: true });
  });
});
