# Changelog

## 0.1.0 - unreleased

- First release as a standalone package. The synchronization engine, state
  store, and synchronization adapters move here from `moodle-core-cli` 0.3.6
  and `moodlia` 0.3.7; `moodle-core-cli` and `moodlia` no longer install the
  native SQLite driver.
- New `moodlia-sync` executable with `capabilities`, `plan`, `approve`,
  `apply`, `status`, `history`, `cancel`, `resume`, `verify`, and `conflicts`.
- `apply` and `resume` consume an approval of the exact plan digest
  atomically with the job record; each approval authorizes one execution.
  `--approve --yes` approves inline. This replaces the retired
  `moodlia-sync-mcp` coordinator.
- A missing or mismatched `better-sqlite3` build fails with
  `dependency_unavailable` and the command that fixes it.
- Group visibility is compared by name across providers (Core reports 0-3,
  MoodlIA a name), Core receives the numeric constant, and MoodlIA sites with
  plugin 0.1.215 or later synchronize group visibility and participation,
  closing the Core-to-MoodlIA group gap found by live qualification.
- State databases written by `moodle-core-cli` 0.3.6 open unchanged.
