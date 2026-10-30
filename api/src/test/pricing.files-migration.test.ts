import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getApp, shutdownApp } from './utils/testApp';
import Pricing from '../main/repositories/mongoose/models/PricingMongoose';
import { movePricingFilesOutOfPublic } from '../main/database/migrations/movePricingFilesOutOfPublic';

/**
 * Pricing files stored by earlier versions under public/static/pricings are
 * moved to the private files directory and their references rewritten,
 * idempotently and safely after an interruption.
 */

const legacyRoot = () => path.resolve('public', 'static', 'pricings');
const privateRoot = () => path.resolve(process.env.SPACE_PRIVATE_FILES_DIR || 'private');

function writeLegacy(relative: string, content: string) {
  const file = path.join(legacyRoot(), relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)]
  );
}

describe('Moving pricing files out of public/', () => {
  const organizationId = new mongoose.Types.ObjectId().toString();
  const created: string[] = [];

  beforeAll(async () => {
    await getApp();
  });

  afterEach(async () => {
    await Pricing.deleteMany({ _organizationId: organizationId });
    for (const file of created.splice(0)) fs.rmSync(file, { force: true, recursive: true });
  });

  afterAll(async () => {
    await shutdownApp();
  });

  async function legacyPricing(yamlPath: string, version = randomUUID()) {
    const pricing = await Pricing.create({
      _serviceName: `migration-${version}`,
      _organizationId: organizationId,
      version,
      currency: 'USD',
      yamlPath,
      features: { enabled: { name: 'enabled', valueType: 'BOOLEAN', defaultValue: true, type: 'DOMAIN' } },
    });
    return pricing._id;
  }

  it('moves referenced and unreferenced files, rewrites the references, and is idempotent', async () => {
    const uploadedName = `${organizationId}-service-${randomUUID()}.yaml`;
    const serviceId = new mongoose.Types.ObjectId().toString();
    const versionId = new mongoose.Types.ObjectId().toString();
    const uploadedContent = `saasName: uploaded\nmarker: ${randomUUID()}\n`;
    const sphereContent = `saasName: snapshot\nmarker: ${randomUUID()}\n`;
    const orphanContent = `saasName: orphan\nmarker: ${randomUUID()}\n`;
    const orphanName = `${organizationId}-deleted-${randomUUID()}.yaml`;
    const tempName = `${randomUUID()}yaml`;

    writeLegacy(uploadedName, uploadedContent);
    writeLegacy(`sphere/${serviceId}/${versionId}.yaml`, sphereContent);
    writeLegacy(orphanName, orphanContent);
    writeLegacy(`uploaded/${tempName}`, orphanContent);
    created.push(
      path.join(privateRoot(), 'pricings', uploadedName),
      path.join(privateRoot(), 'pricings', orphanName),
      path.join(privateRoot(), 'pricings', 'uploaded'),
      path.join(privateRoot(), 'sphere', serviceId)
    );

    const uploadedId = await legacyPricing(`/static/pricings/${uploadedName}`);
    const sphereId = await legacyPricing(`/static/pricings/sphere/${serviceId}/${versionId}.yaml`);

    const first = await movePricingFilesOutOfPublic();
    expect(first.rewritten).toBeGreaterThanOrEqual(2);
    expect(first.moved).toBeGreaterThanOrEqual(4);

    const uploaded: any = await Pricing.findById(uploadedId).lean();
    const sphere: any = await Pricing.findById(sphereId).lean();
    expect(uploaded.yamlPath).toBe(`/private/pricings/${uploadedName}`);
    expect(sphere.yamlPath).toBe(`/private/sphere/${serviceId}/${versionId}.yaml`);

    expect(fs.readFileSync(path.join(privateRoot(), 'pricings', uploadedName), 'utf8')).toBe(uploadedContent);
    expect(fs.readFileSync(path.join(privateRoot(), 'sphere', serviceId, `${versionId}.yaml`), 'utf8')).toBe(sphereContent);
    expect(fs.readFileSync(path.join(privateRoot(), 'pricings', orphanName), 'utf8')).toBe(orphanContent);
    expect(fs.readFileSync(path.join(privateRoot(), 'pricings', 'uploaded', tempName), 'utf8')).toBe(orphanContent);
    expect(filesUnder(legacyRoot())).toEqual([]);

    const second = await movePricingFilesOutOfPublic();
    expect(second).toEqual({ rewritten: 0, moved: 0, deduplicated: 0, conflicts: 0, missing: 0 });
    expect(((await Pricing.findById(uploadedId).lean()) as any).yamlPath).toBe(`/private/pricings/${uploadedName}`);
    expect(fs.readFileSync(path.join(privateRoot(), 'pricings', uploadedName), 'utf8')).toBe(uploadedContent);
  });

  it('finishes an interrupted run: file already copied, reference not yet rewritten', async () => {
    const name = `${organizationId}-interrupted-${randomUUID()}.yaml`;
    const content = `saasName: interrupted\nmarker: ${randomUUID()}\n`;
    const target = path.join(privateRoot(), 'pricings', name);
    created.push(target);

    // Copied, then interrupted before the legacy copy was removed.
    writeLegacy(name, content);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    const bothId = await legacyPricing(`/static/pricings/${name}`);

    // Legacy copy removed, reference not rewritten.
    const name2 = `${organizationId}-interrupted2-${randomUUID()}.yaml`;
    const target2 = path.join(privateRoot(), 'pricings', name2);
    created.push(target2);
    fs.writeFileSync(target2, content);
    const onlyTargetId = await legacyPricing(`/static/pricings/${name2}`);

    // A stale private copy is replaced by the legacy file, which is the one referenced.
    const name3 = `${organizationId}-stale-${randomUUID()}.yaml`;
    const target3 = path.join(privateRoot(), 'pricings', name3);
    created.push(target3);
    writeLegacy(name3, content);
    fs.writeFileSync(target3, 'partial');
    const staleId = await legacyPricing(`/static/pricings/${name3}`);

    const report = await movePricingFilesOutOfPublic();
    expect(report.missing).toBe(0);
    for (const [id, file] of [[bothId, name], [onlyTargetId, name2], [staleId, name3]] as const) {
      expect(((await Pricing.findById(id).lean()) as any).yamlPath).toBe(`/private/pricings/${file}`);
      expect(fs.readFileSync(path.join(privateRoot(), 'pricings', file), 'utf8')).toBe(content);
    }
    expect(filesUnder(legacyRoot())).toEqual([]);
  });

  it('keeps both files when an unreferenced legacy file collides with a different private file', async () => {
    const name = `${organizationId}-collision-${randomUUID()}.yaml`;
    const target = path.join(privateRoot(), 'pricings', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'current');
    writeLegacy(name, 'legacy');

    const report = await movePricingFilesOutOfPublic();
    expect(report.conflicts).toBe(1);
    const kept = fs.readdirSync(path.dirname(target)).filter(file => file.startsWith(name));
    for (const file of kept) created.push(path.join(path.dirname(target), file));
    expect(fs.readFileSync(target, 'utf8')).toBe('current');
    expect(kept.map(file => fs.readFileSync(path.join(path.dirname(target), file), 'utf8')).sort()).toEqual(['current', 'legacy']);
    expect(filesUnder(legacyRoot())).toEqual([]);
  });

  it('rewrites a reference whose file is gone, so it no longer points into public/', async () => {
    const name = `${organizationId}-lost-${randomUUID()}.yaml`;
    const id = await legacyPricing(`/static/pricings/${name}`);

    const report = await movePricingFilesOutOfPublic();
    expect(report.missing).toBe(1);
    expect(((await Pricing.findById(id).lean()) as any).yamlPath).toBe(`/private/pricings/${name}`);
  });
});
