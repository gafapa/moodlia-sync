import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentDigest } from 'moodlia/core/canonical';
import { selectedCourseFields } from './model.mjs';
import { courseBindingId, createCourseSyncPlan, validateSyncPlan } from './planner.mjs';
import { resolveDeferredMoodleReferences } from './references.mjs';

const entityIdFields = ['id', 'section_id', 'group_id', 'grouping_id', 'module_id', 'chapter_id', 'page_id',
  'field_id', 'item_id', 'slot_id', 'course_id'];

// Adapter results echo related settings such as `grouping_id: 0` next to the
// created identity, so only a positive integer counts as the entity identifier.
function resultEntityId(result) {
  for (const field of entityIdFields) {
    const id = Number(result?.[field]);
    if (result?.[field] !== null && result?.[field] !== undefined && Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

// Internal: exported for tests only; sync/index.mjs does not re-export it.
export async function withAssetMaterials(sourceAdapter, assets, callback) {
  let cacheDirectory = null;
  try {
    const materials = [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      let material;
      if (typeof sourceAdapter.downloadAssetToFile === 'function') {
        cacheDirectory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'moodlia-sync-'));
        const destinationPath = path.join(cacheDirectory, `${index}.asset`);
        const downloaded = await sourceAdapter.downloadAssetToFile(asset, destinationPath);
        if (downloaded) {
          material = { asset, filePath: downloaded.path, sha256: downloaded.sha256, filesize: downloaded.filesize };
        }
      }
      if (!material) {
        const data = await sourceAdapter.downloadAsset(asset);
        material = {
          asset,
          data,
          sha256: createHash('sha256').update(data).digest('hex'),
          filesize: data.byteLength
        };
      }
      if (asset.sha256 && material.sha256 !== asset.sha256) {
        throw new TypeError(`Source asset changed after planning: ${asset.filename}.`);
      }
      if (Number(asset.filesize ?? 0) !== Number(material.filesize)) {
        throw new TypeError(`Source asset size changed after planning: ${asset.filename}.`);
      }
      materials.push(material);
    }
    return await callback(materials);
  } finally {
    if (cacheDirectory) await fs.rm(cacheDirectory, { recursive: true, force: true });
  }
}

function fieldsMatch(entity, fields) {
  return entity && Object.entries(fields).every(([name, value]) => entity[name] === value);
}

function reconcileCreateResult(action, model) {
  const collections = {
    'group.create': model.groups,
    'grouping.create': model.groupings
  };
  const candidates = (collections[action.kind] ?? [])
    .filter((entity) => fieldsMatch(entity, action.fields));
  if (candidates.length !== 1) return null;
  return { id: candidates[0].source_id, name: candidates[0].name };
}

function resolveActionReferences(action, context) {
  const resolveValue = (value) => {
    if (typeof value === 'string' && value.includes('moodlia-sync://')) {
      return resolveDeferredMoodleReferences(value, context);
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, resolveValue(item)]));
    }
    return value;
  };
  return resolveValue(action);
}

// Internal: exported for tests only.
export function currentEntityDigest(action, model) {
  if (action.kind === 'course.update') return contentDigest(selectedCourseFields(model));
  if (action.kind === 'section.update') {
    return contentDigest(model.sections.find((entry) => entry.source_id === action.target_id));
  }
  if (action.kind === 'group.update') {
    return contentDigest(model.groups.find((entry) => entry.source_id === action.target_id));
  }
  if (action.kind === 'grouping.update') {
    return contentDigest(model.groupings.find((entry) => entry.source_id === action.target_id));
  }
  if (['module.update', 'assignment_content.update', 'page_content.update', 'label_content.update',
    'url_content.update', 'resource_asset.replace'].includes(action.kind)) {
    return contentDigest(model.sections.flatMap((section) => section.modules)
      .find((entry) => entry.source_id === action.target_id));
  }
  if (action.kind === 'book_chapter.update') {
    return contentDigest(model.sections.flatMap((section) => section.modules)
      .flatMap((module) => module.authoring?.chapters ?? [])
      .find((entry) => Number(entry.chapter_id) === Number(action.target_id)));
  }
  return null;
}

// Internal: exported for tests only.
export function verifyResults(plan, model, results) {
  const failures = [];
  const resultByAction = new Map(results.map((entry) => [entry.action_id, entry]));
  for (const action of plan.actions) {
    let entity;
    if (action.kind === 'module_asset.stage') continue;
    if (action.kind === 'grouping.member.add') {
      const result = resultByAction.get(action.action_id)?.result;
      const groupingId = Number(result?.grouping_id ?? action.target_grouping_id);
      const groupId = Number(result?.group_id ?? action.target_group_id);
      const grouping = model.groupings.find((entry) => entry.source_id === groupingId);
      const group = model.groups.find((entry) => entry.source_id === groupId);
      if (!grouping || !group || !grouping.group_source_keys.includes(group.sync_key)) {
        failures.push({ action_id: action.action_id, reason: 'grouping_membership_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'course.update' || action.kind === 'course.create') entity = model.course;
    if (action.kind.startsWith('section.')) {
      const createdId = resultEntityId(resultByAction.get(action.action_id)?.result);
      entity = model.sections.find((entry) => entry.source_id === (action.target_id ?? createdId));
      const fields = resultByAction.get(action.action_id)?.resolved_fields ?? action.fields;
      if (!fieldsMatch(entity, fields)) {
        failures.push({ action_id: action.action_id, reason: 'readback_mismatch' });
      }
      if (action.expected_assets) {
        const assetsMatch = action.expected_assets.every((asset) => (entity?.files ?? [])
          .some((targetAsset) => asset.filepath === targetAsset.filepath
            && asset.filename === targetAsset.filename
            && asset.sha256 && asset.sha256 === targetAsset.sha256));
        if (!assetsMatch) failures.push({ action_id: action.action_id, reason: 'section_asset_readback_mismatch' });
      }
      continue;
    }
    if (action.kind.startsWith('group.')) {
      const createdId = resultEntityId(resultByAction.get(action.action_id)?.result);
      entity = model.groups.find((entry) => entry.source_id === (action.target_id ?? createdId));
    }
    if (action.kind.startsWith('grouping.')) {
      const createdId = resultEntityId(resultByAction.get(action.action_id)?.result);
      entity = model.groupings.find((entry) => entry.source_id === (action.target_id ?? createdId));
    }
    if (action.kind === 'module.create' || action.kind === 'module.update') {
      const createdId = resultEntityId(resultByAction.get(action.action_id)?.result);
      const moduleId = action.target_id ?? createdId;
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === moduleId);
      const fields = resultByAction.get(action.action_id)?.resolved_fields ?? action.fields;
      const settingsMatch = Object.entries(fields.settings ?? {})
        .every(([name, value]) => entity?.authoring?.settings?.[name] === value);
      if (!entity
        || (fields.module_type !== undefined && entity.module_type !== fields.module_type)
        || (fields.name !== undefined && entity.name !== fields.name)
        || (fields.visible !== undefined && entity.visible !== fields.visible)
        || !settingsMatch) {
        failures.push({ action_id: action.action_id, reason: 'readback_mismatch' });
      }
      if (action.expected_assets) {
        const targetAssets = entity?.authoring?.files ?? [];
        const assetsMatch = action.expected_assets.length === targetAssets.length
          && action.expected_assets.every((asset) => targetAssets.some((targetAsset) =>
            asset.filepath === targetAsset.filepath && asset.filename === targetAsset.filename
            && asset.sha256 && asset.sha256 === targetAsset.sha256));
        if (!assetsMatch) failures.push({ action_id: action.action_id, reason: 'module_asset_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'resource_asset.replace') {
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === action.target_id);
      const targetAssets = entity?.authoring?.files ?? [];
      const asset = action.asset;
      const matched = targetAssets.some((targetAsset) =>
        asset.filepath === targetAsset.filepath && asset.filename === targetAsset.filename
        && asset.sha256 && asset.sha256 === targetAsset.sha256);
      if (!matched) failures.push({ action_id: action.action_id, reason: 'resource_asset_readback_mismatch' });
      continue;
    }
    if (action.kind.startsWith('book_chapter.')) {
      const createdId = resultEntityId(resultByAction.get(action.action_id)?.result);
      const chapterId = action.target_id ?? createdId;
      entity = model.sections.flatMap((section) => section.modules)
        .flatMap((module) => module.authoring?.chapters ?? [])
        .find((entry) => Number(entry.chapter_id) === Number(chapterId));
      const comparable = entity ? {
        title: entity.title,
        content: entity.content,
        content_format: Number(entity.content_format ?? 1),
        subchapter: Boolean(entity.subchapter),
        hidden: Boolean(entity.hidden),
        order: Number(entity.page_number ?? 1) - 1
      } : null;
      const fields = resultByAction.get(action.action_id)?.resolved_fields ?? action.fields;
      if (!fieldsMatch(comparable, fields)) {
        failures.push({ action_id: action.action_id, reason: 'readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'assignment_content.update') {
      const createdModule = action.parent_source_key
        ? plan.actions.find((candidate) => candidate.kind === 'module.create'
          && candidate.source_key === action.parent_source_key)
        : null;
      const moduleId = action.target_id ?? resultEntityId(resultByAction.get(createdModule?.action_id)?.result);
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === moduleId);
      const comparable = { name: entity?.name, ...(entity?.authoring?.content ?? {}) };
      const fields = resultByAction.get(action.action_id)?.resolved_fields ?? action.fields;
      if (!fieldsMatch(comparable, fields)) failures.push({ action_id: action.action_id, reason: 'readback_mismatch' });
      if (action.expected_assets) {
        const targetAssets = entity?.authoring?.content?.[`${action.file_area}_files`] ?? [];
        const assetsMatch = action.expected_assets.every((asset) => targetAssets.some((targetAsset) =>
          asset.filepath === targetAsset.filepath && asset.filename === targetAsset.filename
          && asset.sha256 && asset.sha256 === targetAsset.sha256));
        if (!assetsMatch) failures.push({ action_id: action.action_id, reason: 'assignment_asset_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'page_content.update') {
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === action.target_id);
      const comparable = { name: entity?.name, ...(entity?.authoring?.settings ?? {}) };
      const fields = resultByAction.get(action.action_id)?.resolved_fields ?? action.fields;
      if (!fieldsMatch(comparable, fields)) {
        failures.push({ action_id: action.action_id, reason: 'readback_mismatch' });
      }
      if (action.expected_assets) {
        const targetAssets = entity?.authoring?.files ?? [];
        const assetsMatch = action.expected_assets.every((asset) => targetAssets.some((targetAsset) =>
          asset.filepath === targetAsset.filepath && asset.filename === targetAsset.filename
          && asset.sha256 && asset.sha256 === targetAsset.sha256));
        if (!assetsMatch) failures.push({ action_id: action.action_id, reason: 'page_asset_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'label_content.update' || action.kind === 'url_content.update') {
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === action.target_id);
      const comparable = action.kind === 'url_content.update'
        ? { name: entity?.name, ...(entity?.authoring?.settings ?? {}) }
        : (entity?.authoring?.settings ?? {});
      const fields = resultByAction.get(action.action_id)?.resolved_fields ?? action.fields;
      if (!fieldsMatch(comparable, fields)) {
        failures.push({ action_id: action.action_id, reason: 'readback_mismatch' });
      }
      if (action.expected_assets) {
        const targetAssets = entity?.authoring?.files ?? [];
        const assetsMatch = action.expected_assets.every((asset) => targetAssets.some((targetAsset) =>
          asset.filepath === targetAsset.filepath && asset.filename === targetAsset.filename
          && asset.sha256 && asset.sha256 === targetAsset.sha256));
        if (!assetsMatch) failures.push({ action_id: action.action_id, reason: 'editor_asset_readback_mismatch' });
      }
      continue;
    }
    if (['assignment_rubric.set', 'assignment_checklist.set', 'assignment_guide.set'].includes(action.kind)) {
      const createdModule = plan.actions.find((candidate) =>
        candidate.kind === 'module.create' && candidate.source_key === action.parent_source_key);
      const createdId = createdModule
        ? resultEntityId(resultByAction.get(createdModule.action_id)?.result)
        : action.target_module_id;
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === createdId);
      const expectedMethod = {
        'assignment_rubric.set': 'rubric',
        'assignment_checklist.set': 'checklist',
        'assignment_guide.set': 'guide'
      }[action.kind];
      const actualDefinition = entity?.authoring?.grading_definition
        ?? (entity?.authoring?.rubric ? { method: 'rubric', ...entity.authoring.rubric } : null);
      if (contentDigest(actualDefinition) !== contentDigest({ method: expectedMethod, ...action.fields })) {
        failures.push({ action_id: action.action_id, reason: 'grading_definition_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'workshop_form.set') {
      const createdModule = plan.actions.find((candidate) =>
        candidate.kind === 'module.create' && candidate.source_key === action.parent_source_key);
      const createdId = createdModule
        ? resultEntityId(resultByAction.get(createdModule.action_id)?.result)
        : action.target_module_id;
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === createdId);
      if (contentDigest(entity?.authoring?.grading_form ?? null) !== contentDigest(action.fields)) {
        failures.push({ action_id: action.action_id, reason: 'workshop_form_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'database_field.create' || action.kind === 'feedback_item.create') {
      const createdModule = plan.actions.find((candidate) =>
        candidate.kind === 'module.create' && candidate.source_key === action.parent_source_key);
      const moduleId = action.target_module_id
        ?? resultEntityId(resultByAction.get(createdModule?.action_id)?.result);
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === moduleId);
      if (action.kind === 'database_field.create') {
        const fields = entity?.authoring?.fields ?? [];
        const expected = {
          source_field_id: Number(action.source_key.split(':').at(-1)),
          type: action.fields.type,
          name: action.fields.name,
          description: action.fields.description,
          required: action.fields.required,
          options: action.fields.options
        };
        if (contentDigest(fields.find((field) => field.source_field_id === expected.source_field_id) ?? null)
          !== contentDigest(expected)) {
          failures.push({ action_id: action.action_id, reason: 'database_field_readback_mismatch' });
        }
      } else {
        const items = entity?.authoring?.items ?? [];
        const expected = {
          source_item_id: Number(action.source_key.split(':').at(-1)),
          type: action.fields.type,
          name: action.fields.name,
          definition: action.fields.definition,
          position: action.fields.position,
          label: action.fields.label,
          required: action.fields.required,
          source_depend_item_id: action.fields.source_depend_item_id,
          depend_value: action.fields.depend_value
        };
        if (contentDigest(items.find((item) => item.source_item_id === expected.source_item_id) ?? null)
          !== contentDigest(expected)) {
          failures.push({ action_id: action.action_id, reason: 'feedback_item_readback_mismatch' });
        }
      }
      continue;
    }
    if (action.kind === 'question_bank.import') {
      const createdModule = plan.actions.find((candidate) =>
        candidate.kind === 'module.create' && candidate.source_key === action.parent_source_key);
      const moduleId = action.target_module_id
        ?? resultEntityId(resultByAction.get(createdModule?.action_id)?.result);
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === moduleId);
      if (contentDigest(entity?.authoring?.blueprint ?? null) !== contentDigest(action.fields.blueprint)) {
        failures.push({ action_id: action.action_id, reason: 'question_bank_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'lesson_page.create') {
      const createdModule = plan.actions.find((candidate) =>
        candidate.kind === 'module.create' && candidate.source_key === action.parent_source_key);
      const moduleId = action.target_module_id
        ?? resultEntityId(resultByAction.get(createdModule?.action_id)?.result);
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === moduleId);
      const sourcePageId = Number(action.source_key.split(':').at(-1));
      const page = (entity?.authoring?.pages ?? [])
        .find((entry) => Number(entry.source_page_id) === sourcePageId);
      const comparable = page ? {
        page_type: page.page_type,
        title: page.title,
        content: page.content,
        content_format: page.content_format,
        definition: page.definition,
        display_in_menu: page.display_in_menu,
        horizontal: page.horizontal
      } : null;
      if (contentDigest(comparable) !== contentDigest(action.fields)) {
        failures.push({ action_id: action.action_id, reason: 'lesson_page_readback_mismatch' });
      }
      continue;
    }
    if (['quiz_questions.import', 'quiz_slot.create', 'quiz_slot.update'].includes(action.kind)) {
      const moduleSourceKey = action.kind === 'quiz_slot.update'
        ? action.module_source_key : action.parent_source_key;
      const createdModule = plan.actions.find((candidate) =>
        candidate.kind === 'module.create' && candidate.source_key === moduleSourceKey);
      const moduleId = action.target_module_id
        ?? resultEntityId(resultByAction.get(createdModule?.action_id)?.result);
      entity = model.sections.flatMap((section) => section.modules)
        .find((entry) => entry.source_id === moduleId);
      if (action.kind === 'quiz_questions.import') {
        if (contentDigest(entity?.authoring?.blueprint ?? null)
          !== contentDigest(action.fields.blueprint)) {
          failures.push({ action_id: action.action_id, reason: 'quiz_question_readback_mismatch' });
        }
      } else {
        const slot = (entity?.authoring?.slots ?? [])
          .find((entry) => Number(entry.slot) === Number(action.fields.slot));
        if (!slot
          || (action.kind === 'quiz_slot.create'
            && Number(slot.source_question_id) !== Number(action.fields.source_question_id))
          || (action.kind === 'quiz_slot.update'
            && Number(slot.max_mark) !== Number(action.fields.max_mark))) {
          failures.push({ action_id: action.action_id, reason: 'quiz_slot_readback_mismatch' });
        }
      }
      continue;
    }
    if (action.kind === 'course_completion.set') {
      const result = resultByAction.get(action.action_id)?.result;
      const actual = model.course_completion;
      const expectedIds = (result?.required_module_ids ?? [])
        .map(Number).sort((left, right) => left - right);
      const actualIds = (actual?.required_modules ?? [])
        .map((entry) => Number(entry.source_module_id)).sort((left, right) => left - right);
      if (!actual
        || contentDigest(expectedIds) !== contentDigest(actualIds)
        || actual.activity_aggregation !== (action.fields.require_all_activities ? 'all' : 'any')
        || actual.criteria_aggregation !== action.fields.criteria_aggregation
        || (action.fields.required_course_grade_percent !== undefined
          && Number(actual.required_course_grade_percent) !== Number(action.fields.required_course_grade_percent))) {
        failures.push({ action_id: action.action_id, reason: 'course_completion_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'grade_item.create' || action.kind === 'grade_item.update') {
      const result = resultByAction.get(action.action_id)?.result;
      let item = (model.gradebook?.items ?? []).find((entry) =>
        Number(entry.remote_item_id) === Number(action.target_id ?? resultEntityId(result)));
      if (!item && action.module_source_key) {
        const createdModule = plan.actions.find((candidate) =>
          candidate.kind === 'module.create' && candidate.source_key === action.module_source_key);
        const moduleId = action.target_module_id
          ?? resultEntityId(resultByAction.get(createdModule?.action_id)?.result);
        item = (model.gradebook?.items ?? []).find((entry) =>
          entry.kind === 'module'
          && entry.module_source_key === `module:${moduleId}`
          && Number(entry.item_number) === Number(action.item_number ?? 0));
      }
      if (!item || !fieldsMatch(item, action.fields)) {
        failures.push({ action_id: action.action_id, reason: 'grade_item_readback_mismatch' });
      }
      continue;
    }
    if (action.kind === 'book_asset.transfer') {
      const chapterResult = resultByAction.get(action.action_id)?.result;
      const files = chapterResult?.files ?? chapterResult?.uploaded_files ?? [];
      const matched = action.assets.every((asset) => files.some((file) =>
          String(file.filename) === asset.filename
          && String(file.filepath ?? '/') === asset.filepath
          && Number(file.filesize ?? -1) === asset.filesize
          && (!asset.content_hash || !file.content_hash || file.content_hash === asset.content_hash)));
      if (!matched) failures.push({ action_id: action.action_id, reason: 'asset_set_readback_mismatch' });
      continue;
    }
    if (!fieldsMatch(entity, action.fields)) {
      failures.push({ action_id: action.action_id, reason: 'readback_mismatch' });
    }
  }
  return failures;
}

export class CourseSyncEngine {
  constructor({ stateStore }) {
    if (!stateStore) throw new TypeError('stateStore is required.');
    this.stateStore = stateStore;
  }

  async plan({
    sourceAdapter, targetAdapter, sourceCourseId, targetCourseId = null,
    targetCreation = null, mapping = {}, policies = {}
  }) {
    const [source, target, targetCapabilities] = await Promise.all([
      sourceAdapter.exportCourse(sourceCourseId),
      targetCreation
        ? targetAdapter.prepareTargetCourse(targetCreation)
        : targetAdapter.exportCourse(targetCourseId),
      targetAdapter.syncCapabilities(targetCreation
        ? { categoryId: targetCreation.category_id }
        : { courseId: targetCourseId })
    ]);
    const bindingId = courseBindingId(source, target);
    const storedBinding = this.stateStore.getBinding(bindingId);
    const effectiveMapping = Object.keys(mapping).length > 0 ? mapping : storedBinding?.entity_mappings ?? {};
    const plan = createCourseSyncPlan({
      source,
      target,
      mapping: effectiveMapping,
      baseline: storedBinding?.baseline ?? null,
      capabilities: targetCapabilities,
      targetCreation,
      unsupportedPolicy: policies.unsupported ?? 'error',
      conflictPolicy: policies.conflict ?? 'abort'
    });
    this.stateStore.savePlan(plan);
    return plan;
  }

  async apply({ planId, planDigest, sourceAdapter, targetAdapter, jobId = null, resumeJobId = null }) {
    const plan = this.stateStore.getPlan(planId);
    if (!plan) throw new TypeError(`Unknown sync plan: ${planId}.`);
    validateSyncPlan(plan);
    if (plan.digest !== planDigest) throw new TypeError('The approved plan digest does not match the stored plan.');
    if (!plan.applicable) throw new TypeError('The sync plan contains blocking conflicts or unsupported changes.');
    const resumedJob = resumeJobId ? this.stateStore.getJob(resumeJobId) : null;
    if (resumeJobId && (!resumedJob || resumedJob.plan_id !== plan.plan_id)) {
      throw new TypeError('The requested resume job does not belong to this plan.');
    }
    const freshSource = await sourceAdapter.exportCourse(plan.source.course_id);
    const resumedCourseCreation = resumedJob?.results.find((entry) => {
      const action = plan.actions.find((candidate) => candidate.action_id === entry.action_id);
      return entry.status === 'succeeded' && action?.kind === 'course.create';
    });
    const resumedTargetCourseId = resultEntityId(resumedCourseCreation?.result);
    const freshTarget = resumedTargetCourseId
      ? await targetAdapter.exportCourse(resumedTargetCourseId)
      : (plan.target.course_id === null
        ? await targetAdapter.prepareTargetCourse(plan.target.creation)
        : await targetAdapter.exportCourse(plan.target.course_id));
    if (freshSource.digest !== plan.source.digest || (!resumedJob && freshTarget.digest !== plan.target.digest)) {
      throw new TypeError('Source or target changed after the sync plan was created.');
    }
    if (resumedJob) {
      for (const action of plan.actions) {
        if (resumedJob.results.some((entry) => entry.action_id === action.action_id && entry.status === 'succeeded')) {
          continue;
        }
        const result = resumedJob.results.findLast((entry) => entry.action_id === action.action_id);
        if (!result || !['failed', 'unknown_outcome'].includes(result.status)) continue;
        const reconciledResult = reconcileCreateResult(action, freshTarget);
        if (reconciledResult) {
          result.status = 'succeeded';
          result.result = reconciledResult;
          if (result.error) result.previous_error = result.error;
          delete result.error;
          result.reconciled_at = new Date().toISOString();
          if (action.entity_namespace && action.source_key) {
            const binding = this.stateStore.getBinding(plan.binding_id) ?? {
              schema_version: 1,
              binding_id: plan.binding_id,
              source: plan.source,
              target: plan.target,
              entity_mappings: {}
            };
            binding.entity_mappings[action.entity_namespace] ??= {};
            binding.entity_mappings[action.entity_namespace][action.source_key] = reconciledResult.id;
            binding.updated_at = new Date().toISOString();
            this.stateStore.saveBinding(binding);
          }
          continue;
        }
        if (result.status === 'unknown_outcome') {
          const failures = verifyResults({ ...plan, actions: [action] }, freshTarget, [result]);
          if (failures.length > 0) {
            throw new TypeError('An action has an ambiguous outcome and requires reconciliation before resume.');
          }
          result.status = 'succeeded';
          result.reconciled_at = new Date().toISOString();
        }
      }
      this.stateStore.saveJob(resumedJob);
      const completedIds = new Set(resumedJob.results
        .filter((entry) => entry.status === 'succeeded')
        .map((entry) => entry.action_id));
      const completedPlan = { ...plan, actions: plan.actions.filter((action) => completedIds.has(action.action_id)) };
      const failures = verifyResults(completedPlan, freshTarget, resumedJob.results);
      if (failures.length > 0) throw new TypeError('Completed actions require reconciliation before this job can resume.');
    }
    const executionOwner = resumeJobId ?? jobId ?? randomUUID();
    const leaseExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    if (!this.stateStore.acquireLease(plan.binding_id, executionOwner, leaseExpiry)) {
      throw new TypeError('Another synchronization job holds the target course lease.');
    }
    const queuedJob = resumedJob ?? (jobId ? this.stateStore.getJob(jobId) : null);
    if (queuedJob?.status === 'cancel_requested') {
      const cancelled = { ...queuedJob, status: 'cancelled', updated_at: new Date().toISOString() };
      this.stateStore.saveJob(cancelled);
      this.stateStore.releaseLease(plan.binding_id, executionOwner);
      return cancelled;
    }
    const job = resumedJob ? {
      ...resumedJob,
      correlation_id: resumedJob.correlation_id ?? randomUUID(),
      status: 'running',
      updated_at: new Date().toISOString()
    } : {
      schema_version: 1,
      job_id: jobId ?? randomUUID(),
      correlation_id: queuedJob?.correlation_id ?? randomUUID(),
      plan_id: plan.plan_id,
      status: 'running',
      created_at: queuedJob?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      results: []
    };
    delete job.error;
    this.stateStore.saveJob(job);
    const createdEntities = new Map();
    for (const completed of job.results) {
      const action = plan.actions.find((entry) => entry.action_id === completed.action_id);
      if (completed.status === 'succeeded' && action?.entity_namespace && action.source_key) {
        createdEntities.set(`${action.entity_namespace}:${action.source_key}`, completed.result);
      }
    }
    const completedActionIds = new Set(job.results
      .filter((entry) => entry.status === 'succeeded')
      .map((entry) => entry.action_id));
    let activeResult = null;
    let currentCourseId = plan.target.course_id;
    for (const completed of job.results.filter((entry) => entry.status === 'succeeded')) {
      const action = plan.actions.find((entry) => entry.action_id === completed.action_id);
      if (action?.kind === 'course.create') currentCourseId = resultEntityId(completed.result);
    }
    try {
      for (const action of plan.actions) {
        if (completedActionIds.has(action.action_id)) continue;
        const unmetDependencies = (action.depends_on ?? [])
          .filter((dependencyId) => !completedActionIds.has(dependencyId));
        if (unmetDependencies.length > 0) {
          const error = new TypeError(`Action ${action.action_id} has unmet dependencies.`);
          error.code = 'action_dependency_unmet';
          error.dependencies = unmetDependencies;
          throw error;
        }
        this.stateStore.acquireLease(
          plan.binding_id,
          executionOwner,
          new Date(Date.now() + 10 * 60 * 1000).toISOString()
        );
        const persistedJob = this.stateStore.getJob(job.job_id);
        if (persistedJob?.status === 'cancel_requested') {
          job.status = 'cancelled';
          job.updated_at = new Date().toISOString();
          this.stateStore.saveJob(job);
          return job;
        }
        const context = {
          courseId: currentCourseId,
          createdEntities,
          targetSiteUrl: plan.target.site_url,
          mapping: plan.entity_mapping_snapshot
        };
        if (action.expected_target_digest) {
          const immediateTarget = await targetAdapter.exportCourse(currentCourseId);
          if (currentEntityDigest(action, immediateTarget) !== action.expected_target_digest) {
            const error = new TypeError(`Target entity changed before action ${action.action_id}.`);
            error.code = 'entity_precondition_failed';
            throw error;
          }
        }
        activeResult = {
          action_id: action.action_id,
          correlation_id: `${job.correlation_id}:${action.action_id}`,
          attempt: job.results.filter((entry) => entry.action_id === action.action_id).length + 1,
          status: 'started',
          started_at: new Date().toISOString()
        };
        job.results.push(activeResult);
        job.updated_at = new Date().toISOString();
        this.stateStore.saveJob(job);
        const executableAction = resolveActionReferences(action, context);
        activeResult.resolved_fields = executableAction.fields;
        let result;
        if (action.kind === 'module_asset.stage') {
          result = await withAssetMaterials(sourceAdapter, executableAction.assets, (materials) =>
            targetAdapter.stageModuleAssets(executableAction, materials, context));
        } else if (action.kind === 'resource_asset.replace') {
          result = await withAssetMaterials(sourceAdapter, [executableAction.asset], ([material]) =>
            targetAdapter.replaceResourceAsset(executableAction, material, context));
        } else if (action.kind === 'book_asset.transfer') {
          result = await withAssetMaterials(sourceAdapter, executableAction.assets, (materials) =>
            targetAdapter.publishBookChapterAssets(executableAction, materials, context));
        } else {
          result = await targetAdapter.applySyncAction(executableAction, context);
        }
        activeResult.status = 'succeeded';
        activeResult.result = result;
        activeResult.completed_at = new Date().toISOString();
        activeResult = null;
        completedActionIds.add(action.action_id);
        if (action.kind === 'course.create') currentCourseId = resultEntityId(result);
        if (action.entity_namespace && action.source_key) {
          createdEntities.set(`${action.entity_namespace}:${action.source_key}`, result);
        }
        if (action.target_id === null && action.entity_namespace) {
          const targetId = resultEntityId(result);
          if (targetId) {
            const binding = this.stateStore.getBinding(plan.binding_id) ?? {
              schema_version: 1,
              binding_id: plan.binding_id,
              source: plan.source,
              target: plan.target,
              entity_mappings: {}
            };
            binding.entity_mappings[action.entity_namespace] ??= {};
            binding.entity_mappings[action.entity_namespace][action.source_key] = targetId;
            binding.updated_at = new Date().toISOString();
            this.stateStore.saveBinding(binding);
          }
        }
        job.updated_at = new Date().toISOString();
        this.stateStore.saveJob(job);
      }
      const verified = await targetAdapter.exportCourse(currentCourseId);
      const verificationFailures = verifyResults(plan, verified, job.results);
      if (verificationFailures.length > 0) {
        const error = new TypeError('One or more synchronization actions failed readback verification.');
        error.code = 'verification_failed';
        error.failures = verificationFailures;
        error.details = { failures: verificationFailures };
        throw error;
      }
      job.status = 'succeeded';
      job.verification = { target_digest: verified.digest, checked_at: new Date().toISOString() };
      job.updated_at = new Date().toISOString();
      this.stateStore.saveJob(job);
      const binding = this.stateStore.getBinding(plan.binding_id) ?? {
        schema_version: 1,
        binding_id: plan.binding_id,
        source: plan.source,
        target: plan.target,
        entity_mappings: {}
      };
      binding.baseline = { source_model: freshSource, target_model: verified };
      binding.target = { ...plan.target, course_id: currentCourseId };
      binding.updated_at = new Date().toISOString();
      this.stateStore.saveBinding(binding);
      const actualBindingId = courseBindingId(freshSource, verified);
      if (actualBindingId !== binding.binding_id) {
        this.stateStore.saveBinding({ ...binding, binding_id: actualBindingId });
      }
      return job;
    } catch (error) {
      const ambiguous = error?.name === 'AbortError'
        || ['request_timeout', 'transport_error', 'network_error'].includes(error?.code);
      if (activeResult) {
        activeResult.status = ambiguous ? 'unknown_outcome' : 'failed';
        activeResult.error = { name: error.name, code: error.code, message: error.message };
        activeResult.completed_at = new Date().toISOString();
      }
      job.status = error.code === 'verification_failed'
        ? 'verification_failed'
        : (ambiguous ? 'unknown_outcome' : (job.results.some((entry) => entry.status === 'succeeded') ? 'partially_applied' : 'failed'));
      job.error = {
        name: error.name,
        code: error.code,
        message: error.message,
        ...(error.details && typeof error.details === 'object' ? { details: error.details } : {})
      };
      job.updated_at = new Date().toISOString();
      this.stateStore.saveJob(job);
      throw error;
    } finally {
      this.stateStore.releaseLease(plan.binding_id, executionOwner);
    }
  }

  async verify({ planId, targetAdapter, jobId = null }) {
    const plan = this.stateStore.getPlan(planId);
    if (!plan) throw new TypeError(`Unknown sync plan: ${planId}.`);
    const jobs = this.stateStore.listJobs()
      .filter((job) => job.plan_id === planId && (!jobId || job.job_id === jobId));
    const job = jobs.find((entry) => entry.status === 'succeeded') ?? jobs[0];
    if (!job) throw new TypeError('No synchronization job exists for this plan.');
    const binding = this.stateStore.getBinding(plan.binding_id);
    const targetCourseId = binding?.target?.course_id ?? plan.target.course_id;
    if (!targetCourseId) throw new TypeError('The target course identity is not available for verification.');
    const target = await targetAdapter.exportCourse(targetCourseId);
    const failures = verifyResults(plan, target, job.results);
    return {
      plan_id: planId,
      job_id: job.job_id,
      target_course_id: targetCourseId,
      target_digest: target.digest,
      verified: failures.length === 0,
      failures,
      checked_at: new Date().toISOString()
    };
  }
}

export function createCourseSyncEngine(options) {
  return new CourseSyncEngine(options);
}
