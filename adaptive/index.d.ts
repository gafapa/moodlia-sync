import type { AdaptiveAdapterOptions, AdaptiveMoodleAdapter } from 'moodlia/adaptive';
import type { SyncAdapterMethods } from '../adapters/index.js';
import type { CourseSyncModel } from '../sync/index.js';

export class AdaptiveSyncAdapter extends AdaptiveMoodleAdapter implements SyncAdapterMethods {
  exportCourse(courseId: number): Promise<CourseSyncModel>;
  prepareTargetCourse(target: { category_id: number; shortname: string }): Promise<CourseSyncModel>;
  syncCapabilities(context?: { courseId?: number }): Promise<Record<string, unknown>>;
  applySyncAction(action: Record<string, unknown>, context: { courseId: number; createdEntities?: Map<string, unknown> }): Promise<unknown>;
}

export function createAdaptiveSyncAdapter(options: AdaptiveAdapterOptions): AdaptiveSyncAdapter;
export function createSyncSiteAdapter(options: {
  profile: Record<string, unknown>;
  moodliaContract: Record<string, unknown>;
  allowWrite?: boolean;
}): AdaptiveSyncAdapter;
