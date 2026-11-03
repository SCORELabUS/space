import UsageConsumption from '../../repositories/mongoose/models/UsageConsumptionMongoose';
/** Additive initialization; existing contracts need no rewrite. */
export async function initializeUsageConsumptionRecords(): Promise<void> {
  await UsageConsumption.createCollection();
  await UsageConsumption.createIndexes();
}
