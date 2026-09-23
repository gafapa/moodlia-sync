# moodlia-sync

Synchronize supported course content between Moodle sites without backups.
`moodlia-sync` reads a source course, writes an immutable plan of the changes
a target course needs, and applies that exact plan only after it is approved.
It works with Moodle Core web services and, where installed, the MoodlIA plugin,
choosing a provider per capability.

Status: preview. See [docs/SYNC-CAPABILITY-MATRIX.md](docs/SYNC-CAPABILITY-MATRIX.md)
for what each provider pairing can synchronize, and
[docs/CROSS-VERSION-QUALIFICATION.md](docs/CROSS-VERSION-QUALIFICATION.md) for
the live evidence.

## Install

```sh
npm install -g moodlia-sync
```

Requires Node.js 22.13 or newer. The state store uses the native
`better-sqlite3` driver. If your npm policy blocks install scripts, approve and
build it once:

```sh
npm approve-scripts better-sqlite3
npm rebuild better-sqlite3
```

Without the driver, commands fail with `dependency_unavailable` and print the
same fix.

## Profiles

Sites are described in `.moodle-profiles.json`. Tokens stay in environment
variables and are never written to plans or state:

```json
{
  "schema_version": 1,
  "profiles": {
    "school_a": {
      "url": "https://moodle-a.example.edu",
      "credentials": { "moodlia": { "token_env": "SCHOOL_A_MOODLIA_TOKEN" }, "core": { "token_env": "SCHOOL_A_CORE_TOKEN" } }
    },
    "school_b": {
      "url": "https://moodle-b.example.edu",
      "credentials": { "core": { "token_env": "SCHOOL_B_CORE_TOKEN" } }
    }
  }
}
```

## Workflow

```sh
# 1. Inspect what each site can do.
moodlia-sync capabilities --profile school_b

# 2. Plan (read-only). Writes an immutable plan file and prints its digest.
moodlia-sync plan --source-profile school_a --source-course-id 42 \
  --target-profile school_b --target-course-id 108 --plan-file plan.json

# 3. Review plan.json, then approve that exact plan.
moodlia-sync approve plan.json --yes

# 4. Apply. The approval is consumed atomically; it authorizes one apply.
moodlia-sync apply plan.json --plan-digest <sha256:...> --allow-write

# 5. Verify by live readback, and re-plan: an applied plan converges to no actions.
moodlia-sync verify --plan-id <plan_id>
```

To create a hidden target course instead of updating one, replace
`--target-course-id` with `--create-target-category-id <id> --target-shortname <name>`.
`apply ... --approve --yes` approves and applies in one step.

Other commands: `status --job-id`, `history`, `cancel --job-id`,
`resume --job-id --plan-digest --allow-write` (after a new approval), and
`conflicts plan.json [--resolve source-wins|target-wins --plan-file <path>]`.

Every command prints JSON. Exit codes: 0 success, 1 internal, 2 validation,
3 capability gap, 4 conflict, 5 remote failure, 6 partial execution,
7 verification failure.

## Safety model

- Planning performs reads only.
- Applying requires a saved plan whose digest matches, an unexpired and
  unconsumed approval of that digest, `--allow-write`, unchanged source and
  target course digests, and a destination capability for every field.
- Intent is persisted before each write; timeouts become `unknown_outcome` and
  are reconciled before a resume replays anything.
- Learner submissions, grades awarded, attempts, logs, and completion history
  are never synchronized.

See [docs/SYNC-ARCHITECTURE.md](docs/SYNC-ARCHITECTURE.md) and
[docs/ADR-001-SYNC-FOUNDATION.md](docs/ADR-001-SYNC-FOUNDATION.md).

## Package layout

`moodlia-sync` depends only on `moodlia`, which depends on `moodle-core-cli`.
It extends their discovery adapters with synchronization and is the only
package in the chain with a native dependency.

## Migrating from `moodlia` 0.3 and `moodle-core-cli` 0.3

| Before | Now |
| --- | --- |
| `moodlia course sync --source-profile ... --plan-file p.json` | `moodlia-sync plan --source-profile ... --plan-file p.json` |
| `moodlia course sync --approve-plan p.json --yes` | `moodlia-sync approve p.json --yes` |
| `moodlia course sync --apply-plan p.json --plan-digest D --allow-write` | `moodlia-sync approve p.json --yes` then `moodlia-sync apply p.json --plan-digest D --allow-write` |
| `moodlia sync status --job-id J` | `moodlia-sync status --job-id J` |
| `moodlia sync resume --job-id J --plan-digest D --allow-write` | `moodlia-sync resume --job-id J --plan-digest D --allow-write --approve --yes` |
| `moodlia sync verify --plan-id P` | `moodlia-sync verify --plan-id P` |
| `moodlia sync history` / `cancel` | `moodlia-sync history` / `cancel --job-id J` |
| `moodlia-sync-mcp` tools | the commands above |

State databases created by `moodlia` 0.3 or `moodle-core-cli` 0.3 open unchanged.

## License

GPL-3.0-or-later.
