# Additional plugin suite findings

These diagnostics ran on the isolated `qualification/sync-20261001-232408`
branch at plugin commit `1dcb4b8`, separately from synchronization qualification.
They include the new original-text/format readback regression. The whole plugin
suite was not green at that revision, and a passing synchronization fixture
cannot override those historical results. Subsequent resolution is recorded
below.

| Run | Environment | Result |
| --- | --- | --- |
| [36935985575](https://github.com/gafapa/moodle-local_moodlia/actions/runs/36935985575) | Moodle 4.5.14+, PHP 8.1, MariaDB | 80 tests, 907 assertions, three errors; independent REST fixture also failed |
| [36936003428](https://github.com/gafapa/moodle-local_moodlia/actions/runs/36936003428) | Moodle 5.3 beta, PHP 8.4, PostgreSQL 17 | Two PHPUnit errors; static checks also failed |

The reported PHPUnit errors were:

- `module_update_preservation_test::test_choice_completion_update_keeps_options_and_responses`
  passes an array to `submit_choice_response::execute`, whose third argument
  requires a JSON string. This occurs on both branches.
- `module_update_preservation_test::test_assignment_completion_update_keeps_plugin_settings`
  accesses missing `assignsubmission_file_maxsizebytes` form state on 4.5.
- `read_operations_test::test_read_operations_serialize_real_fixtures`
  changes the page course after glossary fixture creation initialized the theme.
  This occurs on both branches.

The 4.5 independent REST fixture reported a missing `gradecategory` property
during `create_module`. Keep this visible rather than treating the broader
completion/form-state work as qualified by synchronization.

The authored-content regression was not among the PHPUnit errors. Static
analysis found a multi-line call-format error in the new permission guard;
commit `ebf1cad` corrects its formatting without changing behavior. Do not claim
that the whole static suite passed from that correction alone.

## Resolution verified before further upload

Subsequent plugin revisions fixed the Choice JSON argument, Assignment native
form initialization, graded activity defaults and request-local page state.
Additional native and REST failures exposed by the expanded fixtures were also
resolved, including Workshop grade categories and report access restrictions.

- [Run 36942721255](https://github.com/gafapa/moodle-local_moodlia/actions/runs/36942721255)
  passed all ten Moodle 4.5–5.3 beta PHP/database profiles: 82 native tests per
  profile, independent REST requests and static checks.
- [Run 36943122019](https://github.com/gafapa/moodle-local_moodlia/actions/runs/36943122019)
  passed the five-branch matrix and static checks at commit
  `2a58ca4cdebb7680ead01b3ca558f2ec19b677c1`.

Those revisions were integrated locally into the synchronization qualification
plugin branch before any further upload. The earlier sync evidence remains tied
to `765834a`; the passing general suite is tied to its own tested revisions.
Neither report alone qualifies the combined local merge. Moodle 5.x test logs
retain metadata deprecations/notices as documented in the plugin audit.

Local merge `d5e8ff2d85763393690700df64857c515b3c2738` passed all 30 plugin
static tests, syntax checks for 575 PHP and 26 JavaScript files, contract and
manifest parity, boilerplate, documentation and Marketplace package validation.
Its first static-test attempt lacked the worktree's `fflate` development
dependency; `npm ci` restored it and the complete static suite passed. The
canonical synchronization checks passed 185 tests and declaration compilation;
skill checks passed eight tests. No new remote upload was performed for these
local changes. A native/REST run of the exact combined merge remains separate
from the already passing historical runs above.
