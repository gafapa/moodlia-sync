import type { CoreMoodleAdapter } from 'moodlia/core/adapters';
import type { MoodliaMoodleAdapter } from 'moodlia/adapters/moodlia';
import type { CourseSyncModel } from '../sync/index.js';

export interface SyncAdapterMethods {
  exportCourse(courseId: number): Promise<CourseSyncModel>;
  prepareTargetCourse(target: { category_id: number; shortname: string }): Promise<CourseSyncModel>;
  syncCapabilities(context?: { courseId?: number }): Promise<Record<string, unknown>>;
  applySyncAction(action: Record<string, unknown>, context: { courseId: number; createdEntities?: Map<string, unknown> }): Promise<unknown>;
}

export class CoreSyncAdapter extends CoreMoodleAdapter implements SyncAdapterMethods {
  exportCourse(courseId: number): Promise<CourseSyncModel>;
  prepareTargetCourse(target: { category_id: number; shortname: string }): Promise<CourseSyncModel>;
  syncCapabilities(context?: { courseId?: number }): Promise<Record<string, unknown>>;
  applySyncAction(action: Record<string, unknown>, context: { courseId: number; createdEntities?: Map<string, unknown> }): Promise<unknown>;
}

export class MoodliaSyncAdapter extends MoodliaMoodleAdapter implements SyncAdapterMethods {
  exportCourse(courseId: number): Promise<CourseSyncModel>;
  prepareTargetCourse(target: { category_id: number; shortname: string }): Promise<CourseSyncModel>;
  syncCapabilities(context?: { courseId?: number }): Promise<Record<string, unknown>>;
  applySyncAction(action: Record<string, unknown>, context: { courseId: number; createdEntities?: Map<string, unknown> }): Promise<unknown>;
  downloadAsset(asset: Record<string, unknown>): Promise<Uint8Array>;
  downloadAssetToFile(asset: Record<string, unknown>, destinationPath: string): Promise<unknown>;
}

export function createCoreSyncAdapter(options: ConstructorParameters<typeof CoreMoodleAdapter>[0]): CoreSyncAdapter;
export function createMoodliaSyncAdapter(options: ConstructorParameters<typeof MoodliaMoodleAdapter>[0]): MoodliaSyncAdapter;
