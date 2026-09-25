# Synchronization capability matrix

This matrix describes the current implementation, not the complete long-term roadmap.

| Capability | Core source | Core destination | MoodlIA source | MoodlIA destination | Current status |
| --- | --- | --- | --- | --- | --- |
| Course identity and summary | Exact selected reads | Exact supported-field update | Exact selected reads | Exact supported-field update | Preview |
| New hidden target course | Read source metadata | Explicit target category and short name; permission is enforced by Moodle | Read source metadata | Contextual category permission probe and exact creation | Preview |
| Course category | Read | Requires an explicit destination category; source numeric ID is never copied | Read | Same | Explicit mapping |
| Sections, including section zero | Structural read | No verified Core authoring path | Portable raw summary and native editor-file manifests | Create/update with multi-file drafts and contextual permission evidence | Preview |
| Group definitions and grouping membership | Read when exposed to token | Create/update/add membership | Read | Create/update/add membership | Preview |
| Activity shells | Partial structural read | Quick-create is not full authoring | Partial structural read | Available direct operations vary | Reported as incomplete |
| Books and chapters | No verified Core authoring round trip | Unsupported | Ordered chapters and native file manifests | Create/update chapters; publish every owner file through one draft | Preview |
| Pages | Structural reads only | Authoring destination unsupported | Typed content and native editor-file manifests | Exact creation/update with identity preservation and multi-file drafts | Preview |
| Labels and URLs | Structural reads only | Authoring destination unsupported | Complete typed reads and native editor-file manifests | Exact creation and identity-preserving mapped updates | Preview |
| File resources and folders | Structural reads are incomplete | Publication unsupported | File manifests and SHA-256 verification | Exact creation; resource replacement; folder update blocked | Partial preview |
| Assignments and grading forms | Authoring round trip not proven | Unsupported | Selected authoring fields, two native editor-file manifests, rubrics, binary checklists, and marking guides | New assignment/grading form and identity-preserving content/file updates; existing grading definitions protected | Partial preview |
| Workshop forms | Definition reads/writes not proven | Unsupported | Portable definitions for four standard strategies | New Workshop/form; existing definitions protected | Partial preview |
| Standalone question banks | Partial APIs | Ownership-safe round trip not proven | Normalized portable blueprint for supported question types | Create a new mapped bank and import once; existing-content changes are protected | Partial preview |
| Database activity fields | Read-only field APIs vary | Authoring destination unsupported | Portable definitions for supported field types | Create fields in a new activity; destination field IDs are remapped and existing definitions are protected | Partial preview |
| Feedback items | Participant-oriented reads only | Authoring destination unsupported | Portable definitions and item dependencies for supported item types | Create ordered items in a new activity and remap backward dependencies; existing definitions are protected | Partial preview |
| Course completion criteria | Status reads only | Configuration authoring unsupported | Activity and course-grade criteria with source activity identities | Remap required activity IDs and set unlocked criteria; disabling and locked criteria are protected | Partial preview |
| Gradebook settings | Grade reports are not configuration authoring | Configuration authoring unsupported | Root manual items and safe module-item settings | Create root manual items for new courses and update resolved module items; custom categories and unsafe locks/weights are protected | Partial preview |
| Lessons | Participant-oriented reads only | Authoring destination unsupported | Portable definitions for standard page types and selected settings | Create ordered pages with special jumps; embedded files and positive cross-page jumps are blocked | Partial preview |
| Quizzes and private question banks | Partial APIs | Ownership-safe round trip not proven | Normalized supported questions, settings subset, slots and maximum marks | Create a new Quiz, import its private bank, remap questions and create/update slots; explicit loss acceptance required | Partial preview |
| Learner submissions, grades, attempts, logs | Excluded | Excluded | Excluded | Excluded | Out of scope |

Text formats: Page, Label, URL, File resource, and Assignment text keep their Moodle format. HTML and plain text synchronize to every MoodlIA destination; Markdown and Moodle auto-format need MoodlIA plugin 0.1.215 or later on the destination, which declares them in each capability's `text_formats`. Otherwise planning reports `destination_format_not_representable`.

`unsupported_policy=error` is the default. `skip` removes the unsupported entity and dependent actions from the executable graph and records them in `skipped`. `degrade` succeeds only for a named registered transformation; it is not a universal lossy switch.
