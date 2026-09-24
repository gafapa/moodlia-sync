import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoodliaSyncAdapter } from '../adapters/moodlia-sync.mjs';

const OPERATIONS = [
  'get_moodlia_status', 'get_sync_capabilities', 'create_course', 'update_course', 'create_section', 'update_section',
  'get_course_contents', 'create_group', 'update_group', 'create_grouping', 'update_grouping', 'add_group_to_grouping',
  'create_module', 'update_module', 'create_book_chapter', 'update_book_chapter', 'update_page', 'update_label',
  'update_url', 'update_resource', 'update_assignment', 'set_assignment_rubric', 'set_assignment_checklist',
  'set_assignment_marking_guide', 'set_workshop_grading_form', 'import_question_bank_blueprint', 'create_data_field',
  'create_feedback_item', 'set_course_completion_criteria', 'add_question_to_quiz', 'update_quiz_question_slot',
  'create_lesson_page', 'create_grade_item', 'update_grade_item', 'get_grade_items'
];

const ALL_EVIDENCE = Object.fromEntries([
  'course_update', 'course_create', 'group_manage', 'activity_manage', 'book_edit', 'assignment_grade',
  'grading_form_manage', 'workshop_form_manage', 'question_manage', 'question_bank_module_available',
  'database_field_manage', 'feedback_item_manage', 'completion_manage', 'quiz_manage', 'lesson_manage',
  'gradebook_manage'
].map((name) => [name, true]));

function fakeClient({ release = '0.1.215', declared = OPERATIONS, evidence = ALL_EVIDENCE, responses = {} } = {}) {
  const client = {
    calls: [],
    uploads: [],
    operationNames() { return OPERATIONS; },
    async callOperation(name, parameters = {}) {
      client.calls.push([name, parameters]);
      if (name === 'get_moodlia_status') {
        return {
          site_url: 'https://target.example', plugin_release: release, can_use_api: true,
          functions_json: JSON.stringify(declared.map((operation) => `local_moodlia_${operation}`))
        };
      }
      if (name === 'get_sync_capabilities') return { capabilities_json: JSON.stringify(evidence) };
      const response = responses[name];
      return typeof response === 'function' ? response(parameters) : (response ?? { ok: true });
    },
    async uploadDraftData(data, options) {
      client.uploads.push({ bytes: data.length, ...options });
      return { draft_item_id: options.itemId || 77, filename: options.filename, filepath: options.filepath };
    },
    async uploadDraftFile(filePath, options) {
      client.uploads.push({ filePath, ...options });
      return { draft_item_id: options.itemId || 78, filename: options.filename, filepath: options.filepath };
    },
    async downloadFile(url, options) { return { url, options }; },
    async downloadFileToPath(url, destinationPath, options) { return { url, destinationPath, options }; }
  };
  return client;
}

async function discovered(options) {
  const client = fakeClient(options);
  const adapter = createMoodliaSyncAdapter({ client });
  await adapter.discoverSite();
  client.calls.length = 0;
  return { adapter, client };
}

test('sync capabilities follow declared operations and live permission evidence', async () => {
  const { adapter } = await discovered();
  const capabilities = await adapter.syncCapabilities({ courseId: 8 });
  const unavailable = Object.entries(capabilities).filter(([, value]) => value.available !== true).map(([name]) => name);
  assert.deepEqual(unavailable, []);
  assert.ok(capabilities.group_create.supported_fields.includes('visibility'));
  assert.deepEqual(capabilities.page_content_update.text_formats, ['html', 'plain', 'markdown', 'moodle']);

  const limited = await discovered({ release: '0.1.214', declared: ['get_moodlia_status', 'update_course'], evidence: {} });
  const legacy = await limited.adapter.syncCapabilities({ categoryId: 4 });
  assert.equal(limited.client.calls.some(([name]) => name === 'get_sync_capabilities'), false);
  assert.equal(Object.values(legacy).some((value) => value.available === true), false);
  assert.deepEqual(legacy.module_create.text_formats, ['html', 'plain']);
  assert.deepEqual(legacy.group_update.supported_fields, ['name', 'description', 'idnumber']);
});

test('prepareTargetCourse describes a hidden course that does not exist yet', async () => {
  const { adapter } = await discovered();
  const model = await adapter.prepareTargetCourse({ category_id: 4, shortname: 'NEW' });
  assert.equal(model.course.visible, false);
  assert.deepEqual(model.target_creation, { category_id: 4, shortname: 'NEW' });
  assert.equal(model.site.site_url, 'https://target.example');
});

// [action, context entities, expected operation, expected parameter subset]
const created = new Map([
  ['sections:section:s', { section_id: 31, section_number: 3 }],
  ['modules:module:m', { module_id: 41 }],
  ['chapters:chapter:c', { chapter_id: 51 }],
  ['drafts:stage:p', { draft_item_id: 61, files: [{ filename: 'p.png' }] }],
  ['feedback_items:item:f', { item_id: 71 }],
  ['lesson_pages:page:l', { page_id: 81 }],
  ['question_imports:import:q', { created_questions_json: JSON.stringify([{ question_id: 91 }]) }]
]);

const dispatch = [
  [{ kind: 'course.create', fields: { shortname: 'NEW' } }, 'create_course', { shortname: 'NEW' }],
  [{ kind: 'course.update', fields: { fullname: 'F' } }, 'update_course', { course_id: 8, fullname: 'F' }],
  [{ kind: 'section.create', fields: { name: 'S', order: 2 } }, 'create_section', { course_id: 8, name: 'S', position: 2 }],
  [{ kind: 'section.update', parent_source_key: 'section:s', asset_stage_source_key: 'stage:p', fields: { name: 'S', order: 1 } },
    'update_section', { section_id: 31, name: 'S', filename: 'p.png', draft_item_id: 61 }],
  [{ kind: 'group.create', fields: { name: 'G' } }, 'create_group', { course_id: 8, name: 'G' }],
  [{ kind: 'group.update', target_id: 5, fields: { name: 'G' } }, 'update_group', { group_id: 5, name: 'G' }],
  [{ kind: 'grouping.create', fields: { name: 'GR' } }, 'create_grouping', { course_id: 8, name: 'GR' }],
  [{ kind: 'grouping.update', target_id: 6, fields: { name: 'GR' } }, 'update_grouping', { grouping_id: 6, name: 'GR' }],
  [{ kind: 'grouping.member.add', target_grouping_id: 6, target_group_id: 5 }, 'add_group_to_grouping',
    { grouping_id: 6, group_id: 5 }],
  [{ kind: 'module.create', parent_source_key: 'section:s', asset_stage_source_key: 'stage:p',
    fields: { module_type: 'page', name: 'P', visible: true, settings: { content: 'x' } } },
  'create_module', { section_number: 3, module_type: 'page', options: { content: 'x', visible: true, draft_item_id: 61, filename: 'p.png' } }],
  [{ kind: 'module.update', target_id: 41, fields: { name: 'M' } }, 'update_module', { module_id: 41, name: 'M' }],
  [{ kind: 'book_chapter.create', parent_source_key: 'module:m', after_source_key: 'chapter:c', fields: { title: 'T', order: 1 } },
    'create_book_chapter', { module_id: 41, title: 'T', after_chapter_id: 51 }],
  [{ kind: 'book_chapter.update', target_module_id: 41, target_id: 51, fields: { title: 'T', order: 0 } },
    'update_book_chapter', { module_id: 41, chapter_id: 51, title: 'T' }],
  [{ kind: 'page_content.update', target_id: 41, asset_stage_source_key: 'stage:p', fields: { content: 'x', content_format: 4 } },
    'update_page', { module_id: 41, content_format: 'markdown', draft_item_id: 61 }],
  [{ kind: 'label_content.update', target_id: 41, fields: { content: 'x', content_format: 0 } },
    'update_label', { content_format: 'moodle' }],
  [{ kind: 'url_content.update', target_id: 41, fields: { intro_format: 1, display: 'popup' } },
    'update_url', { intro_format: 'html', display: 6 }],
  [{ kind: 'assignment_content.update', parent_source_key: 'module:m', asset_stage_source_key: 'stage:p', file_area: 'intro',
    fields: { intro_format: 2, activity_format: 'html' } },
  'update_assignment', { module_id: 41, intro_format: 'plain', activity_format: 'html', file_area: 'intro' }],
  [{ kind: 'assignment_rubric.set', parent_source_key: 'module:m', fields: { name: 'R', criteria: [1] } },
    'set_assignment_rubric', { module_id: 41, criteria: { criteria: [1] } }],
  [{ kind: 'assignment_checklist.set', target_module_id: 41, fields: { items: [1] } },
    'set_assignment_checklist', { items: { items: [1] } }],
  [{ kind: 'assignment_guide.set', target_module_id: 41, fields: { criteria: [1] } },
    'set_assignment_marking_guide', { criteria: { criteria: [1] }, comments: { comments: [] } }],
  [{ kind: 'workshop_form.set', target_module_id: 41, fields: { strategy: 'rubric', definition: {} } },
    'set_workshop_grading_form', { strategy: 'rubric' }],
  [{ kind: 'database_field.create', target_module_id: 41, fields: { type: 'text', name: 'N', required: true } },
    'create_data_field', { field_type: 'text', name: 'N', required: true }],
  [{ kind: 'feedback_item.create', target_module_id: 41, dependency_source_key: 'item:f', fields: { type: 'textfield', name: 'Q' } },
    'create_feedback_item', { type: 'textfield', depend_item_id: 71 }],
  [{ kind: 'grade_item.create', fields: { name: 'Lab' } }, 'create_grade_item', { course_id: 8, name: 'Lab' }],
  [{ kind: 'grade_item.update', target_id: 9, fields: { grade_max: 10 } }, 'update_grade_item', { item_id: 9, grade_max: 10 }],
  [{ kind: 'course_completion.set',
    fields: { required_modules: [{ source_key: 'module:m' }, { target_id: 42 }], require_all_activities: true,
      required_course_grade_percent: 50, criteria_aggregation: 'all' } },
  'set_course_completion_criteria', { required_module_ids: [41, 42], required_course_grade_percent: 50 }],
  [{ kind: 'quiz_questions.import', target_module_id: 41, fields: { blueprint: { a: 1 } } },
    'import_question_bank_blueprint', { bank_scope: 'quiz_private', quiz_module_id: 41, blueprint_json: '{"a":1}' }],
  [{ kind: 'quiz_slot.create', target_module_id: 41, question_import_source_key: 'import:q', fields: { source_question_id: 1, slot: 1 } },
    'add_question_to_quiz', { quiz_module_id: 41, question_id: 91, slot: 1 }],
  [{ kind: 'quiz_slot.update', target_module_id: 41, fields: { slot: 1, max_mark: 2 } },
    'update_quiz_question_slot', { quiz_module_id: 41, max_mark: 2 }],
  [{ kind: 'lesson_page.create', target_module_id: 41, after_source_key: 'page:l',
    fields: { page_type: 'content', title: 'L', definition: { branches: [1] } } },
  'create_lesson_page', { branches: [1], after_page_id: 81 }],
  [{ kind: 'lesson_page.create', target_module_id: 41, fields: { page_type: 'multichoice', definition: { answers: { a: 1 } } } },
    'create_lesson_page', { answers: { a: 1 } }],
  [{ kind: 'question_bank.import', target_module_id: 41, fields: { blueprint: {} } },
    'import_question_bank_blueprint', { bank_scope: 'course_shared', question_bank_module_id: 41 }]
];

for (const [action, operation, expected] of dispatch) {
  test(`applySyncAction ${action.kind} calls ${operation}`, async () => {
    const { adapter, client } = await discovered();
    await adapter.applySyncAction(action, { courseId: 8, createdEntities: created });
    const [name, parameters] = client.calls.at(-1);
    assert.equal(name, operation);
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(parameters[field], value, field);
  });
}

test('applySyncAction resolves identities it was not given and reports what it cannot resolve', async () => {
  const { adapter, client } = await discovered({
    release: '0.1.214',
    responses: {
      get_course_contents: { sections: [{ section_number: 2, section_id: 32 }] },
      get_grade_items: { items: [{ course_module_id: 41, item_number: 0, item_id: 99 }] }
    }
  });
  const context = { courseId: 8, createdEntities: created };
  await adapter.applySyncAction({ kind: 'section.update', target_section_number: 2, fields: {} }, context);
  assert.equal(client.calls.at(-1)[1].section_id, 32);
  await adapter.applySyncAction({ kind: 'grade_item.update', module_source_key: 'module:m', fields: {} }, context);
  assert.equal(client.calls.at(-1)[1].item_id, 99);

  const failures = [
    [{ kind: 'section.update', target_section_number: 9, fields: {} }, /Cannot resolve destination section 9/],
    [{ kind: 'grouping.member.add', source_key: 'gm' }, /Cannot resolve grouping membership targets for gm/],
    [{ kind: 'module.create', source_key: 'mx', fields: {} }, /Cannot resolve the destination section for mx/],
    [{ kind: 'page_content.update', fields: { content_format: 4 } }, /Page content format cannot be represented/],
    [{ kind: 'label_content.update', fields: { content_format: 'markdown' } }, /label_content.update format cannot be represented/],
    [{ kind: 'assignment_content.update', fields: { activity_format: 0 } }, /Assignment content format cannot be represented/],
    [{ kind: 'grade_item.update', source_key: 'gx', module_source_key: 'module:none', fields: {} },
      /Cannot resolve destination grade item for gx/],
    [{ kind: 'course_completion.set', fields: { required_modules: [{ source_key: 'module:none' }] } },
      /Cannot resolve completion activity module:none/],
    [{ kind: 'quiz_slot.create', target_module_id: 41, fields: { source_question_id: 3 } }, /Cannot resolve imported Quiz question 3/],
    [{ kind: 'mystery.kind' }, /cannot apply sync action mystery.kind/]
  ];
  for (const [action, message] of failures) {
    await assert.rejects(adapter.applySyncAction(action, context), message, action.kind);
  }
});

test('asset helpers stage drafts, replace resources, publish Book files, and cap downloads', async () => {
  const { adapter, client } = await discovered();
  const materials = [
    { asset: { filename: 'a.png', filepath: '/' }, data: new Uint8Array(3) },
    { asset: { filename: 'b.png', filepath: '/' }, filePath: '/tmp/b.png' }
  ];
  const staged = await adapter.stageModuleAssets({}, materials);
  assert.equal(staged.draft_item_id, 77);
  assert.deepEqual(client.uploads.map((upload) => upload.itemId), [0, 77]);

  await adapter.replaceResourceAsset({ target_id: 41, asset: { filename: 'r.pdf', filepath: '/' }, fields: { name: 'R' } },
    new Uint8Array(5), { courseId: 8 });
  assert.deepEqual(client.calls.at(-1), ['update_resource', {
    course_id: 8, module_id: 41, filename: 'r.pdf', draft_item_id: 77, name: 'R'
  }]);

  await adapter.publishBookChapterAssets({ target_module_id: 41, parent_source_key: 'chapter:c', content: 'c', content_format: 1 },
    materials, { courseId: 8, createdEntities: created });
  assert.equal(client.calls.at(-1)[0], 'update_book_chapter');
  assert.equal(client.calls.at(-1)[1].chapter_id, 51);
  await assert.rejects(
    adapter.publishBookChapterAssets({ source_key: 'bx' }, materials, { courseId: 8 }),
    /Cannot resolve the destination Book chapter for bx/
  );

  assert.deepEqual((await adapter.downloadAsset({ url: 'u', filesize: 0 })).options, { maximumBytes: 1 });
  assert.deepEqual((await adapter.downloadAssetToFile({ url: 'u', filesize: 10 }, '/tmp/x')).options, { maximumBytes: 10 });
});

test('exportCourse reads Label, URL, Resource, Folder, Workshop, and Book authoring, and records unreadable parts', async () => {
  const file = (name) => ({ filename: name, filepath: '/', filesize: 3, url: `https://source.example/webservice/pluginfile.php/1/${name}?token=secret` });
  const activities = {
    11: { content: '<p>Label</p>', content_format: 4, files: [] },
    12: { external_url: 'https://moodle.org', intro: 'Go', intro_format: 1, display: 6, print_intro: 1, popup_width: 800 },
    13: { intro: 'File', intro_format: 1, display: 2, show_size: 1, filter_files: 2 },
    14: { intro: 'Folder', display: 1, show_expanded: 1 },
    15: { strategy: 'rubric', text_submission: 2, examples_mode: 1, phase: 20 },
    16: { numbering: 1, customtitles: 1 }
  };
  const client = {
    operationNames() { return []; },
    async callOperation(name, parameters) {
      switch (name) {
        case 'get_course_details':
          return { id: 7, fullname: 'Course', shortname: 'C', summary: '', visible: true };
        case 'get_course_contents':
          return {
            sections: [{
              section_id: 1, section_number: 0, name: 'General', summary: '', visible: true,
              modules: [
                { module_id: 11, module_type: 'label', name: 'L' },
                { module_id: 12, module_type: 'url', name: 'U' },
                { module_id: 13, module_type: 'resource', name: 'R' },
                { module_id: 14, module_type: 'folder', name: 'F' },
                { module_id: 15, module_type: 'workshop', name: 'W' },
                { module_id: 16, module_type: 'book', name: 'B' },
                { module_id: 17, module_type: 'page', name: 'Broken' },
                { module_id: 18, module_type: 'forum', name: 'Not exported' }
              ]
            }]
          };
        case 'get_module_details':
          if (parameters.module_id === 17) throw new Error('read failed');
          return { extra_json: JSON.stringify({ activity: activities[parameters.module_id] }) };
        case 'get_resource_files': return { files: [file('r.pdf')] };
        case 'get_folder_files': return { files: [file('f.txt')] };
        case 'get_workshop_grading_form': return { strategy: 'rubric', definition_json: '{"levels":4}', phase: 30 };
        case 'get_book_chapters':
          return { chapters: [{ chapter_id: 5, title: 'One', content: 'Text', files: [file('c.png')] }] };
        default:
          throw new Error(`${name} is unavailable on this site`);
      }
    },
    async downloadFile() { return new Uint8Array([1, 2, 3]); }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = { provider: 'moodlia', site_url: 'https://source.example', moodle_version: '5.3', operations: [], functions: [] };
  const exported = await adapter.exportCourse(7);
  const modules = Object.fromEntries(exported.sections[0].modules.map((module) => [module.source_id, module]));

  assert.deepEqual(modules[11].authoring.settings, { content: '<p>Label</p>', content_format: 4 });
  assert.equal(modules[12].authoring.settings.display, 'popup');
  assert.equal(modules[12].authoring.settings.popup_width, 800);
  assert.equal(modules[13].authoring.settings.display, 'download');
  assert.equal(modules[13].authoring.settings.filter_files, 'html');
  assert.equal(modules[13].authoring.files[0].url.includes('token'), false, 'download tokens are stripped');
  assert.equal(modules[13].authoring.files[0].sha256.length, 64);
  assert.equal(modules[14].authoring.settings.display, 'course');
  assert.equal(modules[15].authoring.settings.text_submission, 'required');
  assert.equal(modules[15].authoring.settings.examples_mode, 'before_submission');
  assert.equal(modules[15].authoring.phase, 30);
  assert.deepEqual(modules[15].authoring.grading_form, { strategy: 'rubric', definition: { levels: 4 } });
  assert.deepEqual(modules[16].authoring.settings, { numbering: 'numbers', custom_titles: true });
  assert.equal(modules[16].authoring.chapters[0].files[0].sha256.length, 64);
  assert.equal(modules[17].authoring_completeness, 'unavailable');
  assert.equal(modules[18].authoring ?? null, null, 'unsupported module types are not read');

  const scopes = exported.exclusions.map((entry) => `${entry.scope}:${entry.reason}`);
  for (const scope of ['groups', 'groupings', 'assignments', 'course_completion', 'gradebook']) {
    assert.ok(scopes.includes(`${scope}:source_read_unavailable`), scope);
  }
  assert.ok(scopes.includes('module:17:page_authoring_read_unavailable'));
});
