import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [runId, scenario, jobId] = process.argv.slice(2);
if (!runId || !scenario || !jobId) throw new TypeError('runId, scenario, and jobId are required.');

const root = '/qualification';
const runner = path.join(root, 'runner');
const results = path.join(root, 'results');
const fixtureNames = ['m45core', 'm45plugin', 'm53core', 'm53plugin'];
const fixtures = Object.fromEntries(fixtureNames.map((name) => [
  name,
  JSON.parse(fs.readFileSync(path.join(results, `${name}.json`), 'utf8'))
]));
const tokenEnvironment = {
  Q_M45_CORE_TOKEN: fixtures.m45core.token,
  Q_M45_PLUGIN_TOKEN: fixtures.m45plugin.token,
  Q_M53_CORE_TOKEN: fixtures.m53core.token,
  Q_M53_PLUGIN_TOKEN: fixtures.m53plugin.token
};
const plan = JSON.parse(fs.readFileSync(
  path.join(results, `${runId}-${scenario}-plan.json`),
  'utf8'
));
const result = spawnSync(process.execPath, [
  path.join(runner, 'node_modules', 'moodlia-sync', 'cli', 'moodlia-sync.mjs'),
  'resume', '--job-id', jobId,
  '--allow-write', '--approve', '--yes',
  '--plan-digest', plan.digest,
  '--config', path.join(runner, 'profiles.json'),
  '--state', path.join(results, `${runId}-state.sqlite`)
], {
  cwd: runner,
  env: { ...process.env, ...tokenEnvironment },
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024
});
if (result.status !== 0) {
  const redacted = Object.values(tokenEnvironment)
    .reduce((text, token) => text.replaceAll(token, '[redacted]'), result.stderr ?? '');
  throw new Error(`Resume exited ${result.status}: ${redacted}`);
}
const payload = JSON.parse(result.stdout);
fs.writeFileSync(
  path.join(results, `${runId}-${scenario}-apply.json`),
  `${JSON.stringify(payload, null, 2)}\n`,
  { mode: 0o600 }
);
console.log(JSON.stringify({ job_id: payload.job_id, status: payload.status }));
