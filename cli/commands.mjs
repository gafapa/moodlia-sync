import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  booleanOption,
  positiveIntegerOption,
  readJsonFile,
  requiredOption,
  writeNewJsonFile
} from 'moodlia/core/cli-options';
import { describeProfile, loadProfiles, resolveProfile } from 'moodlia/core/profiles';
import { MoodleClientError } from 'moodlia/core/transport';
import { createSyncSiteAdapter } from '../adaptive/index.mjs';
import {
  createCourseSyncEngine,
  SqliteSyncStateStore,
  validateSyncPlan
} from '../sync/index.mjs';

export const DEFAULT_CONFIG = '.moodle-profiles.json';
export const DEFAULT_STATE = path.join('.moodle-sync', 'state.sqlite');
const RESUMABLE_STATUSES = ['failed', 'partially_applied', 'verification_failed', 'unknown_outcome', 'cancelled', 'interrupted'];

const cliErrors = Object.freeze({
  validation: (message, details = {}, cause = null) => new MoodleClientError('invalid_parameters', message, details, cause)
});

const required = (options, name) => requiredOption(options, name, cliErrors);
const positiveInteger = (options, name) => positiveIntegerOption(options, name, { errors: cliErrors });
const flag = (options, name) => booleanOption(options, name, cliErrors);

let defaultContract = null;
export function moodliaContract() {
  defaultContract ??= createRequire(import.meta.url)('moodlia/contract');
  return defaultContract;
}

function resolvedProfile(options, name) {
  return resolveProfile(loadProfiles(options.config ?? DEFAULT_CONFIG), name);
}

function siteAdapter(options, profileName, { allowWrite = false } = {}) {
  return createSyncSiteAdapter({
    profile: resolvedProfile(options, profileName),
    moodliaContract: options.contract ?? moodliaContract(),
    allowWrite
  });
}

export function openStateStore(options) {
  const statePath = path.resolve(options.state ?? DEFAULT_STATE);
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  return new SqliteSyncStateStore(statePath);
}

function readPlan(planPath) {
  const plan = readJsonFile(planPath, 'sync plan', cliErrors);
  try {
    return validateSyncPlan(plan);
  } catch (error) {
    throw new MoodleClientError('invalid_plan', error.message, { plan_path: path.resolve(String(planPath)) }, error);
  }
}

function readMapping(mappingPath) {
  if (mappingPath === undefined) return {};
  const mapping = readJsonFile(mappingPath, '--mapping', cliErrors);
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new MoodleClientError('invalid_parameters', '--mapping must contain a JSON object.');
  }
  return mapping;
}

function planProfiles(plan) {
  const source = String(plan.source?.site?.profile ?? '');
  const target = String(plan.target?.site?.profile ?? '');
  if (!source || !target) {
    throw new MoodleClientError('invalid_plan', 'The plan does not identify both site profiles.');
  }
  return { source, target };
}

function savePlanFile(plan, requestedPath) {
  const planPath = requestedPath === undefined || requestedPath === true
    ? path.join('.moodle-sync', 'plans', `${plan.plan_id}.json`)
    : String(requestedPath);
  return writeNewJsonFile(planPath, plan);
}

function approvalRecord(plan) {
  return {
    schema_version: 1,
    plan_id: plan.plan_id,
    digest: plan.digest,
    approved_at: new Date().toISOString(),
    expires_at: plan.expires_at,
    consumed_at: null
  };
}

function assertDigest(plan, options) {
  const digest = required(options, 'plan_digest');
  if (digest !== plan.digest) {
    throw new MoodleClientError('invalid_plan', '--plan-digest does not match the saved plan.', { plan_id: plan.plan_id });
  }
  return digest;
}

/**
 * Consumes the plan's approval and records the job in one transaction, so an
 * approval authorizes exactly one apply or resume.
 */
function claimApproval(store, plan, digest, job, options) {
  if (flag(options, 'approve')) {
    if (!flag(options, 'yes')) {
      throw new MoodleClientError('permission_denied', '--approve requires --yes.');
    }
    store.saveApproval(approvalRecord(plan));
  }
  if (!store.consumeApprovalAndSaveJob(plan.plan_id, digest, job)) {
    throw new MoodleClientError(
      'permission_denied',
      'This exact plan has no unconsumed approval, or it has expired. Run "moodlia-sync approve <plan> --yes" first, or pass --approve --yes.',
      { plan_id: plan.plan_id }
    );
  }
  return job;
}

function newJob(planId) {
  const now = new Date().toISOString();
  return { schema_version: 1, job_id: randomUUID(), plan_id: planId, status: 'queued', created_at: now, updated_at: now, results: [] };
}

async function withStore(options, callback) {
  const store = openStateStore(options);
  try {
    return await callback(store, createCourseSyncEngine({ stateStore: store }));
  } finally {
    store.close();
  }
}

export async function runCapabilities(options) {
  const profileName = required(options, 'profile');
  const adapter = siteAdapter(options, profileName);
  const discovery = await adapter.discoverSite();
  const capabilities = await adapter.syncCapabilities({
    courseId: options.course_id === undefined ? undefined : positiveInteger(options, 'course_id')
  });
  return { profile: describeProfile(resolvedProfile(options, profileName)), discovery, capabilities };
}

export async function runPlan(options) {
  const sourceName = required(options, 'source_profile');
  const targetName = required(options, 'target_profile');
  const hasTargetCourse = options.target_course_id !== undefined;
  const createsTarget = options.create_target_category_id !== undefined;
  if (hasTargetCourse === createsTarget) {
    throw new MoodleClientError('invalid_parameters', 'Provide exactly one of --target-course-id or --create-target-category-id.');
  }
  return withStore(options, async (store, engine) => {
    const plan = await engine.plan({
      sourceAdapter: siteAdapter(options, sourceName),
      targetAdapter: siteAdapter(options, targetName),
      sourceCourseId: positiveInteger(options, 'source_course_id'),
      targetCourseId: hasTargetCourse ? positiveInteger(options, 'target_course_id') : null,
      targetCreation: createsTarget ? {
        category_id: positiveInteger(options, 'create_target_category_id'),
        shortname: required(options, 'target_shortname')
      } : null,
      mapping: readMapping(options.mapping),
      policies: {
        unsupported: options.unsupported_policy ?? 'error',
        conflict: options.conflict_policy ?? 'abort'
      }
    });
    return { ...plan, plan_path: savePlanFile(plan, options.plan_file) };
  });
}

export async function runApprove(options, planPath) {
  if (!flag(options, 'yes')) {
    throw new MoodleClientError('permission_denied', 'Approving a sync plan requires --yes.');
  }
  const plan = readPlan(planPath);
  if (Date.parse(plan.expires_at) <= Date.now()) {
    throw new MoodleClientError('invalid_plan', 'The plan has expired; create a new plan.', { plan_id: plan.plan_id });
  }
  return withStore(options, (store) => {
    store.savePlan(plan);
    const approval = approvalRecord(plan);
    store.saveApproval(approval);
    return approval;
  });
}

export async function runApply(options, planPath) {
  if (!flag(options, 'allow_write')) {
    throw new MoodleClientError('permission_denied', 'Applying a sync plan requires --allow-write.');
  }
  const plan = readPlan(planPath);
  const digest = assertDigest(plan, options);
  const profiles = planProfiles(plan);
  return withStore(options, async (store, engine) => {
    store.savePlan(plan);
    const job = claimApproval(store, plan, digest, newJob(plan.plan_id), options);
    return engine.apply({
      planId: plan.plan_id,
      planDigest: digest,
      sourceAdapter: siteAdapter(options, profiles.source),
      targetAdapter: siteAdapter(options, profiles.target, { allowWrite: true }),
      jobId: job.job_id
    });
  });
}

export async function runResume(options) {
  if (!flag(options, 'allow_write')) {
    throw new MoodleClientError('permission_denied', 'Resuming a job requires --allow-write.');
  }
  const jobId = required(options, 'job_id');
  return withStore(options, async (store, engine) => {
    const job = store.getJob(jobId);
    if (!job) throw new MoodleClientError('not_found', `Unknown sync job: ${jobId}.`);
    if (!RESUMABLE_STATUSES.includes(job.status)) {
      throw new MoodleClientError('invalid_state', `Job ${jobId} cannot be resumed from status ${job.status}.`);
    }
    const plan = store.getPlan(job.plan_id);
    if (!plan) throw new MoodleClientError('not_found', `Unknown sync plan: ${job.plan_id}.`);
    const digest = assertDigest(plan, options);
    const profiles = planProfiles(plan);
    claimApproval(store, plan, digest, { ...job, status: 'queued', updated_at: new Date().toISOString() }, options);
    return engine.apply({
      planId: plan.plan_id,
      planDigest: digest,
      resumeJobId: job.job_id,
      sourceAdapter: siteAdapter(options, profiles.source),
      targetAdapter: siteAdapter(options, profiles.target, { allowWrite: true })
    });
  });
}

export async function runVerify(options) {
  const planId = required(options, 'plan_id');
  return withStore(options, async (store, engine) => {
    const plan = store.getPlan(planId);
    if (!plan) throw new MoodleClientError('not_found', `Unknown sync plan: ${planId}.`);
    return engine.verify({
      planId,
      targetAdapter: siteAdapter(options, planProfiles(plan).target),
      jobId: options.job_id
    });
  });
}

export async function runStatus(options) {
  const jobId = required(options, 'job_id');
  return withStore(options, (store) => {
    const job = store.getJob(jobId);
    if (!job) throw new MoodleClientError('not_found', `Unknown sync job: ${jobId}.`);
    return job;
  });
}

export async function runHistory(options) {
  return withStore(options, (store) => ({ jobs: store.listJobs() }));
}

export async function runCancel(options) {
  const jobId = required(options, 'job_id');
  return withStore(options, (store) => {
    const job = store.getJob(jobId);
    if (!job) throw new MoodleClientError('not_found', `Unknown sync job: ${jobId}.`);
    if (!['queued', 'running'].includes(job.status)) {
      throw new MoodleClientError('invalid_state', `Job ${jobId} cannot be cancelled from status ${job.status}.`);
    }
    const cancelled = { ...job, status: 'cancel_requested', updated_at: new Date().toISOString() };
    store.saveJob(cancelled);
    return cancelled;
  });
}

export async function runConflicts(options, planPath) {
  const plan = readPlan(planPath);
  if (options.resolve === undefined) {
    return { plan_id: plan.plan_id, conflicts: plan.conflicts ?? [], divergences: plan.divergences ?? [] };
  }
  const resolution = String(options.resolve);
  if (!['source-wins', 'target-wins'].includes(resolution)) {
    throw new MoodleClientError('invalid_parameters', '--resolve must be source-wins or target-wins.');
  }
  const profiles = planProfiles(plan);
  return withStore(options, async (store, engine) => {
    const binding = store.getBinding(plan.binding_id);
    const targetCourseId = binding?.target?.course_id ?? plan.target.course_id;
    const replanned = await engine.plan({
      sourceAdapter: siteAdapter(options, profiles.source),
      targetAdapter: siteAdapter(options, profiles.target),
      sourceCourseId: plan.source.course_id,
      targetCourseId,
      targetCreation: targetCourseId ? null : plan.target.creation,
      mapping: plan.entity_mapping_snapshot ?? {},
      policies: { unsupported: plan.policies.unsupported, conflict: resolution }
    });
    return { ...replanned, plan_path: savePlanFile(replanned, options.plan_file) };
  });
}
