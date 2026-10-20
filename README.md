# MoodlIA Sync

Synchronize supported course content between Moodle sites without backups.
`moodlia-sync` reads a source course, writes an immutable plan of the changes
a target course needs, and applies that exact plan only after it is approved.
It works with Moodle Core web services and, where installed, the MoodlIA plugin,
choosing a provider per capability.

Status: preview. See [docs/SYNC-CAPABILITY-MATRIX.md](docs/SYNC-CAPABILITY-MATRIX.md)
for what each provider pairing can synchronize, and
[docs/CROSS-VERSION-QUALIFICATION.md](docs/CROSS-VERSION-QUALIFICATION.md) for
the live evidence.

Cross-version support applies only to the content families and exact provider
capabilities verified for a destination. The logical version matrix is not a
live compatibility guarantee. See [docs/CROSS-VERSION-REVIEW.md](docs/CROSS-VERSION-REVIEW.md)
for format guards, remaining gaps and qualification requirements.

[Status](#status) · [Getting started](#getting-started) · [Usage](#usage) · [Development](#development) · [Security and privacy](#security-and-privacy) · [Documentation](#documentation) · [License](#license)

## Status

Preview CLI and library. Package version: `0.1.2`. Supported content families and exact provider pairings are defined by the capability matrix and dated qualification evidence, not by a blanket version claim.

## Getting started

### Install

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

### Profiles

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

## Usage

### Workflow

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

### Migrating from `moodlia` 0.3 and `moodle-core-cli` 0.3

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

## Development

### Package layout

`moodlia-sync` depends on `moodlia` for provider adapters, `parse5` for portable HTML/reference handling, and `better-sqlite3` for durable state. `moodlia` depends on `moodle-core-cli`. Sync extends their discovery adapters and is the only package in this chain with a native dependency.

For the archived MCP coordinator, see [Migrating from Sync MCP](docs/MIGRATING-FROM-SYNC-MCP.md). Its old approval examples target legacy 0.3 dependencies, not the current `moodlia` CLI.

```sh
npm ci
npm run check
npm run test:coverage
```

The test suite needs no other repository: it runs against the published
`moodlia` and `moodle-core-cli` in `package-lock.json`. CI runs it on this
repository alone (`check`: Linux and Windows with Node 22.13 and 24, plus macOS
arm64), and again in `siblings` against the `moodlia-cli` and `moodle-core-cli`
sources (the branch with the same name when it exists, otherwise `main`). Live
cross-version qualification against real Moodle sites runs from
`moodlia-test-lab`; see `docs/CROSS-VERSION-QUALIFICATION.md`.

## Security and privacy

### Safety model

- Planning performs reads only.
- Applying requires a saved plan whose digest matches, an unexpired and
  unconsumed approval of that digest, `--allow-write`, unchanged source and
  target course digests, and a destination capability for every field.
- Apply/resume refresh destination capabilities for pending operations and stop
  if the approved snapshot changes. A new course switches from category to course
  context before its child entities are written. Unknown Core permissions still
  rely on Moodle enforcement; writes are not a cross-site transaction.
- Intent is persisted before each write; timeouts become `unknown_outcome` and
  are reconciled before a resume replays anything.
- Interrupted `started` intents are also treated as uncertain until reconciled.
  A draft upload without a proven returned identity is not inferred successful
  from course readback. Lease renewal failure stops further actions.
- Plans order forward dependencies and reject cyclic new content links before
  writes. New self-links remain unsupported pending separate shell publication.
- Learner submissions, grades awarded, attempts, logs, and completion history
  are never synchronized.

See [docs/SYNC-ARCHITECTURE.md](docs/SYNC-ARCHITECTURE.md) and
[docs/ADR-001-SYNC-FOUNDATION.md](docs/ADR-001-SYNC-FOUNDATION.md).

## Documentation

- [Project Pages](https://gafapa.github.io/moodlia-sync/)

Build the repository documentation portal with `python tools/build-project-page.py`. Its status comes from this README; purpose and first steps are maintained in `docs/project-page.json`. The `pages.yml` workflow publishes the portal without deploying the application or changing `moodlia.com`.

Adds reviewed course synchronization to [MoodlIA CLI](https://github.com/gafapa/moodlia-cli) and [Moodle Core CLI](https://github.com/gafapa/moodle-core-cli).

- [Source code](https://github.com/gafapa/moodlia-sync)
- [Issue tracker](https://github.com/gafapa/moodlia-sync/issues)
- [MoodlIA website](https://moodlia.com)
- [docs/SYNC-CAPABILITY-MATRIX.md](docs/SYNC-CAPABILITY-MATRIX.md)
- [docs/CROSS-VERSION-QUALIFICATION.md](docs/CROSS-VERSION-QUALIFICATION.md)
- [docs/MIGRATING-FROM-SYNC-MCP.md](docs/MIGRATING-FROM-SYNC-MCP.md)

## License

GPL-3.0-or-later.
