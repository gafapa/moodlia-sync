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
  assert.equal(store.getJob('deps').status, 'failed');
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
  const withAssets = resign(store, plan, (changed) => {
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
