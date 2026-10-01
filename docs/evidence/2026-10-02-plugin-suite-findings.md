# Additional plugin suite findings

These diagnostics ran on the isolated `qualification/sync-20261001-232408`
branch at plugin commit `1dcb4b8`, separately from synchronization qualification.
They include the new original-text/format readback regression. The whole plugin
suite is not green, and a passing synchronization fixture cannot override these
results.

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
