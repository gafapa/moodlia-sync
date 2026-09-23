import { exitCodeForError, exitCodeForResult } from 'moodlia/core/exit-codes';
import { normalizeClientError, MoodleClientError } from 'moodlia/core/transport';
import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  runApply,
  runApprove,
  runCancel,
  runCapabilities,
  runConflicts,
  runHistory,
  runPlan,
  runResume,
  runStatus,
  runVerify
} from './commands.mjs';

const COMMANDS = {
  capabilities: { run: runCapabilities, usage: 'capabilities --profile <name> [--course-id <id>]' },
  plan: { run: runPlan, usage: 'plan --source-profile <name> --source-course-id <id> --target-profile <name> (--target-course-id <id> | --create-target-category-id <id> --target-shortname <name>) [--plan-file <path>]' },
  approve: { run: runApprove, usage: 'approve <plan.json> --yes', planArgument: true },
  apply: { run: runApply, usage: 'apply <plan.json> --plan-digest <sha256> --allow-write [--approve --yes]', planArgument: true },
  status: { run: runStatus, usage: 'status --job-id <id>' },
  history: { run: runHistory, usage: 'history' },
  cancel: { run: runCancel, usage: 'cancel --job-id <id>' },
  resume: { run: runResume, usage: 'resume --job-id <id> --plan-digest <sha256> --allow-write [--approve --yes]' },
  verify: { run: runVerify, usage: 'verify --plan-id <id> [--job-id <id>]' },
  conflicts: { run: runConflicts, usage: 'conflicts <plan.json> [--resolve source-wins|target-wins --plan-file <path>]', planArgument: true }
};

function toSnakeCase(value) {
  return value.replaceAll('-', '_');
}

export function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const raw = argument.slice(2);
    const separator = raw.indexOf('=');
    if (separator !== -1) {
      options[toSnakeCase(raw.slice(0, separator))] = raw.slice(separator + 1);
      continue;
    }
    const key = toSnakeCase(raw);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

export function printHelp(command = null) {
  if (command && COMMANDS[command]) {
    console.log(`Usage: moodlia-sync ${COMMANDS[command].usage}`);
    return;
  }
  console.log('Usage: moodlia-sync <command> [options]');
  console.log('');
  console.log('Synchronizes supported course content between Moodle sites without backups.');
  console.log('Every write needs a saved plan, its exact digest, an approval, and --allow-write.');
  console.log('');
  console.log('Commands:');
  for (const entry of Object.values(COMMANDS)) console.log(`  ${entry.usage}`);
  console.log('');
  console.log('Planning options:');
  console.log('  --mapping <path>            Explicit section/group ID mapping JSON');
  console.log('  --unsupported-policy <mode> error, skip, or degrade');
  console.log('  --conflict-policy <mode>    abort, source-wins, target-wins, or report');
  console.log('');
  console.log('Global options:');
  console.log(`  --config <path>             Profile file (default: ${DEFAULT_CONFIG})`);
  console.log(`  --state <path>              SQLite state file (default: ${DEFAULT_STATE})`);
  console.log('');
  console.log('Exit codes: 0 success, 1 internal, 2 validation, 3 capability gap, 4 conflict,');
  console.log('            5 remote failure, 6 partial execution, 7 verification failure.');
}

export async function runMoodliaSyncCli(argv = process.argv.slice(2)) {
  const { positional, options } = parseArguments(argv);
  const [command, planPath] = positional;
  if (!command || command === 'help' || options.help) {
    printHelp(command === 'help' ? positional[1] : command);
    return;
  }
  const entry = COMMANDS[command];
  if (!entry) {
    throw new MoodleClientError('invalid_parameters', `Unknown command: ${command}.`, { command });
  }
  if (entry.planArgument && !planPath) {
    throw new MoodleClientError('invalid_parameters', `Usage: moodlia-sync ${entry.usage}`, { command });
  }
  const result = await entry.run(options, planPath);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = exitCodeForResult(result);
}

export function reportMoodliaSyncCliError(error) {
  console.error(JSON.stringify(normalizeClientError(error).toJSON()));
  process.exitCode = exitCodeForError(error);
}
