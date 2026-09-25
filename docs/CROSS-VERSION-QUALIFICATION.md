# Cross-version synchronization qualification

## Scope

The release suite evaluates the five supported Moodle branches (`4.5`, `5.0`, `5.1`, `5.2`, and `5.3`) in every source-to-target direction and through all four provider pairings:

- Core to Core
- Core to MoodlIA
- MoodlIA to Core
- MoodlIA to MoodlIA

This produces 100 logical scenarios. `tests/version-matrix.test.mjs` validates every immutable plan, preserves source and target version evidence, checks provider-specific capability outcomes, and rejects any plan containing backup, restore, course-copy, or `.mbz` transport markers.

## Expected outcomes

The representative fixture always transfers exact supported course metadata. A MoodlIA source additionally exposes a complete portable Page definition:

| Source | Destination | Expected authored Page outcome |
| --- | --- | --- |
| Core | Core | No Page authoring claim because Core extraction is shell-only |
| Core | MoodlIA | No Page authoring claim because the source field is unavailable |
| MoodlIA | Core | Blocking `target_capability_unavailable` gap before any write |
| MoodlIA | MoodlIA | Exact portable Page creation action |

Across all version directions, 75 scenarios are applicable for the selected fixture and 25 intentionally produce the documented Core destination gap. A capability-gap result is a successful qualification outcome, not a successful content transfer.

## Evidence layers

The logical matrix complements rather than replaces the other release evidence:

- `npm test` covers deterministic planning, three-way conflicts, asset streaming, Unicode paths, reference rewriting, interruption, reconciliation, resume, idempotent reruns, and verification failures.
- The Moodle plugin CI matrix executes its PHP and database suite on each supported branch and supported database/PHP boundary.
- Disposable live-site qualification is required for claims about a concrete service, token, database, or deployment. It must use recorded isolated resources and remove them after verification.

No production synchronization or plugin deployment is part of this qualification.

## Disposable live qualification

Since `moodlia-sync` 0.1.0 the live qualification runs on GitHub Actions with the golden images of [gafapa/moodlia-test-lab](https://github.com/gafapa/moodlia-test-lab) (`qualify.yml`): four disposable SQLite sites (Core and MoodlIA on the source and target branches), the published npm packages, and plan, approve, apply, verify, and an unchanged re-plan for each provider pairing.

On 2026-09-24 and 2026-09-25 it ran six times between Moodle 4.5.12 and 5.3beta in both directions with `moodlia-sync@0.1.0`, `moodlia@0.4.0`, `moodle-core-cli@0.4.1`, and MoodlIA plugin `0.1.215`:

- Five runs passed all four pairings, including readback verification and a converged re-plan. A representative report is archived as `docs/evidence/gha-36062421031-qualification-report.json` (5.3 to 4.5).
- One 5.3-to-4.5 run stopped before writing with `Source or target changed after the sync plan was created` in the Core-to-MoodlIA pairing. Neither it nor the cause reappeared in five later runs. The runner now exports both courses twice when this happens and keeps the models with the run evidence, so a recurrence shows which field moved.

The first attempts failed in Core to Core with `readback_mismatch` on `course.update`. Every golden image had created a course named `LAB-SOURCE`, so copying the source shortname collided with the target site's own course. Moodle reported this as a warning and `moodle-core-cli` 0.4.0 treated the update as successful. `moodle-core-cli` 0.4.1 now fails such updates with Moodle's warning, and the fixture names its courses after the site (`M405CORE-SOURCE`).

### 2026-09-22 run on S1

On 2026-09-22 the four provider pairings were executed end to end between disposable Moodle sites on the isolated S1 host, using only public npm packages (`moodlia@0.3.7`, `moodle-core-cli@0.3.6`) and MoodlIA plugin build `2026092201` (release `0.1.213`, commit `117992c343c6397d8b14f1bee87bb7a43414333a`). Run identifier: `release037-core036-final`; the runner's report is archived as `docs/evidence/release037-core036-final-qualification-report.json`.

| Scenario | Source | Destination | Initial actions | Documented gap | Apply | Live verify | Unchanged rerun |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core to Core | 4.5.12 (Build 20260608) | 5.3beta (Build 20260916) | course update, group, grouping, grouping membership | none | succeeded | verified | 0 writes |
| Core to MoodlIA | 4.5.12 | 5.3beta | course update, two sections | Core-sourced group fields (`visibility`, `participation`) reported `target_capability_unavailable`; the dependent grouping and membership were skipped before any write | succeeded | verified | 0 writes |
| MoodlIA to Core | 4.5.12 | 5.3beta | course update, group, grouping, grouping membership | sections `target_capability_unavailable` on the Core destination; the Page therefore stayed `target_section_unresolved` before any write | succeeded | verified | 0 writes |
| MoodlIA to MoodlIA | 4.5.12 | 5.3beta | course update, two sections, group, grouping, membership, staged assets, Page creation | none | succeeded | verified | 0 writes |

The MoodlIA-to-MoodlIA transfer moved a Page with two authenticated assets (`hero ünicode.png` at the root and `diagram ünicode.svg` under `/nested/`): both files were read back with identical SHA-256 digests, the content kept `@@PLUGINFILE@@` references, and no token appeared in the exported model. Every plan was rejected for backup, restore, course-copy, or `.mbz` markers before execution.

The live matrix found defects that the unit and logical evidence had not exposed, and each one was fixed and regression-tested before the final pass:

- Moodle rewrites stored `@@PLUGINFILE@@` references without re-encoding them, so decoded and encoded asset URLs both appear in rendered HTML; the MoodlIA adapter now canonicalizes references to rawurlencoded segments (`moodlia@0.3.7`).
- Module creation results echo `grouping_id: 0` next to `module_id`; the Core engine now identifies created entities by the first positive identifier, which also restores the module binding mapping (`moodle-core-cli@0.3.6`).
- Readback verification failures are now persisted in the job and returned in the CLI error details (`moodle-core-cli@0.3.6`).
- The plugin published Page files with the physical `itemid` and its integrated service lacked `downloadfiles`; both are fixed in build `2026092201`.

All four test containers, their volumes, the compose network, and the staging directory were removed after the final report was archived. No persistent Moodle service took part.

## Latest plugin branch evidence

The release evidence inspected on 2026-09-22 is the successful [Moodle PHPUnit run 35755291294](https://github.com/gafapa/moodle-local_moodlia/actions/runs/35755291294) for plugin commit `117992c343c6397d8b14f1bee87bb7a43414333a` (release `0.1.213`). Its ten successful jobs cover:

- Moodle 4.5 on MariaDB/PHP 8.1 and PostgreSQL/PHP 8.3.
- Moodle 5.0 on MariaDB/PHP 8.2 and PostgreSQL/PHP 8.4.
- Moodle 5.1 on MariaDB/PHP 8.2 and PostgreSQL/PHP 8.4.
- Moodle 5.2 on MariaDB/PHP 8.3 and PostgreSQL/PHP 8.4.
- The audited Moodle 5.3 beta snapshot on MariaDB/PHP 8.3 and PostgreSQL 17/PHP 8.4.

This evidence proves the plugin suite on each branch boundary. It does not turn a static Core token into an authoring API and does not replace live source-to-target permission checks.
