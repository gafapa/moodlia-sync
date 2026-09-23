import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  openStateStore,
  runApply,
  runApprove,
  runCancel,
  runConflicts,
  runHistory,
  runPlan,
  runResume,
  runStatus,
  runVerify
} from '../cli/commands.mjs';
import { startFakeCoreSite } from './helpers/fake-core-site.mjs';

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL('../cli/moodlia-sync.mjs', import.meta.url));

const sourceCourse = {
  id: 10, fullname: 'Source course', shortname: 'SRC', categoryid: 1, idnumber: '',
  summary: '<p>Hola ü</p>', summaryformat: 1, visible: 1, startdate: 0, enddate: 0
};
const targetCourse = {
  id: 20, fullname: 'Old title', shortname: 'DST', categoryid: 1, idnumber: '',
  summary: '', summaryformat: 1, visible: 1, startdate: 0, enddate: 0
};

async function lab() {
  const source = await startFakeCoreSite({
    course: sourceCourse,
    groups: [{ id: 1, courseid: 10, name: 'Team A', description: '', descriptionformat: 1, idnumber: 'A', visibility: 0, participation: true }],
    groupings: [{ id: 2, courseid: 10, name: 'Cohort', description: '', descriptionformat: 1, idnumber: 'C', groups: [1] }]
  });
  const target = await startFakeCoreSite({ course: targetCourse });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moodlia-sync-cli-'));
  process.env.SYNC_TEST_SOURCE_TOKEN = 'source-token';
  process.env.SYNC_TEST_TARGET_TOKEN = 'target-token';
  const config = path.join(directory, 'profiles.json');
  fs.writeFileSync(config, JSON.stringify({
    schema_version: 1,
    profiles: {
      src: { url: source.url, backend: 'core', credentials: { core: { token_env: 'SYNC_TEST_SOURCE_TOKEN' } } },
      dst: { url: target.url, backend: 'core', credentials: { core: { token_env: 'SYNC_TEST_TARGET_TOKEN' } } }
    }
  }));
  const base = { config, state: path.join(directory, 'state.sqlite') };
  const planOptions = {
    ...base,
    source_profile: 'src',
    source_course_id: '10',
    target_profile: 'dst',
    target_course_id: '20'
  };
  return {
    source,
    target,
    directory,
    base,
    planOptions,
    async close() {
      await source.close();
      await target.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('plan, approve, apply, verify, and an idempotent replan between two Core sites', async () => {
  const site = await lab();
  try {
    const planPath = path.join(site.directory, 'plans', 'first.json');
    const plan = await runPlan({ ...site.planOptions, plan_file: planPath });
    assert.deepEqual(plan.actions.map((action) => action.kind), ['course.update', 'group.create', 'grouping.create', 'grouping.member.add']);
    assert.equal(plan.plan_path, planPath);
    assert.equal(JSON.parse(fs.readFileSync(planPath, 'utf8')).digest, plan.digest);
    assert.equal(site.target.state.calls.filter((name) => /create|update|assign/.test(name)).length, 0, 'planning must not write');

    const apply = { ...site.base, plan_digest: plan.digest, allow_write: true };
    await assert.rejects(() => runApply({ ...site.base, plan_digest: plan.digest }, planPath), { code: 'permission_denied' });
    await assert.rejects(() => runApply(apply, planPath), (error) => error.code === 'permission_denied' && /no unconsumed approval/.test(error.message));
    await assert.rejects(() => runApprove(site.base, planPath), { code: 'permission_denied' });
    await assert.rejects(() => runApply({ ...apply, plan_digest: 'sha256:wrong' }, planPath), { code: 'invalid_plan' });

    const approval = await runApprove({ ...site.base, yes: true }, planPath);
    assert.equal(approval.digest, plan.digest);
    assert.equal(approval.consumed_at, null);

    const job = await runApply(apply, planPath);
    assert.equal(job.status, 'succeeded');
    assert.equal(site.target.state.course.fullname, 'Source course');
    assert.deepEqual(site.target.state.groups.map((group) => group.name), ['Team A']);
    assert.deepEqual(site.target.state.groupings[0].groups, [site.target.state.groups[0].id]);

    await assert.rejects(() => runApply(apply, planPath), { code: 'permission_denied' }, 'an approval authorizes one apply');

    const verified = await runVerify({ ...site.base, plan_id: plan.plan_id });
    assert.equal(verified.verified, true, JSON.stringify(verified.failures));
    assert.equal(verified.job_id, job.job_id);

    const status = await runStatus({ ...site.base, job_id: job.job_id });
    assert.equal(status.job_id, job.job_id);
    const history = await runHistory(site.base);
    assert.deepEqual(history.jobs.map((entry) => entry.job_id), [job.job_id]);

    const replan = await runPlan({ ...site.planOptions, plan_file: path.join(site.directory, 'plans', 'second.json') });
    assert.deepEqual(replan.actions, [], 'an applied plan must converge');
  } finally {
    await site.close();
  }
});

test('an approval expires with its plan and --approve --yes approves inline', async () => {
  const site = await lab();
  try {
    const planPath = path.join(site.directory, 'plan.json');
    const plan = await runPlan({ ...site.planOptions, plan_file: planPath });
    await runApprove({ ...site.base, yes: true }, planPath);
    const store = openStateStore(site.base);
    try {
      store.saveApproval({ ...store.getApproval(plan.plan_id), expires_at: '2000-01-01T00:00:00.000Z' });
    } finally {
      store.close();
    }
    const apply = { ...site.base, plan_digest: plan.digest, allow_write: true };
    await assert.rejects(() => runApply(apply, planPath), { code: 'permission_denied' });
    await assert.rejects(() => runApply({ ...apply, approve: true }, planPath), (error) => /--approve requires --yes/.test(error.message));
    const job = await runApply({ ...apply, approve: true, yes: true }, planPath);
    assert.equal(job.status, 'succeeded');
  } finally {
    await site.close();
  }
});

test('resume needs a resumable job and a fresh approval; cancel needs an active job', async () => {
  const site = await lab();
  try {
    const planPath = path.join(site.directory, 'plan.json');
    const plan = await runPlan({ ...site.planOptions, plan_file: planPath });
    await assert.rejects(
      () => runResume({ ...site.base, job_id: 'missing', plan_digest: plan.digest, allow_write: true }),
      { code: 'not_found' }
    );
    const job = await runApply({ ...site.base, plan_digest: plan.digest, allow_write: true, approve: true, yes: true }, planPath);
    await assert.rejects(
      () => runResume({ ...site.base, job_id: job.job_id, plan_digest: plan.digest, allow_write: true }),
      { code: 'invalid_state' }
    );
    await assert.rejects(() => runCancel({ ...site.base, job_id: job.job_id }), { code: 'invalid_state' });

    const store = openStateStore(site.base);
    try {
      store.saveJob({ ...store.getJob(job.job_id), status: 'interrupted' });
    } finally {
      store.close();
    }
    await assert.rejects(
      () => runResume({ ...site.base, job_id: job.job_id, plan_digest: plan.digest, allow_write: true }),
      { code: 'permission_denied' }
    );
    const resumed = await runResume({ ...site.base, job_id: job.job_id, plan_digest: plan.digest, allow_write: true, approve: true, yes: true });
    assert.equal(resumed.job_id, job.job_id);
    assert.equal(resumed.status, 'succeeded');
    assert.equal(site.target.state.groups.length, 1, 'resume reconciles instead of replaying');
  } finally {
    await site.close();
  }
});

test('conflicts lists plan conflicts and replans with a resolution policy', async () => {
  const site = await lab();
  try {
    const planPath = path.join(site.directory, 'plan.json');
    await runPlan({ ...site.planOptions, plan_file: planPath });
    const listed = await runConflicts(site.base, planPath);
    assert.deepEqual(listed.conflicts, []);
    await assert.rejects(() => runConflicts({ ...site.base, resolve: 'mine' }, planPath), { code: 'invalid_parameters' });
    const resolvedPath = path.join(site.directory, 'resolved.json');
    const replanned = await runConflicts({ ...site.base, resolve: 'source-wins', plan_file: resolvedPath }, planPath);
    assert.equal(replanned.policies.conflict, 'source-wins');
    assert.equal(replanned.plan_path, resolvedPath);
  } finally {
    await site.close();
  }
});

test('the executable reports usage, JSON errors, and documented exit codes', async () => {
  const help = await execFileAsync(process.execPath, [cli, '--help']);
  for (const command of ['plan', 'approve', 'apply', 'status', 'history', 'cancel', 'resume', 'verify', 'conflicts', 'capabilities']) {
    assert.match(help.stdout, new RegExp(`\\n  ${command}\\b`));
  }
  const unknown = await execFileAsync(process.execPath, [cli, 'teleport']).catch((error) => error);
  assert.equal(unknown.code, 2);
  assert.equal(JSON.parse(unknown.stderr).code, 'invalid_parameters');
  const missingPlan = await execFileAsync(process.execPath, [cli, 'apply']).catch((error) => error);
  assert.equal(missingPlan.code, 2);
  assert.match(JSON.parse(missingPlan.stderr).message, /Usage: moodlia-sync apply/);
});
