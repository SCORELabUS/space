import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import mongoose from 'mongoose';
import nock from 'nock';
import request from 'supertest';
import { Server } from 'http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { LeanOrganization } from '../main/types/models/Organization';
import ServiceMongoose from '../main/repositories/mongoose/models/ServiceMongoose';
import PricingMongoose from '../main/repositories/mongoose/models/PricingMongoose';
import { functionalHash } from '../main/services/sphere/SphereClient';
import {
  PETCLINIC_BASE_VERSION,
  addPetclinicVersion,
  archivePetclinicVersion,
  uploadPetclinicService,
} from './utils/services/petclinicVersions';

/**
 * GET /services/{s}/pricings/{v}?format=yaml returns the stored Pricing2Yaml
 * file of the version, byte for byte, with its syntax version and a strong
 * ETag (sha256 of the body).
 */

const sha256 = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');

/** Keep YAML bodies as raw bytes (superagent does not buffer application/yaml); still parse JSON errors. */
const raw = (res: any, done: (err: Error | null, body: any) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: any) => chunks.push(Buffer.from(chunk)));
  res.on('end', () => {
    const body = Buffer.concat(chunks);
    if (String(res.headers['content-type'] ?? '').includes('json')) {
      try {
        return done(null, JSON.parse(body.toString('utf8')));
      } catch {
        return done(null, body);
      }
    }
    done(null, body);
  });
};
const text = (response: request.Response) => (Buffer.isBuffer(response.body) ? response.body.toString('utf8') : '');

const origin = 'https://sphere.score.us.es';
const pricingId = '444444444444444444444444';
const currentVersionId = '555555555555555555555555';
const historicalVersionId = '666666666666666666666666';
const sphereYaml = (version: string, createdAt: string) =>
  `saasName: Linked\nversion: '${version}'\ncreatedAt: '${createdAt}'\nsyntaxVersion: '3.1'\ncurrency: EUR\n` +
  `features:\n  enabled:\n    valueType: BOOLEAN\n    defaultValue: true\n    type: DOMAIN\n` +
  `plans:\n  basic:\n    price: 0\n    unit: /month\n    features:\n      enabled: true\n`;

describe('Pricing version as Pricing2Yaml (format=yaml)', function () {
  let app: Server;
  let owner: LeanUser;
  let member: LeanUser;
  let outsider: LeanUser;
  let organization: LeanOrganization;
  let otherOrganization: LeanOrganization;
  let allKey: string;
  let evaluationKey: string;
  let otherKey: string;
  let storedName: string;
  const filesToRemove = new Set<string>();

  const get = (url: string) => request(app).get(url).buffer(true).parse(raw);
  const yamlOf = (version: string, key = evaluationKey, name = storedName) =>
    get(`${baseUrl}/services/${name}/pricings/${version}?format=yaml`).set('x-api-key', key);

  beforeAll(async function () {
    app = await getApp();
    process.env.SPHERE_PUBLIC_URL = origin;
    process.env.SPHERE_API_URL = `${origin}/api/v1`;
  });

  beforeEach(async function () {
    nock.cleanAll();
    owner = await createTestUser('USER');
    member = await createTestUser('USER');
    outsider = await createTestUser('USER');
    organization = await createTestOrganization(owner.username);
    otherOrganization = await createTestOrganization(outsider.username);
    await addMemberToOrganization(organization.id!, { username: member.username, role: 'EVALUATOR' });
    allKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    otherKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id!, { key: allKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id!, { key: evaluationKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id!, { key: otherKey, scope: 'ALL' });

    storedName = (await uploadPetclinicService(app, allKey)).name;
  });

  afterEach(async function () {
    for (const pricing of await PricingMongoose.find({ _organizationId: { $in: [organization.id, otherOrganization.id] } }).lean()) {
      if (pricing.yamlPath) filesToRemove.add(pricing.yamlPath);
    }
    await PricingMongoose.deleteMany({ _organizationId: { $in: [organization.id, otherOrganization.id] } });
    await ServiceMongoose.deleteMany({ organizationId: { $in: [organization.id, otherOrganization.id] } });
    await deleteTestOrganization(organization.id!);
    await deleteTestOrganization(otherOrganization.id!);
    for (const user of [owner, member, outsider]) await deleteTestUser(user.username);
    nock.cleanAll();
  });

  afterAll(async function () {
    for (const file of filesToRemove) fs.rmSync(path.resolve('public', `.${file}`), { force: true });
    await shutdownApp();
  });

  /** The file SPACE stored for a version of the organization's service. */
  const storedFile = async (version: string) => {
    const pricing: any = await PricingMongoose.findOne({
      _organizationId: organization.id,
      version: version.replace(/\./g, '_'),
    }).lean();
    return fs.readFileSync(path.resolve('public', `.${pricing.yamlPath}`));
  };

  describe('uploaded pricings', function () {
    it('returns the uploaded file byte for byte when it is in the latest syntax', async function () {
      const { file } = await addPetclinicVersion(app, allKey, storedName, '3.1.0', '2025-08-01', pricing => {
        pricing.syntaxVersion = '3.1';
      });
      const uploaded = fs.readFileSync(file);

      const response = await yamlOf('3.1.0');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('application/yaml; charset=utf-8');
      expect(Buffer.compare(response.body, uploaded)).toBe(0);
      expect(response.headers['x-pricing-syntax-version']).toBe('3.1');
      expect(response.headers.etag).toBe(`"${sha256(uploaded)}"`);
    });

    it('returns the stored file, which an upload in an older syntax is upgraded to', async function () {
      // The fixture is Pricing2Yaml 3.0; pricing4ts upgrades it while parsing the upload.
      const stored = await storedFile(PETCLINIC_BASE_VERSION);

      const response = await yamlOf(PETCLINIC_BASE_VERSION);

      expect(response.status).toBe(200);
      expect(Buffer.compare(response.body, stored)).toBe(0);
      expect(response.headers['x-pricing-syntax-version']).toBe('3.1');
      expect(response.headers.etag).toBe(`"${sha256(stored)}"`);
    });

    it('answers 304 to a matching If-None-Match, 200 otherwise', async function () {
      const first = await yamlOf(PETCLINIC_BASE_VERSION);

      const same = await yamlOf(PETCLINIC_BASE_VERSION).set('If-None-Match', first.headers.etag);
      const inList = await yamlOf(PETCLINIC_BASE_VERSION).set('If-None-Match', `"other", ${first.headers.etag}`);
      const other = await yamlOf(PETCLINIC_BASE_VERSION).set('If-None-Match', '"0000"');

      expect(same.status).toBe(304);
      expect(text(same)).toBe('');
      expect(same.headers.etag).toBe(first.headers.etag);
      expect(inList.status).toBe(304);
      expect(other.status).toBe(200);
    });

    it('serves every version, archived ones included', async function () {
      await addPetclinicVersion(app, allKey, storedName, '2.0', '2025-06-01');
      const base = (await storedFile(PETCLINIC_BASE_VERSION)).toString('utf8');
      await archivePetclinicVersion(app, allKey, storedName, PETCLINIC_BASE_VERSION);

      const current = await yamlOf('2.0');
      const archived = await yamlOf(PETCLINIC_BASE_VERSION);

      expect(current.status).toBe(200);
      expect(text(current)).toBe((await storedFile('2.0')).toString('utf8'));
      expect(text(current)).toContain("version: '2.0'");
      expect(archived.status).toBe(200);
      expect(text(archived)).toBe(base);
    });

    it('accepts dotted versions', async function () {
      await addPetclinicVersion(app, allKey, storedName, '2.1.0', '2025-07-01');

      const response = await yamlOf('2.1.0');

      expect(response.status).toBe(200);
      expect(text(response)).toBe((await storedFile('2.1.0')).toString('utf8'));
    });

    it('keeps returning the JSON pricing without format, or with format=json', async function () {
      const plain = await request(app)
        .get(`${baseUrl}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}`)
        .set('x-api-key', evaluationKey);
      const json = await request(app)
        .get(`${baseUrl}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}?format=json`)
        .set('x-api-key', evaluationKey);

      expect(plain.status).toBe(200);
      expect(plain.headers['content-type']).toMatch(/^application\/json/);
      expect(plain.body.plans.GOLD).toBeDefined();
      expect(json.body).toEqual(plain.body);
    });

    it('rejects an unknown format', async function () {
      const response = await request(app)
        .get(`${baseUrl}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}?format=xml`)
        .set('x-api-key', evaluationKey);

      expect(response.status).toBe(400);
    });

    it('answers 404 for a version that does not exist', async function () {
      const response = await yamlOf('9.9.9');

      expect(response.status).toBe(404);
      expect(response.body.error).not.toBe('PRICING_YAML_UNAVAILABLE');
    });

    it('answers 404 PRICING_YAML_UNAVAILABLE when no file was stored for the version', async function () {
      await PricingMongoose.updateMany({ _organizationId: organization.id }, { $unset: { yamlPath: '' } });
      // The pricing is cached by id; drop it so the change is seen.
      await request(app).get(`${baseUrl}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}`).set('x-api-key', allKey);
      const pricing: any = await PricingMongoose.findOne({ _organizationId: organization.id }).lean();
      const cacheService = (await import('../main/config/container')).default.resolve('cacheService');
      await cacheService.del(`pricing.id.${pricing._id}`);

      const response = await yamlOf(PETCLINIC_BASE_VERSION);

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('PRICING_YAML_UNAVAILABLE');
    });
  });

  describe('authorization', function () {
    it('is available to organization keys of any scope and to members on the organization route', async function () {
      const all = await yamlOf(PETCLINIC_BASE_VERSION, allKey);
      const scoped = await get(
        `${baseUrl}/organizations/${organization.id}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}?format=yaml`
      ).set('x-api-key', member.apiKey);

      expect(all.status).toBe(200);
      expect(scoped.status).toBe(200);
      expect(text(scoped)).toBe(text(all));
    });

    it('is not available to other organizations or without a key', async function () {
      const foreignKey = await yamlOf(PETCLINIC_BASE_VERSION, otherKey);
      const nonMember = await request(app)
        .get(`${baseUrl}/organizations/${organization.id}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}?format=yaml`)
        .set('x-api-key', outsider.apiKey);
      const anonymous = await request(app).get(
        `${baseUrl}/services/${storedName}/pricings/${PETCLINIC_BASE_VERSION}?format=yaml`
      );

      expect(foreignKey.status).toBe(404);
      expect(nonMember.status).toBe(403);
      expect(anonymous.status).toBe(401);
    });
  });

  describe('SPHERE-linked services', function () {
    const linkedName = 'linked';
    const currentText = sphereYaml('2.0', '2025-01-01');
    const historicalText = sphereYaml('1.0', '2024-01-01');
    const version = (versionId: string, name: string, createdAt: string, text: string) => ({
      versionId, version: name, createdAt, contentHash: functionalHash(text),
    });
    const manifest = () => ({
      pricingId, name: 'Linked', permanentUrl: `${origin}/p/${pricingId}`, latestVersionId: currentVersionId,
      versions: [
        version(historicalVersionId, '1.0', '2024-01-01T00:00:00.000Z', historicalText),
        version(currentVersionId, '2.0', '2025-01-01T00:00:00.000Z', currentText),
      ],
    });

    let snapshotFile: string;

    beforeEach(async function () {
      const serviceId = new mongoose.Types.ObjectId();
      const yamlPath = `/static/pricings/sphere/${serviceId}/${currentVersionId}.yaml`;
      snapshotFile = path.resolve('public', `.${yamlPath}`);
      fs.mkdirSync(path.dirname(path.resolve('public', `.${yamlPath}`)), { recursive: true });
      // Snapshots are stored as SPACE wrote them; any bytes will do here.
      fs.writeFileSync(path.resolve('public', `.${yamlPath}`), `# stored snapshot\n${currentText}`);
      filesToRemove.add(yamlPath);
      const pricing = await PricingMongoose.create({
        _serviceName: linkedName, _organizationId: organization.id, yamlPath, version: '2_0', currency: 'EUR',
        createdAt: new Date('2025-01-01'), features: { enabled: { name: 'enabled', valueType: 'BOOLEAN', defaultValue: true, type: 'DOMAIN' } },
        plans: { basic: { name: 'basic', price: 0, features: { enabled: true } } },
        sphere: { serviceId: String(serviceId), pricingId, ...version(currentVersionId, '2.0', '2025-01-01T00:00:00.000Z', currentText) },
      });
      await ServiceMongoose.collection.insertOne({
        _id: serviceId, name: linkedName, organizationId: organization.id, source: 'sphere', disabled: false,
        activePricings: { '2_0': { id: pricing._id } }, archivedPricings: {},
        sphere: { permanentUrl: `${origin}/p/${pricingId}`, pricingId, name: 'Linked', policy: 'new_last', revision: 1,
          target: version(currentVersionId, '2.0', '2025-01-01T00:00:00.000Z', currentText), status: 'ready' },
      });
    });

    it('returns the stored snapshot of a retained version', async function () {
      const response = await yamlOf('2.0', evaluationKey, linkedName);

      expect(response.status).toBe(200);
      expect(text(response)).toBe(`# stored snapshot\n${currentText}`);
      expect(response.headers['x-pricing-syntax-version']).toBe('3.1');
    });

    it('reports an unquoted syntaxVersion exactly as written (3.0, not 3)', async function () {
      fs.writeFileSync(snapshotFile, currentText.replace("syntaxVersion: '3.1'", 'syntaxVersion: 3.0'));

      const response = await yamlOf('2.0', evaluationKey, linkedName);

      expect(response.status).toBe(200);
      expect(response.headers['x-pricing-syntax-version']).toBe('3.0');
    });

    it('exposes ETag and X-Pricing-Syntax-Version to browser clients through CORS', async function () {
      const response = await yamlOf('2.0', evaluationKey, linkedName).set('Origin', 'http://localhost:5403');
      const exposed = String(response.headers['access-control-expose-headers']).toLowerCase();

      expect(exposed).toContain('etag');
      expect(exposed).toContain('x-pricing-syntax-version');
    });

    it('fetches a historical version that SPACE no longer keeps from SPHERE', async function () {
      nock(origin).get(`/api/v1/public/pricings/${pricingId}`).reply(200, manifest());
      nock(origin).get(`/api/v1/public/pricings/${pricingId}/versions/${historicalVersionId}/yaml`).reply(200, historicalText);

      const response = await yamlOf('1.0', evaluationKey, linkedName);

      expect(response.status).toBe(200);
      expect(text(response)).toBe(historicalText);
      expect(response.headers.etag).toBe(`"${sha256(historicalText)}"`);
      expect(response.headers['x-pricing-syntax-version']).toBe('3.1');
    });

    it('answers 404 PRICING_YAML_UNAVAILABLE when SPHERE does not list the version', async function () {
      nock(origin).get(`/api/v1/public/pricings/${pricingId}`).reply(200, manifest());
      const unknown = await yamlOf('0.5', evaluationKey, linkedName);

      expect(unknown.status).toBe(404);
      expect(unknown.body.error).toBe('PRICING_YAML_UNAVAILABLE');
    });

    it('answers 502 SPHERE_UNAVAILABLE when SPHERE cannot be reached, not 404', async function () {
      nock(origin).get(`/api/v1/public/pricings/${pricingId}`).reply(503, 'down');

      const unavailable = await yamlOf('1.0', evaluationKey, linkedName);

      expect(unavailable.status).toBe(502);
      expect(unavailable.body.error).toBe('SPHERE_UNAVAILABLE');
    });

    it('rejects a historical version whose content does not match the SPHERE manifest', async function () {
      nock(origin).get(`/api/v1/public/pricings/${pricingId}`).reply(200, manifest());
      nock(origin)
        .get(`/api/v1/public/pricings/${pricingId}/versions/${historicalVersionId}/yaml`)
        .reply(200, historicalText.replace('price: 0', 'price: 9'));

      const response = await yamlOf('1.0', evaluationKey, linkedName);

      expect(response.status).toBe(502);
      expect(response.body.error).toBe('SPHERE_UNAVAILABLE');
    });
  });
});
