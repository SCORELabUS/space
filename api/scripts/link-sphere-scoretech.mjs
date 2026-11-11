import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const bindingPattern = /^[a-f0-9]{64}$/;
const objectIdPattern = /^[a-f0-9]{24}$/;
const fail = (message) => { throw new Error(message); };
const load = (path) => import(pathToFileURL(resolve(path)).href);

export function scoretechBinding(issuer, subject) {
  // Same formula as SPHERE's ScoretechIdentityService.scoretechIdentityId.
  return createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
}

export function planLinks({ sphereIssuer, issuer, sphereUsers, subjects, spaceUsers }) {
  if (typeof sphereIssuer !== 'string' || !sphereIssuer || typeof issuer !== 'string' || !issuer ||
      !Array.isArray(sphereUsers) || !Array.isArray(subjects) || !Array.isArray(spaceUsers)) {
    fail('Invalid SPHERE or SCORETech export.');
  }
  const bySphere = new Map();
  const usedBindings = new Map();
  for (const { id, bindings } of sphereUsers) {
    if (!objectIdPattern.test(id) || bySphere.has(id) || !Array.isArray(bindings) ||
        bindings.length === 0 || bindings.some(binding => typeof binding !== 'string' || !bindingPattern.test(binding))) {
      fail('Invalid or repeated SPHERE binding in export.');
    }
    bySphere.set(id, bindings);
    for (const binding of bindings) usedBindings.set(binding, (usedBindings.get(binding) ?? 0) + 1);
  }

  const subjectByBinding = new Map();
  for (const subject of subjects) {
    if (typeof subject !== 'string' || !subject || subject.length > 255) fail('Invalid SCORETech subject in export.');
    const binding = scoretechBinding(issuer, subject);
    if (subjectByBinding.has(binding)) fail('Repeated SCORETech subject in export.');
    subjectByBinding.set(binding, subject);
  }

  const sphereOwners = new Map();
  const scoretechOwners = new Map();
  for (const row of spaceUsers) {
    if (row.sphereIdentity?.issuer === sphereIssuer) {
      const subject = row.sphereIdentity.subject;
      sphereOwners.set(subject, (sphereOwners.get(subject) ?? 0) + 1);
    }
    if (row.scoretechIdentity?.issuer === issuer) {
      const subject = row.scoretechIdentity.subject;
      const owners = scoretechOwners.get(subject) ?? [];
      owners.push(String(row._id));
      scoretechOwners.set(subject, owners);
    }
  }

  const plan = [];
  const report = { candidates: 0, ready: 0, alreadyLinked: 0, noSphereLink: 0, missingInIdentity: 0, conflicts: [] };
  for (const row of spaceUsers) {
    const source = row.sphereIdentity;
    if (source?.issuer !== sphereIssuer) continue;
    report.candidates++;
    const conflict = () => report.conflicts.push(String(row._id));
    const bindings = bySphere.get(source.subject);
    if (!bindings) {
      report.noSphereLink++;
      continue;
    }
    if (bindings.length !== 1 || usedBindings.get(bindings[0]) !== 1 || sphereOwners.get(source.subject) !== 1) {
      conflict();
      continue;
    }
    const subject = subjectByBinding.get(bindings[0]);
    if (!subject) {
      report.missingInIdentity++;
      continue;
    }
    const owners = scoretechOwners.get(subject) ?? [];
    if (owners.some(owner => owner !== String(row._id))) {
      conflict();
      continue;
    }
    if (Object.hasOwn(row, 'scoretechIdentity')) {
      if (row.scoretechIdentity?.issuer === issuer && row.scoretechIdentity.subject === subject) report.alreadyLinked++;
      else conflict();
      continue;
    }
    plan.push({ id: row._id, source, target: { issuer, subject } });
  }
  report.ready = plan.length;
  return { plan, report };
}

export async function applyLinks(users, plan) {
  const index = (await users.indexes()).find(entry => entry.name === 'unique_scoretech_identity');
  if (!index?.unique || Object.keys(index.key).length !== 2 ||
      index.key['scoretechIdentity.issuer'] !== 1 || index.key['scoretechIdentity.subject'] !== 1) {
    fail('Start the updated SPACE API to create its unique identity index before applying.');
  }
  const outcome = { linked: 0, changedSincePlan: [] };
  for (const { id, source, target } of plan) {
    try {
      const result = await users.updateOne({
        _id: id,
        'sphereIdentity.issuer': source.issuer,
        'sphereIdentity.subject': source.subject,
        scoretechIdentity: { $exists: false },
      }, { $set: { scoretechIdentity: target } });
      if (result.modifiedCount === 1) outcome.linked++;
      else outcome.changedSincePlan.push(String(id));
    } catch (error) {
      if (error?.code !== 11000) throw error;
      outcome.changedSincePlan.push(String(id));
    }
  }
  return outcome;
}

async function withUsers(uri, callback) {
  const { default: mongoose } = await import('mongoose');
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
    await callback(mongoose.connection.db.collection('users'));
  } catch (error) {
    if (error?.name?.startsWith('Mongo')) fail('MongoDB operation failed. Check connectivity and rerun the dry run.');
    throw error;
  } finally {
    await mongoose.disconnect();
  }
}

async function exportSphere() {
  // Match SPHERE's oauthIssuer without loading its application container.
  const url = new URL(process.env.OAUTH_ISSUER_URL || process.env.FRONTEND_URL || 'http://localhost:5173');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    fail('SPHERE OIDC issuer must be an HTTPS origin or local loopback origin.');
  }
  const { scoretechConfig } = await load('dist/main/services/scoretech/config.js');
  const { getMongoDBConnectionURI } = await load('dist/main/config/mongoose.js');
  await withUsers(getMongoDBConnectionURI(), async users => {
    const rows = await users.find({ 'identities.provider': 'scoretech' }, {
      projection: { _id: 1, 'identities.provider': 1, 'identities.providerId': 1 },
    }).toArray();
    const sphereUsers = rows.map(row => ({
      id: String(row._id),
      bindings: row.identities.filter(value => value.provider === 'scoretech').map(value => value.providerId),
    }));
    console.log(JSON.stringify({ sphereIssuer: url.origin, issuer: scoretechConfig().issuer, sphereUsers }));
  });
}

async function importLinks(apply) {
  const lines = readFileSync(0, 'utf8').trim().split('\n');
  if (lines.length !== 2) fail('Expected exactly two JSON exports from SPHERE and SCORETech Identity.');
  const source = JSON.parse(lines[0]);
  const subjects = JSON.parse(lines[1]);
  const { identityConfig } = await load('dist/services/identity/config.js');
  if (source?.issuer !== identityConfig().issuer) fail('SPHERE and SPACE are configured with different SCORETech issuers.');
  if (!source.issuer.endsWith('/realms/score')) fail('This production helper expects the SCORETech realm named score.');
  const { sphereIssuer, issuer } = source;
  if (typeof sphereIssuer !== 'string' || !sphereIssuer) fail('Missing SPHERE issuer.');
  if (process.env.SPHERE_OIDC_ISSUER && new URL(process.env.SPHERE_OIDC_ISSUER).origin !== sphereIssuer) {
    fail('The source issuer does not match the legacy SPHERE issuer configured in SPACE.');
  }

  // Production Compose resolves this to the same URI used by the running API.
  if (!process.env.MONGO_URI) fail('Missing MONGO_URI in the SPACE API container.');
  await withUsers(process.env.MONGO_URI, async users => {
    const spaceUsers = await users.find({
      $or: [{ 'sphereIdentity.issuer': sphereIssuer }, { 'scoretechIdentity.issuer': issuer }],
    }, { projection: { _id: 1, sphereIdentity: 1, scoretechIdentity: 1 } }).toArray();
    const { plan, report } = planLinks({ ...source, subjects, spaceUsers });
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...report }, null, 2));
    if (apply && plan.length) console.log(JSON.stringify(await applyLinks(users, plan), null, 2));
  });
}

const mode = process.argv[1]; // The Compose wrapper runs this module with node -e.
if (['export-sphere', 'plan', 'apply'].includes(mode)) {
  try {
    if (mode === 'export-sphere') await exportSphere();
    else await importLinks(mode === 'apply');
  } catch (error) {
    console.error('SPACE identity recovery:', error.message);
    process.exitCode = 1;
  }
}
