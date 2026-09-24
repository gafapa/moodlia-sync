import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { contentDigest } from 'moodlia/core/canonical';
import { selectedCourseFields } from '../sync/model.mjs';
import { currentEntityDigest, verifyResults, withAssetMaterials } from '../sync/engine.mjs';

const asset = { filepath: '/', filename: 'a.png', sha256: 'aa' };

// A target read-back model that satisfies every case below; each failing case changes one thing.
function targetModel() {
  return {
    course: { source_id: 1, fullname: 'Course', summary: 'Summary' },
    sections: [{
      source_id: 10,
      name: 'Week 1',
      files: [asset],
      modules: [
        {
          source_id: 100, module_type: 'assign', name: 'Essay', visible: true,
          authoring: {
            settings: { grade: 10 },
            files: [asset],
            content: { intro: 'Write', intro_files: [asset] },
            grading_definition: { method: 'rubric', criteria: [{ description: 'Clarity' }] }
          }
        },
        { source_id: 101, module_type: 'page', name: 'Page', authoring: { settings: { content: 'Body' }, files: [asset] } },
        { source_id: 102, module_type: 'url', name: 'Link', authoring: { settings: { externalurl: 'https://moodle.org' }, files: [] } },
        {
          source_id: 103, module_type: 'book', name: 'Book',
          authoring: {
            chapters: [{
              chapter_id: 500, title: 'One', content: 'Text', content_format: 1, subchapter: false, hidden: false, page_number: 1
            }]
          }
        },
        { source_id: 104, module_type: 'workshop', name: 'Workshop', authoring: { grading_form: { strategy: 'accumulative' } } },
        {
          source_id: 105, module_type: 'data', name: 'Data',
          authoring: {
            fields: [{ source_field_id: 7, type: 'text', name: 'Title', description: '', required: true, options: {} }]
          }
        },
        {
          source_id: 106, module_type: 'feedback', name: 'Feedback',
          authoring: {
            items: [{
              source_item_id: 8, type: 'textfield', name: 'Name', definition: { size: 20 }, position: 1,
              label: 'name', required: false, source_depend_item_id: 0, depend_value: ''
            }]
          }
        },
        { source_id: 107, module_type: 'qbank', name: 'Bank', authoring: { blueprint: { categories: ['A'] } } },
        {
          source_id: 108, module_type: 'lesson', name: 'Lesson',
          authoring: {
            pages: [{
              source_page_id: 9, page_type: 'content', title: 'Intro', content: 'Hello', content_format: 1,
              definition: { branches: [] }, display_in_menu: true, horizontal: true
            }]
          }
        },
        {
          source_id: 109, module_type: 'quiz', name: 'Quiz',
          authoring: { blueprint: { questions: 1 }, slots: [{ slot: 1, source_question_id: 3, max_mark: 2 }] }
        },
        { source_id: 110, module_type: 'label', name: 'Label', authoring: { settings: { intro: 'Note' }, files: [asset] } }
      ]
    }],
    groups: [{ source_id: 20, sync_key: 'group:g1', name: 'Team' }],
    groupings: [{ source_id: 30, name: 'Teams', group_source_keys: ['group:g1'] }],
    course_completion: {
      required_modules: [{ source_module_id: 100 }],
      activity_aggregation: 'all',
      criteria_aggregation: 'all',
      required_course_grade_percent: 50
    },
    gradebook: {
      items: [
        { remote_item_id: 70, kind: 'manual', name: 'Lab', grademax: 10 },
        { remote_item_id: 71, kind: 'module', module_source_key: 'module:100', item_number: 0, grademax: 20 }
      ]
    }
  };
}

function reasons(action, { results = [], model = targetModel(), actions = [action] } = {}) {
  return verifyResults({ actions }, model, results).map((failure) => failure.reason);
}

// [name, passing action (+options), change that must fail, expected reason]
const cases = [
  ['course.update', { action: { action_id: 'a', kind: 'course.update', fields: { summary: 'Summary' } } },
    (action) => { action.fields.summary = 'Other'; }, 'readback_mismatch'],
  ['section.update with files', {
    action: { action_id: 'a', kind: 'section.update', target_id: 10, fields: { name: 'Week 1' }, expected_assets: [asset] }
  }, (action) => { action.expected_assets = [{ ...asset, sha256: 'bb' }]; }, 'section_asset_readback_mismatch'],
  ['section.create uses the created id', {
    action: { action_id: 'a', kind: 'section.create', target_id: null, fields: { name: 'Week 1' } },
    results: [{ action_id: 'a', result: { section_id: 10 } }]
  }, (action) => { action.fields.name = 'Week 2'; }, 'readback_mismatch'],
  ['group.update', { action: { action_id: 'a', kind: 'group.update', target_id: 20, fields: { name: 'Team' } } },
    (action) => { action.fields.name = 'Other'; }, 'readback_mismatch'],
  ['grouping.create', {
    action: { action_id: 'a', kind: 'grouping.create', target_id: null, fields: { name: 'Teams' } },
    results: [{ action_id: 'a', result: { grouping_id: 30 } }]
  }, (action) => { action.fields.name = 'Other'; }, 'readback_mismatch'],
  ['grouping.member.add', {
    action: { action_id: 'a', kind: 'grouping.member.add', target_grouping_id: 30, target_group_id: 20 }
  }, (action) => { action.target_group_id = 99; }, 'grouping_membership_readback_mismatch'],
  ['module.update with settings and files', {
    action: {
      action_id: 'a', kind: 'module.update', target_id: 100, expected_assets: [asset],
      fields: { module_type: 'assign', name: 'Essay', visible: true, settings: { grade: 10 } }
    }
  }, (action) => { action.fields.settings.grade = 20; }, 'readback_mismatch'],
  ['module.create asset count', {
    action: { action_id: 'a', kind: 'module.create', target_id: null, fields: { name: 'Essay' }, expected_assets: [asset] },
    results: [{ action_id: 'a', result: { module_id: 100, grouping_id: 0 } }]
  }, (action) => { action.expected_assets = [asset, { ...asset, filename: 'b.png' }]; }, 'module_asset_readback_mismatch'],
  ['resource_asset.replace', { action: { action_id: 'a', kind: 'resource_asset.replace', target_id: 101, asset } },
    (action) => { action.asset = { ...asset, filename: 'other.pdf' }; }, 'resource_asset_readback_mismatch'],
  ['book_chapter.update', {
    action: {
      action_id: 'a', kind: 'book_chapter.update', target_id: 500,
      fields: { title: 'One', content: 'Text', content_format: 1, subchapter: false, hidden: false, order: 0 }
    }
  }, (action) => { action.fields.order = 1; }, 'readback_mismatch'],
  ['book_chapter.create uses the created id', {
    action: { action_id: 'a', kind: 'book_chapter.create', target_id: null, fields: { title: 'One' } },
    results: [{ action_id: 'a', result: { chapter_id: 500 } }]
  }, (action) => { action.fields.title = 'Two'; }, 'readback_mismatch'],
  ['assignment_content.update', {
    action: {
      action_id: 'a', kind: 'assignment_content.update', target_id: 100, file_area: 'intro',
      fields: { name: 'Essay', intro: 'Write' }, expected_assets: [asset]
    }
  }, (action) => { action.file_area = 'activity'; }, 'assignment_asset_readback_mismatch'],
  ['page_content.update', {
    action: { action_id: 'a', kind: 'page_content.update', target_id: 101, fields: { name: 'Page', content: 'Body' }, expected_assets: [asset] }
  }, (action) => { action.expected_assets = [{ ...asset, sha256: null }]; }, 'page_asset_readback_mismatch'],
  ['url_content.update', {
    action: { action_id: 'a', kind: 'url_content.update', target_id: 102, fields: { name: 'Link', externalurl: 'https://moodle.org' } }
  }, (action) => { action.fields.externalurl = 'https://example.com'; }, 'readback_mismatch'],
  ['label_content.update', {
    action: { action_id: 'a', kind: 'label_content.update', target_id: 110, fields: { intro: 'Note' }, expected_assets: [asset] }
  }, (action) => { action.expected_assets = [{ ...asset, filepath: '/sub/' }]; }, 'editor_asset_readback_mismatch'],
  ['assignment_rubric.set', {
    action: { action_id: 'a', kind: 'assignment_rubric.set', target_module_id: 100, fields: { criteria: [{ description: 'Clarity' }] } }
  }, (action) => { action.kind = 'assignment_guide.set'; }, 'grading_definition_readback_mismatch'],
  ['workshop_form.set', {
    action: { action_id: 'a', kind: 'workshop_form.set', target_module_id: 104, fields: { strategy: 'accumulative' } }
  }, (action) => { action.fields.strategy = 'rubric'; }, 'workshop_form_readback_mismatch'],
  ['database_field.create', {
    action: {
      action_id: 'a', kind: 'database_field.create', target_module_id: 105, source_key: 'field:7',
      fields: { type: 'text', name: 'Title', description: '', required: true, options: {} }
    }
  }, (action) => { action.fields.required = false; }, 'database_field_readback_mismatch'],
  ['feedback_item.create', {
    action: {
      action_id: 'a', kind: 'feedback_item.create', target_module_id: 106, source_key: 'item:8',
      fields: {
        type: 'textfield', name: 'Name', definition: { size: 20 }, position: 1,
        label: 'name', required: false, source_depend_item_id: 0, depend_value: ''
      }
    }
  }, (action) => { action.fields.position = 2; }, 'feedback_item_readback_mismatch'],
  ['question_bank.import', {
    action: { action_id: 'a', kind: 'question_bank.import', target_module_id: 107, fields: { blueprint: { categories: ['A'] } } }
  }, (action) => { action.fields.blueprint = { categories: [] }; }, 'question_bank_readback_mismatch'],
  ['lesson_page.create', {
    action: {
      action_id: 'a', kind: 'lesson_page.create', target_module_id: 108, source_key: 'page:9',
      fields: {
        page_type: 'content', title: 'Intro', content: 'Hello', content_format: 1,
        definition: { branches: [] }, display_in_menu: true, horizontal: true
      }
    }
  }, (action) => { action.source_key = 'page:10'; }, 'lesson_page_readback_mismatch'],
  ['quiz_questions.import', {
    action: { action_id: 'a', kind: 'quiz_questions.import', target_module_id: 109, fields: { blueprint: { questions: 1 } } }
  }, (action) => { action.fields.blueprint = { questions: 2 }; }, 'quiz_question_readback_mismatch'],
  ['quiz_slot.create', {
    action: { action_id: 'a', kind: 'quiz_slot.create', target_module_id: 109, fields: { slot: 1, source_question_id: 3 } }
  }, (action) => { action.fields.source_question_id = 4; }, 'quiz_slot_readback_mismatch'],
  ['quiz_slot.update', {
    action: { action_id: 'a', kind: 'quiz_slot.update', target_module_id: 109, fields: { slot: 1, max_mark: 2 } }
  }, (action) => { action.fields.slot = 2; }, 'quiz_slot_readback_mismatch'],
  ['course_completion.set', {
    action: {
      action_id: 'a', kind: 'course_completion.set',
      fields: { require_all_activities: true, criteria_aggregation: 'all', required_course_grade_percent: 50 }
    },
    results: [{ action_id: 'a', result: { required_module_ids: [100] } }]
  }, (action) => { action.fields.require_all_activities = false; }, 'course_completion_readback_mismatch'],
  ['grade_item.update', { action: { action_id: 'a', kind: 'grade_item.update', target_id: 70, fields: { grademax: 10 } } },
    (action) => { action.fields.grademax = 5; }, 'grade_item_readback_mismatch'],
  ['grade_item.update of a module item', {
    action: {
      action_id: 'a', kind: 'grade_item.update', target_id: null, module_source_key: 'module:src',
      target_module_id: 100, item_number: 0, fields: { grademax: 20 }
    }
  }, (action) => { action.item_number = 1; }, 'grade_item_readback_mismatch'],
  ['book_asset.transfer', {
    action: { action_id: 'a', kind: 'book_asset.transfer', assets: [{ filename: 'a.png', filepath: '/', filesize: 3, content_hash: 'h' }] },
    results: [{ action_id: 'a', result: { files: [{ filename: 'a.png', filepath: '/', filesize: 3, content_hash: 'h' }] } }]
  }, (action) => { action.assets[0].filesize = 4; }, 'asset_set_readback_mismatch']
];

for (const [name, passing, breakIt, reason] of cases) {
  test(`verifyResults: ${name} matches the read-back and reports ${reason} when it does not`, () => {
    assert.deepEqual(reasons(passing.action, passing), []);
    const failing = structuredClone(passing.action);
    breakIt(failing);
    assert.deepEqual(reasons(failing, { ...passing, action: failing, actions: [failing] }), [reason]);
  });
}

test('verifyResults finds modules created earlier in the same plan through their source key', () => {
  const create = { action_id: 'm', kind: 'module.create', source_key: 'module:src', target_id: null, fields: { name: 'Essay' } };
  const results = [{ action_id: 'm', result: { module_id: 100 } }];
  const children = [
    { action_id: 'c', kind: 'assignment_content.update', parent_source_key: 'module:src', fields: { name: 'Essay', intro: 'Write' } },
    { action_id: 'r', kind: 'assignment_checklist.set', parent_source_key: 'module:src', fields: {} },
    { action_id: 'w', kind: 'workshop_form.set', parent_source_key: 'module:src', fields: {} },
    { action_id: 'd', kind: 'database_field.create', parent_source_key: 'module:src', source_key: 'field:7', fields: {} },
    { action_id: 'q', kind: 'question_bank.import', parent_source_key: 'module:src', fields: { blueprint: null } },
    { action_id: 'l', kind: 'lesson_page.create', parent_source_key: 'module:src', source_key: 'page:1', fields: {} },
    { action_id: 's', kind: 'quiz_slot.update', module_source_key: 'module:src', fields: { slot: 1, max_mark: 1 } }
  ];
  const failures = verifyResults({ actions: [create, ...children] }, targetModel(), results);
  assert.deepEqual(failures.map((failure) => failure.action_id), ['r', 'w', 'd', 'l', 's']);
  assert.deepEqual(verifyResults({ actions: [{ action_id: 'x', kind: 'module_asset.stage' }] }, targetModel(), []), []);
});

test('currentEntityDigest covers every precondition-checked action kind', () => {
  const model = targetModel();
  const modules = model.sections[0].modules;
  assert.equal(currentEntityDigest({ kind: 'course.update' }, model), contentDigest(selectedCourseFields(model)));
  assert.equal(currentEntityDigest({ kind: 'section.update', target_id: 10 }, model), contentDigest(model.sections[0]));
  assert.equal(currentEntityDigest({ kind: 'group.update', target_id: 20 }, model), contentDigest(model.groups[0]));
  assert.equal(currentEntityDigest({ kind: 'grouping.update', target_id: 30 }, model), contentDigest(model.groupings[0]));
  for (const kind of ['module.update', 'assignment_content.update', 'page_content.update', 'label_content.update',
    'url_content.update', 'resource_asset.replace']) {
    assert.equal(currentEntityDigest({ kind, target_id: 101 }, model), contentDigest(modules[1]), kind);
  }
  assert.equal(
    currentEntityDigest({ kind: 'book_chapter.update', target_id: '500' }, model),
    contentDigest(modules[3].authoring.chapters[0])
  );
  assert.equal(currentEntityDigest({ kind: 'grade_item.update' }, model), null);
});

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

test('withAssetMaterials streams to a temporary file when the source can, and removes it afterwards', async () => {
  const data = Buffer.from('file bytes');
  let directory;
  const source = {
    async downloadAssetToFile(item, destinationPath) {
      await fs.writeFile(destinationPath, data);
      directory = destinationPath;
      return { path: destinationPath, sha256: sha256(data), filesize: data.byteLength };
    }
  };
  const result = await withAssetMaterials(source, [{ filename: 'a.txt', sha256: sha256(data), filesize: data.byteLength }],
    async (materials) => {
      assert.equal(await fs.readFile(materials[0].filePath, 'utf8'), 'file bytes');
      return 'done';
    });
  assert.equal(result, 'done');
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('withAssetMaterials falls back to in-memory downloads and rejects assets that changed since planning', async () => {
  const data = Buffer.from('abc');
  const source = {
    async downloadAssetToFile() { return null; },
    async downloadAsset() { return data; }
  };
  const materials = await withAssetMaterials(source, [{ filename: 'a', sha256: sha256(data), filesize: 3 }], async (items) => items);
  assert.equal(materials[0].data, data);
  await assert.rejects(
    withAssetMaterials(source, [{ filename: 'a', sha256: 'other', filesize: 3 }], async () => null),
    /Source asset changed after planning: a\./
  );
  await assert.rejects(
    withAssetMaterials({ async downloadAsset() { return data; } }, [{ filename: 'b', filesize: 4 }], async () => null),
    /Source asset size changed after planning: b\./
  );
});
