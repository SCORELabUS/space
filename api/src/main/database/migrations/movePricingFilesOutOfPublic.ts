import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import PricingMongoose from '../../repositories/mongoose/models/PricingMongoose';
import {
  LEGACY_PRICINGS_PREFIX,
  legacyPublicPricingsRoot,
  legacyPublicYamlFile,
  pricingYamlFile,
  privateYamlPathFor,
} from '../../services/pricingFiles';

export interface PricingFilesMigrationReport {
  /** Pricing documents whose `yamlPath` was rewritten to the private directory. */
  rewritten: number;
  /** Files moved out of `public/static/pricings`. */
  moved: number;
  /** Legacy files dropped because the private copy already had the same bytes. */
  deduplicated: number;
  /** Files whose private target already existed with other bytes (kept under a `.from-public-<hash>` name). */
  conflicts: number;
  /** Rewritten documents whose file existed in neither place. */
  missing: number;
}

function exists(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sameBytes(a: string, b: string): boolean {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function unlinkIfPresent(file: string) {
  try {
    fs.unlinkSync(file);
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * Copy `source` to `target` atomically (temporary file in the target directory,
 * then rename), then remove `source`. Works across devices (public/ and the
 * private directory are usually separate volumes). Returns false when `source`
 * disappeared meanwhile (another instance moved it).
 */
function moveFile(source: string, target: string): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.copyFileSync(source, temporary);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    unlinkIfPresent(temporary);
    throw error;
  }
  unlinkIfPresent(source);
  return true;
}

function filesUnder(directory: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function removeEmptyDirectories(directory: string, keep: boolean) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) removeEmptyDirectories(path.join(directory, entry.name), false);
  }
  if (!keep) {
    try {
      fs.rmdirSync(directory);
    } catch {
      // not empty, or removed by another instance
    }
  }
}

/**
 * Move every pricing file out of `public/static/pricings` (served without
 * authentication) into the private files directory and rewrite the stored
 * `yamlPath` references.
 *
 * Idempotent and safe to interrupt: a file is copied to its target before the
 * reference is rewritten and the legacy copy removed, so a restart finishes the
 * job, and readers resolve both kinds of references meanwhile. Concurrent
 * instances only race on the same atomic renames and conditional updates.
 *
 * 1. Documents with a legacy `yamlPath`: file moved (the legacy file, still the
 *    referenced one, wins over a stale private copy), then the reference.
 * 2. Remaining files under `public/static/pricings` (temporary uploads, files
 *    of deleted versions): moved to the same mapped place, so nothing of the
 *    tree stays reachable. A different file already there is kept and the
 *    legacy one is stored next to it as `<name>.from-public-<hash>`.
 */
export async function movePricingFilesOutOfPublic(): Promise<PricingFilesMigrationReport> {
  const report: PricingFilesMigrationReport = { rewritten: 0, moved: 0, deduplicated: 0, conflicts: 0, missing: 0 };
  const cacheKeys: string[] = [];

  const legacy = await PricingMongoose.find(
    { yamlPath: { $regex: `^${LEGACY_PRICINGS_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}` } },
    { yamlPath: 1 }
  ).lean();

  for (const document of legacy as any[]) {
    const from: string = document.yamlPath;
    const to = privateYamlPathFor(from);
    const source = legacyPublicYamlFile(from);
    const target = pricingYamlFile(to);
    if (!target) {
      console.warn(`Pricing ${document._id}: yamlPath ${from} does not map to a pricing file; left unchanged`);
      continue;
    }

    if (source && exists(source)) {
      if (exists(target) && sameBytes(source, target)) {
        unlinkIfPresent(source);
        report.deduplicated++;
      } else if (moveFile(source, target)) {
        report.moved++;
      }
    } else if (!exists(target)) {
      report.missing++;
    }

    const result = await PricingMongoose.updateOne({ _id: document._id, yamlPath: from }, { $set: { yamlPath: to } });
    if (result.modifiedCount > 0) {
      report.rewritten++;
      cacheKeys.push(`pricing.id.${document._id}`);
    }
  }

  const root = legacyPublicPricingsRoot();
  for (const source of filesUnder(root)) {
    const relative = path.relative(root, source).split(path.sep).join('/');
    const target = pricingYamlFile(`${LEGACY_PRICINGS_PREFIX}${relative}`);
    if (!target) continue;
    if (exists(target)) {
      if (sameBytes(source, target)) {
        unlinkIfPresent(source);
        report.deduplicated++;
        continue;
      }
      const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 12);
      if (moveFile(source, `${target}.from-public-${hash}`)) report.conflicts++;
      continue;
    }
    if (moveFile(source, target)) report.moved++;
  }
  removeEmptyDirectories(root, true);

  if (cacheKeys.length > 0) {
    try {
      // Imported lazily: the container pulls in every service.
      const { default: container } = await import('../../config/container');
      await container.resolve('cacheService').delMany(cacheKeys);
    } catch (error) {
      console.warn('Cached pricings could not be invalidated after moving their files:', (error as Error).message);
    }
  }

  return report;
}
