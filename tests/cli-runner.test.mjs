import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArguments, runMoodliaSyncCli } from '../cli/runner.mjs';

test('CLI runner documents every workflow in-process without opening state or contacting Moodle', async () => {
  const output = [];
  const originalLog = console.log;
  console.log = (...values) => output.push(values.join(' '));
  try {
    await runMoodliaSyncCli([]);
    assert.ok(output.some((line) => line.includes('Every write needs a saved plan')));
    for (const command of ['capabilities', 'plan', 'approve', 'apply', 'status', 'history', 'cancel', 'resume', 'verify', 'conflicts']) {
      output.length = 0;
      await runMoodliaSyncCli([command, '--help']);
      assert.match(output.join('\n'), new RegExp(`Usage: moodlia-sync ${command}`));
    }
  } finally {
    console.log = originalLog;
  }
});

test('CLI runner rejects unknown commands and missing plans before accessing state', async () => {
  assert.deepEqual(parseArguments(['apply', 'plan.json', '--allow-write', '--plan-digest=abc']), {
    positional: ['apply', 'plan.json'], options: { allow_write: true, plan_digest: 'abc' }
  });
  await assert.rejects(runMoodliaSyncCli(['unknown']), { code: 'invalid_parameters' });
  for (const command of ['approve', 'apply', 'conflicts']) {
    await assert.rejects(runMoodliaSyncCli([command]), { code: 'invalid_parameters' });
  }
});
