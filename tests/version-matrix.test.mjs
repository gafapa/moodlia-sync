import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCourseSyncModel,
  createCourseSyncPlan,
  validateSyncPlan
} from '../sync/index.mjs';

const MOODLE_BRANCHES = Object.freeze(['4.5', '5.0', '5.1', '5.2', '5.3']);
const PROVIDER_PAIRINGS = Object.freeze([
  ['core', 'core'],
  ['core', 'moodlia'],
  ['moodlia', 'core'],
  ['moodlia', 'moodlia']
]);

function sourceModel(version, provider) {
  return createCourseSyncModel({
    site: {
      provider,
      site_url: `https://source-${provider}-${version.replace('.', '-')}.example`,
      moodle_version: version
    },
    course: {
      id: 7,
      fullname: `Qualified course ${version}`,
      shortname: 'QUALIFIED',
      summary: '<p>Portable summary</p>',
      visible: false
    },
    sections: [{
      id: 10,
      section: 0,
      name: 'General',
      summary: '',
      visible: true,
      modules: provider === 'moodlia' ? [{
        id: 20,
        modname: 'page',
        name: 'Portable page',
        visible: false,
        authoring_completeness: 'complete',
        authoring: {
          kind: 'page',
          settings: { content: '<p>Qualified content</p>', content_format: 1 },
          files: []
        }
      }] : []
    }],
    completeness: {
      inventory: 'complete',
      pagination: 'complete',
      authoring: provider === 'moodlia' ? 'complete' : 'shell'
    },
    exclusions: provider === 'core'
      ? [{ scope: 'activity_authoring_fields', reason: 'core_course_contents_is_not_a_complete_authoring_export' }]
      : []
  });
}

function targetModel(version, provider) {
  return createCourseSyncModel({
    site: {
      provider,
      site_url: `https://target-${provider}-${version.replace('.', '-')}.example`,
      moodle_version: version
    },
    course: {
      id: 8,
      fullname: 'Previous title',
      shortname: 'QUALIFIED',
      summary: '',
      visible: false
    },
    sections: [{ id: 11, section: 0, name: 'General', summary: '', visible: true, modules: [] }]
  });
}

test('logical release matrix qualifies 100 Moodle branch and provider pairings', () => {
  const outcomes = [];
  for (const sourceVersion of MOODLE_BRANCHES) {
    for (const targetVersion of MOODLE_BRANCHES) {
      for (const [sourceProvider, targetProvider] of PROVIDER_PAIRINGS) {
        const plan = createCourseSyncPlan({
          source: sourceModel(sourceVersion, sourceProvider),
          target: targetModel(targetVersion, targetProvider),
          capabilities: {
            course_update: {
              available: true,
              supported_fields: [
                'fullname', 'shortname', 'category_id', 'idnumber', 'summary', 'visible', 'start_date', 'end_date'
              ]
            },
            module_create: targetProvider === 'moodlia'
              ? { available: true, supported_fields: ['module_type', 'name', 'visible', 'settings'] }
              : { available: false }
          }
        });
        validateSyncPlan(plan);
        assert.equal(plan.source.site.moodle_version, sourceVersion);
        assert.equal(plan.target.site.moodle_version, targetVersion);
        assert.ok(plan.actions.some((action) => action.kind === 'course.update'));

        const serialized = JSON.stringify(plan).toLowerCase();
        for (const forbidden of ['backup_course', 'restore_course', 'duplicate_course', '.mbz']) {
          assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked into a no-backup plan`);
        }

        const pageCreate = plan.actions.find((action) => ['module.create', 'page.create'].includes(action.kind));
        const pageGap = plan.unsupported.find((entry) => ['module.create', 'page.create'].includes(entry.kind));
        if (sourceProvider === 'moodlia' && targetProvider === 'moodlia') {
          assert.ok(pageCreate, 'MoodlIA destination must receive portable authored Page content.');
          assert.equal(pageGap, undefined);
        } else if (sourceProvider === 'moodlia' && targetProvider === 'core') {
          assert.equal(pageCreate, undefined);
          assert.equal(pageGap?.reason, 'target_capability_unavailable', JSON.stringify(plan.unsupported));
          assert.equal(plan.applicable, false);
        }

        outcomes.push({ sourceVersion, targetVersion, sourceProvider, targetProvider, applicable: plan.applicable });
      }
    }
  }

  assert.equal(outcomes.length, 100);
  for (const pairing of PROVIDER_PAIRINGS) {
    assert.equal(outcomes.filter((entry) => entry.sourceProvider === pairing[0]
      && entry.targetProvider === pairing[1]).length, 25);
  }
  assert.equal(outcomes.filter((entry) => entry.applicable).length, 75);
  assert.equal(outcomes.filter((entry) => !entry.applicable).length, 25);
});
