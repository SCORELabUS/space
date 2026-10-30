import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import request from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { baseUrl } from '../testApp';

const PETCLINIC_PRICING_PATH = path.resolve(__dirname, '../../data/pricings/petclinic-2025.yml');

/**
 * Version of the stock petclinic fixture. It has no `version`, so Pricing2Yaml
 * derives it from `createdAt: "2025-03-26"` (without leading zeros).
 */
export const PETCLINIC_BASE_VERSION = '2025-3-26';

export const petclinicPricingPath = PETCLINIC_PRICING_PATH;

/**
 * Write a variant of the petclinic pricing to `data/generated` (git-ignored)
 * and return its path. `mutate` edits the parsed YAML in place.
 */
export function writePetclinicVariant(
  version: string,
  createdAt: string,
  mutate: (pricing: any) => void = () => {}
): string {
  const pricing: any = yaml.load(fs.readFileSync(PETCLINIC_PRICING_PATH, 'utf8'));
  pricing.version = version;
  pricing.createdAt = createdAt;
  mutate(pricing);
  const file = path.resolve(__dirname, `../../data/generated/petclinic-${uuidv4()}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(pricing, { lineWidth: -1, noRefs: true }), 'utf8');
  return file;
}

/** Upload the stock petclinic pricing as a new service of the organization of `orgKey`. */
export async function uploadPetclinicService(app: any, orgKey: string, file = PETCLINIC_PRICING_PATH) {
  const response = await request(app).post(`${baseUrl}/services`).set('x-api-key', orgKey).attach('pricing', file);
  if (response.status !== 201) {
    throw new Error(`Failed to create the petclinic service: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

/** Add a version to the petclinic service of the organization of `orgKey`. */
export async function addPetclinicVersion(
  app: any,
  orgKey: string,
  serviceName: string,
  version: string,
  createdAt: string,
  mutate?: (pricing: any) => void
) {
  const file = writePetclinicVariant(version, createdAt, mutate);
  const response = await request(app)
    .post(`${baseUrl}/services/${serviceName}/pricings`)
    .set('x-api-key', orgKey)
    .attach('pricing', file);
  if (response.status !== 201) {
    throw new Error(`Failed to add petclinic ${version}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { file, service: response.body };
}

/** Archive a version (the fallback only matters for contracts still on it). */
export async function archivePetclinicVersion(app: any, orgKey: string, serviceName: string, version: string) {
  const response = await request(app)
    .put(`${baseUrl}/services/${serviceName}/pricings/${version}?availability=archived`)
    .set('x-api-key', orgKey)
    .send({ subscriptionPlan: 'GOLD', subscriptionAddOns: {} });
  if (response.status !== 200) {
    throw new Error(`Failed to archive petclinic ${version}: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}
