import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  contentDigest,
  createCourseSyncEngine,
  createCourseSyncModel,
  MemorySyncStateStore
} from '../sync/index.mjs';

function model({ courseId, fullname, siteUrl }) {
  return createCourseSyncModel({
    site: { provider: 'core', site_url: siteUrl, moodle_version: '5.3' },
    course: { id: courseId, fullname, shortname: 'COURSE', visible: true }
  });
}

function sourceModel(fullname = 'New name') {
  return model({ courseId: 7, fullname, siteUrl: 'https://source.example' });
}

function targetModel(fullname = 'Old name') {
  return model({ courseId: 8, fullname, siteUrl: 'https://target.example' });
}

// A one-action plan (course.update) against a target that converges when written.
async function setup({ store = new MemorySyncStateStore(), apply } = {}) {
  const source = sourceModel();
  const state = { target: targetModel(), writes: 0 };
  const sourceAdapter = {
    async exportCourse() { return source; },
    async downloadAsset(asset) { return Buffer.from(asset.content); }
  };
  const targetAdapter = {
    async exportCourse() { return state.target; },
    async syncCapabilities() { return { course_update: true }; },
    async applySyncAction(action) {
      state.writes += 1;
      if (apply) return apply(action, state);
      state.target = targetModel(action.fields.fullname);
      return { updated: true };
    }
  };
  const engine = createCourseSyncEngine({ stateStore: store });
  const plan = await engine.plan({ sourceAdapter, targetAdapter, sourceCourseId: 7, targetCourseId: 8 });
  return { engine, store, plan, source, state, sourceAdapter, targetAdapter };
}

// Stores a modified copy of a plan under a valid digest, as the planner would have signed it.
function resign(store, plan, change) {
  const changed = structuredClone(plan);
  change(changed);
  delete changed.digest;
  const signed = { ...changed, digest: contentDigest(changed) };
  store.savePlan(signed);
  return signed;
}

test('apply refuses unknown plans, digest mismatches, and resume jobs of another plan', async () => {
  const { engine, plan, sourceAdapter, targetAdapter, store } = await setup();
  await assert.rejects(engine.apply({ planId: 'missing', planDigest: 'x', sourceAdapter, targetAdapter }), /Unknown sync plan/);
  await assert.rejects(
    engine.apply({ planId: plan.plan_id, planDigest: 'other', sourceAdapter, targetAdapter }),
    /approved plan digest does not match/
  );
  store.saveJob({ schema_version: 1, job_id: 'foreign', plan_id: 'other-plan', status: 'failed', results: [] });
  await assert.rejects(
    engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter, resumeJobId: 'foreign' }),
    /does not belong to this plan/
  );
  const blocked = resign(store, plan, (changed) => { changed.applicable = false; });
  await assert.rejects(
    engine.apply({ planId: blocked.plan_id, planDigest: blocked.digest, sourceAdapter, targetAdapter }),
    /blocking conflicts or unsupported changes/
  );
});

test('apply refuses to start while another job holds the target lease', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
  assert.ok(store.acquireLease(plan.binding_id, 'someone-else', new Date(Date.now() + 60_000).toISOString()));
  await assert.rejects(
    engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter }),
    /Another synchronization job holds the target course lease/
  );
  assert.equal(state.writes, 0);
});

test('apply rechecks contextual capabilities and stops before writing when permission or route changed', async () => {
  for (const live of [false, { available: true, provider: 'core' }, { available: true, text_formats: ['html'] }]) {
    const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
    const contexts = [];
    targetAdapter.syncCapabilities = async (context) => { contexts.push(context); return { course_update: live }; };
    await assert.rejects(engine.apply({
      planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter, jobId: 'preflight'
    }), (error) => error.code === 'capability_gap' && error.details.capabilities[0] === 'course_update');
    assert.deepEqual(contexts, [{ courseId: 8 }]);
    assert.equal(state.writes, 0);
    assert.equal(store.getJob('preflight').status, 'failed');
    assert.equal(store.getJob('preflight').results.length, 0);
    assert.ok(store.acquireLease(plan.binding_id, 'next', new Date(Date.now() + 60_000).toISOString()));
  }
});

test('unrelated capability changes do not invalidate the approved action', async () => {
  const { engine, plan, sourceAdapter, targetAdapter, state } = await setup();
  targetAdapter.syncCapabilities = async () => ({ course_update: true, unrelated: false });
  const job = await engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter });
  assert.equal(job.status, 'succeeded');
  assert.equal(state.writes, 1);
});

test('resume checks only pending capabilities and does not replay completed work', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
  const twoActions = resign(store, plan, (changed) => {
    changed.capability_snapshot.group_create = true;
    changed.actions.push({ action_id: 'pending-group', kind: 'group.create', fields: { name: 'Team' }, depends_on: [] });
  });
  // The completed update is verified against the original target site's identity.
  state.target = targetModel('New name');
  store.saveJob({ schema_version: 1, job_id: 'resume-cap', plan_id: twoActions.plan_id,
    status: 'partially_applied', created_at: new Date().toISOString(), results: [{
      action_id: twoActions.actions[0].action_id, status: 'succeeded', result: { updated: true }
    }] });
  targetAdapter.syncCapabilities = async () => ({ course_update: false, group_create: false });
  await assert.rejects(engine.apply({ planId: twoActions.plan_id, planDigest: twoActions.digest,
    sourceAdapter, targetAdapter, resumeJobId: 'resume-cap'
  }), (error) => error.code === 'capability_gap' && !error.details.capabilities.includes('course_update'));
  assert.equal(state.writes, 0);
  assert.equal(store.getJob('resume-cap').results.length, 1);
});

test('new-course execution switches capability context from category to the returned course', async () => {
  const source = createCourseSyncModel({ site: { provider: 'core', site_url: 'https://source.example' },
    course: { id: 7, fullname: 'Course', shortname: 'SOURCE', visible: false },
    groups: [{ id: 1, name: 'Team' }] });
  const prospective = createCourseSyncModel({ site: { provider: 'core', site_url: 'https://target.example' },
    course: { id: null, fullname: '', shortname: '', visible: false, category_id: 4 },
    targetCreation: { category_id: 4, shortname: 'TARGET' } });
  let target = null;
  const contexts = [];
  const writes = [];
  const sourceAdapter = { exportCourse: async () => source };
  const targetAdapter = {
    prepareTargetCourse: async () => prospective,
    exportCourse: async () => target,
    async syncCapabilities(context) {
      contexts.push(context);
      return { course_create: true, group_create: context.categoryId === 4 };
    },
    async applySyncAction(action) {
      writes.push(action.kind);
      target = createCourseSyncModel({ site: prospective.site,
        course: { id: 80, ...action.fields } });
      return { course_id: 80 };
    }
  };
  const store = new MemorySyncStateStore();
  const engine = createCourseSyncEngine({ stateStore: store });
  const plan = await engine.plan({ sourceAdapter, targetAdapter, sourceCourseId: 7,
    targetCreation: { category_id: 4, shortname: 'TARGET' } });
  assert.deepEqual(plan.actions.map((action) => action.kind), ['course.create', 'group.create']);
  await assert.rejects(engine.apply({ planId: plan.plan_id, planDigest: plan.digest,
    sourceAdapter, targetAdapter, jobId: 'new-course-context'
  }), (error) => error.code === 'capability_gap');
  assert.deepEqual(contexts, [{ categoryId: 4 }, { categoryId: 4 }, { courseId: 80 }]);
  assert.deepEqual(writes, ['course.create']);
  assert.equal(store.getJob('new-course-context').status, 'partially_applied');
  assert.equal(store.getBinding(plan.binding_id).entity_mappings.courses['course:7'], 80);
});

test('a queued job cancelled before it starts is closed without writing', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
  store.saveJob({
    schema_version: 1, job_id: 'queued', plan_id: plan.plan_id, status: 'cancel_requested',
    created_at: new Date().toISOString(), results: []
  });
  const job = await engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter, jobId: 'queued' });
  assert.equal(job.status, 'cancelled');
  assert.equal(state.writes, 0);
  assert.ok(store.acquireLease(plan.binding_id, 'next', new Date(Date.now() + 60_000).toISOString()), 'lease released');
});

test('a cancellation requested while running stops before the next action', async () => {
  class CancellingStore extends MemorySyncStateStore {
    getJob(jobId) {
      const job = super.getJob(jobId);
      return this.cancel && job ? { ...job, status: 'cancel_requested' } : job;
    }
  }
  const store = new CancellingStore();
  const { engine, plan, sourceAdapter, targetAdapter, state } = await setup({ store });
  const twoActions = resign(store, plan, (changed) => {
    const second = { ...structuredClone(changed.actions[0]), action_id: 'second', depends_on: [] };
    delete second.expected_target_digest;
    changed.actions.push(second);
  });
  const original = targetAdapter.applySyncAction;
  targetAdapter.applySyncAction = async (action) => {
    const result = await original(action);
    store.cancel = true;
    return result;
  };
  const job = await engine.apply({ planId: twoActions.plan_id, planDigest: twoActions.digest, sourceAdapter, targetAdapter });
  assert.equal(job.status, 'cancelled');
  assert.equal(state.writes, 1);
});

test('an action whose dependencies have not completed is reported, not executed', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
  const dependent = resign(store, plan, (changed) => { changed.actions[0].depends_on = ['never-ran']; });
  await assert.rejects(
    engine.apply({ planId: dependent.plan_id, planDigest: dependent.digest, sourceAdapter, targetAdapter, jobId: 'deps' }),
    (error) => error.code === 'action_dependency_unmet' && error.dependencies[0] === 'never-ran'
  );
  assert.equal(state.writes, 0);
  assert.equal(store.getJob('deps'), null, 'invalid graphs fail before execution starts');
});

test('an interrupted write intent is reconciled instead of replayed', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
  state.target = targetModel('New name');
  store.saveJob({ schema_version: 1, job_id: 'crashed', plan_id: plan.plan_id,
    status: 'interrupted', results: [{ action_id: plan.actions[0].action_id, status: 'started' }] });
  const job = await engine.apply({ planId: plan.plan_id, planDigest: plan.digest,
    sourceAdapter, targetAdapter, resumeJobId: 'crashed' });
  assert.equal(state.writes, 0);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.results[0].status, 'succeeded');
  assert.equal(job.results[0].reconciliation_reason, 'process_interrupted_after_write_intent');
});

test('interrupted draft uploads cannot be inferred successful from a course read', async () => {
  for (const status of ['started', 'unknown_outcome']) {
    const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
    const draftPlan = resign(store, plan, (changed) => {
      changed.capability_snapshot = { module_asset_stage: true };
      changed.actions = [{ action_id: 'upload', kind: 'module_asset.stage', assets: [], depends_on: [] }];
    });
    store.saveJob({ schema_version: 1, job_id: 'draft-crash', plan_id: draftPlan.plan_id,
      status: 'interrupted', results: [{ action_id: 'upload', status }] });
    await assert.rejects(engine.apply({ planId: draftPlan.plan_id, planDigest: draftPlan.digest,
      sourceAdapter, targetAdapter, resumeJobId: 'draft-crash'
    }), (error) => error.code === 'unknown_outcome' && error.details.reason === 'draft_identity_unproven');
    assert.equal(state.writes, 0);
    assert.equal(store.getJob('draft-crash').results[0].status, 'unknown_outcome');
  }
});

test('lease renewal failure stops before a further action can write', async () => {
  class ExpiringStore extends MemorySyncStateStore {
    acquireLease(...args) {
      this.renewals = (this.renewals ?? 0) + 1;
      return this.renewals <= 2 ? super.acquireLease(...args) : false;
    }
  }
  const store = new ExpiringStore();
  const { engine, plan, sourceAdapter, targetAdapter, state } = await setup({ store });
  const twoActions = resign(store, plan, (changed) => {
    const second = { ...structuredClone(changed.actions[0]), action_id: 'second', depends_on: [] };
    delete second.expected_target_digest;
    changed.actions.push(second);
  });
  await assert.rejects(engine.apply({ planId: twoActions.plan_id, planDigest: twoActions.digest,
    sourceAdapter, targetAdapter, jobId: 'lost-lease' }), (error) => error.details?.reason === 'lease_lost');
  assert.equal(state.writes, 1);
  assert.equal(store.getJob('lost-lease').status, 'partially_applied');
  assert.equal(store.getJob('lost-lease').results.length, 1);
});

test('interrupted publication resolves its created parent from the full action journal', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
  const publication = resign(store, plan, (changed) => {
    changed.capability_snapshot = { module_create: true, page_content_update: true };
    changed.actions = [
      { action_id: 'create', kind: 'module.create', source_key: 'module:20', entity_namespace: 'modules', target_id: null,
        fields: { module_type: 'page', name: 'Page', settings: { content: 'Text', content_format: 4 } }, depends_on: [] },
      { action_id: 'publish', kind: 'page_content.update', parent_source_key: 'module:20', target_id: null,
        fields: { content: 'Text', content_format: 4 }, depends_on: ['create'] }
    ];
  });
  state.target = createCourseSyncModel({ site: plan.target.site,
    course: { id: 8, fullname: 'Old name', shortname: 'COURSE', visible: true },
    sections: [{ id: 10, section: 0, modules: [{ id: 80, modname: 'page', name: 'Page', authoring_completeness: 'complete',
      authoring: { kind: 'page', settings: { content: 'Text', content_format: 4 }, files: [] } }] }] });
  store.saveJob({ schema_version: 1, job_id: 'publication-crash', plan_id: publication.plan_id,
    status: 'interrupted', results: [
      { action_id: 'create', status: 'succeeded', result: { module_id: 80 } },
      { action_id: 'publish', status: 'started' }
    ] });
  const job = await engine.apply({ planId: publication.plan_id, planDigest: publication.digest,
    sourceAdapter, targetAdapter, resumeJobId: 'publication-crash' });
  assert.equal(job.status, 'succeeded');
  assert.equal(state.writes, 0);
  assert.equal(job.results[1].status, 'succeeded');
});

test('a target entity edited after the freshness check fails its precondition', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter, state } = await setup();
  let exports = 0;
  targetAdapter.exportCourse = async () => {
    exports += 1;
    return exports === 1 ? state.target : targetModel('Edited meanwhile');
  };
  await assert.rejects(
    engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter, jobId: 'pre' }),
    (error) => error.code === 'entity_precondition_failed'
  );
  assert.equal(state.writes, 0);
  assert.equal(store.getJob('pre').error.code, 'entity_precondition_failed');
});

test('resume refuses to replay an ambiguous write that did not converge', async () => {
  const { engine, plan, store, sourceAdapter, targetAdapter } = await setup({
    apply() {
      const error = new Error('socket hang up');
      error.code = 'transport_error';
      throw error;
    }
  });
  await assert.rejects(
    engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter, jobId: 'ambiguous' }),
    /socket hang up/
  );
  assert.equal(store.getJob('ambiguous').status, 'unknown_outcome');
  await assert.rejects(
    engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter, resumeJobId: 'ambiguous' }),
    /ambiguous outcome and requires reconciliation/
  );
});

test('resource replacements and Book asset transfers download verified source files', async () => {
  const content = 'resource bytes';
  const sha256 = createHash('sha256').update(content).digest('hex');
  const asset = { filename: 'notes.pdf', filepath: '/', filesize: content.length, sha256, content };
  const calls = [];
  const { engine, plan, store, sourceAdapter, targetAdapter } = await setup();
  targetAdapter.replaceResourceAsset = async (action, material) => {
    calls.push(['resource', material.data.toString()]);
    return { replaced: true };
  };
  targetAdapter.publishBookChapterAssets = async (action, materials) => {
    calls.push(['book', materials.map((material) => material.asset.filename)]);
    return { files: [{ filename: 'notes.pdf', filepath: '/', filesize: content.length }] };
  };
  targetAdapter.syncCapabilities = async () => ({ resource_asset_replace: true, book_asset_transfer: true });
  const withAssets = resign(store, plan, (changed) => {
    changed.capability_snapshot = { resource_asset_replace: true, book_asset_transfer: true };
    changed.actions = [
      { action_id: 'resource', kind: 'resource_asset.replace', target_id: 5, asset, fields: {}, depends_on: [] },
      { action_id: 'book', kind: 'book_asset.transfer', assets: [asset], fields: {}, depends_on: [] }
    ];
  });
  const job = await engine.apply({
    planId: withAssets.plan_id, planDigest: withAssets.digest, sourceAdapter, targetAdapter, jobId: 'assets'
  }).catch((error) => error);
  assert.deepEqual(calls, [['resource', content], ['book', ['notes.pdf']]]);
  // The fake target never shows the resource, so readback verification rejects only that action.
  assert.equal(job.code, 'verification_failed');
  assert.deepEqual(job.failures.map((failure) => failure.action_id), ['resource']);
});

test('verify reports the latest job against the bound target course', async () => {
  const { engine, plan, sourceAdapter, targetAdapter } = await setup();
  await assert.rejects(engine.verify({ planId: 'missing', targetAdapter }), /Unknown sync plan/);
  await assert.rejects(engine.verify({ planId: plan.plan_id, targetAdapter }), /No synchronization job exists/);
  const job = await engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter });
  const report = await engine.verify({ planId: plan.plan_id, targetAdapter, jobId: job.job_id });
  assert.equal(report.verified, true);
  assert.equal(report.target_course_id, 8);
});
