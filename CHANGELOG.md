# Changelog

## 0.1.1 - 2026-09-24

- Page, Label, URL, File, and Assignment text in Markdown or Moodle auto-format
  now synchronizes to MoodlIA targets with plugin 0.1.215 or later. Before,
  planning reported it as `destination_format_not_representable`.
  Capabilities declare the formats they accept in `text_formats`; targets that
  do not declare them still accept only HTML and plain text.
- A course update that Moodle rejects, for example because the shortname is
  already used on the target site, now fails the action with Moodle's warning
  (from `moodle-core-cli` 0.4.1) instead of a later `readback_mismatch`.
- Tests: coverage is now 97% of lines, 83% of branches, and 92% of functions,
  up from 82%, 71%, and 76%. CI enforces 95%, 80%, and 90%.

## 0.1.0 - 2026-09-24

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
