import mongoose from 'mongoose';

/**
 * Migration: a contract's `userId` is unique per organization, not across the
 * whole server.
 *
 * Before: unique index `{ 'userContact.userId': 1 }` (named
 * `userContact.userId_1`). After: unique index
 * `{ organizationId: 1, 'userContact.userId': 1 }`.
 *
 * Mongoose creates the new index on its own (it is declared in the schema) but
 * never drops an index, so without this migration the old, stricter one would
 * keep rejecting a userId that another organization already uses.
 *
 * Idempotent and safe to run concurrently from several instances:
 * 1. Look for documents the new index would reject (same organization and
 *    userId). The old index was stricter, so there cannot be any while it
 *    exists; the check is there for databases that lost it. If there are,
 *    nothing is changed and they are reported.
 * 2. Create the new index (a no-op when it exists).
 * 3. Drop the old index, only if it is present, and only after the new one
 *    exists, so uniqueness is enforced at every moment.
 */

export const CONTRACT_USERID_INDEX_NAME = 'organizationId_1_userContact.userId_1';
export const LEGACY_CONTRACT_USERID_INDEX_NAME = 'userContact.userId_1';

export interface ContractUserIdMigrationReport {
  /** The new unique index was created by this run (false: it already existed). */
  createdIndex: boolean;
  /** The old global unique index was dropped by this run (false: it was not there). */
  droppedLegacyIndex: boolean;
  /** Contracts without organizationId (legacy data); they share the null organization in the index. */
  withoutOrganization: number;
  /** Organization and userId pairs held by more than one contract (at most 20 listed). */
  conflicts: { organizationId: string | null; userId: string; count: number }[];
  /** Nothing was changed because of `conflicts`. */
  blocked: boolean;
}

const isKey = (key: Record<string, unknown> | undefined, expected: Record<string, number>): boolean =>
  !!key &&
  JSON.stringify(Object.entries(key)) === JSON.stringify(Object.entries(expected));

const NEW_KEY = { organizationId: 1, 'userContact.userId': 1 };
const LEGACY_KEY = { 'userContact.userId': 1 };

/** MongoDB error codes meaning "there is nothing to drop / the collection does not exist". */
const NOT_FOUND_CODES = new Set([26 /* NamespaceNotFound */, 27 /* IndexNotFound */]);

export async function migrateContractUserIdPerOrganization(
  connection: mongoose.Connection = mongoose.connection
): Promise<ContractUserIdMigrationReport> {
  const db = connection.db;
  if (!db) throw new Error('MongoDB is not connected');
  const contracts = db.collection('contracts');

  const report: ContractUserIdMigrationReport = {
    createdIndex: false,
    droppedLegacyIndex: false,
    withoutOrganization: 0,
    conflicts: [],
    blocked: false,
  };

  const conflicts = await contracts
    .aggregate(
      [
        { $group: { _id: { organizationId: '$organizationId', userId: '$userContact.userId' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ],
      { allowDiskUse: true }
    )
    .toArray();
  report.conflicts = conflicts.map(entry => ({
    organizationId: entry._id.organizationId == null ? null : String(entry._id.organizationId),
    userId: String(entry._id.userId),
    count: entry.count,
  }));
  report.withoutOrganization = await contracts.countDocuments({ organizationId: { $in: [null, ''] } });

  if (report.conflicts.length > 0) {
    report.blocked = true;
    return report;
  }

  const indexesBefore = await listIndexes(contracts);
  const existing = indexesBefore.find(index => isKey(index.key, NEW_KEY));
  if (existing && !existing.unique) {
    throw new Error(
      `Index ${existing.name} on { organizationId, userContact.userId } exists but is not unique; drop it and run the migration again`
    );
  }
  if (!existing) {
    await contracts.createIndex(NEW_KEY, { unique: true, name: CONTRACT_USERID_INDEX_NAME });
    report.createdIndex = true;
  }

  for (const index of await listIndexes(contracts)) {
    if (!isKey(index.key, LEGACY_KEY) || !index.unique) continue;
    try {
      await contracts.dropIndex(index.name);
      report.droppedLegacyIndex = true;
    } catch (error: any) {
      // Another instance dropped it first.
      if (!NOT_FOUND_CODES.has(error?.code)) throw error;
    }
  }

  return report;
}

async function listIndexes(collection: any): Promise<any[]> {
  try {
    return await collection.listIndexes().toArray();
  } catch (error: any) {
    if (NOT_FOUND_CODES.has(error?.code)) return [];
    throw error;
  }
}

/**
 * Run the migration at startup. Never prevents the server from starting: if it
 * cannot complete, the indexes are left as they were (the old index, if still
 * there, is stricter than the new rule) and the reason is logged.
 */
export async function runContractUserIdMigration(): Promise<ContractUserIdMigrationReport | null> {
  try {
    const report = await migrateContractUserIdPerOrganization();
    if (report.blocked) {
      console.error(
        'Contract userId migration blocked: some organizations have several contracts with the same userId; ' +
          'the unique index { organizationId, userContact.userId } was not created. Resolve them and restart.',
        JSON.stringify(report.conflicts)
      );
    } else if (report.createdIndex || report.droppedLegacyIndex) {
      console.log(
        `Contract userId migration: unique per organization (created index: ${report.createdIndex}, ` +
          `dropped global index: ${report.droppedLegacyIndex}).`
      );
    }
    if (report.withoutOrganization > 0) {
      console.warn(`Contract userId migration: ${report.withoutOrganization} contracts have no organizationId.`);
    }
    return report;
  } catch (error) {
    console.error('Contract userId migration failed; indexes left unchanged:', (error as Error).message);
    return null;
  }
}
