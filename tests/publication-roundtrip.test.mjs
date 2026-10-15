import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createMoodliaSyncAdapter } from '../adapters/moodlia-sync.mjs';
import { createCourseSyncEngine, createCourseSyncModel, MemorySyncStateStore } from '../sync/index.mjs';

const formats = { html: 1, plain: 2, markdown: 4, moodle: 0 };
const operations = ['get_moodlia_status', 'get_sync_capabilities', 'create_module',
  'update_page', 'update_label', 'update_url', 'update_assignment'];

function model(id, version, modules) {
  return createCourseSyncModel({
    site: { provider: 'moodlia', site_url: `https://site-${id}.example`, moodle_version: version },
    course: { id, fullname: 'Course', shortname: 'COURSE', visible: false },
    sections: [{ id: id === 7 ? 10 : 11, section: 0, name: 'General', summary: '', visible: true, modules }]
  });
}

// Stateful remote stand-in: create_module reproduces the plugin's HTML-forcing
// paths. The real adapter must publish the requested format through update_*.
async function roundTrip(type, format, sourceVersion, targetVersion, pluginRelease = '0.1.215') {
  const bytes = Buffer.from('Owned asset');
  const file = { filename: 'diagram ünicode.txt', filepath: '/nested/', filesize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  const textField = type === 'url' ? 'intro' : 'content';
  const formatField = type === 'url' ? 'intro_format' : 'content_format';
  const content = format === 1 ? 'Content' : 'A & B <literal>\n`code` and **Markdown**';
  const authoring = type === 'assign'
    ? { kind: type, settings: {}, content: { intro: content, intro_format: format,
      activity: content, activity_format: format, intro_files: [file], activity_files: [] } }
    : { kind: type, settings: { [textField]: content, [formatField]: format,
      ...(type === 'url' ? { external_url: 'https://example.org' } : {}) }, files: [file] };
  const source = model(7, sourceVersion, [{ id: 20, modname: type, name: 'Content', visible: false,
    authoring_completeness: 'complete', authoring }]);
  let remote = null;
  const writes = [];
  const drafts = new Map();
  const client = {
    operationNames: () => operations,
    async uploadDraftData(data, options) {
      const itemId = options.itemId || drafts.size + 100;
      drafts.set(itemId, [{ filename: options.filename, filepath: options.filepath, filesize: data.length,
        sha256: createHash('sha256').update(data).digest('hex') }]);
      return { draft_item_id: itemId, filename: options.filename, filepath: options.filepath };
    },
    async callOperation(name, parameters) {
      if (name === 'get_moodlia_status') return { site_url: 'https://site-8.example', can_use_api: true,
        plugin_release: pluginRelease, functions_json: JSON.stringify(operations.map((entry) => `local_moodlia_${entry}`)) };
      if (name === 'get_sync_capabilities') return { capabilities_json: JSON.stringify({ activity_manage: true }) };
      writes.push({ name, parameters: structuredClone(parameters) });
      if (name === 'create_module') {
        const settings = structuredClone(authoring.settings);
        if (type !== 'assign' && parameters.options.draft_item_id) settings[formatField] = 1;
        remote = { id: 80, modname: type, name: 'Content', visible: false, authoring_completeness: 'complete',
          authoring: type === 'assign' ? { kind: type, settings: {},
            content: { intro: content, intro_format: 1, activity: content, activity_format: 1,
              intro_files: [], activity_files: [] } }
            : { kind: type, settings, files: drafts.get(parameters.options.draft_item_id) ?? [] } };
        return { module_id: 80 };
      }
      assert.equal(parameters.module_id, 80, 'publish to the returned destination identity');
      if (type === 'assign') {
        for (const area of ['intro', 'activity']) {
          if (parameters[area] !== undefined) remote.authoring.content[area] = parameters[area];
          if (parameters[`${area}_format`] !== undefined) remote.authoring.content[`${area}_format`] = formats[parameters[`${area}_format`]];
        }
        if (parameters.draft_item_id) remote.authoring.content[`${parameters.file_area}_files`] = drafts.get(parameters.draft_item_id);
      } else {
        remote.authoring.settings[formatField] = formats[parameters[formatField]];
        remote.authoring.settings[textField] = parameters[textField];
        if (parameters.draft_item_id) remote.authoring.files = drafts.get(parameters.draft_item_id);
      }
      return { module_id: 80 };
    }
  };
  const targetAdapter = createMoodliaSyncAdapter({ client });
  targetAdapter.exportCourse = async () => model(8, targetVersion, remote ? [remote] : []);
  const sourceAdapter = { exportCourse: async () => source, downloadAsset: async () => bytes };
  const engine = createCourseSyncEngine({ stateStore: new MemorySyncStateStore() });
  const plan = await engine.plan({ sourceAdapter, targetAdapter, sourceCourseId: 7, targetCourseId: 8 });
  if (pluginRelease === '0.1.214' && [0, 4].includes(format)) {
    assert.equal(plan.applicable, false);
    assert.equal(plan.actions.length, 0);
    await assert.rejects(engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter }), /blocking conflicts or unsupported/);
    assert.equal(writes.length, 0);
    return;
  }
  assert.equal(plan.applicable, true, JSON.stringify(plan.unsupported));
  const job = await engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter });
  assert.equal(job.status, 'succeeded');
  assert.equal(writes[0].name, 'create_module');
  if (type === 'assign' || format !== 1) {
    assert.ok(writes.some((entry) => entry.name === (type === 'assign' ? 'update_assignment' : `update_${type}`)));
    if (type !== 'assign') assert.equal(writes[0].parameters.options.draft_item_id, undefined);
  }
  const repeat = await engine.plan({ sourceAdapter, targetAdapter, sourceCourseId: 7, targetCourseId: 8 });
  assert.equal(repeat.applicable, true, JSON.stringify(repeat.unsupported));
  assert.equal(repeat.actions.length, 0, 'readback converges without replaying creation or publication');
}

test('all four formats survive creation, owned drafts and readback in both endpoint directions', async () => {
  for (const [sourceVersion, targetVersion] of [['4.5', '5.3'], ['5.3', '4.5']]) {
    for (const type of ['page', 'label', 'url', 'assign']) {
      for (const format of [0, 1, 2, 4]) await roundTrip(type, format, sourceVersion, targetVersion);
    }
  }
});

test('legacy plugin capabilities preserve HTML/plain and reject newer formats without writes', async () => {
  for (const type of ['page', 'label', 'url', 'assign']) {
    for (const format of [0, 1, 2, 4]) await roundTrip(type, format, '5.3', '4.5', '0.1.214');
  }
});
