# Migrating from the archived Sync MCP coordinator

`moodlia-sync-mcp` is archived and read-only on GitHub. Its README and examples describe the retained coordinator and its legacy `moodlia`/`moodle-core-cli` 0.3 dependencies; they are not instructions for the current CLI packages. In particular, current `moodlia course sync` commands report the replacement rather than approving or applying a synchronization plan.

Use the maintained `moodlia-sync` CLI for new synchronization work. Start with the [current workflow](../README.md#workflow), which keeps the plan, approval, apply and verification steps separate:

```sh
moodlia-sync plan --source-profile school_a --source-course-id 42 \
  --target-profile school_b --target-course-id 108 --plan-file plan.json
moodlia-sync approve plan.json --yes
moodlia-sync apply plan.json --plan-digest <sha256:...> --allow-write
moodlia-sync verify --plan-id <plan_id>
```

The plan digest must be the one produced by the reviewed plan. An approval is consumed atomically for one apply or resume. Do not treat the existence of an old MCP approval or an agent-supplied boolean as authorization for another execution.

Existing state databases are a migration input, not a reason to run old CLI examples against newer dependencies. Stop the coordinator, retain a backup of the database and plans, configure the maintained CLI with the intended profiles and state location, inspect existing jobs, and follow its current approval/recovery requirements. Do not run the old and new coordinators concurrently against the same state file. Avoid changing provider identities or rewriting job history to force an interrupted action to run.

For an interrupted job, use the exact recorded job ID and plan digest with the current resume command after reviewing and renewing authorization:

```sh
moodlia-sync resume --job-id <job_id> --plan-digest <sha256:...> --allow-write --approve --yes
```

The native SQLite driver and its installation requirements are documented in the [installation section](../README.md#install). No MCP server is embedded in the maintained synchronization CLI. Historical cross-version reports remain evidence of their named versions and environments, not a guarantee for every current Moodle deployment.
