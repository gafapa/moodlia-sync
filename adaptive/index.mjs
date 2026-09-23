import { createAdaptiveSiteAdapter } from 'moodlia/adaptive';
import { CoreSyncAdapter } from '../adapters/core-sync.mjs';
import { MoodliaSyncAdapter } from '../adapters/moodlia-sync.mjs';
import { AdaptiveSyncAdapter } from './adaptive-sync.mjs';

export { AdaptiveSyncAdapter, createAdaptiveSyncAdapter } from './adaptive-sync.mjs';

/** Builds the synchronization-capable adaptive adapter for a site profile. */
export function createSyncSiteAdapter({ profile, moodliaContract, allowWrite = false }) {
  return createAdaptiveSiteAdapter({
    profile,
    moodliaContract,
    allowWrite,
    classes: { core: CoreSyncAdapter, moodlia: MoodliaSyncAdapter, adaptive: AdaptiveSyncAdapter }
  });
}
