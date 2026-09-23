import { contentDigest } from 'moodlia/core/canonical';

function optionalString(value) {
  return value === undefined || value === null ? null : String(value);
}

function normalizeTextFormat(value) {
  if (value === undefined || value === null || value === '') return null;
  const formats = { 0: 'moodle', 1: 'html', 2: 'plain', 4: 'markdown' };
  return formats[value] ?? String(value).toLowerCase();
}

function fieldState(source, names, normalizedValue) {
  const declared = names.some((name) => Object.hasOwn(source, name));
  if (!declared) return 'unknown';
  if (normalizedValue === null) return 'explicit_null';
  if (normalizedValue === '') return 'explicit_empty';
  return 'present';
}

function fieldStates(source, definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([field, { names, value }]) => [
    field,
    fieldState(source, names, value)
  ]));
}

function normalizeSection(section, index) {
  const sourceId = Number(section.id ?? section.section_id ?? 0);
  const sectionNumber = Number(section.section ?? section.section_number ?? index);
  const normalized = {
    sync_key: `section:${sourceId || sectionNumber}`,
    source_id: sourceId || null,
    section_number: sectionNumber,
    name: optionalString(section.name) ?? '',
    summary: optionalString(section.summary) ?? '',
    summary_format: normalizeTextFormat(section.summaryformat ?? section.summary_format ?? 1),
    files: structuredClone(section.files ?? section.summary_files ?? []),
    visible: section.visible === undefined ? null : Boolean(section.visible),
    order: index,
    modules: (section.modules ?? []).map((module, moduleIndex) => {
      const normalizedModule = {
        sync_key: `module:${Number(module.id ?? module.module_id ?? 0) || `${sectionNumber}:${moduleIndex}`}`,
        source_id: Number(module.id ?? module.module_id ?? 0) || null,
        instance_id: Number(module.instance ?? module.instance_id ?? 0) || null,
        module_type: String(module.modname ?? module.module_type ?? ''),
        name: optionalString(module.name) ?? '',
        visible: module.visible === undefined ? null : Boolean(module.visible),
        order: moduleIndex,
        url: optionalString(module.url),
        availability: optionalString(module.availability),
        authoring_completeness: module.authoring_completeness ?? 'shell',
        authoring: module.authoring ? structuredClone(module.authoring) : null
      };
      normalizedModule.field_states = fieldStates(module, {
        name: { names: ['name'], value: normalizedModule.name },
        visible: { names: ['visible'], value: normalizedModule.visible },
        availability: { names: ['availability'], value: normalizedModule.availability },
        authoring: { names: ['authoring'], value: normalizedModule.authoring }
      });
      return normalizedModule;
    })
  };
  normalized.field_states = fieldStates(section, {
    name: { names: ['name'], value: normalized.name },
    summary: { names: ['summary'], value: normalized.summary },
    summary_format: { names: ['summaryformat', 'summary_format'], value: normalized.summary_format },
    files: { names: ['files', 'summary_files'], value: normalized.files },
    visible: { names: ['visible'], value: normalized.visible }
  });
  return normalized;
}

export function createCourseSyncModel({
  site, course, sections = [], groups = [], groupings = [], exclusions = [], targetCreation = null,
  completeness = {}, losses = [], unknowns = [], capabilityEvidence = {}, courseCompletion = null,
  gradebook = null
}) {
  if (!site || !course) throw new TypeError('site and course are required.');
  const normalizedGroups = groups.map((group) => ({
    sync_key: `group:${Number(group.id ?? group.group_id ?? 0) || String(group.idnumber ?? group.name)}`,
    source_id: Number(group.id ?? group.group_id ?? 0) || null,
    name: optionalString(group.name) ?? '',
    description: optionalString(group.description) ?? '',
    idnumber: optionalString(group.idnumber),
    visibility: group.visibility ?? null,
    participation: group.participation ?? null
  }));
  const normalizedCourse = {
    source_id: Number(course.id ?? course.course_id ?? 0) || null,
    fullname: optionalString(course.fullname) ?? '',
    shortname: optionalString(course.shortname) ?? '',
    category_id: Number(course.category_id ?? course.categoryid ?? 0) || null,
    idnumber: optionalString(course.idnumber),
    summary: optionalString(course.summary),
    summary_format: normalizeTextFormat(course.summary_format ?? course.summaryformat),
    visible: course.visible === undefined ? null : Boolean(course.visible),
    start_date: course.start_date ?? course.startdate ?? null,
    end_date: course.end_date ?? course.enddate ?? null
  };
  normalizedCourse.field_states = fieldStates(course, {
    fullname: { names: ['fullname'], value: normalizedCourse.fullname },
    shortname: { names: ['shortname'], value: normalizedCourse.shortname },
    category_id: { names: ['category_id', 'categoryid'], value: normalizedCourse.category_id },
    idnumber: { names: ['idnumber'], value: normalizedCourse.idnumber },
    summary: { names: ['summary'], value: normalizedCourse.summary },
    summary_format: { names: ['summary_format', 'summaryformat'], value: normalizedCourse.summary_format },
    visible: { names: ['visible'], value: normalizedCourse.visible },
    start_date: { names: ['start_date', 'startdate'], value: normalizedCourse.start_date },
    end_date: { names: ['end_date', 'enddate'], value: normalizedCourse.end_date }
  });
  const model = {
    schema_version: 2,
    extracted_at: new Date().toISOString(),
    ...(targetCreation ? { target_creation: structuredClone(targetCreation) } : {}),
    site: {
      provider: String(site.provider),
      profile: optionalString(site.profile),
      site_url: String(site.site_url),
      moodle_version: optionalString(site.moodle_version),
      plugin_version: optionalString(site.plugin_version)
    },
    course: normalizedCourse,
    sections: sections.map(normalizeSection),
    groups: normalizedGroups,
    groupings: groupings.map((grouping) => ({
      sync_key: `grouping:${Number(grouping.id ?? grouping.grouping_id ?? 0) || String(grouping.idnumber ?? grouping.name)}`,
      source_id: Number(grouping.id ?? grouping.grouping_id ?? 0) || null,
      name: optionalString(grouping.name) ?? '',
      description: optionalString(grouping.description) ?? '',
      idnumber: optionalString(grouping.idnumber),
      group_source_keys: (grouping.group_ids ?? grouping.groups?.map((group) => group.id) ?? [])
        .map((groupId) => normalizedGroups.find((group) => group.source_id === Number(groupId))?.sync_key)
        .filter(Boolean)
    })),
    course_completion: courseCompletion ? structuredClone(courseCompletion) : null,
    gradebook: gradebook ? structuredClone(gradebook) : null,
    assets: [],
    exclusions: [...exclusions],
    losses: structuredClone(losses),
    unknowns: structuredClone(unknowns),
    completeness: {
      inventory: completeness.inventory ?? 'complete',
      pagination: completeness.pagination ?? 'complete',
      authoring: completeness.authoring ?? 'selected'
    },
    capability_evidence: structuredClone(capabilityEvidence)
  };
  model.assets = model.sections.flatMap((section) => [
    ...(section.files ?? []).map((file) => ({
      owner: {
        entity: section.sync_key,
        component: 'course',
        file_area: 'section',
        field: 'summary'
      },
      filename: String(file.filename ?? ''),
      filepath: String(file.filepath ?? '/'),
      filesize: Number(file.filesize ?? 0),
      mimetype: optionalString(file.mimetype),
      content_hash: optionalString(file.content_hash),
      sha256: optionalString(file.sha256),
      url: optionalString(file.url)
    })),
    ...section.modules.flatMap((module) => [
    ...(module.authoring?.files ?? []).map((file) => ({
      owner: {
        entity: module.sync_key,
        module: module.sync_key,
        component: `mod_${module.module_type}`,
        file_area: 'content',
        field: 'files'
      },
      filename: String(file.filename ?? ''),
      filepath: String(file.filepath ?? '/'),
      filesize: Number(file.filesize ?? 0),
      mimetype: optionalString(file.mimetype),
      content_hash: optionalString(file.content_hash),
      sha256: optionalString(file.sha256),
      url: optionalString(file.url)
    })),
    ...(module.authoring?.chapters ?? []).flatMap((chapter) => (chapter.files ?? []).map((file) => ({
      owner: {
        entity: `chapter:${Number(chapter.chapter_id ?? 0) || 'unknown'}`,
        module: module.sync_key,
        component: 'mod_book',
        file_area: 'chapter',
        field: 'content'
      },
      filename: String(file.filename ?? ''),
      filepath: String(file.filepath ?? '/'),
      filesize: Number(file.filesize ?? 0),
      mimetype: optionalString(file.mimetype),
      content_hash: optionalString(file.content_hash),
      sha256: optionalString(file.sha256),
      url: optionalString(file.url)
    }))),
    ...['intro', 'activity'].flatMap((field) => (module.authoring?.content?.[`${field}_files`] ?? [])
      .map((file) => ({
        owner: {
          entity: module.sync_key,
          module: module.sync_key,
          component: 'mod_assign',
          file_area: field === 'intro' ? 'intro' : 'activityattachment',
          field
        },
        filename: String(file.filename ?? ''),
        filepath: String(file.filepath ?? '/'),
        filesize: Number(file.filesize ?? 0),
        mimetype: optionalString(file.mimetype),
        content_hash: optionalString(file.content_hash),
        sha256: optionalString(file.sha256),
        url: optionalString(file.url)
      })))
    ])
  ]).map((asset) => ({
    asset_key: `asset:${contentDigest({
      owner: asset.owner,
      filepath: asset.filepath,
      filename: asset.filename,
      content_hash: asset.content_hash,
      sha256: asset.sha256
    }).slice(0, 24)}`,
    logical_path: `${asset.filepath}${asset.filename}`.replaceAll('//', '/'),
    ...asset
  }));
  model.digest = contentDigest({ ...model, extracted_at: undefined, digest: undefined });
  return model;
}

export function selectedCourseFields(model) {
  const result = {};
  for (const field of ['fullname', 'shortname', 'category_id', 'idnumber', 'summary', 'summary_format', 'visible', 'start_date', 'end_date']) {
    if (model.course[field] !== null && model.course[field] !== undefined) result[field] = model.course[field];
  }
  return result;
}
