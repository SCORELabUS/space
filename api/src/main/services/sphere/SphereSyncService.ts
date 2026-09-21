import SphereSyncRepository from '../../repositories/mongoose/SphereSyncRepository';
import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { retrievePricingFromText, writePricingToYaml } from 'pricing4ts/server';
import yaml from 'js-yaml';
import container from '../../config/container';
import { parsePricingToSpacePricingObject } from '../../utils/pricing-yaml2json';
import { escapeVersion, resetEscapeVersion } from '../../utils/helpers';
import { isSubscriptionValidInPricing } from '../../controllers/validation/ContractValidation';
import { validatePricingData } from '../validation/PricingServiceValidation';
import SphereClient, { functionalHash } from './SphereClient';
import { SphereConfiguration, SphereManifest, SphereVersion, SyntaxUpgrade, isSphereSyncEnabled, selectVersion, validateConfiguration } from './types';
import { migrateSubscription, migrateUsage } from './migration';
import { withOrganizationLock } from './lock';

export default class SphereSyncService {
  private client = new SphereClient();
  private readonly repository: SphereSyncRepository = container.resolve('sphereSyncRepository');
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private reconciledAt = 0;
  private jobs = new Set<Promise<unknown>>();

  async preview(config: SphereConfiguration) {
    const link = this.client.parseLink(config.permanentUrl);
    const manifest = await this.client.manifest(link.pricingId);
    const target = selectVersion(manifest, config);
    return { ...manifest, ...link, syntaxUpgrade: await this.inspectSyntaxUpgrade(link.pricingId, target) };
  }
  async create(config: SphereConfiguration, organizationId: string) {
    validateConfiguration(config);
    return withOrganizationLock(organizationId, async assertOwned => {
      const manifest = await this.preview(config);
      const version = selectVersion(manifest, config);
      if (manifest.syntaxUpgrade && config.acceptedSyntaxUpgradeVersionId !== version.versionId) {
        throw new Error(`Pricing2Yaml syntax upgrade from ${manifest.syntaxUpgrade.from} to ${manifest.syntaxUpgrade.to} requires confirmation`);
      }
      const name = manifest.name.toLowerCase();
      if (!name || /[.$\x00]/.test(name)) throw new Error('Invalid service name in SPHERE pricing');
      if (await this.repository.serviceExists({ organizationId, name })) throw new Error('Service already exists');
      const serviceId = new mongoose.Types.ObjectId();
      const local = await this.importVersion({ _id: serviceId, name, organizationId, sphere: manifest }, version);
      let persisted = false;
      try {
        await assertOwned();
        const created = await this.repository.createService({ _id: serviceId, organizationId, name, source: 'sphere', disabled: false,
          activePricings: { [escapeVersion(version.version)]: { id: local._id } }, archivedPricings: {},
          sphere: { permanentUrl: manifest.permanentUrl, pricingId: manifest.pricingId, name: manifest.name,
            policy: config.policy, selectedVersionId: config.policy.endsWith('_pick') ? config.selectedVersionId : undefined,
            pollIntervalMinutes: config.pollIntervalMinutes ?? 5,
            target: version, revision: 1, status: 'ready', lastCheckedAt: new Date(), lastSyncedAt: new Date(), nextCheckAt: this.nextCheck(String(serviceId), config.pollIntervalMinutes ?? 5) } });
        persisted = true;
        await this.invalidate(created).catch(error => console.error('Initial cache invalidation failed', error.message));
        return created;
      } catch (error) {
        if (!persisted) await this.removeCopy(local);
        throw error;
      }
    });
  }
  async historicalPricing(organizationId: string, name: string, version: string) {
    const service: any = await this.repository.service({ organizationId, name, source: 'sphere' });
    if (!service) throw new Error('Historical pricing not found');
    const manifest = await this.client.manifest(service.sphere.pricingId);
    const remote = manifest.versions.find(v => v.version === resetEscapeVersion(version));
    if (!remote) throw new Error('Historical version is no longer public in SPHERE');
    const text = await this.client.yaml(service.sphere.pricingId, remote.versionId);
    if (functionalHash(text) !== remote.contentHash) throw new Error('Historical version changed during retrieval');
    return parsePricingToSpacePricingObject(retrievePricingFromText(text));
  }
  async get(organizationId: string, name: string) {
    const service: any = await this.repository.service({ organizationId, name });
    if (!service) throw new Error('Service not found');
    const retained = await this.repository.pricings({ 'sphere.serviceId': String(service._id) });
    const run = service.sphere?.runId ? await this.repository.run(service.sphere.runId) : null;
    return { source: service.source ?? 'manual', configuration: service.sphere ?? null, retainedVersions: retained.map((v: any) => ({ ...v, version: v.sphere?.version ?? resetEscapeVersion(v.version) })), run };
  }
  async configure(organizationId: string, name: string, config: SphereConfiguration) {
    validateConfiguration(config);
    return withOrganizationLock(organizationId, async assertOwned => {
      const service: any = await this.repository.service({ organizationId, name, source: 'sphere', disabled: false });
      if (!service) throw new Error('Linked service not found');
      if (service.sphere.status === 'applying') throw new Error('Synchronization is applying; retry after recovery');
      if (config.permanentUrl && config.permanentUrl !== service.sphere.permanentUrl) throw new Error('Changing pricing identity is not supported');
      const manifest = await this.client.manifest(service.sphere.pricingId);
      selectVersion(manifest, config);
      await assertOwned();
      await this.repository.updateService({ _id: service._id }, { $set: { 'sphere.policy': config.policy,
        'sphere.selectedVersionId': config.policy.endsWith('_pick') ? config.selectedVersionId : null,
        'sphere.pollIntervalMinutes': config.pollIntervalMinutes ?? service.sphere.pollIntervalMinutes ?? 5,
        'sphere.status': 'queued', 'sphere.nextCheckAt': new Date() }, $inc: { 'sphere.revision': 1 } });
      await this.invalidate(service);
      return this.get(organizationId, name);
    });
  }
  async enqueue(organizationId: string, name: string) {
    if (!await this.repository.serviceExists({ organizationId, name, source: 'sphere', disabled: false })) throw new Error('Linked service not found');
    await this.repository.updateService({ organizationId, name, source: 'sphere', disabled: false, 'sphere.status': { $ne: 'applying' } },
      { $set: { 'sphere.nextCheckAt': new Date(), 'sphere.status': 'queued' } });
    await this.repository.updateService({ organizationId, name, source: 'sphere', disabled: false, 'sphere.status': 'applying' }, { $set: { 'sphere.nextCheckAt': new Date() } });
    return this.get(organizationId, name);
  }
  private nextCheck(id: string, intervalMinutes = 5) {
    const interval = intervalMinutes * 60_000;
    const phase = parseInt(id.slice(-6), 16) % interval;
    const now = Date.now();
    return new Date(now + interval - ((now - phase) % interval));
  }
  start() {
    if (!isSphereSyncEnabled() || this.timer) return;
    const tick = () => {
      if (!this.ticking) this.ticking = this.poll().catch(error => console.error('SPHERE synchronization', error.message)).finally(() => { this.ticking = undefined; });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    tick();
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.ticking; await Promise.allSettled([...this.jobs]); }
  async poll() {
    if (Date.now() - this.reconciledAt >= 300000) {
      await this.reconcileOrphans();
      this.reconciledAt = Date.now();
    }
    const services = await this.repository.services({ source: 'sphere', disabled: false,
      $or: [{ 'sphere.nextCheckAt': { $lte: new Date() } }, { 'sphere.nextCheckAt': { $exists: false } }] }, 10);
    // Sequential work bounds concurrency; distributed organization leases coordinate replicas.
    for (const service of services) {
      try { await this.synchronize(String(service._id)); }
      catch (error) { console.error('SPHERE synchronization deferred', String(service._id), (error as Error).message); }
    }
  }
  async reconcileOrphans() {
    // Initial imports can survive a crash before the service document is created.
    // The same organization lease prevents racing an in-flight service creation.
    const copies = await this.repository.pricings({ 'sphere.serviceId': { $exists: true } });
    for (const copy of copies) {
      if (await this.repository.serviceExists({ _id: copy.sphere.serviceId })) continue;
      try {
        await withOrganizationLock(String(copy._organizationId), async assertOwned => {
          if (await this.repository.serviceExists({ _id: copy.sphere.serviceId })) return;
          await assertOwned();
          await this.removeCopy(copy);
        });
      } catch (error) {
        if (!(error as Error).message.includes('busy')) throw error;
      }
    }
  }
  async synchronize(id: string) {
    const job = this.synchronizeOnce(id);
    this.jobs.add(job);
    try { return await job; } finally { this.jobs.delete(job); }
  }
  private async synchronizeOnce(id: string) {
    const initial: any = await this.repository.service({ _id: id });
    if (!initial || initial.disabled || initial.source !== 'sphere') return;
    return withOrganizationLock(initial.organizationId, async assertOwned => {
      const service: any = await this.repository.service({ _id: id });
      if (!service || service.disabled || new Date(service.sphere.nextCheckAt ?? 0).getTime() > Date.now()) return;
      let run: any = service.sphere.status === 'applying' && service.sphere.runId ? await this.repository.run(service.sphere.runId) : null;
      let applying = Boolean(run);
      try {
        if (!run) {
          await this.repository.updateService({ _id: id }, { $set: { 'sphere.status': 'checking', 'sphere.lastCheckedAt': new Date() } });
          const manifest = await this.client.manifest(service.sphere.pricingId);
          const candidate = selectVersion(manifest, service.sphere, service.sphere.target);
          // Check every retained public snapshot for content changes, even when the target is unchanged.
          const retained: any[] = await this.repository.pricings({ 'sphere.serviceId': id });
          for (const copy of retained) {
            const remote = manifest.versions.find(v => v.versionId === copy.sphere.versionId);
            if (remote && remote.contentHash !== copy.sphere.contentHash) throw new Error('An imported version changed content; publish a new SPHERE version');
          }
          const local = await this.importVersion(service, candidate);
          const prepared = service.sphere.policy.startsWith('all_') ? await this.prepare(service, local) : [];
          await assertOwned();
          run = (await this.repository.createRun({ serviceId: id, organizationId: service.organizationId,
            revision: service.sphere.revision, status: 'applying', candidate }));
          await this.repository.updateService({ _id: id, 'sphere.revision': service.sphere.revision }, {
            $set: { 'sphere.status': 'applying', 'sphere.runId': String(run._id), 'sphere.name': manifest.name,
              [`activePricings.${escapeVersion(candidate.version)}`]: { id: local._id } } });
          applying = true;
          await this.invalidate(service);
          // Prevalidation above covers all contracts before the first write.
          for (const entry of prepared) await this.applyContract(service, local, entry.contract, run, assertOwned);
        }
        const local: any = await this.repository.pricing({ 'sphere.serviceId': id, 'sphere.versionId': run.candidate.versionId });
        if (!local) throw new Error('Missing imported snapshot; synchronization requires recovery');
        if (service.sphere.policy.startsWith('all_')) {
          const contracts = await this.contracts(service);
          for (const contract of contracts) await this.applyContract(service, local, contract, run, assertOwned);
        }
        await assertOwned();
        const history: any[] = await this.repository.aggregateContracts([{ $match: { organizationId: service.organizationId } },
          { $unwind: '$synchronizationHistory' }, { $match: { 'synchronizationHistory.runId': String(run._id) } },
          { $group: { _id: null, migrated: { $sum: 1 }, replaced: { $sum: { $cond: ['$synchronizationHistory.replaced', 1, 0] } } } }]);
        const counts = { migrated: history[0]?.migrated ?? 0, replaced: history[0]?.replaced ?? 0 };
        await this.repository.updateService({ _id: id, 'sphere.revision': run.revision }, { $set: {
          'sphere.target': run.candidate, 'sphere.status': 'ready', 'sphere.error': null,
          'sphere.lastSyncedAt': new Date(), 'sphere.nextCheckAt': this.nextCheck(id, service.sphere.pollIntervalMinutes ?? 5),
          'sphere.migrated': counts.migrated, 'sphere.replaced': counts.replaced } });
        for (const changed of await this.repository.contracts({ 'synchronizationHistory.runId': String(run._id) })) {
          await container.resolve('cacheService').del(`contracts.${changed.userContact!.userId}`);
          await container.resolve('cacheService').del(`features.${changed.userContact!.userId}.*`);
        }
        await this.repository.updateRun({ _id: run._id }, { $set: { status: 'ready', finishedAt: new Date(), ...counts } });
        await this.invalidate(service);
        await this.cleanup(id, assertOwned);
        container.resolve('eventService').emitPricingActivedMessage(service.name, run.candidate.version);
      } catch (error) {
        const message = (error as Error).message;
        await assertOwned();
        const status = applying ? 'applying' : /No valid|Incompatible|changed content/.test(message) ? 'blocked' : 'degraded';
        await this.repository.updateService({ _id: id }, { $set: { 'sphere.status': status, 'sphere.error': message,
          'sphere.lastCheckedAt': new Date(), 'sphere.nextCheckAt': this.nextCheck(id, service.sphere.pollIntervalMinutes ?? 5) } });
        if (run) await this.repository.updateRun({ _id: run._id }, { $set: { error: message } });
        await this.invalidate(service);
        if (!applying) await this.cleanup(id, assertOwned);
      }
    });
  }
  private async importVersion(service: any, version: SphereVersion): Promise<any> {
    const existing: any = await this.repository.pricing({ 'sphere.serviceId': String(service._id), 'sphere.versionId': version.versionId });
    if (existing) {
      if (existing.sphere.contentHash !== version.contentHash) throw new Error('An imported version changed content; publish a new SPHERE version');
      return existing;
    }
    const text = await this.client.yaml(service.sphere.pricingId, version.versionId);
    if (functionalHash(text) !== version.contentHash) throw new Error('SPHERE snapshot changed while downloading; retry');
    const parsed = retrievePricingFromText(text);
    if (parsed.version !== version.version || new Date(parsed.createdAt).getTime() !== Date.parse(version.createdAt)) throw new Error('Invalid SPHERE snapshot metadata');
    const data = parsePricingToSpacePricingObject(parsed);
    const errors = validatePricingData(data);
    if (errors.length) throw new Error(`Invalid pricing: ${errors.join(', ')}`);
    const yamlPath = `/static/pricings/sphere/${service._id}/${version.versionId}.yaml`;
    const file = path.resolve('public', '.' + yamlPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Persist the parsed Pricing2Yaml model, not the remote source text. This
    // makes a confirmed legacy-syntax upgrade explicit and reproducible.
    await fs.writeFile(file, '', { flag: 'w' });
    try {
      writePricingToYaml(parsed, file);
      const saved = await this.repository.createPricing({ ...data, _serviceName: service.name, _organizationId: service.organizationId,
        yamlPath, sphere: { serviceId: String(service._id), pricingId: service.sphere.pricingId,
          permanentUrl: service.sphere.permanentUrl, ...version } });
      return await this.repository.pricing({ _id: saved._id });
    } catch (error) { await fs.rm(file, { force: true }); throw error; }
  }
  private async inspectSyntaxUpgrade(pricingId: string, version: SphereVersion): Promise<SyntaxUpgrade | undefined> {
    const text = await this.client.yaml(pricingId, version.versionId);
    if (functionalHash(text) !== version.contentHash) throw new Error('SPHERE snapshot changed while downloading; retry');
    const source = yaml.load(text) as { syntaxVersion?: unknown };
    if (!source || typeof source !== 'object' || typeof source.syntaxVersion !== 'string') {
      throw new Error('SPHERE pricing has no valid Pricing2Yaml syntaxVersion');
    }
    const parsed = retrievePricingFromText(text);
    return source.syntaxVersion === parsed.syntaxVersion ? undefined : {
      versionId: version.versionId, from: source.syntaxVersion, to: parsed.syntaxVersion,
    };
  }
  private contracts(service: any): Promise<any[]> {
    return this.repository.contracts({ organizationId: service.organizationId, [`contractedServices.${service.name}`]: { $exists: true } }) as any;
  }
  private async prepareOne(service: any, local: any, contract: any) {
    const priorVersion = contract.contractedServices[service.name];
    const previous: any = await this.repository.pricing({ _serviceName: service.name, _organizationId: service.organizationId,
      version: escapeVersion(priorVersion) });
    if (!previous) throw new Error('Missing currently contracted pricing snapshot');
    const migrated = migrateSubscription(contract, service.name, local,
      subscription => isSubscriptionValidInPricing(service.name, subscription, local));
    const usage = migrateUsage(previous, local, contract.usageLevels?.[service.name]);
    return { ...migrated, usage, fromVersionId: previous.sphere?.versionId, fromVersion: previous.sphere?.version ?? resetEscapeVersion(priorVersion) };
  }
  private async prepare(service: any, local: any) {
    const entries = [];
    for (const contract of await this.contracts(service)) {
      if (contract.contractedServices[service.name] !== escapeVersion(local.version)) {
        await this.prepareOne(service, local, contract); entries.push({ contract });
      }
    }
    return entries;
  }
  private async applyContract(service: any, local: any, initial: any, run: any, assertOwned: () => Promise<void>) {
    let contract = initial;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!contract || contract.contractedServices?.[service.name] === escapeVersion(local.version)) return;
      const migrated = await this.prepareOne(service, local, contract);
      await assertOwned();
      const usagePath = `usageLevels.${service.name}`;
      const planPath = `subscriptionPlans.${service.name}`;
      const update: any = { $set: { [`contractedServices.${service.name}`]: escapeVersion(local.version),
        [`subscriptionAddOns.${service.name}`]: migrated.subscription.subscriptionAddOns[service.name] ?? {},
        [usagePath]: migrated.usage }, $push: { synchronizationHistory: {
          runId: String(run._id), service: service.name, pricingId: service.sphere.pricingId,
          fromVersion: migrated.fromVersion, toVersion: local.sphere.version,
          fromVersionId: migrated.fromVersionId, toVersionId: local.sphere.versionId, priorPlan: contract.subscriptionPlans?.[service.name],
          priorAddOns: contract.subscriptionAddOns?.[service.name] ?? {}, replaced: migrated.replaced, at: new Date(),
          reason: migrated.replaced ? 'invalid_subscription_cheapest_valid_public_plan' : 'policy_target_changed',
        } } };
      const plan = migrated.subscription.subscriptionPlans[service.name];
      if (plan) update.$set[planPath] = plan; else update.$unset = { [planPath]: '' };
      const result = await this.repository.updateContract({ _id: contract._id,
        contractedServices: contract.contractedServices, subscriptionPlans: contract.subscriptionPlans,
        subscriptionAddOns: contract.subscriptionAddOns,
        [usagePath]: contract.usageLevels?.[service.name] ?? { $exists: false } }, update);
      if (result.modifiedCount) {
        await this.repository.updateRun({ _id: run._id }, { $inc: { migrated: 1, replaced: migrated.replaced ? 1 : 0 } });
        await container.resolve('cacheService').del(`contracts.${contract.userContact.userId}`);
        await container.resolve('cacheService').del(`features.${contract.userContact.userId}.*`);
        return;
      }
      contract = await this.repository.contract({ _id: contract._id });
    }
    throw new Error('Concurrent consumption prevented migration; progress retained for retry');
  }
  async cleanup(id: string, assertOwned: () => Promise<void> = async () => {}) {
    const service: any = await this.repository.service({ _id: id });
    if (!service || service.source !== 'sphere' || service.sphere.status === 'applying') return;
    const retained = new Set((await this.contracts(service)).map(c => c.contractedServices[service.name]));
    retained.add(escapeVersion(service.sphere.target.version));
    const copies: any[] = await this.repository.pricings({ 'sphere.serviceId': id });
    for (const copy of copies) {
      if (retained.has(copy.version)) continue;
      await assertOwned();
      if (await this.repository.contractExists({ organizationId: service.organizationId, [`contractedServices.${service.name}`]: escapeVersion(copy.version) })) continue;
      await this.repository.updateService({ _id: id }, { $unset: { [`activePricings.${escapeVersion(copy.version)}`]: '', [`archivedPricings.${escapeVersion(copy.version)}`]: '' } });
      await this.removeCopy(copy);
    }
    await this.invalidate(service);
  }
  async removeLinkedService(id: string, disable: boolean, assertOwned: () => Promise<void>) {
    const service: any = await this.repository.service({ _id: id });
    if (!service || service.source !== 'sphere') throw new Error('Linked service not found');
    if (service.sphere.status === 'applying') throw new Error('Synchronization is applying; retry after recovery');
    for (const contract of await this.contracts(service)) {
      await assertOwned();
      const update: any = { $unset: { [`contractedServices.${service.name}`]: '', [`subscriptionPlans.${service.name}`]: '',
        [`subscriptionAddOns.${service.name}`]: '', [`usageLevels.${service.name}`]: '' },
        $push: { synchronizationHistory: { service: service.name, pricingId: service.sphere.pricingId,
          fromVersion: resetEscapeVersion(contract.contractedServices[service.name]), reason: 'service_removed', at: new Date() } } };
      if (Object.keys(contract.contractedServices).length === 1) update.$set = { 'billingPeriod.endDate': new Date(), 'billingPeriod.autoRenew': false };
      await this.repository.updateContract({ _id: contract._id, contractedServices: contract.contractedServices }, update);
      await container.resolve('cacheService').del(`contracts.${contract.userContact.userId}`);
      await container.resolve('cacheService').del(`features.${contract.userContact.userId}.*`);
    }
    await assertOwned();
    if (disable) {
      await this.repository.updateService({ _id: id }, { $set: { disabled: true } });
      await this.cleanup(id, assertOwned);
      container.resolve('eventService').emitServiceDisabledMessage(service.name);
    } else {
      if (await this.repository.contractExists({ organizationId: service.organizationId, [`contractedServices.${service.name}`]: { $exists: true } })) throw new Error('Contract binding changed; retry removal');
      for (const copy of await this.repository.pricings({ 'sphere.serviceId': id })) await this.removeCopy(copy);
      await this.repository.deleteService({ _id: id });
    }
    await this.invalidate(service);
    return true;
  }
  private async removeCopy(copy: any) {
    if (copy.yamlPath?.startsWith('/static/pricings/sphere/')) await fs.rm(path.resolve('public', '.' + copy.yamlPath), { force: true });
    await this.repository.deletePricing({ _id: copy._id });
    await container.resolve('cacheService').del(`pricing.id.${copy._id}`);
  }
  private async invalidate(service: any) {
    await container.resolve('cacheService').del(`service.${service.organizationId}.${service.name}`);
  }
}
