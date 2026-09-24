import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdaptiveSyncAdapter } from '../adaptive/adaptive-sync.mjs';
import { createMoodliaSyncAdapter } from '../adapters/moodlia-sync.mjs';


function adapter(provider, capabilities, model) {
  return {
    provider,
    async discoverSite() { return { provider, site_url: `https://${provider}.example` }; },
    async exportCourse() { return structuredClone(model); },
    async syncCapabilities() { return structuredClone(capabilities); },
    async applySyncAction(action) { return { provider, kind: action.kind }; }
  };
}

test('adaptive adapter prefers MoodlIA per capability and falls back to Core', async () => {
  const model = {
    schema_version: 1,
    extracted_at: '2026-01-01T00:00:00.000Z',
    digest: 'old',
    site: { provider: 'moodlia', site_url: 'https://example.test', profile: 'school' },
    course: { source_id: 1 },
    sections: [], groups: [], groupings: [], assets: [], exclusions: []
  };
  const moodlia = adapter('moodlia', {
    course_update: { available: true, supported_fields: ['summary'] },
    group_create: { available: false }
  }, model);
  const core = adapter('core', {
    course_update: { available: true, supported_fields: ['summary'] },
    group_create: { available: true, supported_fields: ['name'] }
  }, model);
  const adaptive = createAdaptiveSyncAdapter({ moodlia, core, profileName: 'school' });
  await adaptive.discoverSite();
  const capabilities = await adaptive.syncCapabilities();
  assert.equal(capabilities.course_update.provider, 'moodlia');
  assert.equal(capabilities.group_create.provider, 'core');
  assert.equal((await adaptive.applySyncAction({ kind: 'course.update' }, { courseId: 1 })).provider, 'moodlia');
  assert.equal((await adaptive.applySyncAction({ kind: 'group.create' }, { courseId: 1 })).provider, 'core');
});

test('adaptive adapter falls back when MoodlIA discovery fails', async () => {
  const core = adapter('core', { course_update: true }, {
    schema_version: 1,
    extracted_at: '2026-01-01T00:00:00.000Z',
    digest: 'old',
    site: { provider: 'core', site_url: 'https://example.test', profile: 'school' },
    course: { source_id: 1 },
    sections: [], groups: [], groupings: [], assets: [], exclusions: []
  });
  const moodlia = { async discoverSite() { throw new Error('not installed'); } };
  const adaptive = createAdaptiveSyncAdapter({ moodlia, core, profileName: 'school' });
  const discovery = await adaptive.discoverSite();
  assert.equal(discovery.providers.moodlia.available, false);
  assert.equal(discovery.providers.core.available, true);
  assert.equal((await adaptive.exportCourse(1)).site.selected_provider, 'core');
});

test('adaptive adapter routes binary sync work through the selected MoodlIA capability', async () => {
  const calls = [];
  const moodlia = {
    provider: 'moodlia',
    async discoverSite() { return { provider: 'moodlia' }; },
    async syncCapabilities() {
      return {
        module_asset_stage: { available: true },
        resource_asset_replace: { available: true },
        book_asset_transfer: { available: true }
      };
    },
    async downloadAsset(asset) { calls.push(['download', asset.filename]); return new Uint8Array([1]); },
    async stageModuleAssets() { calls.push(['stage']); return { draft_item_id: 2 }; },
    async replaceResourceAsset() { calls.push(['replace']); return { files: [] }; },
    async publishBookChapterAssets() { calls.push(['book']); return { files: [] }; }
  };
  const adapter = createAdaptiveSyncAdapter({ moodlia, profileName: 'school' });
  await adapter.discoverSite();
  await adapter.syncCapabilities({ courseId: 1 });
  await adapter.downloadAsset({ filename: 'file.pdf' });
  await adapter.stageModuleAssets({}, [], { courseId: 1 });
  await adapter.replaceResourceAsset({}, new Uint8Array(), { courseId: 1 });
  await adapter.publishBookChapterAssets({}, [], { courseId: 1 });
  assert.deepEqual(calls, [['download', 'file.pdf'], ['stage'], ['replace'], ['book']]);
});

test('MoodlIA grouping membership keeps the destination course context', async () => {
  const operations = [];
  const client = {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return { added: true };
    }
  };
  const moodlia = createMoodliaSyncAdapter({ client });
  const createdEntities = new Map([
    ['groups:group:1', { group_id: 21 }],
    ['groupings:grouping:1', { grouping_id: 34 }]
  ]);

  await moodlia.applySyncAction({
    kind: 'grouping.member.add',
    source_key: 'grouping:1:group:1',
    group_source_key: 'group:1',
    grouping_source_key: 'grouping:1'
  }, { courseId: 8, createdEntities });

  assert.deepEqual(operations, [{
    name: 'add_group_to_grouping',
    parameters: { course_id: 8, grouping_id: 34, group_id: 21 }
  }]);
});

test('Book chapter assets share one draft and publish once', async () => {
  const uploads = [];
  const operations = [];
  const client = {
    async uploadDraftData(data, options) {
      uploads.push({ data: [...data], options });
      return {
        draft_item_id: options.itemId || 41,
        filename: options.filename,
        filepath: options.filepath
      };
    },
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return { files: uploads.map((upload) => ({ ...upload.options, filesize: upload.data.length })) };
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  const action = {
    source_key: 'assets:chapter:3',
    parent_source_key: 'chapter:3',
    parent_module_source_key: 'module:2',
    content: '<p>Portable</p>',
    content_format: 1,
    assets: [
      { filename: 'hero.jpg', filepath: '/' },
      { filename: 'flow.svg', filepath: '/diagrams/' }
    ]
  };
  const createdEntities = new Map([
    ['modules:module:2', { module_id: 20 }],
    ['chapters:chapter:3', { chapter_id: 30 }]
  ]);

  await adapter.publishBookChapterAssets(action, [
    { asset: action.assets[0], data: new Uint8Array([1, 2]) },
    { asset: action.assets[1], data: new Uint8Array([3]) }
  ], { courseId: 10, createdEntities });

  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].options.itemId, 0);
  assert.equal(uploads[1].options.itemId, 41);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].name, 'update_book_chapter');
  assert.equal(operations[0].parameters.draft_item_id, 41);
  assert.equal(operations[0].parameters.filename, 'hero.jpg');
});

test('Label and URL sync actions reuse one staged editor draft', async () => {
  const operations = [];
  const client = {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return { module_id: parameters.module_id };
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  const createdEntities = new Map([['drafts:draft:module:20', {
    draft_item_id: 77,
    files: [{ filename: 'hero image.jpg', filepath: '/' }]
  }]]);

  await adapter.applySyncAction({
    kind: 'label_content.update',
    target_id: 40,
    asset_stage_source_key: 'draft:module:20',
    fields: { content: '<img src="@@PLUGINFILE@@/hero%20image.jpg">', content_format: 1 }
  }, { courseId: 8, createdEntities });
  await adapter.applySyncAction({
    kind: 'url_content.update',
    target_id: 41,
    fields: {
      name: 'Reference', external_url: 'https://example.org', intro: '<p>Reference</p>',
      intro_format: 'html', display: 'popup', popup_width: 720, popup_height: 480
    }
  }, { courseId: 8, createdEntities });

  assert.equal(operations[0].name, 'update_label');
  assert.equal(operations[0].parameters.draft_item_id, 77);
  assert.equal(operations[0].parameters.filename, 'hero image.jpg');
  assert.equal(operations[0].parameters.content_format, 'html');
  assert.equal(operations[1].name, 'update_url');
  assert.equal(operations[1].parameters.display, 6);
  assert.equal(operations[1].parameters.intro_format, 'html');
});

test('section and assignment sync actions publish staged editor drafts', async () => {
  const operations = [];
  const client = {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return name === 'update_section' ? { section_id: parameters.section_id } : { module_id: parameters.module_id };
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  const createdEntities = new Map([
    ['sections:section:10', { section_id: 90, section_number: 1 }],
    ['modules:module:20', { module_id: 80 }],
    ['drafts:draft:section:10', {
      draft_item_id: 70,
      files: [{ filename: 'section hero.jpg', filepath: '/media/' }]
    }],
    ['drafts:draft:intro:module:20', {
      draft_item_id: 71,
      files: [{ filename: 'assignment hero.jpg', filepath: '/' }]
    }]
  ]);

  await adapter.applySyncAction({
    kind: 'section.update',
    source_key: 'content:section:10',
    parent_source_key: 'section:10',
    target_id: null,
    target_section_number: 1,
    asset_stage_source_key: 'draft:section:10',
    fields: { summary: '<img src="@@PLUGINFILE@@/media/section hero.jpg">', summary_format: 'html' }
  }, { courseId: 8, createdEntities });
  await adapter.applySyncAction({
    kind: 'assignment_content.update',
    source_key: 'intro:module:20',
    parent_source_key: 'module:20',
    target_id: null,
    file_area: 'intro',
    asset_stage_source_key: 'draft:intro:module:20',
    fields: { intro: '<img src="@@PLUGINFILE@@/assignment hero.jpg">', intro_format: 1 }
  }, { courseId: 8, createdEntities });

  assert.equal(operations[0].name, 'update_section');
  assert.equal(operations[0].parameters.section_id, 90);
  assert.equal(operations[0].parameters.draft_item_id, 70);
  assert.equal(operations[0].parameters.filename, 'section hero.jpg');
  assert.equal(operations[1].name, 'update_assignment');
  assert.equal(operations[1].parameters.module_id, 80);
  assert.equal(operations[1].parameters.file_area, 'intro');
  assert.equal(operations[1].parameters.draft_item_id, 71);
  assert.equal(operations[1].parameters.intro_format, 'html');
});

test('MoodlIA export produces portable section and assignment editor manifests', async () => {
  const sectionFile = {
    filename: 'section.jpg', filepath: '/', filesize: 3, mimetype: 'image/jpeg',
    content_hash: 'section-hash', url: 'https://source.example/pluginfile.php/1/course/section/10/section.jpg'
  };
  const introFile = {
    filename: 'intro.png', filepath: '/media/', filesize: 4, mimetype: 'image/png',
    content_hash: 'intro-hash', url: 'https://source.example/pluginfile.php/2/mod_assign/intro/0/media/intro.png'
  };
  const pageFile = {
    filename: 'hero ünicode.png', filepath: '/', filesize: 2, mimetype: 'image/png',
    content_hash: 'page-hash',
    url: 'https://source.example/moodle/webservice/pluginfile.php/3/mod_page/content/2/hero%20%C3%BCnicode.png'
  };
  const client = {
    async callOperation(name) {
      if (name === 'get_course_details') return {
        course_id: 7,
        fullname: 'Course',
        shortname: 'COURSE',
        summary: '<div class="no-overflow"><p>Portable summary</p></div>'
      };
      if (name === 'get_course_contents') return {
        sections: [{
          section_id: 10, section_number: 0, name: 'General', visible: true,
          summary: '<img src="https://source.example/pluginfile.php/1/course/section/10/section.jpg">',
          summary_raw: '<img src="@@PLUGINFILE@@/section.jpg">', summary_format: 'html',
          summary_files: [sectionFile],
          modules: [
            { module_id: 20, instance_id: 30, module_type: 'assign', name: 'Task', visible: true },
            { module_id: 21, instance_id: 31, module_type: 'qbank', name: 'Shared bank', visible: true },
            { module_id: 22, instance_id: 32, module_type: 'page', name: 'Portable Page', visible: true }
          ]
        }]
      };
      if (name === 'get_groups') return { groups: [] };
      if (name === 'get_groupings') return { groupings: [] };
      if (name === 'get_course_assignments') return { assignments: [{
        module_id: 20, name: 'Task', intro: '<img src="@@PLUGINFILE@@/media/intro.png">', intro_format: 1,
        intro_files: [introFile], activity: '', activity_format: 1, activity_files: [],
        submission_plugins: [], feedback_plugins: []
      }] };
      if (name === 'get_course_completion_criteria') return {
        course_completion_enabled: true, criteria_locked: false,
        criteria_aggregation: 'all', activity_aggregation: 'all', required_module_ids: [20],
        grade_criterion_enabled: true, required_course_grade_percent: 80
      };
      if (name === 'get_assignment_grading_form') return {
        active_method: 'guide', supported: true, name: 'Guide', description: '', options_json: '{}',
        criteria: [{
          sort_order: 1, shortname: 'Accuracy', description: 'Accuracy',
          description_markers: 'Marker guidance', max_score: 10
        }],
        comments: [{ sort_order: 1, description: 'Well supported' }]
      };
      if (name === 'export_question_bank_blueprint') return {
        skipped_question_count: 0,
        blueprint_json: JSON.stringify({
          schema: 'moodlia.question_bank_blueprint.v1', exported_at: 100, source_course_id: 7,
          bank_scope: 'course_shared', context_id: 99, question_bank_module_id: 21,
          categories: [{
            source_category_id: 501, source_parent_id: 0, name: 'Questions',
            questions: [{
              source_question_id: 900, question_type: 'truefalse', name: 'Earth',
              question_text: '<p>Round?</p>', options: { correct_answer: true }
            }]
          }]
        })
      };
      if (name === 'get_module_details') return {
        extra_json: JSON.stringify({ activity: {
          content: '<img src="https://source.example/moodle/webservice/pluginfile.php/3/mod_page/content/2/hero%20%C3%BCnicode.png">',
          content_format: 1,
          print_intro: false,
          print_last_modified: false,
          files: [pageFile]
        } })
      };
      throw new Error(`Unexpected operation ${name}`);
    },
    async downloadFile(url) {
      return new Uint8Array(url.includes('section.jpg') ? [1, 2, 3] : [4, 5, 6, 7]);
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = {
    provider: 'moodlia', site_url: 'https://source.example', moodle_version: '5.3',
    plugin_version: '0.1.211', operations: [], functions: []
  };
  const exported = await adapter.exportCourse(7);
  assert.equal(exported.course.summary, '<p>Portable summary</p>');
  assert.equal(exported.sections[0].summary, '<img src="@@PLUGINFILE@@/section.jpg">');
  assert.equal(exported.sections[0].files[0].sha256.length, 64);
  assert.equal(exported.sections[0].modules[0].authoring.content.intro_files[0].sha256.length, 64);
  assert.equal(exported.sections[0].modules[0].authoring.grading_definition.method, 'guide');
  assert.equal(exported.sections[0].modules[1].authoring.blueprint.categories[0].source_category_id, 1);
  assert.equal(exported.sections[0].modules[1].authoring.blueprint.categories[0].questions[0].source_question_id, 1);
  assert.equal(
    exported.sections[0].modules[2].authoring.settings.content,
    '<img src="@@PLUGINFILE@@/hero%20%C3%BCnicode.png">'
  );
  assert.equal(exported.sections[0].modules[2].authoring.files[0].sha256.length, 64);
  assert.equal(exported.course_completion.required_modules[0].source_key, 'module:20');
  assert.equal(exported.course_completion.required_course_grade_percent, 80);
  assert.deepEqual(exported.assets.map((asset) => asset.owner.file_area), ['section', 'intro', 'content']);
});

test('MoodlIA export canonicalizes decoded and pre-normalized plugin file references', async () => {
  const pageFile = {
    filename: 'hero ünicode.png', filepath: '/nested (v2)/', filesize: 2, mimetype: 'image/png',
    content_hash: 'page-hash',
    url: 'https://target.example/webservice/pluginfile.php/16/mod_page/content/2/nested%20(v2)/hero%20%C3%BCnicode.png'
  };
  const client = {
    async callOperation(name) {
      if (name === 'get_course_details') return {
        course: { id: 3, fullname: 'Target', shortname: 'TARGET', category_id: 1, summary: '', summary_format: 1, visible: true, start_date: 0, end_date: 0 }
      };
      if (name === 'get_course_contents') return {
        sections: [{
          section_id: 30, section_number: 0, name: 'General', summary: '', summary_format: 1, visible: true,
          modules: [{ module_id: 40, name: 'Portable Page', module_type: 'page', visible: true }]
        }]
      };
      if (name === 'get_module_details') return {
        extra_json: JSON.stringify({ activity: {
          content: [
            '<img src="https://target.example/webservice/pluginfile.php/16/mod_page/content/2/nested (v2)/hero ünicode.png">',
            '<img src="/pluginfile.php/16/mod_page/content/2/nested%20(v2)/hero%20%C3%BCnicode.png">',
            '<img src="@@PLUGINFILE@@/nested (v2)/hero ünicode.png">',
            '<img src="@@PLUGINFILE@@/nested%20%28v2%29/hero%20%C3%BCnicode.png">'
          ].join(''),
          content_format: 1,
          print_intro: false,
          print_last_modified: false,
          files: [pageFile]
        } })
      };
      throw new Error(`Unexpected operation ${name}`);
    },
    async downloadFile() {
      return new Uint8Array([4, 5]);
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = {
    provider: 'moodlia', site_url: 'https://target.example', moodle_version: '5.3',
    plugin_version: '0.1.213', operations: [], functions: []
  };
  const exported = await adapter.exportCourse(3);
  const page = exported.sections[0].modules[0];
  assert.equal(
    page.authoring.settings.content,
    '<img src="@@PLUGINFILE@@/nested%20%28v2%29/hero%20%C3%BCnicode.png">'.repeat(4)
  );
  assert.equal(page.authoring.files[0].filepath, '/nested (v2)/');
  assert.equal(page.authoring.files[0].filename, 'hero ünicode.png');
});

test('assignment grading-definition actions use the canonical wrapped payloads', async () => {
  const operations = [];
  const client = {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return { active_method: name };
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  const createdEntities = new Map([['modules:module:20', { module_id: 80 }]]);
  await adapter.applySyncAction({
    kind: 'assignment_rubric.set', parent_source_key: 'module:20', target_module_id: null,
    fields: { name: 'Rubric', description: '', criteria: [{ description: 'Quality', levels: [] }], options: {} }
  }, { courseId: 8, createdEntities });
  await adapter.applySyncAction({
    kind: 'assignment_checklist.set', parent_source_key: 'module:20', target_module_id: null,
    fields: { name: 'Checklist', description: '', items: [{ description: 'Evidence', score: 5 }] }
  }, { courseId: 8, createdEntities });
  await adapter.applySyncAction({
    kind: 'assignment_guide.set', parent_source_key: 'module:20', target_module_id: null,
    fields: {
      name: 'Guide', description: '', criteria: [{ shortname: 'Accuracy', max_score: 10 }],
      comments: [{ description: 'Strong' }], options: {}
    }
  }, { courseId: 8, createdEntities });
  assert.deepEqual(operations.map((entry) => entry.name), [
    'set_assignment_rubric', 'set_assignment_checklist', 'set_assignment_marking_guide'
  ]);
  assert.ok(Array.isArray(operations[0].parameters.criteria.criteria));
  assert.ok(Array.isArray(operations[1].parameters.items.items));
  assert.ok(Array.isArray(operations[2].parameters.criteria.criteria));
  assert.ok(Array.isArray(operations[2].parameters.comments.comments));
});

test('question-bank import resolves a newly created bank without exposing source ids as parameters', async () => {
  const operations = [];
  const client = {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return { created_question_count: 1 };
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  const blueprint = {
    schema: 'moodlia.question_bank_blueprint.v1', bank_scope: 'course_shared', categories: []
  };
  await adapter.applySyncAction({
    kind: 'question_bank.import', parent_source_key: 'module:20', target_module_id: null,
    fields: { blueprint }
  }, {
    courseId: 8,
    createdEntities: new Map([['modules:module:20', { module_id: 80 }]])
  });
  assert.equal(operations[0].name, 'import_question_bank_blueprint');
  assert.equal(operations[0].parameters.question_bank_module_id, 80);
  assert.deepEqual(JSON.parse(operations[0].parameters.blueprint_json), blueprint);
});

test('MoodlIA export normalizes a Quiz private bank and slot identities', async () => {
  const client = {
    async callOperation(name) {
      if (name === 'get_course_details') return { course_id: 7, fullname: 'Course', shortname: 'COURSE' };
      if (name === 'get_course_contents') return { sections: [{
        section_id: 10, section_number: 0, name: 'General', summary: '', summary_files: [],
        modules: [{ module_id: 20, instance_id: 30, module_type: 'quiz', name: 'Quiz', visible: true }]
      }] };
      if (name === 'get_groups') return { groups: [] };
      if (name === 'get_groupings') return { groupings: [] };
      if (name === 'get_course_assignments') return { assignments: [] };
      if (name === 'get_course_completion_criteria') return { course_completion_enabled: false };
      if (name === 'get_module_details') return { extra_json: JSON.stringify({ activity: {
        questionsperpage: 1, grademethod: 1, grade: 10, browsersecurity: '-', showuserpicture: 0
      } }) };
      if (name === 'export_question_bank_blueprint') return {
        skipped_question_count: 0,
        blueprint_json: JSON.stringify({
          schema: 'moodlia.question_bank_blueprint.v1', bank_scope: 'quiz_private',
          categories: [{
            source_category_id: 400, source_parent_id: 0, name: 'Private',
            questions: [{
              source_question_id: 900, question_type: 'truefalse', name: 'Earth',
              question_text: '<p>Round?</p>', options: { correct_answer: true }
            }]
          }]
        })
      };
      if (name === 'get_quiz_questions') return { questions: [{
        slot: 1, question_id: 900, page: 1, maxmark: 2
      }] };
      throw new Error(`Unexpected operation ${name}`);
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = {
    provider: 'moodlia', site_url: 'https://source.example', moodle_version: '5.3',
    plugin_version: '0.1.211', operations: [], functions: []
  };
  const exported = await adapter.exportCourse(7);
  const quiz = exported.sections[0].modules[0];
  assert.equal(quiz.authoring_completeness, 'complete');
  assert.equal(quiz.authoring.blueprint.categories[0].questions[0].source_question_id, 1);
  assert.deepEqual(quiz.authoring.slots, [{ source_question_id: 1, slot: 1, page: 1, max_mark: 2 }]);
  assert.ok(quiz.authoring.losses.includes('quiz_review_and_access_configuration_not_exported'));
});

test('Quiz definition actions resolve imported questions without source Moodle ids', async () => {
  const operations = [];
  const client = {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      if (name === 'import_question_bank_blueprint') {
        return { created_questions_json: JSON.stringify([{ question_id: 700 }]) };
      }
      if (name === 'add_question_to_quiz') return { slot_id: 800, slot: 1, question_id: 700 };
      return { updated: true, slot: 1, maxmark: 2 };
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  const createdEntities = new Map([['modules:module:20', { module_id: 80 }]]);
  const imported = await adapter.applySyncAction({
    kind: 'quiz_questions.import', parent_source_key: 'module:20',
    fields: { blueprint: { schema: 'moodlia.question_bank_blueprint.v1', categories: [] } }
  }, { courseId: 8, createdEntities });
  createdEntities.set('question_imports:quiz-questions:module:20', imported);
  await adapter.applySyncAction({
    kind: 'quiz_slot.create', parent_source_key: 'module:20',
    question_import_source_key: 'quiz-questions:module:20',
    fields: { source_question_id: 1, slot: 1 }
  }, { courseId: 8, createdEntities });
  await adapter.applySyncAction({
    kind: 'quiz_slot.update', module_source_key: 'module:20',
    fields: { slot: 1, max_mark: 2 }
  }, { courseId: 8, createdEntities });
  assert.deepEqual(operations.map((entry) => entry.name), [
    'import_question_bank_blueprint', 'add_question_to_quiz', 'update_quiz_question_slot'
  ]);
  assert.equal(operations[0].parameters.bank_scope, 'quiz_private');
  assert.equal(operations[1].parameters.question_id, 700);
  assert.equal(operations[1].parameters.quiz_module_id, 80);
  assert.equal(operations[2].parameters.max_mark, 2);
});

test('MoodlIA export normalizes portable Lesson definitions', async () => {
  const client = {
    async callOperation(name) {
      if (name === 'get_course_details') return { course_id: 7, fullname: 'Course', shortname: 'COURSE' };
      if (name === 'get_course_contents') return { sections: [{
        section_id: 10, section_number: 0, name: 'General', summary: '', summary_files: [],
        modules: [{ module_id: 20, instance_id: 30, module_type: 'lesson', name: 'Lesson', visible: true }]
      }] };
      if (name === 'get_groups') return { groups: [] };
      if (name === 'get_groupings') return { groupings: [] };
      if (name === 'get_course_assignments') return { assignments: [] };
      if (name === 'get_course_completion_criteria') return { course_completion_enabled: false };
      if (name === 'get_module_details') return { extra_json: JSON.stringify({ activity: {
        max_answers: 4, grade: 100, retakes_allowed: true, completion_end_reached: true
      } }) };
      if (name === 'get_lesson_pages') return { pages: [{
        page_id: 500, page_type: 'content', title: 'Start', content: '<p>Choose.</p>',
        content_format: 1, display_in_menu_block: true, layout: 0, files_count: 0,
        definition_json: JSON.stringify({ branches: [{ title: 'Next', jump_to: -1, score: 0 }] })
      }] };
      throw new Error(`Unexpected operation ${name}`);
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = {
    provider: 'moodlia', site_url: 'https://source.example', moodle_version: '5.3',
    plugin_version: '0.1.211', operations: [], functions: []
  };
  const exported = await adapter.exportCourse(7);
  const lesson = exported.sections[0].modules[0];
  assert.equal(lesson.authoring_completeness, 'complete');
  assert.equal(lesson.authoring.pages[0].source_page_id, 1);
  assert.equal(lesson.authoring.pages[0].definition.branches[0].jump_to, -1);
});

test('Lesson page actions resolve module and previous-page identities', async () => {
  const operations = [];
  const adapter = createMoodliaSyncAdapter({ client: {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return { page_id: 701 };
    }
  } });
  await adapter.applySyncAction({
    kind: 'lesson_page.create', parent_source_key: 'module:20',
    after_source_key: 'lesson-page:module:20:1',
    fields: {
      page_type: 'content', title: 'Second', content: '<p>Continue.</p>', content_format: 1,
      definition: { branches: [{ title: 'Finish', jump_to: -9, score: 0 }] },
      display_in_menu: true, horizontal: false
    }
  }, {
    courseId: 8,
    createdEntities: new Map([
      ['modules:module:20', { module_id: 80 }],
      ['lesson_pages:lesson-page:module:20:1', { page_id: 700 }]
    ])
  });
  assert.equal(operations[0].name, 'create_lesson_page');
  assert.equal(operations[0].parameters.module_id, 80);
  assert.equal(operations[0].parameters.after_page_id, 700);
  assert.deepEqual(operations[0].parameters.branches, [{ title: 'Finish', jump_to: -9, score: 0 }]);
  assert.equal(operations[0].parameters.answers, undefined);
});

test('MoodlIA export normalizes Database fields and Feedback item dependencies', async () => {
  const client = {
    async callOperation(name, parameters = {}) {
      if (name === 'get_course_details') return { course_id: 7, fullname: 'Course', shortname: 'COURSE' };
      if (name === 'get_course_contents') return { sections: [{
        section_id: 10, section_number: 0, name: 'General', summary: '', summary_files: [], modules: [
          { module_id: 20, instance_id: 30, module_type: 'data', name: 'Database', visible: true },
          { module_id: 21, instance_id: 31, module_type: 'feedback', name: 'Survey', visible: true }
        ]
      }] };
      if (name === 'get_groups') return { groups: [] };
      if (name === 'get_groupings') return { groupings: [] };
      if (name === 'get_course_assignments') return { assignments: [] };
      if (name === 'get_module_details') return {
        extra_json: JSON.stringify({ activity: parameters.module_id === 20
          ? { comments: true, default_sort_field_id: 0, default_sort_direction: 0 }
          : { anonymous: 1, completion_submit: true } })
      };
      if (name === 'get_data_fields') return { fields: [{
        field_id: 500, type: 'menu', name: 'Topic', description: '', required: true,
        params_json: JSON.stringify({ param1: 'A\nB' })
      }] };
      if (name === 'get_feedback_items') return { items: [{
        item_id: 600, type: 'multichoice', name: 'Useful?', presentation: 'r>>>>>Yes|No<<<<<0',
        options: 'i', position: 1, label: '', required: true, depend_item_id: 0, depend_value: ''
      }, {
        item_id: 601, type: 'textfield', name: 'Why?', presentation: '30|255', options: '',
        position: 2, label: '', required: false, depend_item_id: 600, depend_value: 'Yes'
      }] };
      throw new Error(`Unexpected operation ${name}`);
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = {
    provider: 'moodlia', site_url: 'https://source.example', moodle_version: '5.3',
    plugin_version: '0.1.211', operations: [], functions: []
  };
  const exported = await adapter.exportCourse(7);
  const [database, feedback] = exported.sections[0].modules;
  assert.deepEqual(database.authoring.fields[0], {
    source_field_id: 1, type: 'menu', name: 'Topic', description: '', required: true,
    options: { param1: 'A\nB' }
  });
  assert.equal(feedback.authoring.items[0].definition.subtype, 'radio');
  assert.deepEqual(feedback.authoring.items[0].definition.choices, ['Yes', 'No']);
  assert.equal(feedback.authoring.items[1].source_depend_item_id, 1);
});

test('definition actions resolve new modules and Feedback dependencies', async () => {
  const operations = [];
  const adapter = createMoodliaSyncAdapter({ client: {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return name === 'create_data_field' ? { field_id: 501 } : { item_id: 602 };
    }
  } });
  const createdEntities = new Map([
    ['modules:module:20', { module_id: 80 }],
    ['modules:module:21', { module_id: 81 }],
    ['feedback_items:feedback-item:module:21:1', { item_id: 601 }]
  ]);
  await adapter.applySyncAction({
    kind: 'database_field.create', parent_source_key: 'module:20',
    fields: { type: 'text', name: 'Topic', description: '', required: true, options: {} }
  }, { courseId: 8, createdEntities });
  await adapter.applySyncAction({
    kind: 'feedback_item.create', parent_source_key: 'module:21',
    dependency_source_key: 'feedback-item:module:21:1',
    fields: {
      type: 'textfield', name: 'Why?', definition: { size: 30, max_length: 255 },
      position: 2, label: '', required: false, source_depend_item_id: 1, depend_value: 'Yes'
    }
  }, { courseId: 8, createdEntities });
  assert.equal(operations[0].name, 'create_data_field');
  assert.equal(operations[0].parameters.module_id, 80);
  assert.equal(operations[1].name, 'create_feedback_item');
  assert.equal(operations[1].parameters.module_id, 81);
  assert.equal(operations[1].parameters.depend_item_id, 601);
  assert.equal(operations[1].parameters.source_depend_item_id, undefined);
});

test('course completion actions resolve destination activity ids', async () => {
  const operations = [];
  const adapter = createMoodliaSyncAdapter({ client: {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      return { required_module_ids: parameters.required_module_ids };
    }
  } });
  await adapter.applySyncAction({
    kind: 'course_completion.set',
    fields: {
      required_modules: [
        { source_key: 'module:20', target_id: null },
        { source_key: 'module:21', target_id: 91 }
      ],
      require_all_activities: true,
      required_course_grade_percent: 80,
      criteria_aggregation: 'all'
    }
  }, {
    courseId: 8,
    createdEntities: new Map([['modules:module:20', { module_id: 90 }]])
  });
  assert.equal(operations[0].name, 'set_course_completion_criteria');
  assert.deepEqual(operations[0].parameters.required_module_ids, [90, 91]);
  assert.equal(operations[0].parameters.required_course_grade_percent, 80);
});

test('MoodlIA export normalizes portable root gradebook items', async () => {
  const client = {
    async callOperation(name) {
      if (name === 'get_course_details') return { course_id: 7, fullname: 'Course', shortname: 'COURSE' };
      if (name === 'get_course_contents') return { sections: [{
        section_id: 10, section_number: 0, name: 'General', summary: '', summary_files: [],
        modules: [{ module_id: 20, instance_id: 30, module_type: 'page', name: 'Page', visible: true }]
      }] };
      if (name === 'get_groups') return { groups: [] };
      if (name === 'get_groupings') return { groupings: [] };
      if (name === 'get_course_assignments') return { assignments: [] };
      if (name === 'get_course_completion_criteria') return { course_completion_enabled: false };
      if (name === 'get_module_details') return { extra_json: JSON.stringify({ activity: {
        content: '<p>Read.</p>', content_format: 1, files: []
      } }) };
      if (name === 'get_grade_categories') return { categories: [{ category_id: 100, total_item_id: 400 }] };
      if (name === 'get_grade_items') return { items: [
        { item_id: 400, item_type: 'course', category_id: 100 },
        {
          item_id: 401, item_type: 'manual', category_id: 100, name: 'Participation',
          grade_min: 0, grade_max: 10, grade_pass: 5, hidden: false
        },
        {
          item_id: 402, item_type: 'mod', category_id: 100, course_module_id: 20,
          item_number: 0, name: 'Page', grade_min: 0, grade_max: 100, grade_pass: 80,
          hidden: false, locked: false, weight: 0, weight_overridden: false
        }
      ] };
      throw new Error(`Unexpected operation ${name}`);
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = {
    provider: 'moodlia', site_url: 'https://source.example', moodle_version: '5.3',
    plugin_version: '0.1.211', operations: [], functions: []
  };
  const exported = await adapter.exportCourse(7);
  assert.equal(exported.gradebook.losses.length, 0);
  assert.equal(exported.gradebook.items[0].kind, 'manual');
  assert.equal(exported.gradebook.items[0].remote_item_id, 401);
  assert.equal(exported.gradebook.items[1].module_source_key, 'module:20');
});

test('gradebook actions resolve newly created activity grade items', async () => {
  const operations = [];
  const adapter = createMoodliaSyncAdapter({ client: {
    async callOperation(name, parameters) {
      operations.push({ name, parameters });
      if (name === 'get_grade_items') return { items: [{ item_id: 700, course_module_id: 80, item_number: 0 }] };
      return name === 'create_grade_item' ? { item_id: 701 } : { item_id: parameters.item_id };
    }
  } });
  const createdEntities = new Map([['modules:module:20', { module_id: 80 }]]);
  await adapter.applySyncAction({
    kind: 'grade_item.create', fields: {
      name: 'Participation', grade_min: 0, grade_max: 10, grade_pass: 5, hidden: false
    }
  }, { courseId: 8, createdEntities });
  await adapter.applySyncAction({
    kind: 'grade_item.update', source_key: 'grade-item:module:20:0',
    module_source_key: 'module:20', item_number: 0, target_id: null,
    fields: { grade_pass: 80, hidden: false, locked: false }
  }, { courseId: 8, createdEntities });
  assert.deepEqual(operations.map((entry) => entry.name), [
    'create_grade_item', 'get_grade_items', 'update_grade_item'
  ]);
  assert.equal(operations[2].parameters.item_id, 700);
  assert.equal(operations[2].parameters.grade_pass, 80);
});

test('group visibility compares by name across Core numbers and MoodlIA names', async () => {
  const { createCourseSyncModel, normalizeGroupVisibility } = await import('../sync/model.mjs');
  assert.equal(normalizeGroupVisibility(1), 'members');
  assert.equal(normalizeGroupVisibility('3'), 'none');
  assert.equal(normalizeGroupVisibility('own'), 'own');
  assert.equal(normalizeGroupVisibility(null), null);
  const site = { provider: 'core', functions: [], operations: [] };
  const course = { id: 1, fullname: 'C', shortname: 'C' };
  const fromCore = createCourseSyncModel({ site, course, groups: [{ id: 5, name: 'G', visibility: 1, participation: 1 }] });
  const fromPlugin = createCourseSyncModel({ site, course, groups: [{ group_id: 5, name: 'G', visibility: 'members', participation: true }] });
  assert.deepEqual(fromCore.groups[0].visibility, fromPlugin.groups[0].visibility);
  assert.equal(fromCore.groups[0].participation, true);
});

test('Core applies named group visibility as the Moodle constant', async () => {
  const { createCoreSyncAdapter } = await import('../adapters/core-sync.mjs');
  const calls = [];
  const adapter = createCoreSyncAdapter({
    client: { callOperation: async (name, parameters) => { calls.push({ name, parameters }); return { id: 9 }; } }
  });
  await adapter.applySyncAction({ kind: 'group.create', fields: { name: 'G', visibility: 'own', participation: false } }, { courseId: 3 });
  await adapter.applySyncAction({ kind: 'group.update', target_id: 9, fields: { visibility: 'members' } }, { courseId: 3 });
  assert.deepEqual(calls.map((call) => call.parameters.visibility), [2, 1]);
  assert.equal(calls[0].parameters.course_id, 3);
});

test('MoodlIA declares group visibility and participation only from plugin 0.1.215', () => {
  const adapter = createMoodliaSyncAdapter({ client: { operationNames: () => [] } });
  adapter.discovery = { plugin_release: '0.1.214' };
  assert.deepEqual(adapter.groupFields(), ['name', 'description', 'idnumber']);
  adapter.discovery = { plugin_release: '0.1.215' };
  assert.ok(adapter.groupFields().includes('visibility'));
  adapter.discovery = { plugin_release: '0.2.0' };
  assert.ok(adapter.groupFields().includes('participation'));
});
