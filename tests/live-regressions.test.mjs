import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoodliaSyncAdapter } from '../adapters/moodlia-sync.mjs';
import { createCourseSyncModel, createCourseSyncPlan } from '../sync/index.mjs';

function exportingAdapter(course, modules = [], files = []) {
  const client = {
    async callOperation(name, parameters) {
      if (name === 'get_course_details') return { course_id: 7, fullname: 'Course', shortname: 'COURSE', ...course };
      if (name === 'get_course_contents') return { sections: [{ section_id: 10, section_number: 0,
        name: 'General', summary: '', summary_format: 'html', modules }] };
      if (name === 'get_groups') return { groups: [] };
      if (name === 'get_groupings') return { groupings: [] };
      if (name === 'get_course_assignments') return { assignments: modules.filter((module) => module.module_type === 'assign')
        .map((module) => ({ module_id: module.module_id, intro: 'Introduction', intro_format: 1,
          activity: '', activity_format: 1, intro_files: files.filter((file) => file.module_id === module.module_id),
          activity_files: [], submission_plugins: [], feedback_plugins: [] })) };
      if (name === 'get_module_details') return { extra_json: JSON.stringify({ activity: {
        content: 'Content', content_format: 1, intro: 'Introduction', intro_format: 1,
        external_url: 'https://example.org/', display: 5,
        files: files.filter((file) => file.module_id === parameters.module_id)
      } }) };
      throw new Error(`Unavailable optional fixture operation: ${name}`);
    },
    async downloadFile(url) {
      const file = files.find((entry) => new URL(url).pathname === entry.expected_path);
      assert.ok(file, `Unexpected file route: ${url}`);
      assert.equal(new URL(url).searchParams.has('token'), false);
      return new Uint8Array([1, 2, 3]);
    }
  };
  const adapter = createMoodliaSyncAdapter({ client });
  adapter.discovery = { provider: 'moodlia', site_url: 'https://source.example',
    moodle_version: '4.5', plugin_version: '0.1.215', operations: [], functions: [] };
  return adapter;
}

test('legacy introduction file routes remove only a redundant item id and retain genuine zero directories', async () => {
  const files = [];
  const modules = [];
  for (const [index, type] of ['label', 'url', 'assign', 'page'].entries()) {
    const moduleId = index + 20;
    modules.push({ module_id: moduleId, module_type: type, name: type, visible: true });
    for (const legacy of [false, true]) {
      const filepath = legacy ? '/nested/' : '/0/';
      const suffix = `${filepath}notes%20%C3%BCnicode.txt`;
      const prefix = `/webservice/pluginfile.php/${moduleId}/mod_${type}/${type === 'page' ? 'content/0' : 'intro'}`;
      files.push({ module_id: moduleId, filename: 'notes ünicode.txt', filepath, filesize: 3,
        expected_path: `${prefix}${suffix}`,
        url: `https://source.example${prefix}${legacy && type !== 'page' ? '/0' : ''}${suffix}?token=secret` });
    }
  }
  const model = await exportingAdapter({ summary: '', summary_format: 'html' }, modules, files).exportCourse(7);
  assert.equal(model.assets.length, 8);
  assert.ok(model.assets.every((asset) => asset.sha256.length === 64));
  assert.ok(!JSON.stringify(model).includes('secret'));
  assert.ok(model.sections[0].modules.every((module) => module.authoring_completeness !== 'unavailable'));
});

test('rendered legacy summaries cannot be copied as raw non-HTML source text', async () => {
  for (const format of ['plain', 'markdown', 'moodle', 2, 4, 0]) {
    const source = await exportingAdapter({ summary: 'A &amp; B<br />', summary_format: format }).exportCourse(7);
    assert.ok(source.unknowns.some((entry) => entry.reason === 'raw_summary_unavailable'));
    for (const create of [false, true]) {
      const target = createCourseSyncModel({ site: { provider: 'moodlia', site_url: 'https://target.example' },
        course: { id: create ? 0 : 8, fullname: 'Old', shortname: 'OLD', summary: 'Old', summary_format: 'html' },
        targetCreation: create ? { category_id: 1, shortname: 'COPY' } : null });
      for (const policy of ['error', 'skip']) {
        const plan = createCourseSyncPlan({ source, target, unsupportedPolicy: policy, targetCreation: target.target_creation,
          capabilities: { course_create: { available: true }, course_update: { available: true }, section_create: false } });
        assert.equal(plan.applicable, policy === 'skip');
        assert.ok(plan.unsupported.some((entry) => entry.reason === 'source_raw_text_unavailable'));
        assert.ok(plan.actions.every((action) => !Object.hasOwn(action.fields, 'summary')
          && !Object.hasOwn(action.fields, 'summary_format')));
      }
    }
    const raw = 'A & B <literal>\n**Text**';
    const supported = await exportingAdapter({ summary: 'Rendered', summary_raw: raw, summary_format: format }).exportCourse(7);
    assert.equal(supported.course.summary, raw);
    assert.ok(!supported.unknowns.some((entry) => entry.reason === 'raw_summary_unavailable'));
  }
});

test('activity-owned grade ranges cannot be written through the generic grade-item API', () => {
  const snapshot = (id, moduleId, maximum, pass, includeModule = true) => createCourseSyncModel({
    site: { provider: 'moodlia', site_url: `https://site-${id}.example` },
    course: { id, fullname: 'Course', shortname: 'COURSE' },
    sections: [{ id: id + 10, section: 0, modules: includeModule ? [{ id: moduleId, modname: 'assign', name: 'Task',
      authoring_completeness: 'complete', authoring: { kind: 'assignment', settings: { grade: 100 },
        content: { intro: '', intro_format: 1, activity: '', activity_format: 1 }, losses: [] } }] : [] }],
    gradebook: { losses: [], items: includeModule ? [{ kind: 'module', module_source_key: `module:${moduleId}`,
      remote_item_id: moduleId + 100, item_number: 0, grade_min: 0, grade_max: maximum,
      grade_pass: pass, hidden: false, locked: false }] : [] }
  });
  const source = snapshot(7, 20, 100, 80);
  const capabilities = { module_create: true, assignment_content_update: true, grade_item_update: true };
  const mapped = createCourseSyncPlan({ source, target: snapshot(8, 30, 100, 0),
    mapping: { modules: { 'module:20': 30 } }, capabilities });
  assert.equal(mapped.applicable, true, JSON.stringify(mapped.unsupported));
  const update = mapped.actions.find((action) => action.kind === 'grade_item.update');
  assert.deepEqual(update.fields, { grade_pass: 80 });
  const changedRange = createCourseSyncPlan({ source, target: snapshot(8, 30, 50, 0),
    mapping: { modules: { 'module:20': 30 } }, capabilities });
  assert.equal(changedRange.applicable, false);
  assert.ok(changedRange.unsupported.some((entry) => entry.reason === 'grade_range_requires_owning_activity_update'));
  assert.ok(!changedRange.actions.some((action) => action.kind === 'grade_item.update'));
  const unrepresented = createCourseSyncPlan({ source: snapshot(7, 20, 120, 80),
    target: snapshot(8, 30, 100, 0, false), capabilities });
  assert.equal(unrepresented.applicable, false);
  assert.ok(unrepresented.unsupported.some((entry) => entry.reason === 'grade_range_requires_owning_activity_update'));
});
