import assert from 'node:assert/strict';
import test from 'node:test';
import { createCourseSyncModel, createCourseSyncEngine, MemorySyncStateStore,
  createCourseSyncPlan, validateSyncPlan, contentDigest, rewriteMoodleHtmlReferences } from '../sync/index.mjs';

function snapshot(id, modules) {
  return createCourseSyncModel({
    site: { provider: 'moodlia', site_url: id === 7 ? 'https://source.example/moodle' : 'https://target.example/learn' },
    course: { id, fullname: 'Course', shortname: 'COURSE', visible: false },
    sections: [{ id: id === 7 ? 10 : 11, section: 0, name: 'General', summary: '', visible: true, modules }]
  });
}

function page(id, name, content) {
  return { id, modname: 'page', name, visible: false, authoring_completeness: 'complete',
    authoring: { kind: 'page', settings: { content, content_format: 1 }, files: [] } };
}

test('forward Moodle links reorder creation and resolve the target subdirectory, query and fragment', async () => {
  const source = snapshot(7, [
    page(20, 'First', '<a href="https://source.example/moodle/mod/page/view.php?id=21&amp;forceview=1#part">Next</a>'),
    page(21, 'Second', '<p>Ready</p>')
  ]);
  const modules = [];
  const writes = [];
  const store = new MemorySyncStateStore();
  const sourceAdapter = { exportCourse: async () => source };
  const targetAdapter = {
    exportCourse: async () => snapshot(8, modules),
    syncCapabilities: async () => ({ module_create: true }),
    async applySyncAction(action) {
      const intent = store.getJob('linked').results.findLast((entry) => entry.action_id === action.action_id);
      assert.equal(intent.status, 'started');
      assert.deepEqual(intent.resolved_fields, action.fields, 'resolved fields are durable before the remote call');
      writes.push(action.fields);
      const id = 80 + modules.length;
      modules.push(page(id, action.fields.name, action.fields.settings.content));
      return { module_id: id };
    }
  };
  const engine = createCourseSyncEngine({ stateStore: store });
  const plan = await engine.plan({ sourceAdapter, targetAdapter, sourceCourseId: 7, targetCourseId: 8 });
  assert.deepEqual(plan.actions.map((action) => action.fields.name), ['Second', 'First']);
  const job = await engine.apply({ planId: plan.plan_id, planDigest: plan.digest, sourceAdapter, targetAdapter, jobId: 'linked' });
  assert.equal(job.status, 'succeeded');
  assert.match(writes[1].settings.content, /https:\/\/target\.example\/learn\/mod\/page\/view\.php\?id=80&forceview=1#part/);
  const repeat = await engine.plan({ sourceAdapter, targetAdapter, sourceCourseId: 7, targetCourseId: 8 });
  assert.equal(repeat.actions.length, 0);
});

test('cyclic authored links remain blocking even under skip', () => {
  const source = snapshot(7, [
    page(20, 'First', '<a href="https://source.example/moodle/mod/page/view.php?id=21">Second</a>'),
    page(21, 'Second', '<a href="https://source.example/moodle/mod/page/view.php?id=20">First</a>')
  ]);
  for (const unsupportedPolicy of ['error', 'skip']) {
    const plan = createCourseSyncPlan({ source, target: snapshot(8, []), capabilities: { module_create: true }, unsupportedPolicy });
    assert.equal(plan.applicable, false);
    assert.ok(plan.unsupported.some((entry) => entry.reason === 'cyclic_action_dependencies'));
    validateSyncPlan(plan);
  }
});

test('a new entity cannot resolve its own identity while it is being created', () => {
  const plan = createCourseSyncPlan({ source: snapshot(7, [
    page(20, 'Self link', '<a href="https://source.example/moodle/mod/page/view.php?id=20">Here</a>')
  ]), target: snapshot(8, []), capabilities: { module_create: true } });
  assert.equal(plan.applicable, false);
  assert.ok(plan.unsupported.some((entry) => entry.reason === 'cyclic_action_dependencies'));
});

test('Book links do not silently drop an unknown chapter or attach a chapter to another Book', () => {
  const source = snapshot(7, [
    { id: 20, modname: 'book', name: 'First', authoring: { chapters: [{ chapter_id: 30, title: 'One' }] } },
    { id: 21, modname: 'book', name: 'Second', authoring: { chapters: [{ chapter_id: 31, title: 'Two' }] } }
  ]);
  const target = snapshot(8, []);
  for (const [chapterId, reason] of [[999, 'chapter_unresolved'], [31, 'chapter_owner_mismatch']]) {
    const result = rewriteMoodleHtmlReferences(`<a href="https://source.example/moodle/mod/book/view.php?id=20&amp;chapterid=${chapterId}">Read</a>`, {
      sourceSiteUrl: source.site.site_url, targetSiteUrl: target.site.site_url,
      sourceModel: source, targetModel: target, mapping: {}
    });
    assert.equal(result.blocked[0].reason, reason);
  }
});

test('signed plans reject invalid expiry, duplicate identities and forward execution dependencies', () => {
  const plan = createCourseSyncPlan({ source: snapshot(7, [page(20, 'Page', 'Text')]),
    target: snapshot(8, []), capabilities: { module_create: true } });
  for (const mutate of [
    (changed) => { changed.expires_at = 'invalid'; },
    (changed) => { changed.actions.push(structuredClone(changed.actions[0])); },
    (changed) => { changed.actions[0].depends_on = ['future'];
      changed.actions.push({ ...structuredClone(changed.actions[0]), action_id: 'future', depends_on: [] }); }
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    const { digest, ...unsigned } = changed;
    changed.digest = contentDigest(unsigned);
    assert.throws(() => validateSyncPlan(changed));
  }
});
