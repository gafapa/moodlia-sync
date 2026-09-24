import { createCourseSyncModel } from '../sync/model.mjs';
import { CoreMoodleAdapter } from 'moodlia/core/adapters';

const CORE_GROUP_VISIBILITY = { all: 0, members: 1, own: 2, none: 3 };

// The sync model names group visibility; Moodle Core's web service takes 0-3.
function coreGroupFields(fields) {
  if (fields.visibility === undefined || fields.visibility === null) return fields;
  return { ...fields, visibility: CORE_GROUP_VISIBILITY[fields.visibility] ?? fields.visibility };
}

function operationNames(client) {
  return new Set(client.operationNames());
}

function operationAvailable(client, discovery, name) {
  if (!operationNames(client).has(name)) return false;
  const operation = client.contract?.operations?.find((entry) => entry.name === name);
  if (!operation?.moodleFunction) return false;
  return new Set(discovery?.functions ?? []).has(operation.moodleFunction);
}

async function optionalOperation(client, discovery, name, parameters, fallback = []) {
  if (!operationAvailable(client, discovery, name)) return fallback;
  try {
    return await client.callOperation(name, parameters);
  } catch (error) {
    if (['function_not_available', 'permission_denied', 'invalid_response'].includes(error.code)) return fallback;
    throw error;
  }
}

export class CoreSyncAdapter extends CoreMoodleAdapter {
  async exportCourse(courseId) {
    const site = this.discovery ?? await this.discoverSite();
    const [course, sections, groups, groupingSummaries] = await Promise.all([
      this.client.callOperation('get_course', { course_id: courseId }),
      this.client.callOperation('get_course_contents', { course_id: courseId }),
      optionalOperation(this.client, site, 'get_course_groups', { course_id: courseId }),
      optionalOperation(this.client, site, 'get_course_groupings', { course_id: courseId })
    ]);
    const groupings = await Promise.all(groupingSummaries.map(async (grouping) => {
      const groupingId = Number(grouping.id ?? grouping.grouping_id);
      if (!groupingId || !operationAvailable(this.client, site, 'get_grouping')) return grouping;
      return optionalOperation(this.client, site, 'get_grouping', {
        grouping_id: groupingId,
        include_groups: true
      }, grouping);
    }));
    const authoringUnknowns = sections.flatMap((section) => (section.modules ?? []).map((module) => ({
      scope: `module:${Number(module.id ?? module.module_id ?? 0)}`,
      field: 'authoring',
      reason: 'core_course_contents_is_not_a_complete_authoring_export'
    })));
    return createCourseSyncModel({
      site,
      course,
      sections,
      groups,
      groupings,
      exclusions: [
        { scope: 'student_outcomes', reason: 'content_sync_scope' },
        { scope: 'activity_authoring_fields', reason: 'core_course_contents_is_not_a_complete_authoring_export' }
      ],
      unknowns: authoringUnknowns,
      completeness: { inventory: 'complete', pagination: 'complete', authoring: 'shell' },
      capabilityEvidence: {
        provider: 'core',
        declared_function_count: site.functions.length,
        contract_operation_count: site.operations.length
      }
    });
  }

  async prepareTargetCourse({ category_id: categoryId, shortname }) {
    const site = this.discovery ?? await this.discoverSite();
    return createCourseSyncModel({
      site,
      course: { id: null, fullname: '', shortname: '', category_id: categoryId, visible: false },
      sections: [{ id: null, section: 0, name: '', summary: '', visible: true, modules: [] }],
      targetCreation: { category_id: Number(categoryId), shortname: String(shortname) },
      exclusions: [{ scope: 'target_course', reason: 'not_created_yet' }]
    });
  }

  async syncCapabilities() {
    if (!this.discovery) await this.discoverSite();
    const available = (name) => operationAvailable(this.client, this.discovery, name);
    return {
      course_create: {
        available: available('create_course'),
        permission: 'unknown',
        supported_fields: ['fullname', 'shortname', 'category_id', 'idnumber', 'summary', 'visible', 'start_date', 'end_date']
      },
      course_update: {
        available: available('update_course'),
        permission: 'unknown',
        supported_fields: ['fullname', 'shortname', 'category_id', 'idnumber', 'summary', 'visible', 'start_date', 'end_date']
      },
      section_create: false,
      section_update: false,
      group_create: {
        available: available('create_group'),
        permission: 'unknown',
        supported_fields: ['name', 'description', 'idnumber', 'visibility', 'participation']
      },
      group_update: {
        available: available('update_group'),
        permission: 'unknown',
        supported_fields: ['name', 'description', 'idnumber', 'visibility', 'participation']
      },
      grouping_create: {
        available: available('create_grouping'), permission: 'unknown',
        supported_fields: ['name', 'description', 'idnumber']
      },
      grouping_update: {
        available: available('update_grouping'), permission: 'unknown',
        supported_fields: ['name', 'description', 'idnumber']
      },
      grouping_member_add: {
        available: available('add_group_to_grouping'), permission: 'unknown',
        supported_fields: ['grouping_id', 'group_id']
      }
    };
  }

  async applySyncAction(action, { courseId, createdEntities }) {
    if (action.kind === 'course.create') {
      return this.client.callOperation('create_course', action.fields);
    }
    if (action.kind === 'course.update') {
      return this.client.callOperation('update_course', { course_id: courseId, ...action.fields });
    }
    if (action.kind === 'group.create') {
      return this.client.callOperation('create_group', { course_id: courseId, ...coreGroupFields(action.fields) });
    }
    if (action.kind === 'group.update') {
      return this.client.callOperation('update_group', { group_id: action.target_id, ...coreGroupFields(action.fields) });
    }
    if (action.kind === 'grouping.create') {
      return this.client.callOperation('create_grouping', { course_id: courseId, ...action.fields });
    }
    if (action.kind === 'grouping.update') {
      return this.client.callOperation('update_grouping', { grouping_id: action.target_id, ...action.fields });
    }
    if (action.kind === 'grouping.member.add') {
      const groupingId = action.target_grouping_id
        ?? Number(createdEntities.get(`groupings:${action.grouping_source_key}`)?.id
          ?? createdEntities.get(`groupings:${action.grouping_source_key}`)?.grouping_id);
      const groupId = action.target_group_id
        ?? Number(createdEntities.get(`groups:${action.group_source_key}`)?.id
          ?? createdEntities.get(`groups:${action.group_source_key}`)?.group_id);
      return this.client.callOperation('add_group_to_grouping', { grouping_id: groupingId, group_id: groupId });
    }
    throw new TypeError(`Core adapter cannot apply sync action ${action.kind}.`);
  }
}

export function createCoreSyncAdapter(options) {
  return new CoreSyncAdapter(options);
}
