# Synchronization evidence inventory

This inventory records implementation status rather than inferred Moodle capability.

| Area | Status | Evidence and boundary |
| --- | --- | --- |
| Moodle 4.5-5.3 Core discovery | Verified statically and by disposable installation matrix | Versioned Core contract plus `core_webservice_get_site_info`; MoodlIA build `2026092110` was installed on 4.5.14, 5.0.8, 5.1.5, 5.2.2, and 5.3 beta, and build `2026092112` passed the ten-job Moodle CI matrix across MariaDB/PostgreSQL and supported PHP boundaries on 2026-09-21 |
| Core course metadata create/update | Verified by request/response fixtures | Permission remains unknown until Moodle authorizes the request |
| Core groups/groupings/membership | Verified by request/response fixtures | Structure only; user membership is excluded |
| Core section/activity authoring | Unavailable | No promoted exact authoring adapter; course-format actions remain experimental |
| MoodlIA contextual discovery | Verified contract | Category/course capability evidence from `get_sync_capabilities` |
| MoodlIA sections and group structure | Verified unit/static contract and supported-branch PHPUnit matrix | Destination permissions and course state remain runtime preconditions |
| Page/Label/URL authoring | Verified planner/adapter fixtures | Typed creation and identity-preserving updates use multi-file drafts |
| Section and assignment editor files | Verified planner/adapter/static plugin tests and supported-branch PHPUnit matrix | End-to-end bytes and restored-backup checks remain entity-specific release evidence |
| Resource/folder creation | Verified planner/adapter fixtures | Resource replacement is supported; existing folder replacement is unavailable |
| Book chapters and files | Verified planner/adapter/static plugin tests | Source bytes use SHA-256; final file manifests are read back |
| Assignment content and new rubrics | Verified planner/adapter/static plugin tests | Existing grading definitions are protected; incomplete plugin configuration requires a named degradation |
| Workshop grading forms | Verified for accumulative, comments, numerrors, and rubric definitions | New forms only; existing definitions are protected; rubric levels are not capped at four |
| Standalone/Quiz-private questions and Quiz slots | Verified planner/adapter/plugin matrix | Supported file-free question types in newly created banks/quizzes; review/access settings, custom breaks, embedded assets, and existing definition replacement remain explicit gaps |
| Lesson pages | Verified planner/adapter/plugin matrix | Standard portable page definitions and special jumps; embedded files and positive cross-page jumps remain blocked |
| Database fields and Feedback items | Verified planner/adapter/plugin matrix | Definitions are created only in new activities; destination IDs and backward dependencies are remapped; existing definitions are protected |
| Course completion and gradebook configuration | Verified planner/adapter/plugin matrix | Unlocked criteria, root manual items, and safe module-item settings; custom categories, unsafe weights, and locked targets remain protected |
| Live cross-version synchronization | Verified on disposable Moodle 4.5.12 and 5.3beta golden-image sites on GitHub Actions (2026-09-25, run `gha-36062421031`, both directions) and earlier on S1 (2026-09-22, run `release037-core036-final`) | Since 0.1.0: all four provider pairings passed with `moodlia-sync@0.1.0`, `moodlia@0.4.0`, `moodle-core-cli@0.4.1`, and plugin `0.1.215` in five of six runs; one run stopped before writing on an unexplained target drift (see `CROSS-VERSION-QUALIFICATION.md`). Earlier: All four provider pairings planned, applied, verified by live readback, and produced zero writes on rerun with public `moodlia@0.3.7`, `moodle-core-cli@0.3.6`, and plugin build `2026092201`; the MoodlIA-to-MoodlIA Page transfer read back two Unicode assets, one nested, with identical SHA-256 digests; see `CROSS-VERSION-QUALIFICATION.md` for the documented gaps per pairing |
| Package distribution | Verified from the public registry | A clean project installed `moodlia-sync@0.1.1` with `moodlia@0.4.1` and `moodle-core-cli@0.4.1` on 2026-09-25, loaded the SQLite driver, and ran the executable. Earlier: The disposable S1 runner installed `moodlia@0.3.7` with `moodle-core-cli@0.3.6` from npm on Node 24 (ARM64) with zero vulnerabilities, loaded the SQLite state store, and executed the live matrix from those packages; an earlier clean project also installed `moodlia-sync-mcp@0.1.0` and loaded every public export and executable |
| Deletion/pruning | Unavailable by default | No delete action is generated from filtered or incomplete inventory |
| Learner outcomes | Excluded | Submissions, grades, attempts, completion history, logs, and personal content are not synchronized |

Upstream operations that record view events are classified as writes in the Core client policy even when their names begin with `view`. Generic dynamic forms and arbitrary AJAX actions are not promoted as synchronization capabilities.

The disposable S1 matrix bound every test site to loopback, installed the release archive through Moodle's CLI upgrade path, linted every plugin PHP file, verified the stored plugin build, and removed all test containers, volumes, networks, and uploaded artifacts. Moodle 5.1 and later place web plugin types under `public/`; deployment tooling must resolve the effective plugin directory instead of assuming `<moodle-root>/local`.

The persistent `moodle-aula` service on S1 was observed healthy on Moodle 4.5.14 without MoodlIA, while the isolated main Moodle container reported 5.2.2 with MoodlIA. These observations are environment checks, not authorization to mutate either production-like service. The GitHub Moodle PHPUnit run `35627262680` is the release evidence for plugin build `2026092112` across the full supported branch matrix.
