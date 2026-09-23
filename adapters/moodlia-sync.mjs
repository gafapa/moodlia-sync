import { createHash } from 'node:crypto';
import { createCourseSyncModel } from '../sync/model.mjs';
import { MoodliaMoodleAdapter } from 'moodlia/adapters/moodlia';

function parseCapabilityEvidence(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeQuestionBankBlueprint(value) {
  const blueprint = parseObject(value);
  const categoryIds = new Map((blueprint.categories ?? []).map((category, index) => [
    Number(category.source_category_id), index + 1
  ]));
  let questionIndex = 0;
  return {
    schema: String(blueprint.schema ?? 'moodlia.question_bank_blueprint.v1'),
    bank_scope: String(blueprint.bank_scope ?? 'course_shared'),
    categories: (blueprint.categories ?? []).map((category, index) => ({
      source_category_id: index + 1,
      source_parent_id: categoryIds.get(Number(category.source_parent_id)) ?? 0,
      name: String(category.name ?? ''),
      questions: (category.questions ?? []).map((question) => ({
        ...structuredClone(question),
        source_question_id: ++questionIndex
      }))
    }))
  };
}

function questionBlueprintIdMap(value) {
  const blueprint = parseObject(value);
  const ids = new Map();
  let normalizedId = 0;
  for (const category of blueprint.categories ?? []) {
    for (const question of category.questions ?? []) {
      normalizedId += 1;
      ids.set(Number(question.source_question_id), normalizedId);
    }
  }
  return ids;
}

function normalizeDataField(field, index) {
  return {
    source_field_id: index + 1,
    type: String(field.type ?? ''),
    name: String(field.name ?? ''),
    description: String(field.description ?? ''),
    required: Boolean(field.required),
    options: parseObject(field.params_json)
  };
}

function feedbackChoiceDefinition(item, rated = false) {
  const presentation = String(item.presentation ?? '');
  const [choicePart, horizontalPart = '0'] = presentation.split('<<<<<', 2);
  const separator = choicePart.indexOf('>>>>>');
  if (separator < 0) return null;
  const subtypeCode = choicePart.slice(0, separator);
  const choices = choicePart.slice(separator + 5).split('|').filter((choice) => choice !== '');
  const subtype = { r: 'radio', c: 'checkbox', d: 'dropdown' }[subtypeCode];
  if (!subtype || choices.length < 2) return null;
  const normalizedChoices = rated
    ? choices.map((choice) => {
      const ratedSeparator = choice.indexOf('####');
      if (ratedSeparator < 0 || !Number.isFinite(Number(choice.slice(0, ratedSeparator)))) return null;
      return { value: Number(choice.slice(0, ratedSeparator)), text: choice.slice(ratedSeparator + 4) };
    })
    : choices;
  if (normalizedChoices.some((choice) => choice === null)) return null;
  return {
    subtype,
    choices: normalizedChoices,
    horizontal: horizontalPart === '1',
    ignore_empty: String(item.options ?? '').includes('i'),
    hide_no_select: String(item.options ?? '').includes('h')
  };
}

function portableFeedbackDefinition(item) {
  const presentation = String(item.presentation ?? '');
  switch (String(item.type ?? '')) {
    case 'textfield': {
      const [size, maxLength] = presentation.split('|').map(Number);
      return Number.isFinite(size) && Number.isFinite(maxLength)
        ? { size, max_length: maxLength } : null;
    }
    case 'textarea': {
      const [width, height] = presentation.split('|').map(Number);
      return Number.isFinite(width) && Number.isFinite(height)
        ? { width, height } : null;
    }
    case 'numeric': {
      const [from, to] = presentation.split('|');
      return {
        range_from: from === '-' || from === '' ? null : Number(from),
        range_to: to === '-' || to === '' ? null : Number(to)
      };
    }
    case 'multichoice': return feedbackChoiceDefinition(item, false);
    case 'multichoicerated': return feedbackChoiceDefinition(item, true);
    case 'label': return { content: presentation };
    case 'info': return { mode: { 1: 'response_time', 2: 'course', 3: 'category' }[presentation] ?? presentation };
    case 'captcha':
    case 'pagebreak': return {};
    default: return null;
  }
}

function normalizeFeedbackItems(items) {
  const ids = new Map((items ?? []).map((item, index) => [Number(item.item_id), index + 1]));
  const losses = [];
  const normalized = [];
  for (const [index, item] of (items ?? []).entries()) {
    const definition = portableFeedbackDefinition(item);
    if (definition === null || Object.values(definition).some((value) => Number.isNaN(value))) {
      losses.push(`unsupported_feedback_item:${String(item.type ?? 'unknown')}:${index + 1}`);
      continue;
    }
    const sourceDependItemId = ids.get(Number(item.depend_item_id)) ?? 0;
    normalized.push({
      source_item_id: index + 1,
      type: String(item.type ?? ''),
      name: String(item.name ?? ''),
      definition,
      position: Number(item.position ?? index + 1),
      label: String(item.label ?? ''),
      required: Boolean(item.required),
      source_depend_item_id: sourceDependItemId,
      depend_value: String(item.depend_value ?? '')
    });
  }
  return { items: normalized, losses };
}

async function uploadMaterial(client, material, itemId = 0) {
  const options = {
    filename: material.asset.filename,
    filepath: material.asset.filepath,
    itemId
  };
  return material.filePath
    ? client.uploadDraftFile(material.filePath, options)
    : client.uploadDraftData(material.data, options);
}

function normalizeEditorContent(contentValue, rawFiles) {
  let content = String(contentValue ?? '');
  const files = (rawFiles ?? []).map((file) => ({
    filename: String(file.filename),
    filepath: String(file.filepath ?? '/'),
    filesize: Number(file.filesize ?? 0),
    mimetype: String(file.mimetype ?? ''),
    content_hash: String(file.content_hash ?? ''),
    url: (() => {
      const url = new URL(String(file.url));
      for (const name of ['token', 'wstoken', 'access_token']) url.searchParams.delete(name);
      return url.toString();
    })()
  }));
  for (const file of files) {
    try {
      const sourceUrl = new URL(file.url);
      const relativePath = `${file.filepath}${file.filename}`.replace('//', '/');
      const replacement = `@@PLUGINFILE@@${encodePluginfilePath(relativePath)}`;
      const references = new Set();
      for (const pathname of pluginfilePathVariants(sourceUrl.pathname, relativePath)) {
        const regularPath = pathname.replace('/webservice/pluginfile.php/', '/pluginfile.php/');
        const webservicePath = pathname.includes('/webservice/pluginfile.php/')
          ? pathname
          : pathname.replace('/pluginfile.php/', '/webservice/pluginfile.php/');
        for (const candidate of [webservicePath, regularPath]) {
          references.add(`${sourceUrl.origin}${candidate}`);
          references.add(candidate);
        }
      }
      for (const relativeVariant of relativePathVariants(relativePath)) {
        references.add(`@@PLUGINFILE@@${relativeVariant}`);
      }
      for (const reference of [...references].sort((left, right) => right.length - left.length)) {
        if (reference !== replacement) content = content.split(reference).join(replacement);
      }
    } catch {
      // Invalid asset URLs remain visible to planner verification instead of being fetched.
    }
  }
  return { content, files };
}

// Moodle's editors store `@@PLUGINFILE@@` references with rawurlencoded path
// segments, while `file_rewrite_pluginfile_urls()` keeps whatever form was
// stored. Both encoded and decoded forms therefore appear in rendered HTML.
function encodePluginfileSegment(segment) {
  return encodeURIComponent(segment)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePluginfilePath(relativePath) {
  return relativePath.split('/').map(encodePluginfileSegment).join('/');
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function relativePathVariants(relativePath) {
  return new Set([relativePath, encodePluginfilePath(relativePath), encodeURI(relativePath)]);
}

function pluginfilePathVariants(pathname, relativePath) {
  const variants = new Set([pathname, safeDecode(pathname)]);
  const decodedPathname = safeDecode(pathname);
  if (decodedPathname.endsWith(relativePath)) {
    const prefix = decodedPathname.slice(0, -relativePath.length);
    for (const relativeVariant of relativePathVariants(relativePath)) {
      variants.add(`${prefix}${relativeVariant}`);
    }
  }
  return variants;
}

function normalizeRenderedCourseSummary(course) {
  if (course.summary_raw !== undefined && course.summary_raw !== null) {
    return String(course.summary_raw);
  }
  const summary = String(course.summary ?? '');
  const overflowWrapper = /^<div class="no-overflow">([\s\S]*)<\/div>$/;
  return summary.match(overflowWrapper)?.[1] ?? summary;
}

function normalizeChapterContent(chapter) {
  return { ...chapter, ...normalizeEditorContent(chapter.content, chapter.files) };
}

async function hashChapterFiles(client, chapter) {
  const normalized = normalizeChapterContent(chapter);
  normalized.files = await Promise.all(normalized.files.map(async (file) => {
    const data = await client.downloadFile(file.url, { maximumBytes: Math.max(file.filesize, 1) });
    return { ...file, sha256: createHash('sha256').update(data).digest('hex') };
  }));
  return normalized;
}

function normalizeFile(file) {
  const url = new URL(String(file.url));
  for (const name of ['token', 'wstoken', 'access_token']) url.searchParams.delete(name);
  return {
    filename: String(file.filename),
    filepath: String(file.filepath ?? '/'),
    filesize: Number(file.filesize ?? 0),
    mimetype: String(file.mimetype ?? ''),
    content_hash: String(file.content_hash ?? ''),
    url: url.toString()
  };
}

async function hashFiles(client, files) {
  return Promise.all((files ?? []).map(async (rawFile) => {
    const file = normalizeFile(rawFile);
    const data = await client.downloadFile(file.url, { maximumBytes: Math.max(file.filesize, 1) });
    return { ...file, sha256: createHash('sha256').update(data).digest('hex') };
  }));
}

async function assignmentAuthoring(client, assignment, gradingForm) {
  const settings = {
    submission_attachments: Boolean(assignment.submissionattachments),
    submission_drafts: Boolean(assignment.submissiondrafts),
    require_submission_statement: Boolean(assignment.requiresubmissionstatement),
    send_notifications: Boolean(assignment.sendnotifications),
    send_late_notifications: Boolean(assignment.sendlatenotifications),
    send_student_notifications: Boolean(assignment.sendstudentnotifications),
    allow_submissions_from_date: Number(assignment.allowsubmissionsfromdate ?? 0),
    due_date: Number(assignment.duedate ?? 0),
    cutoff_date: Number(assignment.cutoffdate ?? 0),
    grading_due_date: Number(assignment.gradingduedate ?? 0),
    grade: Number(assignment.grade ?? 0),
    team_submission: Boolean(assignment.teamsubmission),
    require_all_team_members_submit: Boolean(assignment.requireallteammemberssubmit),
    blind_marking: Boolean(assignment.blindmarking),
    hide_grader: Boolean(assignment.hidegrader),
    max_attempts: Number(assignment.maxattempts ?? 1),
    attempt_reopen_method: String(assignment.attemptreopenmethod ?? 'manual'),
    marking_workflow: Boolean(assignment.markingworkflow),
    marking_allocation: Boolean(assignment.markingallocation),
    online_text: (assignment.submission_plugins ?? []).includes('onlinetext'),
    file_submissions: (assignment.submission_plugins ?? []).includes('file'),
    feedback_comments: (assignment.feedback_plugins ?? []).includes('comments'),
    feedback_files: (assignment.feedback_plugins ?? []).includes('file'),
    feedback_offline: (assignment.feedback_plugins ?? []).includes('offline'),
    feedback_editpdf: (assignment.feedback_plugins ?? []).includes('editpdf')
  };
  const rubric = gradingForm?.active_method === 'rubric' && gradingForm.supported
    ? {
      name: String(gradingForm.name ?? ''),
      description: String(gradingForm.description ?? ''),
      criteria: (gradingForm.criteria ?? []).map((criterion) => ({
        sort_order: Number(criterion.sort_order ?? 0),
        description: String(criterion.description ?? ''),
        levels: (criterion.levels ?? []).map((level) => ({
          score: Number(level.score ?? 0),
          definition: String(level.definition ?? '')
        }))
      })),
      options: parseObject(gradingForm.options_json)
    }
    : null;
  let gradingDefinition = null;
  if (rubric) {
    gradingDefinition = gradingForm.checklist_compatible ? {
      method: 'checklist',
      name: rubric.name,
      description: rubric.description,
      items: rubric.criteria.map((criterion) => ({
        sort_order: criterion.sort_order,
        description: criterion.description,
        score: Math.max(...criterion.levels.map((level) => level.score), 0)
      }))
    } : { method: 'rubric', ...rubric };
  } else if (gradingForm?.active_method === 'guide' && gradingForm.supported) {
    gradingDefinition = {
      method: 'guide',
      name: String(gradingForm.name ?? ''),
      description: String(gradingForm.description ?? ''),
      criteria: (gradingForm.criteria ?? []).map((criterion) => ({
        sort_order: Number(criterion.sort_order ?? 0),
        shortname: String(criterion.shortname ?? ''),
        description: String(criterion.description ?? ''),
        description_markers: String(criterion.description_markers ?? ''),
        max_score: Number(criterion.max_score ?? 0)
      })),
      comments: (gradingForm.comments ?? []).map((comment) => ({
        sort_order: Number(comment.sort_order ?? 0),
        description: String(comment.description ?? '')
      })),
      options: parseObject(gradingForm.options_json)
    };
  }
  const intro = normalizeEditorContent(assignment.intro, assignment.intro_files);
  const activity = normalizeEditorContent(assignment.activity, assignment.activity_files);
  return {
    kind: 'assignment',
    content: {
      intro: intro.content,
      intro_format: Number(assignment.intro_format ?? 1),
      intro_files: await hashFiles(client, intro.files),
      activity: activity.content,
      activity_format: Number(assignment.activity_format ?? 1),
      activity_files: await hashFiles(client, activity.files)
    },
    settings,
    rubric,
    grading_definition: gradingDefinition,
    losses: [
      ...((assignment.submission_plugins ?? []).length > 0 ? ['submission_plugin_configuration_not_exported'] : []),
      ...((assignment.feedback_plugins ?? []).length > 0 ? ['feedback_plugin_configuration_not_exported'] : []),
      ...(Number(assignment.teamsubmissiongroupingid ?? 0) > 0 ? ['team_submission_grouping_requires_mapping'] : [])
    ]
  };
}

export class MoodliaSyncAdapter extends MoodliaMoodleAdapter {
  async exportCourse(courseId) {
    const site = this.discovery ?? await this.discoverSite();
    const [course, contents, groupsResult, groupingsResult, assignmentsResult, completionResult,
      gradeItemsResult, gradeCategoriesResult] = await Promise.all([
      this.client.callOperation('get_course_details', { course_id: courseId }),
      this.client.callOperation('get_course_contents', { course_id: courseId }),
      this.client.callOperation('get_groups', { course_id: courseId }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: { groups: [] }, error })
      ),
      this.client.callOperation('get_groupings', { course_id: courseId }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: { groupings: [] }, error })
      ),
      this.client.callOperation('get_course_assignments', { course_id: courseId }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: { assignments: [] }, error })
      ),
      this.client.callOperation('get_course_completion_criteria', { course_id: courseId }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: null, error })
      ),
      this.client.callOperation('get_grade_items', { course_id: courseId }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: { items: [] }, error })
      ),
      this.client.callOperation('get_grade_categories', { course_id: courseId }).then(
        (value) => ({ value, error: null }),
        (error) => ({ value: { categories: [] }, error })
      )
    ]);
    const exclusions = [
      { scope: 'student_outcomes', reason: 'content_sync_scope' },
      { scope: 'activity_authoring_fields', reason: 'first_sync_milestone' }
    ];
    if (groupsResult.error) exclusions.push({ scope: 'groups', reason: 'source_read_unavailable' });
    if (groupingsResult.error) exclusions.push({ scope: 'groupings', reason: 'source_read_unavailable' });
    if (assignmentsResult.error) exclusions.push({ scope: 'assignments', reason: 'source_read_unavailable' });
    if (completionResult.error) exclusions.push({ scope: 'course_completion', reason: 'source_read_unavailable' });
    if (gradeItemsResult.error || gradeCategoriesResult.error) {
      exclusions.push({ scope: 'gradebook', reason: 'source_read_unavailable' });
    }
    const assignmentsByModule = new Map((assignmentsResult.value.assignments ?? [])
      .map((assignment) => [Number(assignment.module_id), assignment]));
    const sections = structuredClone(contents.sections ?? []);
    await Promise.all(sections.map(async (section) => {
      const normalized = normalizeEditorContent(
        section.summary_raw ?? section.summary,
        section.summary_files
      );
      section.summary = normalized.content;
      section.files = await hashFiles(this.client, normalized.files);
    }));
    await Promise.all(sections.flatMap((section) => (section.modules ?? []).map(async (module) => {
      if (!['assign', 'book', 'page', 'label', 'url', 'resource', 'folder', 'workshop', 'qbank', 'data', 'feedback', 'quiz', 'lesson']
        .includes(module.module_type)) return;
      try {
        if (module.module_type === 'assign') {
          const assignment = assignmentsByModule.get(Number(module.module_id));
          if (!assignment) throw new TypeError('Assignment details are unavailable.');
          const gradingForm = await this.client.callOperation('get_assignment_grading_form', {
            course_id: courseId,
            module_id: module.module_id
          }).catch(() => null);
          module.authoring_completeness = 'selected';
          module.authoring = await assignmentAuthoring(this.client, assignment, gradingForm);
          return;
        }
        if (module.module_type === 'qbank') {
          const exported = await this.client.callOperation('export_question_bank_blueprint', {
            course_id: courseId,
            bank_scope: 'course_shared',
            question_bank_module_id: module.module_id,
            include_unsupported: true
          });
          const blueprint = normalizeQuestionBankBlueprint(exported.blueprint_json);
          module.authoring_completeness = Number(exported.skipped_question_count ?? 0) === 0
            ? 'complete'
            : 'selected';
          module.authoring = {
            kind: 'question_bank',
            blueprint,
            losses: Number(exported.skipped_question_count ?? 0) > 0
              ? ['unsupported_questions_not_exported']
              : []
          };
          return;
        }
        const details = await this.client.callOperation('get_module_details', {
          course_id: courseId,
          module_id: module.module_id
        });
        const extra = parseObject(details.extra_json);
        const activity = parseObject(extra.activity);
        module.authoring_completeness = 'complete';
        if (module.module_type === 'lesson') {
          const pages = await this.client.callOperation('get_lesson_pages', {
            course_id: courseId,
            module_id: module.module_id
          });
          const pageIds = new Map((pages.pages ?? []).map((page, index) => [Number(page.page_id), index + 1]));
          const normalizedPages = (pages.pages ?? []).map((page, index) => {
            const definition = parseObject(page.definition_json);
            const normalizeJumps = (value) => {
              if (Array.isArray(value)) return value.map(normalizeJumps);
              if (value && typeof value === 'object') {
                return Object.fromEntries(Object.entries(value).map(([key, item]) => [
                  key,
                  ['jump_to', 'correct_jump_to', 'wrong_jump_to'].includes(key) && Number(item) > 0
                    ? { source_page_id: pageIds.get(Number(item)) ?? null }
                    : normalizeJumps(item)
                ]));
              }
              return value;
            };
            return {
              source_page_id: index + 1,
              page_type: String(page.page_type ?? 'unsupported'),
              title: String(page.title ?? ''),
              content: String(page.content ?? ''),
              content_format: Number(page.content_format ?? 1),
              display_in_menu: Boolean(page.display_in_menu_block),
              horizontal: Boolean(page.layout),
              definition: normalizeJumps(definition),
              files_count: Number(page.files_count ?? 0)
            };
          });
          const losses = [
            ...(Boolean(activity.use_password) ? ['lesson_password_not_exported'] : []),
            ...(Number(activity.activity_link ?? 0) > 0 ? ['lesson_activity_link_requires_mapping'] : []),
            ...(normalizedPages.some((page) => page.page_type === 'unsupported')
              ? ['unsupported_lesson_page_type'] : []),
            ...(normalizedPages.some((page) => JSON.stringify(page.definition).includes('"source_page_id":null'))
              ? ['lesson_jump_target_not_exported'] : [])
          ];
          module.authoring_completeness = losses.some((loss) =>
            ['unsupported_lesson_page_type', 'lesson_jump_target_not_exported'].includes(loss))
            ? 'selected' : 'complete';
          module.authoring = {
            kind: 'lesson',
            settings: {
              intro: String(activity.intro ?? ''),
              practice: Boolean(activity.practice),
              allow_review: Boolean(activity.allow_review),
              ongoing_score: Boolean(activity.ongoing_score),
              progress_bar: Boolean(activity.progress_bar),
              display_left_menu: Boolean(activity.display_left_menu),
              display_left_if: Number(activity.display_left_if ?? 0),
              slideshow: Boolean(activity.slideshow),
              max_answers: Number(activity.max_answers ?? 4),
              default_feedback: activity.default_feedback === undefined ? true : Boolean(activity.default_feedback),
              available_from: Number(activity.available_from ?? 0),
              deadline: Number(activity.deadline ?? 0),
              time_limit_seconds: Number(activity.time_limit_seconds ?? 0),
              allow_question_retry: Boolean(activity.allow_question_retry),
              max_attempts: Number(activity.max_attempts ?? 5),
              after_correct_answer: ({ 0: 'normal', 1: 'unseen_page', 2: 'unanswered_page' })[
                Number(activity.after_correct_answer ?? 0)
              ] ?? 'normal',
              pages_to_show: Number(activity.pages_to_show ?? 0),
              grade: Number(activity.grade ?? 100),
              custom_scoring: Boolean(activity.custom_scoring),
              retakes_allowed: activity.retakes_allowed === undefined ? true : Boolean(activity.retakes_allowed),
              use_max_grade: Boolean(activity.use_max_grade),
              minimum_questions: Number(activity.minimum_questions ?? 0),
              completion_end_reached: activity.completion_end_reached === undefined
                ? true : Boolean(activity.completion_end_reached),
              completion_time_spent_seconds: Number(activity.completion_time_spent_seconds ?? 0),
              allow_offline_attempts: Boolean(activity.allow_offline_attempts)
            },
            pages: normalizedPages,
            losses
          };
          return;
        }
        if (module.module_type === 'quiz') {
          const [exported, quizQuestions] = await Promise.all([
            this.client.callOperation('export_question_bank_blueprint', {
              course_id: courseId,
              bank_scope: 'quiz_private',
              quiz_module_id: module.module_id,
              include_unsupported: true
            }),
            this.client.callOperation('get_quiz_questions', { quiz_module_id: module.module_id })
          ]);
          const sourceQuestionIds = questionBlueprintIdMap(exported.blueprint_json);
          const blueprint = normalizeQuestionBankBlueprint(exported.blueprint_json);
          const slots = (quizQuestions.questions ?? []).map((question) => ({
            source_question_id: sourceQuestionIds.get(Number(question.question_id)) ?? null,
            slot: Number(question.slot),
            page: Number(question.page ?? 1),
            max_mark: Number(question.maxmark ?? 1)
          }));
          const questionsPerPage = Math.max(1, Number(activity.questionsperpage ?? 1));
          const losses = [
            'quiz_review_and_access_configuration_not_exported',
            ...(Number(exported.skipped_question_count ?? 0) > 0
              ? ['unsupported_questions_not_exported'] : []),
            ...(slots.some((slot) => slot.source_question_id === null)
              ? ['quiz_slot_question_not_exported'] : []),
            ...(slots.some((slot) => slot.page !== Math.floor((slot.slot - 1) / questionsPerPage) + 1)
              ? ['custom_quiz_page_breaks_not_portable'] : []),
            ...((Number(activity.completionattemptsexhausted ?? 0) > 0
              || Number(activity.completionminattempts ?? 0) > 0)
              ? ['quiz_custom_completion_not_exported'] : [])
          ];
          module.authoring_completeness = losses.some((loss) =>
            ['unsupported_questions_not_exported', 'quiz_slot_question_not_exported'].includes(loss))
            ? 'selected' : 'complete';
          module.authoring = {
            kind: 'quiz',
            settings: {
              time_open: Number(activity.timeopen ?? 0),
              time_close: Number(activity.timeclose ?? 0),
              time_limit_seconds: Number(activity.timelimit ?? 0),
              overdue_handling: String(activity.overduehandling ?? 'autosubmit'),
              grace_period_seconds: Number(activity.graceperiod ?? 0),
              preferred_behaviour: String(activity.preferredbehaviour ?? 'deferredfeedback'),
              can_redo_questions: Boolean(activity.canredoquestions),
              attempts: Number(activity.attempts ?? 0),
              attempt_on_last: Boolean(activity.attemptonlast),
              grade_method: ({ 1: 'highest', 2: 'average', 3: 'first', 4: 'last' })[
                Number(activity.grademethod ?? 1)
              ] ?? 'highest',
              decimal_points: Number(activity.decimalpoints ?? 2),
              question_decimal_points: Number(activity.questiondecimalpoints ?? -1),
              questions_per_page: questionsPerPage,
              navigation_method: String(activity.navmethod ?? 'free'),
              shuffle_answers: Boolean(activity.shuffleanswers),
              grade: Number(activity.grade ?? 10),
              network_address: String(activity.subnet ?? ''),
              browser_security: ({ '-': 'none', popup: 'popup', securewindow: 'securewindow' })[
                String(activity.browsersecurity ?? '-')
              ] ?? 'none',
              delay_first_second_seconds: Number(activity.delay1 ?? 0),
              delay_later_seconds: Number(activity.delay2 ?? 0),
              show_user_picture: ({ 0: 'none', 1: 'small', 2: 'large' })[
                Number(activity.showuserpicture ?? 0)
              ] ?? 'none',
              show_blocks: Boolean(activity.showblocks),
              allow_offline_attempts: Boolean(activity.allowofflineattempts)
            },
            blueprint,
            slots,
            losses
          };
          return;
        }
        if (module.module_type === 'data') {
          const fields = await this.client.callOperation('get_data_fields', {
            course_id: courseId,
            module_id: module.module_id
          });
          const defaultSortFieldId = Number(activity.default_sort_field_id ?? 0);
          module.authoring = {
            kind: 'database',
            settings: {
              intro: String(activity.intro ?? ''),
              comments: Boolean(activity.comments),
              approval_required: Boolean(activity.approval_required),
              manage_approved: activity.manage_approved === undefined ? true : Boolean(activity.manage_approved),
              available_from: Number(activity.available_from ?? 0),
              available_to: Number(activity.available_to ?? 0),
              view_from: Number(activity.view_from ?? 0),
              view_to: Number(activity.view_to ?? 0),
              required_entries: Number(activity.required_entries ?? 0),
              required_entries_to_view: Number(activity.required_entries_to_view ?? 0),
              max_entries: Number(activity.max_entries ?? 0),
              rss_articles: Number(activity.rss_articles ?? 0),
              default_sort_direction: Number(activity.default_sort_direction ?? 0) === 1
                ? 'descending' : 'ascending',
              edit_any: Boolean(activity.edit_any),
              notification: Number(activity.notification ?? 0),
              completion_entries: Number(activity.completion_entries ?? 0)
            },
            fields: (fields.fields ?? []).map(normalizeDataField),
            losses: defaultSortFieldId > 0 ? ['default_sort_field_requires_destination_field_mapping'] : []
          };
          return;
        }
        if (module.module_type === 'feedback') {
          const result = await this.client.callOperation('get_feedback_items', {
            course_id: courseId,
            module_id: module.module_id
          });
          const normalized = normalizeFeedbackItems(result.items ?? []);
          module.authoring_completeness = normalized.losses.length === 0 ? 'complete' : 'selected';
          module.authoring = {
            kind: 'feedback',
            settings: {
              intro: String(activity.intro ?? ''),
              time_open: Number(activity.time_open ?? 0),
              time_close: Number(activity.time_close ?? 0),
              anonymous: Number(activity.anonymous ?? 1) === 2 ? 'named' : 'anonymous',
              completion_submit: Boolean(activity.completion_submit)
            },
            items: normalized.items,
            losses: normalized.losses
          };
          return;
        }
        if (module.module_type === 'page') {
          const normalized = normalizeEditorContent(activity.content, activity.files);
          module.authoring = {
            kind: 'page',
            settings: {
              content: normalized.content,
              content_format: Number(activity.content_format ?? 1),
              print_intro: Boolean(activity.print_intro),
              print_last_modified: activity.print_last_modified === undefined
                ? true
                : Boolean(activity.print_last_modified)
            },
            files: await hashFiles(this.client, normalized.files)
          };
          return;
        }
        if (module.module_type === 'label') {
          const normalized = normalizeEditorContent(activity.content, activity.files);
          module.authoring = {
            kind: 'label',
            settings: {
              content: normalized.content,
              content_format: Number(activity.content_format ?? 1)
            },
            files: await hashFiles(this.client, normalized.files)
          };
          return;
        }
        if (module.module_type === 'url') {
          const displayNames = { 0: 'auto', 1: 'embed', 3: 'new', 5: 'open', 6: 'popup' };
          const normalized = normalizeEditorContent(activity.intro, activity.files);
          module.authoring = {
            kind: 'url',
            settings: {
              external_url: String(activity.external_url ?? ''),
              intro: normalized.content,
              intro_format: Number(activity.intro_format ?? 1),
              ...(displayNames[activity.display] ? { display: displayNames[activity.display] } : {}),
              print_intro: Boolean(activity.print_intro),
              ...(activity.popup_width ? { popup_width: Number(activity.popup_width) } : {}),
              ...(activity.popup_height ? { popup_height: Number(activity.popup_height) } : {})
            },
            files: await hashFiles(this.client, normalized.files)
          };
          return;
        }
        if (module.module_type === 'resource') {
          const resourceDisplays = { 0: 'auto', 1: 'embed', 2: 'download', 3: 'open', 4: 'popup' };
          const filterFiles = { 0: 'none', 1: 'all', 2: 'html' };
          const resourceFiles = await this.client.callOperation('get_resource_files', {
            course_id: courseId,
            module_id: module.module_id
          });
          module.authoring = {
            kind: 'resource',
            settings: {
              intro: String(activity.intro ?? ''),
              intro_format: Number(activity.intro_format ?? 1),
              ...(resourceDisplays[activity.display] ? { display: resourceDisplays[activity.display] } : {}),
              print_intro: Boolean(activity.print_intro),
              show_size: Boolean(activity.show_size),
              show_type: Boolean(activity.show_type),
              show_date: Boolean(activity.show_date),
              filter_files: filterFiles[activity.filter_files] ?? 'none',
              popup_width: Number(activity.popup_width ?? 620),
              popup_height: Number(activity.popup_height ?? 450)
            },
            files: await hashFiles(this.client, resourceFiles.files)
          };
          return;
        }
        if (module.module_type === 'folder') {
          const folderDisplays = { 0: 'separate', 1: 'course' };
          const folderFiles = await this.client.callOperation('get_folder_files', {
            course_id: courseId,
            module_id: module.module_id
          });
          module.authoring = {
            kind: 'folder',
            settings: {
              intro: String(activity.intro ?? ''),
              intro_format: Number(activity.intro_format ?? 1),
              ...(folderDisplays[activity.display] ? { display: folderDisplays[activity.display] } : {}),
              show_expanded: Boolean(activity.show_expanded),
              show_download_folder: Boolean(activity.show_download_folder),
              force_download: Boolean(activity.force_download)
            },
            files: await hashFiles(this.client, folderFiles.files)
          };
          return;
        }
        if (module.module_type === 'workshop') {
          const submissionModes = { 0: 'disabled', 1: 'available', 2: 'required' };
          const exampleModes = { 0: 'voluntary', 1: 'before_submission', 2: 'before_assessment' };
          const gradingForm = await this.client.callOperation('get_workshop_grading_form', {
            course_id: courseId,
            module_id: module.module_id
          });
          module.authoring = {
            kind: 'workshop',
            settings: {
              strategy: String(activity.strategy ?? 'accumulative'),
              submission_grade: Number(activity.submission_grade ?? 80),
              assessment_grade: Number(activity.assessment_grade ?? 20),
              grade_decimals: Number(activity.grade_decimals ?? 0),
              submission_instructions: String(activity.submission_instructions ?? ''),
              assessment_instructions: String(activity.assessment_instructions ?? ''),
              text_submission: submissionModes[activity.text_submission] ?? 'available',
              file_submission: submissionModes[activity.file_submission] ?? 'available',
              max_submission_attachments: Number(activity.max_submission_attachments ?? 1),
              submission_file_types: String(activity.submission_file_types ?? ''),
              max_file_size: Number(activity.max_file_size ?? 0),
              late_submissions: Boolean(activity.late_submissions),
              self_assessment: Boolean(activity.self_assessment),
              example_submissions: Boolean(activity.example_submissions),
              examples_mode: exampleModes[activity.examples_mode] ?? 'voluntary',
              submission_start: Number(activity.submission_start ?? 0),
              submission_end: Number(activity.submission_end ?? 0),
              assessment_start: Number(activity.assessment_start ?? 0),
              assessment_end: Number(activity.assessment_end ?? 0),
              switch_to_assessment_after_submission_deadline: Boolean(
                activity.switch_to_assessment_after_submission_deadline
              ),
              conclusion: String(activity.conclusion ?? '')
            },
            phase: Number(gradingForm.phase ?? activity.phase ?? 0),
            grading_form: {
              strategy: String(gradingForm.strategy),
              definition: parseObject(gradingForm.definition_json)
            }
          };
          return;
        }
        const chapters = await this.client.callOperation('get_book_chapters', {
            course_id: courseId,
            module_id: module.module_id,
            include_content: true,
            include_hidden: true
          });
        const numberingNames = { 0: 'none', 1: 'numbers', 2: 'bullets', 3: 'indented' };
        module.authoring = {
          kind: 'book',
          settings: {
            ...(activity.numbering === undefined
              ? {}
              : { numbering: numberingNames[activity.numbering] ?? String(activity.numbering) }),
            ...(activity.custom_titles === undefined && activity.customtitles === undefined
              ? {}
              : { custom_titles: Boolean(activity.custom_titles ?? activity.customtitles) })
          },
          chapters: await Promise.all((chapters.chapters ?? []).map((chapter) => hashChapterFiles(this.client, chapter)))
        };
      } catch {
        module.authoring_completeness = 'unavailable';
        exclusions.push({
          scope: `module:${module.module_id}`,
          reason: `${module.module_type}_authoring_read_unavailable`
        });
      }
    })));
    const modules = sections.flatMap((section) => section.modules ?? []);
    const completion = completionResult.value ? {
      enabled: Boolean(completionResult.value.course_completion_enabled),
      locked: Boolean(completionResult.value.criteria_locked),
      criteria_aggregation: String(completionResult.value.criteria_aggregation ?? 'all'),
      activity_aggregation: String(completionResult.value.activity_aggregation ?? 'all'),
      required_modules: (completionResult.value.required_module_ids ?? []).map((moduleId) => {
        const module = modules.find((entry) => Number(entry.module_id) === Number(moduleId));
        return { source_key: module ? `module:${Number(module.module_id)}` : null, source_module_id: Number(moduleId) };
      }),
      grade_criterion_enabled: Boolean(completionResult.value.grade_criterion_enabled),
      required_course_grade_percent: Number(completionResult.value.required_course_grade_percent ?? 0),
      losses: (completionResult.value.required_module_ids ?? []).some((moduleId) =>
        !modules.some((entry) => Number(entry.module_id) === Number(moduleId)))
        ? ['completion_activity_not_present_in_course_inventory'] : []
    } : null;
    const gradeItems = gradeItemsResult.value.items ?? [];
    const courseTotal = gradeItems.find((item) => item.item_type === 'course');
    const rootCategory = (gradeCategoriesResult.value.categories ?? []).find((category) =>
      Number(category.total_item_id) === Number(courseTotal?.item_id));
    const gradebookLosses = [];
    const portableGradeItems = [];
    let manualIndex = 0;
    for (const item of gradeItems) {
      if (item.item_type === 'manual') {
        manualIndex += 1;
        if (!rootCategory || Number(item.category_id) !== Number(rootCategory.category_id)) {
          gradebookLosses.push(`manual_grade_item_category_not_portable:${manualIndex}`);
        }
        if (Boolean(item.locked) || Boolean(item.weight_overridden)) {
          gradebookLosses.push(`manual_grade_item_lock_or_weight_not_portable:${manualIndex}`);
        }
        portableGradeItems.push({
          kind: 'manual', source_item_id: manualIndex, remote_item_id: Number(item.item_id),
          name: String(item.name ?? ''),
          grade_min: Number(item.grade_min ?? 0), grade_max: Number(item.grade_max ?? 100),
          grade_pass: Number(item.grade_pass ?? 0), hidden: Boolean(item.hidden)
        });
      } else if (item.item_type === 'mod' && Number(item.course_module_id) > 0) {
        const module = modules.find((entry) => Number(entry.module_id) === Number(item.course_module_id));
        if (!module) {
          gradebookLosses.push(`module_grade_item_activity_not_exported:${Number(item.course_module_id)}`);
          continue;
        }
        if (!rootCategory || Number(item.category_id) !== Number(rootCategory.category_id)) {
          gradebookLosses.push(`module_grade_item_category_not_portable:${Number(item.course_module_id)}`);
        }
        portableGradeItems.push({
          kind: 'module', module_source_key: `module:${Number(module.module_id)}`,
          remote_item_id: Number(item.item_id),
          item_number: Number(item.item_number ?? 0), name: String(item.name ?? ''),
          grade_min: Number(item.grade_min ?? 0), grade_max: Number(item.grade_max ?? 100),
          grade_pass: Number(item.grade_pass ?? 0), hidden: Boolean(item.hidden),
          locked: Boolean(item.locked), weight: Number(item.weight ?? 0),
          weight_overridden: Boolean(item.weight_overridden)
        });
      }
    }
    const gradebook = gradeItemsResult.error || gradeCategoriesResult.error ? null : {
      items: portableGradeItems,
      losses: [...new Set(gradebookLosses)]
    };
    return createCourseSyncModel({
      site,
      course: { ...course, summary: normalizeRenderedCourseSummary(course) },
      sections,
      groups: groupsResult.value.groups ?? [],
      groupings: groupingsResult.value.groupings ?? [],
      courseCompletion: completion,
      gradebook,
      exclusions,
      unknowns: exclusions
        .filter((entry) => entry.reason.endsWith('_read_unavailable'))
        .map((entry) => ({ ...entry, field: 'authoring' })),
      completeness: { inventory: 'complete', pagination: 'complete', authoring: 'selected' },
      capabilityEvidence: {
        provider: 'moodlia',
        plugin_version: site.plugin_version,
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

  async syncCapabilities({ courseId, categoryId } = {}) {
    if (!this.discovery) await this.discoverSite();
    let evidence = {};
    if (this.hasDeclaredOperation('get_sync_capabilities')) {
      const result = await this.client.callOperation('get_sync_capabilities', {
        ...(courseId === undefined ? {} : { course_id: courseId }),
        ...(categoryId === undefined ? {} : { category_id: categoryId })
      });
      evidence = parseCapabilityEvidence(result.capabilities_json);
    }
    const courseWriteAllowed = evidence.course_update === true;
    const courseCreateAllowed = evidence.course_create === true;
    const groupWriteAllowed = evidence.group_manage === true;
    const activityWriteAllowed = evidence.activity_manage === true;
    const bookWriteAllowed = evidence.book_edit === true && activityWriteAllowed;
    const gradingFormWriteAllowed = evidence.assignment_grade === true && evidence.grading_form_manage === true;
    const workshopFormWriteAllowed = evidence.workshop_form_manage === true && activityWriteAllowed;
    const questionBankWriteAllowed = evidence.question_manage === true
      && evidence.question_bank_module_available === true
      && activityWriteAllowed;
    const databaseFieldWriteAllowed = evidence.database_field_manage === true && activityWriteAllowed;
    const feedbackItemWriteAllowed = evidence.feedback_item_manage === true && activityWriteAllowed;
    const completionWriteAllowed = evidence.completion_manage === true;
    const quizWriteAllowed = evidence.quiz_manage === true
      && evidence.question_manage === true
      && activityWriteAllowed;
    const lessonWriteAllowed = evidence.lesson_manage === true && activityWriteAllowed;
    const gradebookWriteAllowed = evidence.gradebook_manage === true;
    return {
      course_create: {
        available: this.hasDeclaredOperation('create_course') && courseCreateAllowed,
        supported_fields: ['fullname', 'shortname', 'category_id', 'idnumber', 'summary', 'visible', 'start_date', 'end_date']
      },
      course_update: {
        available: this.hasDeclaredOperation('update_course') && courseWriteAllowed,
        supported_fields: [
          'fullname', 'shortname', 'category_id', 'summary', 'summary_format',
          'visible', 'start_date', 'end_date'
        ]
      },
      section_create: {
        available: this.hasDeclaredOperation('create_section') && courseWriteAllowed,
        supported_fields: ['name', 'summary', 'summary_format', 'visible', 'order']
      },
      section_update: {
        available: this.hasDeclaredOperation('update_section') && courseWriteAllowed,
        supported_fields: ['name', 'summary', 'summary_format', 'visible', 'order']
      },
      group_create: {
        available: this.hasDeclaredOperation('create_group') && groupWriteAllowed,
        supported_fields: ['name', 'description', 'idnumber']
      },
      group_update: {
        available: this.hasDeclaredOperation('update_group') && groupWriteAllowed,
        supported_fields: ['name', 'description', 'idnumber']
      },
      grouping_create: {
        available: this.hasDeclaredOperation('create_grouping') && groupWriteAllowed,
        supported_fields: ['name', 'description', 'idnumber']
      },
      grouping_update: {
        available: this.hasDeclaredOperation('update_grouping') && groupWriteAllowed,
        supported_fields: ['name', 'description', 'idnumber']
      },
      grouping_member_add: {
        available: this.hasDeclaredOperation('add_group_to_grouping') && groupWriteAllowed,
        supported_fields: ['grouping_id', 'group_id']
      },
      module_create: {
        available: this.hasDeclaredOperation('create_module') && activityWriteAllowed,
        supported_fields: ['module_type', 'name', 'visible', 'visible_on_course_page', 'settings']
      },
      module_update: {
        available: this.hasDeclaredOperation('update_module') && activityWriteAllowed,
        supported_fields: ['name', 'visible']
      },
      book_chapter_create: {
        available: this.hasDeclaredOperation('create_book_chapter') && bookWriteAllowed,
        supported_fields: ['title', 'content', 'content_format', 'subchapter', 'hidden', 'order']
      },
      book_chapter_update: {
        available: this.hasDeclaredOperation('update_book_chapter') && bookWriteAllowed,
        supported_fields: ['title', 'content', 'content_format', 'subchapter', 'hidden', 'order']
      },
      book_asset_transfer: {
        available: this.hasDeclaredOperation('update_book_chapter') && bookWriteAllowed,
        supported_fields: ['filename', 'filepath', 'filesize', 'content_hash', 'content']
      },
      page_content_update: {
        available: this.hasDeclaredOperation('update_page') && activityWriteAllowed,
        supported_fields: ['name', 'content', 'content_format', 'print_intro', 'print_last_modified']
      },
      label_content_update: {
        available: this.hasDeclaredOperation('update_label') && activityWriteAllowed,
        supported_fields: ['content', 'content_format']
      },
      url_content_update: {
        available: this.hasDeclaredOperation('update_url') && activityWriteAllowed,
        supported_fields: ['name', 'external_url', 'intro', 'intro_format', 'display', 'print_intro', 'popup_width',
          'popup_height']
      },
      module_asset_stage: {
        available: activityWriteAllowed,
        supported_fields: ['filename', 'filepath', 'filesize', 'content_hash']
      },
      resource_asset_replace: {
        available: this.hasDeclaredOperation('update_resource') && activityWriteAllowed,
        supported_fields: ['filename', 'filepath', 'filesize', 'content_hash']
      },
      assignment_content_update: {
        available: this.hasDeclaredOperation('update_assignment') && activityWriteAllowed,
        supported_fields: ['name', 'intro', 'intro_format', 'activity', 'activity_format']
      },
      assignment_rubric_set: {
        available: this.hasDeclaredOperation('set_assignment_rubric') && gradingFormWriteAllowed,
        supported_fields: ['name', 'description', 'criteria', 'options']
      },
      assignment_checklist_set: {
        available: this.hasDeclaredOperation('set_assignment_checklist') && gradingFormWriteAllowed,
        supported_fields: ['name', 'description', 'items']
      },
      assignment_guide_set: {
        available: this.hasDeclaredOperation('set_assignment_marking_guide') && gradingFormWriteAllowed,
        supported_fields: ['name', 'description', 'criteria', 'comments', 'options']
      },
      workshop_form_set: {
        available: this.hasDeclaredOperation('set_workshop_grading_form') && workshopFormWriteAllowed,
        supported_fields: ['strategy', 'definition']
      },
      question_bank_import: {
        available: this.hasDeclaredOperation('import_question_bank_blueprint') && questionBankWriteAllowed,
        supported_fields: ['blueprint']
      },
      database_field_create: {
        available: this.hasDeclaredOperation('create_data_field') && databaseFieldWriteAllowed,
        supported_fields: ['type', 'name', 'description', 'required', 'options']
      },
      feedback_item_create: {
        available: this.hasDeclaredOperation('create_feedback_item') && feedbackItemWriteAllowed,
        supported_fields: [
          'type', 'name', 'definition', 'position', 'label', 'required',
          'source_depend_item_id', 'depend_value'
        ]
      },
      course_completion_set: {
        available: this.hasDeclaredOperation('set_course_completion_criteria') && completionWriteAllowed,
        supported_fields: [
          'required_modules', 'require_all_activities',
          'required_course_grade_percent', 'criteria_aggregation'
        ]
      },
      quiz_questions_import: {
        available: this.hasDeclaredOperation('import_question_bank_blueprint') && quizWriteAllowed,
        supported_fields: ['blueprint']
      },
      quiz_slot_create: {
        available: this.hasDeclaredOperation('add_question_to_quiz') && quizWriteAllowed,
        supported_fields: ['source_question_id', 'slot']
      },
      quiz_slot_update: {
        available: this.hasDeclaredOperation('update_quiz_question_slot') && quizWriteAllowed,
        supported_fields: ['slot', 'max_mark']
      },
      lesson_page_create: {
        available: this.hasDeclaredOperation('create_lesson_page') && lessonWriteAllowed,
        supported_fields: [
          'page_type', 'title', 'content', 'content_format', 'definition',
          'display_in_menu', 'horizontal'
        ]
      },
      grade_item_create: {
        available: this.hasDeclaredOperation('create_grade_item') && gradebookWriteAllowed,
        supported_fields: ['name', 'grade_min', 'grade_max', 'grade_pass', 'hidden']
      },
      grade_item_update: {
        available: this.hasDeclaredOperation('update_grade_item') && gradebookWriteAllowed,
        supported_fields: [
          'name', 'grade_min', 'grade_max', 'grade_pass', 'hidden', 'locked', 'weight'
        ]
      }
    };
  }

  async applySyncAction(action, { courseId, createdEntities = new Map() }) {
    if (action.kind === 'course.create') {
      return this.client.callOperation('create_course', action.fields);
    }
    if (action.kind === 'course.update') {
      return this.client.callOperation('update_course', { course_id: courseId, ...action.fields });
    }
    if (action.kind === 'section.create') {
      const { order, ...fields } = action.fields;
      return this.client.callOperation('create_section', {
        course_id: courseId,
        ...fields,
        ...(order === undefined ? {} : { position: order })
      });
    }
    if (action.kind === 'section.update') {
      const { order, ...fields } = action.fields;
      const createdSection = createdEntities.get(`sections:${action.parent_source_key ?? action.source_key}`);
      let sectionId = action.target_id ?? createdSection?.section_id;
      if (!sectionId) {
        const contents = await this.client.callOperation('get_course_contents', { course_id: courseId });
        sectionId = (contents.sections ?? []).find(
          (section) => Number(section.section_number) === Number(action.target_section_number)
        )?.section_id;
      }
      if (!Number.isInteger(Number(sectionId))) {
        throw new TypeError(`Cannot resolve destination section ${action.target_section_number}.`);
      }
      const staged = action.asset_stage_source_key
        ? createdEntities.get(`drafts:${action.asset_stage_source_key}`)
        : null;
      return this.client.callOperation('update_section', {
        course_id: courseId,
        section_id: Number(sectionId),
        ...fields,
        ...(staged?.draft_item_id ? {
          filename: staged.files[0].filename,
          draft_item_id: staged.draft_item_id
        } : {})
      });
    }
    if (action.kind === 'group.create') {
      return this.client.callOperation('create_group', { course_id: courseId, ...action.fields });
    }
    if (action.kind === 'group.update') {
      return this.client.callOperation('update_group', { group_id: action.target_id, ...action.fields });
    }
    if (action.kind === 'grouping.create') {
      return this.client.callOperation('create_grouping', { course_id: courseId, ...action.fields });
    }
    if (action.kind === 'grouping.update') {
      return this.client.callOperation('update_grouping', { grouping_id: action.target_id, ...action.fields });
    }
    if (action.kind === 'grouping.member.add') {
      const grouping = createdEntities.get(`groupings:${action.grouping_source_key}`);
      const group = createdEntities.get(`groups:${action.group_source_key}`);
      const groupingId = action.target_grouping_id ?? Number(grouping?.id ?? grouping?.grouping_id);
      const groupId = action.target_group_id ?? Number(group?.id ?? group?.group_id);
      if (!Number.isInteger(groupingId) || !Number.isInteger(groupId)) {
        throw new TypeError(`Cannot resolve grouping membership targets for ${action.source_key}.`);
      }
      return this.client.callOperation('add_group_to_grouping', {
        course_id: courseId,
        grouping_id: groupingId,
        group_id: groupId
      });
    }
    if (action.kind === 'module.create') {
      const createdSection = createdEntities.get(`sections:${action.parent_source_key}`);
      const sectionNumber = action.target_section_number ?? createdSection?.section_number;
      if (!Number.isInteger(Number(sectionNumber))) {
        throw new TypeError(`Cannot resolve the destination section for ${action.source_key}.`);
      }
      const { module_type: moduleType, name, visible, settings } = action.fields;
      const staged = action.asset_stage_source_key
        ? createdEntities.get(`drafts:${action.asset_stage_source_key}`)
        : null;
      return this.client.callOperation('create_module', {
        course_id: courseId,
        section_number: Number(sectionNumber),
        module_type: moduleType,
        name,
        options: {
          ...settings,
          visible,
          ...(staged?.draft_item_id ? { draft_item_id: staged.draft_item_id } : {}),
          ...(['resource', 'page', 'label', 'url'].includes(moduleType) && staged?.files?.[0]?.filename
            ? { filename: staged.files[0].filename }
            : {})
        }
      });
    }
    if (action.kind === 'module.update') {
      return this.client.callOperation('update_module', {
        course_id: courseId,
        module_id: action.target_id,
        ...action.fields
      });
    }
    if (action.kind === 'book_chapter.create') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      const previousChapter = action.after_source_key
        ? createdEntities.get(`chapters:${action.after_source_key}`)
        : null;
      const { order, ...fields } = action.fields;
      return this.client.callOperation('create_book_chapter', {
        course_id: courseId,
        module_id: Number(moduleId),
        ...fields,
        ...(previousChapter?.chapter_id ? { after_chapter_id: previousChapter.chapter_id } : {})
      });
    }
    if (action.kind === 'book_chapter.update') {
      const { order, ...fields } = action.fields;
      return this.client.callOperation('update_book_chapter', {
        course_id: courseId,
        module_id: action.target_module_id,
        chapter_id: action.target_id,
        ...fields
      });
    }
    if (action.kind === 'page_content.update') {
      const formats = { 1: 'html', 2: 'plain', html: 'html', plain: 'plain' };
      const fields = { ...action.fields };
      if (fields.content_format !== undefined) fields.content_format = formats[fields.content_format];
      if (action.fields.content_format !== undefined && !fields.content_format) {
        throw new TypeError('Page content format cannot be represented by the destination operation.');
      }
      const staged = action.asset_stage_source_key
        ? createdEntities.get(`drafts:${action.asset_stage_source_key}`)
        : null;
      return this.client.callOperation('update_page', {
        course_id: courseId,
        module_id: action.target_id,
        ...fields,
        ...(staged?.draft_item_id ? {
          filename: staged.files[0].filename,
          draft_item_id: staged.draft_item_id
        } : {})
      });
    }
    if (action.kind === 'label_content.update' || action.kind === 'url_content.update') {
      const operation = action.kind === 'label_content.update' ? 'update_label' : 'update_url';
      const formatField = action.kind === 'label_content.update' ? 'content_format' : 'intro_format';
      const formats = { 1: 'html', 2: 'plain', html: 'html', plain: 'plain' };
      const fields = { ...action.fields };
      if (fields[formatField] !== undefined) fields[formatField] = formats[fields[formatField]];
      if (action.fields[formatField] !== undefined && !fields[formatField]) {
        throw new TypeError(`${action.kind} format cannot be represented by the destination operation.`);
      }
      if (action.kind === 'url_content.update' && typeof fields.display === 'string') {
        const displays = { auto: 0, embed: 1, new: 3, open: 5, popup: 6 };
        fields.display = displays[fields.display];
      }
      const staged = action.asset_stage_source_key
        ? createdEntities.get(`drafts:${action.asset_stage_source_key}`)
        : null;
      return this.client.callOperation(operation, {
        course_id: courseId,
        module_id: action.target_id,
        ...fields,
        ...(staged?.draft_item_id ? {
          filename: staged.files[0].filename,
          draft_item_id: staged.draft_item_id
        } : {})
      });
    }
    if (action.kind === 'assignment_content.update') {
      const formats = { 1: 'html', 2: 'plain', html: 'html', plain: 'plain' };
      const fields = { ...action.fields };
      if (fields.intro_format !== undefined) fields.intro_format = formats[fields.intro_format];
      if (fields.activity_format !== undefined) fields.activity_format = formats[fields.activity_format];
      if ((action.fields.intro_format !== undefined && !fields.intro_format)
        || (action.fields.activity_format !== undefined && !fields.activity_format)) {
        throw new TypeError('Assignment content format cannot be represented by the destination operation.');
      }
      const createdModule = createdEntities.get(`modules:${action.parent_source_key ?? action.source_key}`);
      const moduleId = action.target_id ?? createdModule?.module_id;
      const staged = action.asset_stage_source_key
        ? createdEntities.get(`drafts:${action.asset_stage_source_key}`)
        : null;
      return this.client.callOperation('update_assignment', {
        course_id: courseId,
        module_id: Number(moduleId),
        ...fields,
        ...(staged?.draft_item_id ? {
          filename: staged.files[0].filename,
          draft_item_id: staged.draft_item_id,
          file_area: action.file_area
        } : {})
      });
    }
    if (action.kind === 'assignment_rubric.set') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      return this.client.callOperation('set_assignment_rubric', {
        course_id: courseId,
        module_id: Number(moduleId),
        ...action.fields,
        criteria: { criteria: action.fields.criteria }
      });
    }
    if (action.kind === 'assignment_checklist.set' || action.kind === 'assignment_guide.set') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      if (action.kind === 'assignment_checklist.set') {
        return this.client.callOperation('set_assignment_checklist', {
          course_id: courseId,
          module_id: Number(moduleId),
          ...action.fields,
          items: { items: action.fields.items }
        });
      }
      return this.client.callOperation('set_assignment_marking_guide', {
        course_id: courseId,
        module_id: Number(moduleId),
        ...action.fields,
        criteria: { criteria: action.fields.criteria },
        comments: { comments: action.fields.comments ?? [] }
      });
    }
    if (action.kind === 'workshop_form.set') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      return this.client.callOperation('set_workshop_grading_form', {
        course_id: courseId,
        module_id: Number(moduleId),
        strategy: action.fields.strategy,
        definition: action.fields.definition
      });
    }
    if (action.kind === 'database_field.create') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      return this.client.callOperation('create_data_field', {
        course_id: courseId,
        module_id: Number(moduleId),
        field_type: action.fields.type,
        name: action.fields.name,
        description: action.fields.description,
        required: action.fields.required,
        options: action.fields.options
      });
    }
    if (action.kind === 'feedback_item.create') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      const dependency = action.dependency_source_key
        ? createdEntities.get(`feedback_items:${action.dependency_source_key}`)
        : null;
      return this.client.callOperation('create_feedback_item', {
        course_id: courseId,
        module_id: Number(moduleId),
        type: action.fields.type,
        name: action.fields.name,
        definition: action.fields.definition,
        position: action.fields.position,
        label: action.fields.label,
        required: action.fields.required,
        ...(dependency?.item_id ? { depend_item_id: Number(dependency.item_id) } : {}),
        depend_value: action.fields.depend_value
      });
    }
    if (action.kind === 'grade_item.create') {
      return this.client.callOperation('create_grade_item', {
        course_id: courseId,
        ...action.fields
      });
    }
    if (action.kind === 'grade_item.update') {
      let itemId = Number(action.target_id ?? 0);
      if (itemId <= 0 && action.module_source_key) {
        const createdModule = createdEntities.get(`modules:${action.module_source_key}`);
        const moduleId = action.target_module_id ?? createdModule?.module_id;
        const gradebook = await this.client.callOperation('get_grade_items', { course_id: courseId });
        const item = (gradebook.items ?? []).find((entry) =>
          Number(entry.course_module_id) === Number(moduleId)
          && Number(entry.item_number ?? 0) === Number(action.item_number ?? 0));
        itemId = Number(item?.item_id ?? 0);
      }
      if (!Number.isInteger(itemId) || itemId <= 0) {
        throw new TypeError(`Cannot resolve destination grade item for ${action.source_key}.`);
      }
      return this.client.callOperation('update_grade_item', {
        course_id: courseId,
        item_id: itemId,
        ...action.fields
      });
    }
    if (action.kind === 'course_completion.set') {
      const requiredModuleIds = action.fields.required_modules.map((requirement) => {
        const created = createdEntities.get(`modules:${requirement.source_key}`);
        const moduleId = requirement.target_id ?? created?.module_id;
        if (!Number.isInteger(Number(moduleId)) || Number(moduleId) <= 0) {
          throw new TypeError(`Cannot resolve completion activity ${requirement.source_key}.`);
        }
        return Number(moduleId);
      });
      return this.client.callOperation('set_course_completion_criteria', {
        course_id: courseId,
        required_module_ids: requiredModuleIds,
        require_all_activities: action.fields.require_all_activities,
        ...(action.fields.required_course_grade_percent === undefined ? {}
          : { required_course_grade_percent: action.fields.required_course_grade_percent }),
        criteria_aggregation: action.fields.criteria_aggregation
      });
    }
    if (action.kind === 'quiz_questions.import') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      return this.client.callOperation('import_question_bank_blueprint', {
        course_id: courseId,
        blueprint_json: JSON.stringify(action.fields.blueprint),
        bank_scope: 'quiz_private',
        quiz_module_id: Number(moduleId),
        create_categories: true
      });
    }
    if (action.kind === 'quiz_slot.create') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      const imported = createdEntities.get(`question_imports:${action.question_import_source_key}`);
      const createdQuestions = parseArray(imported?.created_questions_json);
      const question = createdQuestions[Number(action.fields.source_question_id) - 1];
      const questionId = Number(question?.question_id ?? question?.id ?? 0);
      if (!Number.isInteger(questionId) || questionId <= 0) {
        throw new TypeError(`Cannot resolve imported Quiz question ${action.fields.source_question_id}.`);
      }
      return this.client.callOperation('add_question_to_quiz', {
        quiz_module_id: Number(moduleId),
        question_id: questionId,
        slot: action.fields.slot
      });
    }
    if (action.kind === 'quiz_slot.update') {
      const createdModule = createdEntities.get(`modules:${action.module_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      return this.client.callOperation('update_quiz_question_slot', {
        quiz_module_id: Number(moduleId),
        slot: action.fields.slot,
        max_mark: action.fields.max_mark
      });
    }
    if (action.kind === 'lesson_page.create') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      const previousPage = action.after_source_key
        ? createdEntities.get(`lesson_pages:${action.after_source_key}`)
        : null;
      const definition = action.fields.definition ?? {};
      return this.client.callOperation('create_lesson_page', {
        course_id: courseId,
        module_id: Number(moduleId),
        title: action.fields.title,
        content: action.fields.content,
        content_format: action.fields.content_format,
        page_type: action.fields.page_type,
        ...(action.fields.page_type === 'content'
          ? { branches: definition.branches ?? [] }
          : { answers: definition.answers ?? {} }),
        ...(previousPage?.page_id ? { after_page_id: Number(previousPage.page_id) } : {}),
        display_in_menu: action.fields.display_in_menu,
        horizontal: action.fields.horizontal
      });
    }
    if (action.kind === 'question_bank.import') {
      const createdModule = createdEntities.get(`modules:${action.parent_source_key}`);
      const moduleId = action.target_module_id ?? createdModule?.module_id;
      return this.client.callOperation('import_question_bank_blueprint', {
        course_id: courseId,
        blueprint_json: JSON.stringify(action.fields.blueprint),
        bank_scope: 'course_shared',
        question_bank_module_id: Number(moduleId),
        create_categories: true
      });
    }
    throw new TypeError(`MoodlIA adapter cannot apply sync action ${action.kind}.`);
  }

  async downloadAsset(asset) {
    return this.client.downloadFile(asset.url, { maximumBytes: Math.max(asset.filesize, 1) });
  }

  async downloadAssetToFile(asset, destinationPath) {
    return this.client.downloadFileToPath(asset.url, destinationPath, {
      maximumBytes: Math.max(asset.filesize, 1)
    });
  }

  async stageModuleAssets(action, assetsWithData) {
    let draftItemId = 0;
    const files = [];
    for (const material of assetsWithData) {
      const uploaded = await uploadMaterial(this.client, material, draftItemId);
      draftItemId = uploaded.draft_item_id;
      files.push(uploaded);
    }
    return { draft_item_id: draftItemId, files };
  }

  async replaceResourceAsset(action, material, { courseId }) {
    const resolvedMaterial = material instanceof Uint8Array ? { data: material } : material;
    const uploaded = await uploadMaterial(this.client, { asset: action.asset, ...resolvedMaterial });
    return this.client.callOperation('update_resource', {
      course_id: courseId,
      module_id: action.target_id,
      filename: uploaded.filename,
      draft_item_id: uploaded.draft_item_id,
      ...(action.fields ?? {})
    });
  }

  async publishBookChapterAssets(action, assetsWithData, { courseId, createdEntities = new Map() }) {
    const createdModule = createdEntities.get(`modules:${action.parent_module_source_key}`);
    const createdChapter = createdEntities.get(`chapters:${action.parent_source_key}`);
    const moduleId = action.target_module_id ?? createdModule?.module_id;
    const chapterId = action.target_chapter_id ?? createdChapter?.chapter_id;
    if (!Number.isInteger(Number(moduleId)) || !Number.isInteger(Number(chapterId))) {
      throw new TypeError(`Cannot resolve the destination Book chapter for ${action.source_key}.`);
    }
    let draftItemId = 0;
    const uploadedFiles = [];
    for (const material of assetsWithData) {
      const uploaded = await uploadMaterial(this.client, material, draftItemId);
      draftItemId = uploaded.draft_item_id;
      uploadedFiles.push(uploaded);
    }
    return this.client.callOperation('update_book_chapter', {
      course_id: courseId,
      module_id: Number(moduleId),
      chapter_id: Number(chapterId),
      content: action.content,
      content_format: action.content_format,
      filename: uploadedFiles[0]?.filename,
      draft_item_id: draftItemId
    });
  }
}

export function createMoodliaSyncAdapter(options) {
  return new MoodliaSyncAdapter(options);
}
