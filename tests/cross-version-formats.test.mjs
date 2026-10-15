import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseSyncModel, createCourseSyncPlan, validateSyncPlan, rewriteMoodleHtmlReferences } from '../sync/index.mjs';

function snapshot({ version, id, modules = [], course = {}, targetCreation = null }) {
  return createCourseSyncModel({
    site: { provider: 'moodlia', site_url: `https://site-${id}.example`, moodle_version: version },
    course: { id, fullname: 'Course', shortname: 'COURSE', visible: false, ...course },
    sections: [{ id: id === 7 ? 10 : 11, section: 0, name: 'General', summary: '', visible: true, modules }],
    targetCreation
  });
}

function authoredModule(type, id, format, text) {
  const settings = type === 'url'
    ? { external_url: 'https://example.org', intro: text, intro_format: format }
    : { content: text, content_format: format };
  return { id, modname: type, name: 'Content', visible: false,
    authoring_completeness: 'complete', authoring: { kind: type, settings, files: [] } };
}

test('cross-version formats use the selected create or mapped update capability only', () => {
  let cases = 0;
  for (const [sourceVersion, targetVersion] of [['4.5', '5.3'], ['5.3', '4.5']]) {
    for (const type of ['page', 'label', 'url']) {
      for (const mapped of [false, true]) {
        for (const format of [0, 4]) {
          for (const selectedAccepts of [false, true]) {
            const source = snapshot({ version: sourceVersion, id: 7,
              modules: [authoredModule(type, 20, format, 'New content')] });
            const target = snapshot({ version: targetVersion, id: 8,
              modules: mapped ? [authoredModule(type, 30, format, 'Old content')] : [] });
            const selected = mapped ? `${type}_content_update` : 'module_create';
            const other = mapped ? 'module_create' : `${type}_content_update`;
            const formats = ['html', 'plain', 'markdown', 'moodle'];
            const plan = createCourseSyncPlan({ source, target,
              mapping: mapped ? { modules: { 'module:20': 30 } } : {},
              capabilities: {
                [selected]: { available: true, text_formats: selectedAccepts ? formats : ['html', 'plain'] },
                // The unused route deliberately advertises the opposite format support.
                [other]: { available: true, text_formats: selectedAccepts ? ['html', 'plain'] : formats }
              }
            });
            validateSyncPlan(plan);
            assert.equal(plan.applicable, selectedAccepts, JSON.stringify({ type, mapped, format, selectedAccepts }));
            assert.equal(plan.actions.length, selectedAccepts ? 1 : 0);
            if (!selectedAccepts) assert.equal(plan.unsupported[0].reason, 'destination_format_not_representable');
            else assert.equal(plan.actions[0].kind, mapped ? `${type}_content.update` : 'module.create');
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 48);
});

test('legacy resource and folder creation blocks unsupported intro formats before asset staging', () => {
  for (const type of ['resource', 'folder']) {
    const source = snapshot({ version: '5.3', id: 7, modules: [{
      id: 20, modname: type, name: 'Files', visible: false, authoring_completeness: 'complete',
      authoring: { kind: type, settings: { intro: '*Notes*', intro_format: 4 },
        files: [{ filename: 'lesson.txt', filepath: '/', filesize: 3, sha256: 'abc' }] }
    }] });
    const target = snapshot({ version: '4.5', id: 8 });
    for (const current of [false, true]) {
      const plan = createCourseSyncPlan({ source, target, capabilities: {
        module_create: { available: true, text_formats: current ? ['html', 'plain', 'markdown', 'moodle'] : ['html', 'plain'] },
        module_asset_stage: { available: true }
      } });
      assert.equal(plan.applicable, current);
      assert.equal(plan.actions.length, current ? 2 : 0);
      if (!current) assert.equal(plan.unsupported[0].reason, 'destination_format_not_representable');
    }
  }
});

test('new course summaries preserve non-HTML format or block instead of silently creating HTML', () => {
  for (const format of ['plain', 'markdown', 'moodle']) {
    const source = snapshot({ version: '5.3', id: 7, course: { summary: '*Summary*', summary_format: format } });
    const target = snapshot({ version: '4.5', id: null,
      targetCreation: { category_id: 2, shortname: 'NEW' } });
    const fields = ['fullname', 'shortname', 'category_id', 'summary', 'visible'];
    const legacy = createCourseSyncPlan({ source, target,
      capabilities: { course_create: { available: true, supported_fields: fields } } });
    assert.equal(legacy.applicable, false);
    assert.equal(legacy.actions.some((action) => action.kind === 'course.create'), false);
    const current = createCourseSyncPlan({ source, target, capabilities: { course_create: {
      available: true, supported_fields: [...fields, 'summary_format'],
      text_formats: ['html', 'plain', 'markdown', 'moodle']
    } } });
    assert.equal(current.applicable, true, JSON.stringify(current.unsupported));
    assert.equal(current.actions[0].fields.summary_format, format);
  }
});

test('course summary text and format are updated together for format-only and text-only changes', () => {
  for (const formatOnly of [false, true]) {
    const source = snapshot({ version: '5.3', id: 7,
      course: { summary: formatOnly ? 'Same text' : 'New text', summary_format: 'plain' } });
    const target = snapshot({ version: '4.5', id: 8,
      course: { summary: formatOnly ? 'Same text' : 'Old text', summary_format: formatOnly ? 'html' : 'plain' } });
    const plan = createCourseSyncPlan({ source, target, capabilities: { course_update: {
      available: true, supported_fields: ['summary', 'summary_format'], text_formats: ['html', 'plain']
    } } });
    assert.equal(plan.applicable, true);
    assert.deepEqual(plan.actions[0].fields, { summary: source.course.summary, summary_format: 'plain' });
    const core = createCourseSyncPlan({ source, target, capabilities: { course_update: {
      available: true, supported_fields: ['summary']
    } } });
    assert.equal(core.applicable, false);
    assert.equal(core.actions.length, 0);
  }
});

test('new Page, Label and URL editor drafts block non-HTML formats before publication', () => {
  for (const type of ['page', 'label', 'url']) {
    for (const format of [0, 1, 2, 4]) {
      const module = authoredModule(type, 20, format, 'Content');
      module.authoring.files = [{ filename: 'lesson.txt', filepath: '/', filesize: 3, sha256: 'abc' }];
      const source = snapshot({ version: '5.3', id: 7, modules: [module] });
      const target = snapshot({ version: '4.5', id: 8 });
      const plan = createCourseSyncPlan({ source, target, capabilities: {
        module_create: { available: true, text_formats: ['html', 'plain', 'markdown', 'moodle'] },
        module_asset_stage: { available: true }
      } });
      assert.equal(plan.applicable, format === 1);
      assert.equal(plan.actions.length, format === 1 ? 2 : 0);
      if (format !== 1) assert.equal(plan.unsupported[0].reason, 'destination_editor_format_not_preserved');
    }
  }
});

test('new assignments restore plain instructions through a dependent content update', () => {
  const source = snapshot({ version: '5.3', id: 7, modules: [{
    id: 20, modname: 'assign', name: 'Task', visible: false, authoring_completeness: 'complete',
    authoring: { kind: 'assign', settings: {}, content: {
      intro: 'Introduction', intro_format: 1, activity: 'Plain instructions', activity_format: 2
    } }
  }] });
  const target = snapshot({ version: '4.5', id: 8 });
  const plan = createCourseSyncPlan({ source, target, capabilities: {
    module_create: { available: true, text_formats: ['html', 'plain', 'markdown', 'moodle'] },
    assignment_content_update: { available: true, text_formats: ['html', 'plain', 'markdown', 'moodle'] }
  } });
  assert.equal(plan.applicable, true);
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.actions[1].kind, 'assignment_content.update');
  assert.equal(plan.actions[1].fields.activity_format, 2);
  assert.ok(plan.actions[1].depends_on.includes(plan.actions[0].action_id));
  const blocked = createCourseSyncPlan({ source, target, capabilities: { module_create: { available: true } } });
  assert.equal(blocked.applicable, false);
  assert.equal(blocked.actions.length, 0);
});

test('skip removes dependent module publication and orphan editor drafts', () => {
  const file = { filename: 'lesson.txt', filepath: '/', filesize: 3, sha256: 'abc' };
  const module = authoredModule('page', 20, 1, 'Content');
  module.authoring.files = [file];
  const source = createCourseSyncModel({ site: { provider: 'moodlia', site_url: 'https://source.example' },
    course: { id: 7, fullname: 'Course', shortname: 'COURSE', visible: false },
    sections: [{ id: 10, section: 1, name: 'Topic', summary: '<img src="@@PLUGINFILE@@/lesson.txt">',
      summary_format: 1, visible: true, files: [file], modules: [module] }] });
  const target = snapshot({ version: '4.5', id: 8 });
  const plan = createCourseSyncPlan({ source, target, unsupportedPolicy: 'skip', capabilities: {
    section_create: true, section_update: false, module_asset_stage: true, module_create: true
  } });
  assert.equal(plan.applicable, true);
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.skipped.some((entry) => entry.kind === 'module_asset.stage' && entry.reason === 'no_remaining_publication'));
});

test('skip cannot publish child entities when the requested target course cannot be created', () => {
  const source = snapshot({ version: '5.3', id: 7,
    modules: [authoredModule('page', 20, 1, 'Content')] });
  const target = snapshot({ version: '4.5', id: null,
    targetCreation: { category_id: 2, shortname: 'NEW' } });
  const plan = createCourseSyncPlan({ source, target, unsupportedPolicy: 'skip', capabilities: {
    module_create: true, section_update: true
  } });
  assert.equal(plan.applicable, false);
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.skipped.some((entry) => entry.kind === 'module.create' && entry.reason === 'target_course_unavailable'));
});

test('non-HTML text retains literal syntax and blocks internal links until a format-specific rewrite exists', () => {
  const source = snapshot({ version: '5.3', id: 7, modules: [authoredModule('page', 20, 4, 'Text')] });
  const target = snapshot({ version: '4.5', id: 8 });
  for (const format of [0, 2, 4]) {
    const options = { textFormat: format, sourceSiteUrl: source.site.site_url,
      targetSiteUrl: target.site.site_url, sourceModel: source, targetModel: target, mapping: {} };
    const text = 'A & B <literal>\n`code` **bold** https://example.org/read?a=1&b=2';
    assert.equal(rewriteMoodleHtmlReferences(text, options).html, text);
    assert.deepEqual(rewriteMoodleHtmlReferences(text, options).blocked, []);
    const internal = rewriteMoodleHtmlReferences('[Read](https://site-7.example/mod/page/view.php?id=20)', options);
    assert.equal(internal.blocked[0].reason, 'non_html_internal_reference_unsupported');
    const secret = rewriteMoodleHtmlReferences('https://site-7.example/mod/page/view.php?id=20&wstoken=secret', options);
    assert.equal(secret.blocked[0].reason, 'token_bearing_url');
  }
});
