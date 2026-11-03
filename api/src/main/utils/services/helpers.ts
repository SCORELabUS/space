import { LeanPricing } from '../../types/models/Pricing';
import { LeanService, PricingEntry } from '../../types/models/Service';
import { resetEscapeVersion } from '../helpers';

function resetEscapeVersionInService(service: LeanService): void {
  // Collect transformations for activePricings
  const activeTransformations: Array<[string, string, PricingEntry]> = [];
  for (const [version, pricing] of service.activePricings.entries()) {
    const formattedVersion = resetEscapeVersion(version);
    if (formattedVersion !== version) {
      activeTransformations.push([version, formattedVersion, pricing]);
    }
  }
  
  // Apply transformations to activePricings
  for (const [oldVersion, newVersion, pricing] of activeTransformations) {
    service.activePricings.delete(oldVersion);
    service.activePricings.set(newVersion, pricing);
  }

  // Collect transformations for archivedPricings
  if (service.archivedPricings) {
    const archivedTransformations: Array<[string, string, PricingEntry]> = [];
    for (const [version, pricing] of service.archivedPricings.entries()) {
      const formattedVersion = resetEscapeVersion(version);
      if (formattedVersion !== version) {
        archivedTransformations.push([version, formattedVersion, pricing]);
      }
    }
    
    // Apply transformations to archivedPricings
    for (const [oldVersion, newVersion, pricing] of archivedTransformations) {
      service.archivedPricings.delete(oldVersion);
      service.archivedPricings.set(newVersion, pricing);
    }
  }
}

function resetEscapePricingVersion(pricing: LeanPricing){
  pricing.version = resetEscapeVersion(pricing.version);
}

/**
 * Path of the Pricing2Yaml file of a version (`format=yaml`), on the same kind
 * of route as the request: organization-scoped when the request was (user API
 * keys), direct otherwise (organization API keys).
 */
function pricingYamlUrl(organizationId: string | undefined, serviceName: string, version: string): string {
  const scope = organizationId ? `/organizations/${organizationId}` : '';
  return `/api/v1${scope}/services/${encodeURIComponent(serviceName)}/pricings/${encodeURIComponent(version)}?format=yaml`;
}

export { resetEscapeVersionInService, resetEscapePricingVersion, pricingYamlUrl };
