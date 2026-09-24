import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdaptiveSyncAdapter } from '../adaptive/adaptive-sync.mjs';
import { createCoreSyncAdapter } from '../adapters/core-sync.mjs';

const CORE_OPERATIONS = {
  get_course: 'core_course_get_courses_by_field',
  get_course_contents: 'core_course_get_contents',
  get_course_groups: 'core_group_get_course_groups',
  get_course_groupings: 'core_group_get_course_groupings',
  get_grouping: 'core_group_get_groupings',
  create_course: 'core_course_create_courses',
  update_course: 'core_course_update_courses',
  create_group: 'core_group_create_groups',
  update_group: 'core_group_update_groups',
  create_grouping: 'core_group_create_groupings',
  update_grouping: 'core_group_update_groupings',
  add_group_to_grouping: 'core_group_assign_grouping'
};

function coreAdapter({ functions = Object.values(CORE_OPERATIONS), responses = {} } = {}) {
  const calls = [];
  const client = {
    contract: { operations: Object.entries(CORE_OPERATIONS).map(([name, moodleFunction]) => ({ name, moodleFunction })) },
    operationNames() { return Object.keys(CORE_OPERATIONS); },
    async callOperation(name, parameters) {
      calls.push([name, parameters]);
      const response = responses[name];
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(parameters) : (response ?? { id: 1 });
    }
  };
  const adapter = createCoreSyncAdapter({ client });
  adapter.discovery = {
    provider: 'core', site_url: 'https://core.example', moodle_version: '5.3',
    functions, operations: Object.keys(CORE_OPERATIONS)
  };
  return { adapter, calls };
}

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

test('Core export reads grouping members when available and tolerates missing group permissions', async () => {
  const { adapter } = coreAdapter({
    responses: {
      get_course: { id: 7, fullname: 'Course', shortname: 'C', visible: true },
      get_course_contents: [{ id: 1, section: 0, name: 'General', modules: [{ id: 3, modname: 'forum', name: 'News' }] }],
      get_course_groups: coded('permission_denied'),
      get_course_groupings: [{ id: 4, name: 'Teams' }],
      get_grouping: { id: 4, name: 'Teams', groups: [] }
    }
  });
  const model = await adapter.exportCourse(7);
  assert.deepEqual(model.groups, []);
  assert.equal(model.groupings[0].name, 'Teams');
  assert.ok(model.unknowns.some((entry) => entry.scope === 'module:3'));

  const failing = coreAdapter({
    responses: {
      get_course: { id: 7, fullname: 'Course', shortname: 'C', visible: true },
      get_course_contents: [],
      get_course_groups: coded('transport_error')
    }
  });
  await assert.rejects(failing.adapter.exportCourse(7), /transport_error/);

  const withoutGroupings = coreAdapter({
    functions: [CORE_OPERATIONS.get_course, CORE_OPERATIONS.get_course_contents],
    responses: { get_course: { id: 7, fullname: 'Course', shortname: 'C', visible: true }, get_course_contents: [] }
  });
  const minimal = await withoutGroupings.adapter.exportCourse(7);
  assert.deepEqual([minimal.groups, minimal.groupings], [[], []]);
  assert.equal(withoutGroupings.calls.some(([name]) => name === 'get_course_groups'), false);
});

test('Core capabilities, target preparation, and every Core write action', async () => {
  const { adapter, calls } = coreAdapter();
  const capabilities = await adapter.syncCapabilities();
  assert.equal(capabilities.course_update.available, true);
  assert.equal(capabilities.section_create, false);

  const limited = coreAdapter({ functions: [] });
  assert.equal((await limited.adapter.syncCapabilities()).group_create.available, false);

  const prepared = await adapter.prepareTargetCourse({ category_id: 2, shortname: 'NEW' });
  assert.deepEqual(prepared.target_creation, { category_id: 2, shortname: 'NEW' });

  const created = new Map([['groupings:grouping:1', { id: 40 }], ['groups:group:1', { group_id: 30 }]]);
  const context = { courseId: 7, createdEntities: created };
  await adapter.applySyncAction({ kind: 'course.create', fields: { shortname: 'NEW' } }, context);
  await adapter.applySyncAction({ kind: 'course.update', fields: { fullname: 'F' } }, context);
  await adapter.applySyncAction({ kind: 'grouping.create', fields: { name: 'GR' } }, context);
  await adapter.applySyncAction({ kind: 'grouping.update', target_id: 40, fields: { name: 'GR2' } }, context);
  await adapter.applySyncAction({ kind: 'grouping.member.add', grouping_source_key: 'grouping:1', group_source_key: 'group:1' }, context);
  await adapter.applySyncAction({ kind: 'group.create', fields: { name: 'G' } }, context);
  assert.deepEqual(calls.map(([name]) => name), [
    'create_course', 'update_course', 'create_grouping', 'update_grouping', 'add_group_to_grouping', 'create_group'
  ]);
  assert.deepEqual(calls[4][1], { grouping_id: 40, group_id: 30 });
  assert.equal(calls[5][1].visibility, undefined, 'unset visibility is left to Moodle');
  await assert.rejects(adapter.applySyncAction({ kind: 'module.create' }, context), /Core adapter cannot apply sync action module.create/);
});

function provider(name, { available = true, extra = {} } = {}) {
  const calls = [];
  return {
    calls,
    provider: name,
    async discoverSite() {
      if (!available) throw new Error(`${name} is not installed`);
      return { provider: name, site_url: `https://${name}.example` };
    },
    async syncCapabilities() {
      return {
        module_asset_stage: { available: true },
        resource_asset_replace: { available: true },
        book_asset_transfer: { available: true }
      };
    },
    async prepareTargetCourse(creation) {
      calls.push(['prepare', creation]);
      return { site: { provider: name, site_url: `https://${name}.example` }, course: { source_id: null }, digest: 'x' };
    },
    async stageModuleAssets() { calls.push(['stage']); return { draft_item_id: 1 }; },
    async replaceResourceAsset() { calls.push(['replace']); return { replaced: true }; },
    async publishBookChapterAssets() { calls.push(['publish']); return { files: [] }; },
    ...extra
  };
}

test('adaptive adapter prepares new courses and routes asset work to the provider that owns the capability', async () => {
  const moodlia = provider('moodlia');
  const core = provider('core');
  const adaptive = createAdaptiveSyncAdapter({ moodlia, core, profileName: 'school' });
  const prepared = await adaptive.prepareTargetCourse({ category_id: 3, shortname: 'NEW' });
  assert.equal(prepared.site.provider, 'adaptive');
  assert.equal(prepared.site.selected_provider, 'moodlia');
  assert.equal(prepared.site.profile, 'school');
  assert.notEqual(prepared.digest, 'x');

  await adaptive.stageModuleAssets({}, [], {});
  await adaptive.replaceResourceAsset({ provider: 'core' }, new Uint8Array(1), {});
  await adaptive.publishBookChapterAssets({}, [], {});
  assert.deepEqual(moodlia.calls.map(([name]) => name), ['prepare', 'stage', 'publish']);
  assert.deepEqual(core.calls.map(([name]) => name), ['replace']);
  assert.equal(await adaptive.downloadAssetToFile({}, '/tmp/x'), null, 'providers without streaming downloads fall back');
  await assert.rejects(adaptive.downloadAsset({}), /cannot download synchronized assets/);
});

test('adaptive adapter explains when no provider can prepare, export, or apply', async () => {
  const withoutPreparation = createAdaptiveSyncAdapter({
    moodlia: provider('moodlia', { available: false }),
    core: provider('core', { extra: { prepareTargetCourse: undefined } })
  });
  await assert.rejects(withoutPreparation.prepareTargetCourse({ category_id: 1, shortname: 'X' }), /No provider can prepare a new target course/);
  await assert.rejects(
    withoutPreparation.applySyncAction({ kind: 'mystery.action' }, {}),
    /No provider can apply sync action mystery.action/
  );

  const nothing = createAdaptiveSyncAdapter({
    moodlia: provider('moodlia', { available: false }),
    core: provider('core', { available: false })
  });
  await assert.rejects(nothing.exportCourse(1), /No provider is available for profile/);
});
