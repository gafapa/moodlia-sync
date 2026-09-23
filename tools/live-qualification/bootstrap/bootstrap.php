<?php
// Disposable cross-version qualification fixture. Never deploy this file to a Moodle site.

define('CLI_SCRIPT', true);
require('/var/www/html/config.php');
require_once($CFG->libdir . '/externallib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/group/lib.php');

if ($argc !== 4) {
    fwrite(STDERR, "Usage: bootstrap.php <site-key> <core|moodlia> <source|target>\n");
    exit(2);
}

[$script, $sitekey, $provider, $role] = $argv;
if (!preg_match('/^[a-z0-9]+$/', $sitekey)
        || !in_array($provider, ['core', 'moodlia'], true)
        || !in_array($role, ['source', 'target'], true)) {
    fwrite(STDERR, "Invalid qualification fixture arguments.\n");
    exit(2);
}

global $DB, $USER;
$admin = get_admin();
\core\session\manager::set_user($admin);
set_config('enablewebservices', 1);
set_config('webserviceprotocols', 'rest');

function qualification_core_service(): stdClass {
    global $DB;
    $shortname = 'moodlia_qualification_core';
    $service = $DB->get_record('external_services', ['shortname' => $shortname]);
    if (!$service) {
        $now = time();
        $serviceid = $DB->insert_record('external_services', (object) [
            'name' => 'MoodlIA disposable Core qualification',
            'enabled' => 1,
            'requiredcapability' => '',
            'restrictedusers' => 1,
            'component' => '',
            'timecreated' => $now,
            'timemodified' => $now,
            'shortname' => $shortname,
            'downloadfiles' => 1,
            'uploadfiles' => 1,
        ]);
        $service = $DB->get_record('external_services', ['id' => $serviceid], '*', MUST_EXIST);
    }
    $registered = $DB->get_records_menu('external_services_functions',
        ['externalserviceid' => $service->id], '', 'functionname, id');
    foreach ($DB->get_fieldset_select('external_functions', 'name', '1 = 1') as $functionname) {
        if (!array_key_exists($functionname, $registered)) {
            $DB->insert_record('external_services_functions', (object) [
                'externalserviceid' => $service->id,
                'functionname' => $functionname,
            ]);
        }
    }
    return $service;
}

function qualification_service(string $provider): stdClass {
    global $DB;
    if ($provider === 'core') {
        return qualification_core_service();
    }
    return $DB->get_record('external_services', ['shortname' => 'local_moodlia'], '*', MUST_EXIST);
}

function qualification_token(stdClass $service, stdClass $user): string {
    global $DB;
    $existinguser = $DB->record_exists('external_services_users', [
        'externalserviceid' => $service->id,
        'userid' => $user->id,
    ]);
    if (!$existinguser) {
        $DB->insert_record('external_services_users', (object) [
            'externalserviceid' => $service->id,
            'userid' => $user->id,
            'iprestriction' => '',
            'validuntil' => 0,
            'timecreated' => time(),
        ]);
    }
    $arguments = [
        EXTERNAL_TOKEN_PERMANENT,
        $service,
        (int) $user->id,
        \context_system::instance(),
        0,
        '',
    ];
    if (class_exists('core_external\\util')
            && method_exists('core_external\\util', 'generate_token')) {
        return \core_external\util::generate_token(...$arguments);
    }
    return external_generate_token(...$arguments);
}

function qualification_course(string $shortname, string $fullname, string $summary): stdClass {
    global $DB;
    $existing = $DB->get_record('course', ['shortname' => $shortname]);
    if ($existing) {
        return $existing;
    }
    $course = create_course((object) [
        'fullname' => $fullname,
        'shortname' => $shortname,
        'category' => 1,
        'summary' => $summary,
        'summaryformat' => FORMAT_HTML,
        'format' => 'topics',
        'visible' => 0,
        'numsections' => 2,
    ]);
    course_create_sections_if_missing($course, 1);
    return $DB->get_record('course', ['id' => $course->id], '*', MUST_EXIST);
}

function qualification_group_fixture(stdClass $course): void {
    global $DB;
    if ($DB->record_exists('groups', ['courseid' => $course->id, 'name' => 'Unicode Team á'])) {
        return;
    }
    $groupid = groups_create_group((object) [
        'courseid' => $course->id,
        'name' => 'Unicode Team á',
        'description' => '<p>Portable group description.</p>',
        'descriptionformat' => FORMAT_HTML,
    ]);
    $groupingid = groups_create_grouping((object) [
        'courseid' => $course->id,
        'name' => 'Qualification grouping',
        'description' => '<p>Cross-version grouping.</p>',
        'descriptionformat' => FORMAT_HTML,
    ]);
    groups_assign_grouping($groupingid, $groupid);
}

function qualification_page_fixture(stdClass $course, stdClass $user): void {
    global $DB;
    if (!class_exists('local_moodlia\\operation\\create_module')) {
        throw new coding_exception('MoodlIA operation classes are unavailable.');
    }
    $existing = $DB->get_record_sql(
        'SELECT cm.id FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module '
            . 'JOIN {page} p ON p.id = cm.instance WHERE cm.course = ? AND m.name = ? AND p.name = ?',
        [$course->id, 'page', 'Portable Page á']
    );
    $filename = 'hero ünicode.png';
    if ($existing) {
        $context = \context_module::instance((int) $existing->id);
        $stored = get_file_storage()->get_file(
            $context->id,
            'mod_page',
            'content',
            0,
            '/',
            $filename
        );
        if ($stored && !$stored->is_directory()) {
            return;
        }
        course_delete_module((int) $existing->id);
    }
    $draftitemid = file_get_unused_draft_itemid();
    $bytes = base64_decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        true
    );
    get_file_storage()->create_file_from_string([
        'contextid' => \context_user::instance((int) $user->id)->id,
        'component' => 'user',
        'filearea' => 'draft',
        'itemid' => $draftitemid,
        'filepath' => '/',
        'filename' => $filename,
    ], $bytes);
    get_file_storage()->create_file_from_string([
        'contextid' => \context_user::instance((int) $user->id)->id,
        'component' => 'user',
        'filearea' => 'draft',
        'itemid' => $draftitemid,
        'filepath' => '/nested/',
        'filename' => 'diagram ünicode.svg',
    ], '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"></svg>');
    \local_moodlia\operation\create_module::execute(
        (int) $course->id,
        1,
        'page',
        'Portable Page á',
        [
            'content' => '<p>Cross-version portable content.</p>'
                . '<p><img src="@@PLUGINFILE@@/hero%20%C3%BCnicode.png" alt="One pixel"></p>'
                . '<p><img src="@@PLUGINFILE@@/nested/diagram%20%C3%BCnicode.svg" alt="Nested diagram"></p>',
            'filename' => $filename,
            'draft_item_id' => $draftitemid,
        ]
    );
}

$debugstage = static function(string $stage): void {
    fwrite(STDERR, '[qualification] ' . $stage . PHP_EOL);
};

$debugstage('service');
$service = qualification_service($provider);
$debugstage('token');
$token = qualification_token($service, $admin);
$result = [
    'site_key' => $sitekey,
    'provider' => $provider,
    'role' => $role,
    'token' => $token,
    'moodle_release' => $CFG->release,
    'plugin_version' => get_config('local_moodlia', 'version') ?: null,
];

if ($role === 'source') {
    $debugstage('source-course');
    $shortname = strtoupper($sitekey) . '-SOURCE';
    $course = qualification_course(
        $shortname,
        'Qualification source ' . $sitekey,
        '<p>Cross-version summary from ' . $sitekey . '.</p>'
    );
    $debugstage('source-groups');
    qualification_group_fixture($course);
    if ($provider === 'moodlia') {
        $debugstage('source-page');
        qualification_page_fixture($course, $admin);
    }
    $result['source_course_id'] = (int) $course->id;
} else {
    $debugstage('target-course-a');
    $targeta = qualification_course(
        strtoupper($sitekey) . '-TARGET-A',
        'Qualification target A ' . $sitekey,
        '<p>Target A placeholder.</p>'
    );
    $debugstage('target-course-b');
    $targetb = qualification_course(
        strtoupper($sitekey) . '-TARGET-B',
        'Qualification target B ' . $sitekey,
        '<p>Target B placeholder.</p>'
    );
    $result['target_course_ids'] = [(int) $targeta->id, (int) $targetb->id];
}

echo json_encode($result, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . PHP_EOL;
