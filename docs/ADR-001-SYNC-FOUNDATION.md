# ADR 001: Shared adaptive synchronization foundation

Status: accepted for preview

## Decision

`moodlia-sync` owns the provider-neutral course model, planner, executor, and state stores, and extends the discovery adapters of `moodle-core-cli` and `moodlia` with synchronization. `moodle-core-cli` keeps profiles, the capability registry, transport, and discovery; `moodlia` adds the field-aware MoodlIA provider and re-exports the Core modules `moodlia-sync` needs.

Amended 2026-09-24: the engine moved out of Core so only synchronization users install the native SQLite driver, and the `moodlia-sync-mcp` coordinator was retired because its approval boundary did not hold against agents with shell access; the CLI's atomic approval consumption replaces it.

The state store uses the maintained `better-sqlite3` driver, pinned to a release
whose declared runtime floor is Node 22. This provides synchronous transactions,
WAL journaling, leases, and schema-versioned durable state without relying on
Node's experimental `node:sqlite` API. The in-memory implementation remains the
test double. Node 22.13 remains the package runtime floor and is qualified with
Node 24 on Windows and Linux.

Plans are canonical JSON documents with a digest, expiry, capability snapshot, selected provider per action, source and target preconditions, conflicts, unsupported changes, skipped dependencies, effects, and transfer estimates. Plan files and SQLite state are created with restrictive POSIX permissions where supported. Credentials remain environment-variable references and are never serialized.

## Consequences

- Core-only sites retain a useful, explicitly limited path.
- MoodlIA can improve an individual capability without replacing the whole client.
- Provider fallback happens during planning, never after an ambiguous mutation.
- New target courses are created hidden and only in an explicitly selected category.
- A timeout does not imply failure: it becomes `unknown_outcome` and requires readback reconciliation.
- Native backups remain a separate portability/QA mechanism and are not part of cross-site synchronization.

## Rejected alternatives

- Merging both repositories would force GPL/MoodlIA dependencies into the MIT Core client.
- Keeping the engine in Core would give every Core and MoodlIA user a native dependency they do not use.
- Selecting one backend for an entire command would discard safe Core fallbacks and hide field-level gaps.
- JSON-only state would not provide transactional approval consumption or target-course leases.
- Node's built-in experimental SQLite API emits warnings on the supported Node 22 line and does not meet the stable-driver requirement.
- Automatic title matching would risk overwriting unrelated Moodle entities.
