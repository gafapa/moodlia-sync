# Cross-site synchronization architecture

## Scope

`moodlia-sync` owns the provider-neutral synchronization model, immutable planner, executor, state stores, and the synchronization side of the Core and MoodlIA adapters. It extends the discovery adapters of `moodle-core-cli` and `moodlia` (`CoreSyncAdapter`, `MoodliaSyncAdapter`, `AdaptiveSyncAdapter`) and depends only on `moodlia`, which re-exports the Core modules it needs under `moodlia/core`. The adaptive adapter selects a provider for each capability instead of selecting one backend for an entire command.

The package chain is linear: `moodle-core-cli` ← `moodlia` ← `moodlia-sync`. Core and `moodlia` have no native dependencies; only `moodlia-sync` installs `better-sqlite3`. The former `moodlia-sync-mcp` coordinator is retired; the CLI is the only execution surface.

The preview synchronizes selected metadata and proven structure plus selected portable authoring through MoodlIA: section summaries, Pages, Labels, URLs, resources, folders, Books, Lessons without native files or positive cross-page jumps, standalone and Quiz-private question banks without embedded files, selected Quiz settings and slots, assignments with rubrics, checklists or marking guides, Workshop grading forms, Database fields, Feedback items, unlocked course-completion criteria, root manual grade items, and safe module-grade-item settings. Quiz publication imports supported questions before adding separately journaled slots and marks; review/access settings and custom page breaks require explicit loss acceptance. Lesson publication preserves standard page definitions and ordering, while password and activity-link losses require explicit acceptance. Custom grade categories, nonportable manual weights, and locked target items remain protected. Database and Feedback definitions are created only in new activities; destination IDs, question ownership, backward item dependencies, and completion activity references are remapped, while existing definitions and locked completion criteria remain protected. Section, activity, Book, and assignment editor files are staged as one destination draft per owner and file area, preserving nested paths and Unicode names. The capability matrix distinguishes create/update gaps. Learner submissions, awarded grades, attempts, logs, and historical completion records remain excluded.

The provider-neutral model and immutable plan use schema version 2. The model records field states (`unknown`, `explicit_null`, `explicit_empty`, or `present`), extraction completeness, losses, unknown scopes, capability evidence, and owner-bound asset keys. Plans expose changed actions separately from unchanged and unknown entities. Version 1 preview plans are intentionally rejected instead of being reinterpreted.

## Decision: local state

The default store uses the pinned `better-sqlite3` driver (a native module)
and requires Node 22.13 or newer. SQLite keeps immutable plans, jobs, course
bindings, entity mappings, approvals, and leases together with synchronous
transactions and WAL journaling. If npm blocked the driver's install script,
opening the store fails with `dependency_unavailable` and the fix
`npm approve-scripts better-sqlite3 && npm rebuild better-sqlite3`. The
in-memory store remains available for deterministic tests.

The database never stores Moodle tokens. Profiles contain environment-variable references only. A deployment must keep one writer per state database and protect both the database and plan files with operating-system permissions.

## Safety model

Planning performs reads only. Applying requires all of the following:

1. A saved plan whose canonical digest matches its contents.
2. A non-expired plan.
3. Unchanged source and target course digests.
4. An unconsumed approval of that exact plan digest (`moodlia-sync approve`, or `--approve --yes`), consumed atomically with the job record, plus explicit `--allow-write`. Each approval authorizes one apply or one resume.
5. A destination capability that covers every requested field.

The executor persists intent before every write, records attempts and correlation IDs, stores returned identifiers immediately, and reads the target again after writes. It checks entity preconditions immediately before updates. Timeout-like failures become `unknown_outcome` and must be reconciled before resume. A readback mismatch is a verification failure, not success. A cancellation request stops scheduling new actions between writes. Cross-server transactions and automatic rollback are not claimed.

Asset actions prefer a protected per-action temporary cache. Downloads are streamed to exclusive files while SHA-256 and byte counts are computed, then destination uploads stream those files into one owner-scoped draft. The cache is removed after success or failure. Adapters without streamed transfer retain the bounded in-memory compatibility path.

## Identity and mappings

Remote numeric IDs are scoped to their own Moodle site. A binding ID hashes the source site/course and target site/course. Entity mappings then associate opaque source sync keys with destination IDs by namespace. Names and positions are not identity.

Section zero is matched only with section zero. Other existing sections require a persisted or caller-supplied mapping. New courses are created hidden in an explicitly selected category; their real binding is persisted after creation. New sections, groups, groupings, modules, and chapters receive mappings from destination IDs. This avoids overwriting an unrelated entity merely because its title is similar.

## Provider evidence

Core capability availability is the intersection of the static versioned contract and the functions returned for the current token by `core_webservice_get_site_info`. Moodle Core does not expose a general permission probe, so write permission remains `unknown` until an authorized request is attempted.

MoodlIA 0.1.213 provides `get_sync_capabilities`, multi-file editor publication, identity-preserving typed content updates, and authenticated asset downloads through its built-in external service. It evaluates category-scoped course creation and course-scoped structure, activity, grading-form, Book, Workshop, question-bank, Database-field, and Feedback-item capabilities. Older plugins remain usable for legacy direct commands, but adaptive synchronization does not promote a declared write operation to an available capability without contextual evidence.

## Compatibility

The support floor is Moodle 4.5. Static Core contracts are audited for 4.5, 5.0, 5.1, 5.2, and the 5.3 snapshot. A future version is not accepted merely because its number is greater. Each provider must also expose the selected function to the current service and token.
