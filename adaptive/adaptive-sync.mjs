import { contentDigest } from 'moodlia/core/canonical';
import { AdaptiveMoodleAdapter } from 'moodlia/adaptive';

export class AdaptiveSyncAdapter extends AdaptiveMoodleAdapter {
  async exportCourse(courseId) {
    if (!this.discovery) await this.discoverSite();
    const adapter = this.availableAdapter();
    if (!adapter) throw new TypeError('No provider can export the course.');
    const model = await adapter.exportCourse(courseId);
    const adapted = {
      ...model,
      site: {
        ...model.site,
        provider: 'adaptive',
        selected_provider: adapter.provider,
        profile: this.profileName
      }
    };
    adapted.digest = contentDigest({ ...adapted, extracted_at: undefined, digest: undefined });
    return adapted;
  }

  async prepareTargetCourse(targetCreation) {
    if (!this.discovery) await this.discoverSite();
    const adapter = this.availableAdapter();
    if (!adapter?.prepareTargetCourse) throw new TypeError('No provider can prepare a new target course.');
    const model = await adapter.prepareTargetCourse(targetCreation);
    const adapted = {
      ...model,
      site: {
        ...model.site,
        provider: 'adaptive',
        selected_provider: adapter.provider,
        profile: this.profileName
      }
    };
    adapted.digest = contentDigest({ ...adapted, extracted_at: undefined, digest: undefined });
    return adapted;
  }

  async syncCapabilities(context = {}) {
    if (!this.discovery) await this.discoverSite();
    const byProvider = {};
    for (const name of ['moodlia', 'core']) {
      if (!this.discovery.providers[name]?.available) continue;
      byProvider[name] = await this.adapters[name].syncCapabilities(context);
    }
    const capabilities = {};
    const names = new Set(Object.values(byProvider).flatMap((entry) => Object.keys(entry)));
    for (const capabilityName of names) {
      for (const providerName of ['moodlia', 'core']) {
        const value = byProvider[providerName]?.[capabilityName];
        const available = value === true || value?.available === true;
        if (!available) continue;
        capabilities[capabilityName] = typeof value === 'object'
          ? { ...value, provider: providerName }
          : { available: true, provider: providerName };
        this.capabilityProviders.set(capabilityName, providerName);
        break;
      }
      capabilities[capabilityName] ??= { available: false };
    }
    return capabilities;
  }

  async applySyncAction(action, context) {
    const capabilityName = action.kind.replaceAll('.', '_');
    if (!this.capabilityProviders.has(capabilityName)) await this.syncCapabilities(context);
    const providerName = action.provider ?? this.capabilityProviders.get(capabilityName);
    const adapter = this.adapters[providerName];
    if (!adapter) throw new TypeError(`No provider can apply sync action ${action.kind}.`);
    return adapter.applySyncAction(action, context);
  }

  async providerForCapability(capabilityName, context = {}, requiredProvider = null) {
    if (!this.capabilityProviders.has(capabilityName)) await this.syncCapabilities(context);
    const providerName = requiredProvider ?? this.capabilityProviders.get(capabilityName);
    const adapter = this.adapters[providerName];
    if (!adapter) throw new TypeError(`No provider is available for capability ${capabilityName}.`);
    return adapter;
  }

  async downloadAsset(asset) {
    if (!this.discovery) await this.discoverSite();
    const adapter = this.availableAdapter();
    if (!adapter?.downloadAsset) throw new TypeError('The selected source provider cannot download synchronized assets.');
    return adapter.downloadAsset(asset);
  }

  async downloadAssetToFile(asset, destinationPath) {
    if (!this.discovery) await this.discoverSite();
    const adapter = this.availableAdapter();
    if (!adapter?.downloadAssetToFile) return null;
    return adapter.downloadAssetToFile(asset, destinationPath);
  }

  async stageModuleAssets(action, assetsWithData, context) {
    const adapter = await this.providerForCapability('module_asset_stage', context, action.provider);
    return adapter.stageModuleAssets(action, assetsWithData, context);
  }

  async replaceResourceAsset(action, data, context) {
    const adapter = await this.providerForCapability('resource_asset_replace', context, action.provider);
    return adapter.replaceResourceAsset(action, data, context);
  }

  async publishBookChapterAssets(action, assetsWithData, context) {
    const adapter = await this.providerForCapability('book_asset_transfer', context, action.provider);
    return adapter.publishBookChapterAssets(action, assetsWithData, context);
  }
}

export function createAdaptiveSyncAdapter(options) {
  return new AdaptiveSyncAdapter(options);
}
