import mongoose from 'mongoose';

/** Add the organization lookup index to existing databases without changing uniqueness. */
export async function ensureContractOrganizationIndex(connection: mongoose.Connection = mongoose.connection) {
  if (!connection.db) throw new Error('MongoDB is not connected');
  const collection = connection.db.collection('contracts');
  let indexes;
  try {
    indexes = await collection.listIndexes().toArray();
  } catch (error: any) {
    if (error.code !== 26) throw error; // New database: no collection yet.
    indexes = [];
  }
  // A future organization/userId compound index also covers this lookup.
  if (indexes.some(index => Object.keys(index.key)[0] === 'organizationId' &&
    index.key.organizationId === 1 && !index.sparse && !index.partialFilterExpression)) return;
  await collection.createIndex({ organizationId: 1 }, { name: 'organizationId_1' });
}
