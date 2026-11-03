import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { baseUrl, getApp, shutdownApp } from './utils/testApp';
import { createTestUser, deleteTestUser } from './utils/users/userTestUtils';
import {
  addApiKeyToOrganization,
  addMemberToOrganization,
  createTestOrganization,
  deleteTestOrganization,
} from './utils/organization/organizationTestUtils';
import { generatePricingFile } from './utils/services/pricingTestUtils';
import { generateOrganizationApiKey } from '../main/utils/users/helpers';
import { functionalHash } from '../main/services/sphere/SphereClient';
import Service from '../main/repositories/mongoose/models/ServiceMongoose';
import Pricing from '../main/repositories/mongoose/models/PricingMongoose';

/**
 * Pricing2Yaml files (uploaded pricings and SPHERE snapshots) must never be
 * served without authorisation. Anonymous callers and other organizations get
 * what a missing file gets (404); the owning organization reads the file
 * through the authorised pricing route (`?format=yaml`).
 *
 * Raw paths are sent with `http.request`, because supertest normalises them.
 */

type RawResponse = { status: number; body: string; headers: http.IncomingHttpHeaders };

function rawRequest(server: Server, rawPath: string, headers: Record<string, string> = {}, method = 'GET'): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Static path under which SPACE published an uploaded pricing (before this fix). */
function legacyUploadedPath(organizationId: string, serviceName: string, version: string) {
  const part = (value: string) => value.trim().replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').toLowerCase();
  return `/static/pricings/${part(organizationId)}-${part(serviceName)}-${part(version)}.yaml`;
}

/** The file a stored `yamlPath` refers to, as SPACE resolves it with the default directories. */
function storedFile(yamlPath: string) {
  if (yamlPath.startsWith('/private/')) return path.resolve('private', `.${yamlPath.slice('/private'.length)}`);
  return path.resolve('public', `.${yamlPath}`);
}

const origin = 'https://sphere.score.us.es';
const pricingId = '444444444444444444444444';
const versionId = '555555555555555555555555';
const sphereYaml = `saasName: Snapshot\nversion: '1.0'\ncreatedAt: '2024-01-01'\nsyntaxVersion: '3.1'\ncurrency: USD\nfeatures:\n  enabled:\n    valueType: BOOLEAN\n    defaultValue: true\n    type: DOMAIN\nplans:\n  basic:\n    price: 0\n    unit: /month\n    features:\n      enabled: true\n  internal:\n    price: 1\n    unit: /month\n    private: true\n    features:\n      enabled: true\n`;

describe('Pricing YAML files are not served without authorisation', () => {
  let app: Server;
  let ownerUser: any;
  let memberUser: any;
  let outsiderUser: any;
  let organization: any;
  let otherOrganization: any;
  let ownerKey: string;
  let evaluationKey: string;
  let otherKey: string;
  let serviceName: string;
  let version: string;
  /** The file as SPACE stored it (it may upgrade the Pricing2Yaml syntax on upload). */
  let storedContent: string;
  const planted: string[] = [];

  beforeAll(async () => {
    app = await getApp();
    process.env.SPHERE_PUBLIC_URL = origin;
    process.env.SPHERE_API_URL = `${origin}/api/v1`;
  });

  beforeEach(async () => {
    nock.cleanAll();
    ownerUser = await createTestUser('USER');
    memberUser = await createTestUser('USER');
    outsiderUser = await createTestUser('USER');
    organization = await createTestOrganization(ownerUser.username);
    otherOrganization = await createTestOrganization(outsiderUser.username);
    await addMemberToOrganization(organization.id, { username: memberUser.username, role: 'EVALUATOR' });
    ownerKey = generateOrganizationApiKey();
    evaluationKey = generateOrganizationApiKey();
    otherKey = generateOrganizationApiKey();
    await addApiKeyToOrganization(organization.id, { key: ownerKey, scope: 'ALL' });
    await addApiKeyToOrganization(organization.id, { key: evaluationKey, scope: 'EVALUATION' });
    await addApiKeyToOrganization(otherOrganization.id, { key: otherKey, scope: 'ALL' });

    serviceName = `static-files-${Date.now()}`;
    version = randomUUID();
    const pricingPath = await generatePricingFile(serviceName, version);

    const created = await request(app)
      .post(`${baseUrl}/services`)
      .set('x-api-key', ownerKey)
      .attach('pricing', pricingPath);
    expect(created.status).toBe(201);

    const pricing: any = await Pricing.findOne({ _organizationId: organization.id, _serviceName: serviceName }).lean();
    storedContent = fs.readFileSync(storedFile(pricing.yamlPath), 'utf8');
    expect(storedContent).toContain(`saasName: ${serviceName}`);
  });

  afterEach(async () => {
    for (const file of planted.splice(0)) fs.rmSync(file, { force: true });
    const pricings = await Pricing.find({ _organizationId: { $in: [organization.id, otherOrganization.id] } }).lean();
    for (const pricing of pricings) if (pricing.yamlPath) fs.rmSync(storedFile(pricing.yamlPath), { force: true });
    await Pricing.deleteMany({ _organizationId: { $in: [organization.id, otherOrganization.id] } });
    await Service.deleteMany({ organizationId: { $in: [organization.id, otherOrganization.id] } });
    await deleteTestOrganization(organization.id);
    await deleteTestOrganization(otherOrganization.id);
    for (const user of [ownerUser, memberUser, outsiderUser]) await deleteTestUser(user.username);
    nock.cleanAll();
  });

  afterAll(async () => {
    await shutdownApp();
  });

  const pricingRoute = () => `${baseUrl}/services/${serviceName}/pricings/${version}`;
  const orgPricingRoute = () => `${baseUrl}/organizations/${organization.id}/services/${serviceName}/pricings/${version}`;

  /** A file left under public/static/pricings, e.g. by a version of SPACE before this fix. */
  function plantLeftover(marker: string) {
    const name = `${organization.id}-leftover-${Date.now()}.yaml`;
    const file = path.resolve('public', 'static', 'pricings', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `saasName: leftover\nmarker: ${marker}\n`);
    planted.push(file);
    return name;
  }

  describe('uploaded pricings', () => {
    it('anonymous GET of the static path answers 404, like a missing file, without content', async () => {
      const legacy = legacyUploadedPath(organization.id, serviceName, version);
      const missing = await rawRequest(app, `/static/pricings/${organization.id}-missing-${Date.now()}.yaml`);
      const response = await rawRequest(app, legacy);

      expect(response.status).toBe(404);
      expect(response.status).toBe(missing.status);
      expect(response.body).toBe(missing.body);
      expect(response.body).not.toContain(serviceName);
      expect(response.body).not.toContain('saasName');
    });

    it('the stored yamlPath is not a static URL and is not served anonymously', async () => {
      const pricing = await request(app).get(pricingRoute()).set('x-api-key', ownerKey);
      expect(pricing.status).toBe(200);
      expect(pricing.body.yamlPath).toBeDefined();
      expect(pricing.body.yamlPath.startsWith('/static/')).toBe(false);

      const response = await rawRequest(app, pricing.body.yamlPath);
      expect(response.status).toBe(404);
      expect(response.body).not.toContain(serviceName);
      expect(fs.existsSync(path.resolve('public', `.${legacyUploadedPath(organization.id, serviceName, version)}`))).toBe(false);
    });

    it('another organization gets 404 on the static path and on the authorised route', async () => {
      const legacy = legacyUploadedPath(organization.id, serviceName, version);
      const viaStatic = await rawRequest(app, legacy, { 'x-api-key': otherKey });
      expect(viaStatic.status).toBe(404);
      expect(viaStatic.body).not.toContain(serviceName);

      const viaRoute = await request(app).get(`${pricingRoute()}?format=yaml`).set('x-api-key', otherKey);
      expect(viaRoute.status).toBe(404);
      expect(viaRoute.text).not.toContain('saasName');
    });

    it('the owning organization key reads the exact bytes with ?format=yaml', async () => {
      for (const key of [ownerKey, evaluationKey]) {
        const response = await rawRequest(app, `${pricingRoute()}?format=yaml`, { 'x-api-key': key });
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toMatch(/^application\/yaml/);
        expect(response.body).toBe(storedContent);
      }
    });

    it('a member user reads the exact bytes through the organization route; a non-member cannot', async () => {
      const member = await rawRequest(app, `${orgPricingRoute()}?format=yaml`, { 'x-api-key': memberUser.apiKey });
      expect(member.status).toBe(200);
      expect(member.body).toBe(storedContent);

      const owner = await rawRequest(app, `${orgPricingRoute()}?format=yaml`, { 'x-api-key': ownerUser.apiKey });
      expect(owner.status).toBe(200);
      expect(owner.body).toBe(storedContent);

      const outsider = await rawRequest(app, `${orgPricingRoute()}?format=yaml`, { 'x-api-key': outsiderUser.apiKey });
      expect(outsider.status).toBe(403);
      expect(outsider.body).not.toContain('saasName');
    });

    it('anonymous ?format=yaml is refused like every pricing route', async () => {
      const response = await rawRequest(app, `${pricingRoute()}?format=yaml`);
      expect(response.status).toBe(401);
      expect(response.body).not.toContain('saasName');
    });

    it('an unknown version answers 404 with ?format=yaml', async () => {
      const response = await request(app).get(`${baseUrl}/services/${serviceName}/pricings/${randomUUID()}?format=yaml`).set('x-api-key', ownerKey);
      expect(response.status).toBe(404);
    });

    it('rejects an unknown format with 400', async () => {
      const response = await request(app).get(`${pricingRoute()}?format=xml`).set('x-api-key', ownerKey);
      expect(response.status).toBe(400);
    });

    it('public-url returns the authorised route, which needs credentials', async () => {
      const response = await request(app).get(`${pricingRoute()}/public-url`).set('x-api-key', ownerKey);
      expect(response.status).toBe(200);
      expect(response.body.requiresAuthentication).toBe(true);
      const url = new URL(response.body.url);
      expect(url.pathname).toBe(pricingRoute());
      expect(url.searchParams.get('format')).toBe('yaml');

      const anonymous = await rawRequest(app, `${url.pathname}${url.search}`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).not.toContain('saasName');

      const authorised = await rawRequest(app, `${url.pathname}${url.search}`, { 'x-api-key': ownerKey });
      expect(authorised.status).toBe(200);
      expect(authorised.body).toBe(storedContent);
    });
  });

  describe('files left under public/static/pricings', () => {
    it('are not served, whatever the spelling of the path', async () => {
      const marker = `leftover-${randomUUID()}`;
      const name = plantLeftover(marker);
      const encodedName = name.split('').map(c => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`).join('');
      const missing = await rawRequest(app, `/static/pricings/${organization.id}-missing-${Date.now()}.yaml`);

      const paths = [
        `/static/pricings/${name}`,
        `/static/pricings/${name}?download=1`,
        `//static/pricings/${name}`,
        `/./static/pricings/${name}`,
        `/static//pricings/${name}`,
        `/static/./pricings/${name}`,
        `/static/x/../pricings/${name}`,
        `/static/pricings/sphere/../${name}`,
        `/static/%2e%2e/static/pricings/${name}`,
        `/static/%2E%2E/static/pricings/${name}`,
        `/x/%2e%2e/static/pricings/${name}`,
        `/static/pricings%2f${name}`,
        `/static%2fpricings%2f${name}`,
        `/static/pricings/sphere/..%2f${name}`,
        `/static/pricings/sphere/%2e%2e%2f${name}`,
        `/static/%70ricings/${name}`,
        `/static/pricings/${encodedName}`,
        `/static%5cpricings%5c${name}`,
        `/static/pricings/${name}%00`,
      ];

      for (const rawPath of paths) {
        for (const headers of [{}, { 'x-api-key': ownerKey }, { 'x-api-key': otherKey }] as Record<string, string>[]) {
          const response = await rawRequest(app, rawPath, headers);
          expect({ rawPath, status: response.status }).toEqual({ rawPath, status: 404 });
          expect(response.body).not.toContain(marker);
        }
      }

      const head = await rawRequest(app, `/static/pricings/${name}`, {}, 'HEAD');
      expect(head.status).toBe(404);

      const plain = await rawRequest(app, `/static/pricings/${name}`);
      expect(plain.body).toBe(missing.body);
    });

    it('do not affect other static assets', async () => {
      const marker = `asset-${randomUUID()}`;
      const file = path.resolve('public', 'static', `asset-${Date.now()}.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, marker);
      planted.push(file);

      const response = await rawRequest(app, `/static/${path.basename(file)}`);
      expect(response.status).toBe(200);
      expect(response.body).toBe(marker);
    });
  });

  describe('SPHERE snapshots', () => {
    async function linkSphereService() {
      const manifest = {
        pricingId, name: 'Snapshot', permanentUrl: `${origin}/p/${pricingId}`, latestVersionId: versionId,
        versions: [{ versionId, version: '1.0', createdAt: '2024-01-01T00:00:00.000Z', contentHash: functionalHash(sphereYaml) }],
      };
      nock(origin).get(`/api/v1/public/pricings/${pricingId}`).times(5).reply(200, manifest);
      nock(origin).get(`/api/v1/public/pricings/${pricingId}/versions/${versionId}/yaml`).times(5).reply(200, sphereYaml);

      const created = await request(app)
        .post(`${baseUrl}/services`)
        .set('x-api-key', ownerKey)
        .send({ source: 'sphere', permanentUrl: `${origin}/p/${pricingId}`, policy: 'new_last' });
      expect(created.status).toBe(201);
      const service: any = await Service.findOne({ organizationId: organization.id, name: 'snapshot' }).lean();
      const snapshot: any = await Pricing.findOne({ 'sphere.serviceId': String(service._id) }).lean();
      return { service, snapshot };
    }

    it('the static path of a public snapshot answers 404 to everybody, without content', async () => {
      const { service, snapshot } = await linkSphereService();
      const legacy = `/static/pricings/sphere/${service._id}/${versionId}.yaml`;
      const missing = await rawRequest(app, `/static/pricings/sphere/${service._id}/${'6'.repeat(24)}.yaml`);

      for (const headers of [{}, { 'x-api-key': ownerKey }, { 'x-api-key': otherKey }] as Record<string, string>[]) {
        for (const rawPath of [legacy, `/static/pricings/sphere/x/../${service._id}/${versionId}.yaml`, `/static/pricings/sphere%2f${service._id}%2f${versionId}.yaml`, snapshot.yamlPath]) {
          const response = await rawRequest(app, rawPath, headers);
          expect({ rawPath, status: response.status }).toEqual({ rawPath, status: 404 });
          expect(response.body).not.toContain('internal');
        }
      }
      expect((await rawRequest(app, legacy)).body).toBe(missing.body);
      expect(snapshot.yamlPath.startsWith('/static/')).toBe(false);
    });

    it('the owning organization reads the stored snapshot with ?format=yaml; another organization gets 404', async () => {
      const { snapshot } = await linkSphereService();
      const stored = fs.readFileSync(storedFile(snapshot.yamlPath), 'utf8');

      const owner = await rawRequest(app, `${baseUrl}/services/snapshot/pricings/1.0?format=yaml`, { 'x-api-key': ownerKey });
      expect(owner.status).toBe(200);
      expect(owner.body).toBe(stored);
      expect(owner.body).toContain('internal');

      const member = await rawRequest(app, `${baseUrl}/organizations/${organization.id}/services/snapshot/pricings/1.0?format=yaml`, { 'x-api-key': memberUser.apiKey });
      expect(member.status).toBe(200);
      expect(member.body).toBe(stored);

      const other = await rawRequest(app, `${baseUrl}/services/snapshot/pricings/1.0?format=yaml`, { 'x-api-key': otherKey });
      expect(other.status).toBe(404);
      expect(other.body).not.toContain('internal');
    });
  });
});
