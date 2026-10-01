# Cross-version synchronization review

Reviewed local sources on 2026-09-30: moodlia-sync 0.1.1, the sibling MoodlIA
plugin checkout (0.1.215 plus unreleased changes), CLI adapters, logical tests,
live qualification runner, archived evidence and test-lab workflow definitions.
No remote Moodle writes, deployment or new live qualification were performed.

Implementation follow-up on 2026-10-01 adds contextual capability preflight,
field-specific publication and dependency pruning. All changes remain local
and unreleased; this report distinguishes them from published 0.1.1 behavior.

A second pre-live review on 2026-10-01 adds interruption reconciliation, durable
resolved write intents, lease-loss detection and dependency ordering/validation.
Deferred links now use the target subdirectory and retain their query/fragment.
Missing or mismatched Book chapter identities are blocked. Forward links have
an apply/readback/converged-replan regression; cyclic new links and new self-links
remain blocked until separate shell/publication authoring can represent them.
Unknown draft uploads cannot be recovered solely from course state and require
explicit reconciliation rather than a blind replay. These are local regression
results; no Moodle site was contacted during this pass.

## Assessment

Synchronization remains preview. Branch names are provenance, not a guarantee
that nested activity settings, module availability, question schemas, grading
definitions and editor file behavior are representable on the destination.
The plan must fail before writes when exact preservation is unproven.

The 100-case logical test changes version labels while reusing the same
capabilities. Archived live evidence exercises 4.5.12 and 5.3 beta with a small
course/group/section/Page fixture. Test-lab schedules a 25-direction matrix,
but this review did not retrieve its current remote results. Neither layer
establishes complete course parity across all five branches.

## Corrected in this checkout

| Defect | Trigger and previous behavior | Result |
| --- | --- | --- |
| Format support from the wrong route | A mapped Page/Label/URL used an update API, while only creation accepted Markdown; planning passed using their union | Check only the operation that writes |
| Missing creation preflight | A File/Folder introduction used a format unavailable on an older plugin; asset staging could precede a remote failure | Block before staging |
| Course summary format loss | Creating a course copied plain/Markdown text without its format; updating text alone reset the plugin format to HTML, while format alone lacked required summary text | Preserve the pair or block the unsupported destination |
| Editor draft format loss | New Page/Label/URL creation with a draft calls the plugin update helper with literal HTML even if another format was requested | Create without publishing the draft, then journal a format-preserving content update; block if the update route cannot preserve it |
| Assignment instruction format loss | New Assignment activity instructions use HTML in the plugin creation helper; a plain-text plan was previously accepted | Journal field-specific updates for non-HTML or asset-bearing areas; validate their declared formats before writes |
| Stale capability evidence | A site could retain reads while write permissions or the selected provider changed | Refresh discovery and compare pending approved capabilities before apply/resume; check new-course permissions in course context |
| Literal text corruption | HTML serialization escaped ampersands or interpreted literal tags in plain/Markdown/Moodle text | Preserve raw non-HTML text; block unsupported internal link remapping |
| Orphan uploads under skip | Dropped entities could leave asset stages and reference-dependent actions | Prune reference dependencies and unused drafts; refuse children of an uncreatable course |
| Assignment readback mismatch | Module creation verified intro/activity as configuration, although export keeps them in content | Compare the correct content block during verification |

The regression suite includes 48 asymmetric route cases in both endpoint
directions, legacy File/Folder cases, new course summaries, paired course
updates and editor-draft/Assignment creation guards. It does not replace live
Moodle testing. The follow-up adds 48 stateful remote-stand-in cases through
the real adapter, including older plugin capabilities, separate publication,
owned files, literal text, readback and a converged re-plan. Permission drift,
resume, category-to-course context and skipped draft dependencies are also
regression-tested. These changes are local and unreleased.

## Remaining work, in priority order

1. **Extend live publication qualification.** The 2026-10-02 run passed Page,
   Label, URL and selected Assignment content in all four formats, in both
   endpoint directions and on SQLite/PostgreSQL. Extend that scope to empty text
   and interrupted/resumed publication on live sites. The stand-in tests exercise
   additional branches but cannot qualify those behaviors on real editors.
2. **Capability precision.** Preflight now detects changed pending snapshots.
   Core permission probes still report unknown; Moodle enforces them remotely.
   No preflight can guarantee permissions stay constant between remote writes.
   Add stronger contextual Core evidence only where the service actually exposes it.
3. **Nested definition evidence.** `module_create` declares a broad `settings`
   field; that does not validate each module option against branch-specific
   schemas. Verify question-bank availability/ownership, supported question
   types, Assignment/Workshop forms, Feedback dependencies, Database fields,
   Lesson jumps and completion/gradebook mappings on both upgrade and downgrade.
4. **Live fixture breadth and strict gaps.** The runner uses `unsupported-policy=skip`
   and checks whether a Page is skipped; that validates a supported subset.
   Add strict fixtures for each advertised family, assert exact expected gaps
   and required entities, and retain field/file readback plus a zero-write replan.
5. **Traceable qualification artifacts.** Record Moodle build, plugin commit,
   package versions, schema/capability digests, DB/PHP versions and content
   fixtures for every direction. Include different plugin releases, restricted
   tokens, disabled activity types and interrupted/resumed transfers. A job
   passing on a branch pair must be described with its exact transferred scope.

## Release gate

Live testing on 2026-10-02 exposed two additional legacy-service defects:
introduction file URLs included an item-id segment that Moodle does not expect,
and non-HTML course summaries returned rendered HTML without the original text.
The synchronizer now normalizes the former against the owned file path and
blocks summary publication for the latter. The fixture checks the summary gap
before testing module formats with an HTML course summary. Exact run results
and scope belong in the qualification evidence; these fixes remain unreleased.

Do not advertise complete cross-version synchronization from the logical
matrix. Require disposable-site apply, separate readback and unchanged re-plan
for each claimed content family and direction. Unsupported fixtures must prove
no mutation of that entity or its dependent assets. The scoped publication
evidence is recorded in `CROSS-VERSION-QUALIFICATION.md`; it does not qualify
all supported families or resolve the general plugin-suite failures recorded
alongside the run evidence.
