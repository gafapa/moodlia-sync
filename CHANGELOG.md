# Changelog

## Unreleased

- Correct legacy plugin introduction-file URLs using the stored file path,
  retaining genuine `0` directories and authenticated file hashing.
- Preserve activity-owned grade ranges through the owning creation settings;
  never send those ranges to the generic grade-item update API. Block range
  changes that require an unsupported owning-activity update.
- Block non-HTML course summaries when a legacy service exports rendered HTML
  without raw source text. `skip` omits both summary text and format explicitly.
- Add a disposable GitHub qualification workflow for both directions between
  Moodle 4.5 and 5.3 beta, on SQLite and PostgreSQL, using a package artifact
  built from the isolated test branch rather than an npm release.
- Resolve deferred Moodle links against the actual target site's subdirectory,
  retain query parameters and fragments, and block unresolved or mismatched
  chapter ownership. Order dependent creates before their consumers; cyclic
  links (including new self-links) remain blocking even with `skip`.
- Reconcile interrupted `started` write intents before replay. Unknown draft
  uploads remain blocked without a proven draft identity. Publication recovery
  retains the full parent-action context and durably stores resolved fields
  before each remote call.
- Stop scheduling writes when the synchronization lease cannot be renewed.
  Reject malformed plan expiry, duplicate action identities and invalid execution
  dependency order before starting a job.
- Validate Page, Label and URL formats against the selected creation or mapped
  update capability, rather than the union of both routes.
- Validate File and Folder introduction formats before creation and asset staging.
- Preserve known non-HTML course summary formats during creation, and keep
  summary text and format paired during updates. Destinations without the
  required fields or formats now receive a blocking gap instead of silent HTML.
- Publish non-HTML Page, Label and URL editor drafts through a journaled,
  field-specific update after creation, avoiding the plugin's HTML-forcing path.
- Preserve all declared Assignment formats with field-specific updates after
  creation, including areas without files. Block before writes when the required
  update route or format is unavailable. Verify Assignment text in its content
  block rather than treating it as a configuration setting.
- Refresh destination capability discovery before apply/resume and compare only
  pending operation snapshots. Recheck in course context after category-based
  creation, retain the created identity on failure, and remove stale adaptive routes.
- Preserve literal non-HTML text instead of serializing it as HTML. Internal
  links in these formats remain blocked pending a format-specific rewriter.
- Prune skipped reference dependencies and orphan draft uploads; a failed course
  creation capability cannot be bypassed with `unsupported_policy=skip`.
- Correct the qualification documentation: the 100-case logical matrix does
  not prove cross-version compatibility. The published 0.1.1 Assignment planner
  still blocks Markdown/Moodle formats; the corrections above are unreleased.

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
