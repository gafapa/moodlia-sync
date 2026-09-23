export interface CourseSyncModel {
  schema_version: 2;
  extracted_at: string;
  digest: string;
  site: Record<string, unknown>;
  course: Record<string, unknown> & { source_id: number | null };
  sections: Array<Record<string, unknown>>;
  groups: Array<Record<string, unknown>>;
  groupings: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  exclusions: Array<Record<string, unknown>>;
  losses: Array<Record<string, unknown>>;
  unknowns: Array<Record<string, unknown>>;
  completeness: Record<string, unknown>;
  capability_evidence: Record<string, unknown>;
}

export interface CourseSyncPlan {
  schema_version: 2;
  plan_id: string;
  binding_id: string;
  digest: string;
  semantic_digest: string;
  created_at: string;
  expires_at: string;
  source: Record<string, unknown>;
  target: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  entity_mapping_snapshot: Record<string, Record<string, number>>;
  conflicts: Array<Record<string, unknown>>;
  divergences: Array<Record<string, unknown>>;
  unsupported: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
  unchanged: Array<Record<string, unknown>>;
  unknown: Array<Record<string, unknown>>;
  applicable: boolean;
}

export function canonicalize<T>(value: T): T;
export function canonicalJson(value: unknown): string;
export function rewriteMoodleHtmlReferences(html: string, context: Record<string, unknown>): {
  html: string;
  reference_source_keys: string[];
  blocked: Array<{ url: string; reason: string }>;
};
export function resolveDeferredMoodleReferences(html: string, context: Record<string, unknown>): string;
export function contentDigest(value: unknown): string;
export function createCourseSyncModel(input: Record<string, unknown>): CourseSyncModel;
export function selectedCourseFields(model: CourseSyncModel): Record<string, unknown>;
export function createCourseSyncPlan(input: Record<string, unknown>): CourseSyncPlan;
export function courseBindingId(source: CourseSyncModel, target: CourseSyncModel): string;
export function validateSyncPlan(plan: CourseSyncPlan): CourseSyncPlan;

export class MemorySyncStateStore {
  savePlan(plan: CourseSyncPlan): void;
  getPlan(id: string): CourseSyncPlan | null;
  saveJob(job: Record<string, unknown>): void;
  getJob(id: string): Record<string, unknown> | null;
  listJobs(): Array<Record<string, unknown>>;
  saveBinding(binding: Record<string, unknown>): void;
  getBinding(id: string): Record<string, unknown> | null;
  saveApproval(approval: Record<string, unknown>): void;
  getApproval(planId: string): Record<string, unknown> | null;
  consumeApprovalAndSaveJob(planId: string, digest: string, job: Record<string, unknown>, now?: string): boolean;
  acquireLease(bindingId: string, owner: string, expiresAt: string, now?: string): boolean;
  releaseLease(bindingId: string, owner: string): void;
  close(): void;
}

export function openSqliteDatabase(databasePath: string, DatabaseImplementation?: new (path: string) => unknown): unknown;

export class SqliteSyncStateStore {
  constructor(databasePath: string, options?: { DatabaseImplementation?: new (path: string) => unknown });
  savePlan(plan: CourseSyncPlan): void;
  getPlan(id: string): CourseSyncPlan | null;
  saveJob(job: Record<string, unknown>): void;
  getJob(id: string): Record<string, unknown> | null;
  listJobs(): Array<Record<string, unknown>>;
  saveBinding(binding: Record<string, unknown>): void;
  getBinding(id: string): Record<string, unknown> | null;
  saveApproval(approval: Record<string, unknown>): void;
  getApproval(planId: string): Record<string, unknown> | null;
  consumeApprovalAndSaveJob(planId: string, digest: string, job: Record<string, unknown>, now?: string): boolean;
  acquireLease(bindingId: string, owner: string, expiresAt: string, now?: string): boolean;
  releaseLease(bindingId: string, owner: string): void;
  close(): void;
}

export class CourseSyncEngine {
  constructor(options: { stateStore: MemorySyncStateStore | SqliteSyncStateStore });
  plan(input: Record<string, unknown>): Promise<CourseSyncPlan>;
  apply(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  verify(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createCourseSyncEngine(options: ConstructorParameters<typeof CourseSyncEngine>[0]): CourseSyncEngine;
