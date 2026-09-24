import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import contract from 'moodlia/contract' with { type: 'json' };
import { createSyncSiteAdapter } from 'moodlia-sync/adaptive';

// qualify-live (moodlia-test-lab) sets QUALIFICATION_ROOT; the S1 compose mounts /qualification.
const root = process.env.QUALIFICATION_ROOT ?? '/qualification';
const runner = path.join(root, 'runner');
const results = path.join(root, 'results');
const profilesPath = path.join(runner, 'profiles.json');
const profileUrls = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(profilesPath, 'utf8')).profiles)
  .map(([name, profile]) => [name, profile.url]));
const runId = String(process.env.QUALIFICATION_RUN_ID ?? '');
assert.match(runId, /^[a-z0-9][a-z0-9-]{0,40}$/, 'QUALIFICATION_RUN_ID is required');
const statePath = path.join(results, `${runId}-state.sqlite`);
const cliPath = path.join(runner, 'node_modules', 'moodlia-sync', 'cli', 'moodlia-sync.mjs');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(results, `${name}.json`), 'utf8'));
}

const fixtures = Object.fromEntries(['m45core', 'm45plugin', 'm53core', 'm53plugin']
  .map((name) => [name, readFixture(name)]));
const tokenEnvironment = {
  Q_M45_CORE_TOKEN: fixtures.m45core.token,
  Q_M45_PLUGIN_TOKEN: fixtures.m45plugin.token,
  Q_M53_CORE_TOKEN: fixtures.m53core.token,
  Q_M53_PLUGIN_TOKEN: fixtures.m53plugin.token
};
const secrets = Object.values(tokenEnvironment);

function redact(value) {
  return secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), String(value));
}

function invoke(name, phase, args, allowedStatuses = [0]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: runner,
    env: { ...process.env, ...tokenEnvironment },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  fs.writeFileSync(path.join(results, `${runId}-${name}-${phase}.stderr.log`), redact(result.stderr ?? ''), {
    mode: 0o600
  });
  if (!allowedStatuses.includes(result.status)) {
    throw new Error(`${name} ${phase} exited ${result.status}: ${redact(result.stderr)}`);
  }
  const output = JSON.parse(result.stdout);
  fs.writeFileSync(path.join(results, `${runId}-${name}-${phase}.json`), `${JSON.stringify(output, null, 2)}\n`, {
    mode: 0o600
  });
  return output;
}

const scenarios = [
  {
    name: 'core-to-core', source: 'm45core', target: 'm53core', targetIndex: 0,
    expectedSkippedPage: false
  },
  {
    name: 'core-to-moodlia', source: 'm45core', target: 'm53plugin', targetIndex: 0,
    expectedSkippedPage: false
  },
  {
    name: 'moodlia-to-core', source: 'm45plugin', target: 'm53core', targetIndex: 1,
    expectedSkippedPage: true
  },
  {
    name: 'moodlia-to-moodlia', source: 'm45plugin', target: 'm53plugin', targetIndex: 1,
    expectedSkippedPage: false
  }
];

const report = {
  schema_version: 1,
  run_id: runId,
  generated_at: new Date().toISOString(),
  node_version: process.version,
  package_versions: {
    moodlia_sync: JSON.parse(fs.readFileSync(path.join(runner, 'node_modules', 'moodlia-sync', 'package.json'))).version,
    moodlia: JSON.parse(fs.readFileSync(path.join(runner, 'node_modules', 'moodlia', 'package.json'))).version,
    moodle_core_cli: JSON.parse(fs.readFileSync(path.join(runner, 'node_modules', 'moodle-core-cli', 'package.json'))).version
  },
  scenarios: []
};

for (const scenario of scenarios) {
  const source = fixtures[scenario.source];
  const target = fixtures[scenario.target];
  const targetCourseId = target.target_course_ids[scenario.targetIndex];
  const planPath = path.join(results, `${runId}-${scenario.name}.plan.json`);
  const repeatPlanPath = path.join(results, `${runId}-${scenario.name}.repeat.plan.json`);
  const common = ['--config', profilesPath, '--state', statePath];
  const readPhase = (phase) => {
    const filePath = path.join(results, `${runId}-${scenario.name}-${phase}.json`);
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
  };
  let plan = readPhase('plan');
  let job = readPhase('apply');
  let verification = readPhase('verify');
  let repeat = readPhase('repeat-plan');
  if (!plan) {
    plan = invoke(scenario.name, 'plan', [
    'plan',
    '--source-profile', scenario.source,
    '--source-course-id', String(source.source_course_id),
    '--target-profile', scenario.target,
    '--target-course-id', String(targetCourseId),
    '--unsupported-policy', 'skip',
    '--plan-file', planPath,
    ...common
    ], [0, 3]);
  }
  assert.equal(plan.applicable, true, `${scenario.name} plan must be applicable`);
  assert.ok(plan.actions.length > 0, `${scenario.name} initial plan must contain work`);
  const skippedPage = [...plan.skipped, ...plan.unsupported]
    .some((entry) => String(entry.kind).includes('page') || entry.module_type === 'page');
  assert.equal(skippedPage, scenario.expectedSkippedPage, `${scenario.name} page gap classification`);
  const forbiddenAction = plan.actions.find((action) => /backup|restore|\.mbz|course\.copy/i.test(action.kind));
  assert.equal(forbiddenAction, undefined, `${scenario.name} must not use backup or copy actions`);

  if (!job) invoke(scenario.name, 'approve', ['approve', planPath, '--yes', ...common]);
  job ??= invoke(scenario.name, 'apply', [
      'apply', planPath,
      '--plan-digest', plan.digest,
      '--allow-write',
      ...common
    ]);
  assert.equal(job.status, 'succeeded', `${scenario.name} apply must succeed`);
  assert.ok(job.verification, `${scenario.name} must record verification evidence`);

  verification ??= invoke(scenario.name, 'verify', [
    'verify', '--plan-id', plan.plan_id,
    '--job-id', job.job_id,
    ...common
  ]);
  assert.ok(verification, `${scenario.name} live verification must return evidence`);

  repeat ??= invoke(scenario.name, 'repeat-plan', [
    'plan',
    '--source-profile', scenario.source,
    '--source-course-id', String(source.source_course_id),
    '--target-profile', scenario.target,
    '--target-course-id', String(targetCourseId),
    '--unsupported-policy', 'skip',
    '--plan-file', repeatPlanPath,
    ...common
  ], [0, 3]);
  assert.equal(repeat.actions.length, 0, `${scenario.name} unchanged rerun must contain no writes`);

  report.scenarios.push({
    name: scenario.name,
    source_release: source.moodle_release,
    target_release: target.moodle_release,
    source_provider: source.provider,
    target_provider: target.provider,
    initial_action_count: plan.actions.length,
    initial_action_kinds: [...new Set(plan.actions.map((action) => action.kind))].sort(),
    skipped_count: plan.skipped.length,
    skipped_kinds: [...new Set(plan.skipped.map((entry) => entry.kind))].sort(),
    apply_status: job.status,
    job_id: job.job_id,
    repeat_action_count: repeat.actions.length,
    verified: true
  });
}

function moodliaProfile(name, url, token) {
  return {
    name,
    url,
    backend: 'moodlia',
    allow_insecure: true,
    credentials: { moodlia: { token } }
  };
}

const sourceAdapter = createSyncSiteAdapter({
  profile: moodliaProfile('m45plugin', profileUrls.m45plugin, fixtures.m45plugin.token),
  moodliaContract: contract
});
const targetAdapter = createSyncSiteAdapter({
  profile: moodliaProfile('m53plugin', profileUrls.m53plugin, fixtures.m53plugin.token),
  moodliaContract: contract
});
const sourceModel = await sourceAdapter.exportCourse(fixtures.m45plugin.source_course_id);
const targetModel = await targetAdapter.exportCourse(fixtures.m53plugin.target_course_ids[1]);
const sourcePage = sourceModel.sections.flatMap((section) => section.modules)
  .find((module) => module.authoring?.kind === 'page');
const targetPage = targetModel.sections.flatMap((section) => section.modules)
  .find((module) => module.authoring?.kind === 'page');
assert.ok(sourcePage && targetPage, 'Portable Page must exist on both MoodlIA sites');
assert.equal(targetPage.authoring.settings.content, sourcePage.authoring.settings.content);
assert.equal(targetPage.authoring.files.length, 2);
assert.ok(targetPage.authoring.files.some((file) => file.filepath === '/nested/'));
const assetIdentity = (file) => `${file.filepath}${file.filename}:${file.sha256}`;
assert.deepEqual(
  targetPage.authoring.files.map(assetIdentity).sort(),
  sourcePage.authoring.files.map(assetIdentity).sort(),
  'Transferred asset paths, names, and bytes must match'
);
assert.ok(targetPage.authoring.settings.content.includes('@@PLUGINFILE@@/'));
assert.ok(!JSON.stringify(targetPage.authoring).includes(fixtures.m45plugin.token));
report.rich_content = {
  module_name: targetPage.name,
  asset_count: targetPage.authoring.files.length,
  nested_asset_verified: true,
  unicode_asset_verified: targetPage.authoring.files.some((file) => file.filename.includes('ü')),
  byte_hashes_match: true,
  pluginfile_references_preserved: true
};

const reportPath = path.join(results, `${runId}-qualification-report.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  report: reportPath,
  scenarios: report.scenarios.map((scenario) => ({
    name: scenario.name,
    actions: scenario.initial_action_count,
    skipped: scenario.skipped_count,
    apply_status: scenario.apply_status,
    repeat_actions: scenario.repeat_action_count
  })),
  rich_content: report.rich_content
}, null, 2));
