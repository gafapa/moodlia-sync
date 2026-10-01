import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FORMATS = { html: 1, plain: 2, markdown: 4, moodle: 0 };
const TYPES = ['page', 'label', 'url', 'assign'];

async function uploadFiles(client, beforeUpload) {
  const assets = [
    { filename: 'notes ünicode.txt', filepath: '/', data: Buffer.from('Portable source bytes\n') },
    { filename: 'diagram ünicode.svg', filepath: '/nested/', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#369"/></svg>') }
  ];
  let itemId = 0;
  for (const asset of assets) {
    beforeUpload(asset.filename);
    const uploaded = await client.uploadDraftData(asset.data, { filename: asset.filename, filepath: asset.filepath, itemId });
    itemId = Number(uploaded.draft_item_id);
    assert.ok(itemId > 0, 'Moodle must return a user-owned draft identity');
  }
  return { draft_item_id: itemId, filename: assets[0].filename };
}

function identity(file) {
  return `${file.filepath}${file.filename}:${file.sha256}`;
}

// The parent runner owns only disposable lab sites and approvals. This fixture
// proves strict gaps, then allows only the declared Assignment transformation.
// It never transfers learner data.
export async function qualifyAuthoring({ sourceAdapter, targetAdapter, sourceFixture, targetFixture,
  runId, results, invoke, common, redact }) {
  const progress = { schema_version: 1, phase: 'setup', source_course_id: null, target_course_id: null, cases: [] };
  const save = () => fs.writeFileSync(path.join(results, `${runId}-authoring-report.json`),
    `${redact(JSON.stringify(progress, null, 2))}\n`, { mode: 0o600 });
  const sourceClient = sourceAdapter.adapters.moodlia.client;
  const targetClient = targetAdapter.adapters.moodlia.client;
  // CLI phases block this process's event loop. Do not reuse fixture sockets
  // whose remote keep-alive timeout elapsed while a child process was running.
  for (const client of [sourceClient, targetClient]) {
    const request = client.transport.fetchImplementation;
    client.transport.fetchImplementation = (url, options = {}) => {
      const headers = new Headers(options.headers);
      headers.set('connection', 'close');
      return request(url, { ...options, headers });
    };
  }
  save();
  try {
    const sourceDetails = await sourceClient.callOperation('get_course_details', { course_id: sourceFixture.source_course_id });
    const targetDetails = await targetClient.callOperation('get_course_details', { course_id: targetFixture.target_course_ids[1] });
    const sourceCourse = await sourceClient.callOperation('create_course', {
      fullname: 'Cross-version authoring qualification', shortname: `${runId}-author-source`,
      category_id: sourceDetails.category_id, visible: false, enable_completion: false,
      summary: 'A & B <literal>\nPortable summary', summary_format: 'plain'
    });
    const targetCourse = await targetClient.callOperation('create_course', {
      fullname: 'Empty authoring destination', shortname: `${runId}-author-target`,
      category_id: targetDetails.category_id, visible: false, enable_completion: false,
      summary: 'Previous summary', summary_format: 'html'
    });
    progress.source_course_id = sourceCourse.course_id;
    progress.target_course_id = targetCourse.course_id;
    assert.ok(progress.source_course_id > 0 && progress.target_course_id > 0);
    for (const [client, courseId] of [[sourceClient, sourceCourse.course_id], [targetClient, targetCourse.course_id]]) {
      const inventory = await client.callOperation('get_course_contents', { course_id: courseId });
      for (const module of inventory.sections.flatMap((section) => section.modules)) {
        assert.equal(module.module_type, 'forum', 'Only Moodle automatic announcements may exist in a fresh fixture');
        await client.callOperation('delete_module', { course_id: courseId, module_id: module.module_id });
      }
    }
    progress.phase = 'seed-content';
    save();
    const seeded = [];
    for (const type of TYPES) {
      for (const [format, constant] of Object.entries(FORMATS)) {
        progress.current_case = { type, format, operation: 'create_module' };
        save();
        const name = `Qualification ${type} ${format}`;
        const content = format === 'html'
          ? '<p>Portable content</p><a href="@@PLUGINFILE@@/nested/diagram%20%C3%BCnicode.svg">Asset</a>'
          : `${name}\nA & B <literal>\n**Markdown** and \`code\`\n@@PLUGINFILE@@/nested/diagram%20%C3%BCnicode.svg`;
        const created = await sourceClient.callOperation('create_module', {
          course_id: sourceCourse.course_id, section_number: 0, module_type: type, name,
          options: { visible: false, ...(type === 'label' ? { content: '<p>Initial label</p>' } : {}),
            ...(type === 'url' ? { external_url: 'https://example.org/' } : {}),
            ...(type === 'assign' ? { online_text: false, file_submissions: false, feedback_comments: false,
              feedback_files: false, feedback_offline: false, feedback_editpdf: false } : {}) }
        });
        const editor = await uploadFiles(sourceClient, (filename) => {
          progress.current_case.operation = 'uploadDraftData';
          progress.current_case.filename = filename;
          save();
        });
        progress.current_case.operation = type === 'assign' ? 'update_assignment' : `update_${type}`;
        save();
        const parameters = { course_id: sourceCourse.course_id, module_id: created.module_id, ...editor };
        if (type === 'assign') {
          await sourceClient.callOperation('update_assignment', { ...parameters,
            intro: content, intro_format: format, activity: `${name}\nInstructions & <literal>`,
            activity_format: format, file_area: 'intro' });
        } else {
          const textField = type === 'url' ? 'intro' : 'content';
          const formatField = type === 'url' ? 'intro_format' : 'content_format';
          await sourceClient.callOperation(`update_${type}`, { ...parameters, [textField]: content, [formatField]: format });
        }
        seeded.push({ type, format, constant, source_module_id: created.module_id });
      }
    }
    // Warm Moodle's lazily initialized gradebook before immutable extraction.
    await sourceClient.callOperation('get_grade_items', { course_id: sourceCourse.course_id });
    await targetClient.callOperation('get_grade_items', { course_id: targetCourse.course_id });
    const initialSource = await sourceAdapter.exportCourse(sourceCourse.course_id);
    progress.source_summary = initialSource.course;
    const guarded = invoke('authoring', 'summary-guard-plan', ['plan', '--source-profile', 'm45plugin',
      '--source-course-id', String(sourceCourse.course_id), '--target-profile', 'm53plugin',
      '--target-course-id', String(targetCourse.course_id), '--unsupported-policy', 'error',
      '--plan-file', path.join(results, `${runId}-authoring-summary-guard.plan.json`), ...common], [0, 3]);
    assert.equal(guarded.applicable, false);
    assert.ok(guarded.unsupported.some((entry) => entry.reason === 'source_raw_text_unavailable'));
    assert.ok(guarded.actions.every((action) => !action.kind.startsWith('course.')
      || !Object.hasOwn(action.fields ?? {}, 'summary')));
    progress.summary_raw_guard_verified = true;
    // Legacy services expose a rendered course summary; qualify module formats
    // with an HTML summary after separately proving the unsafe summary is blocked.
    await sourceClient.callOperation('update_course', { course_id: sourceCourse.course_id,
      summary: '<p>Portable summary</p>', summary_format: 'html' });
    const updatedInventory = await sourceClient.callOperation('get_course_contents', { course_id: sourceCourse.course_id });
    for (const module of updatedInventory.sections.flatMap((section) => section.modules)
      .filter((entry) => entry.module_type === 'forum')) {
      await sourceClient.callOperation('delete_module', { course_id: sourceCourse.course_id, module_id: module.module_id });
    }
    progress.source_read_diagnostics = [];
    for (const module of initialSource.sections.flatMap((section) => section.modules)
      .filter((entry) => entry.authoring_completeness === 'unavailable')) {
      const diagnostic = { module_id: module.source_id, type: module.module_type };
      try {
        const details = await sourceClient.callOperation('get_module_details', {
          course_id: sourceCourse.course_id, module_id: module.source_id });
        const extra = JSON.parse(details.extra_json);
        const activity = typeof extra.activity === 'string' ? JSON.parse(extra.activity) : extra.activity;
        let files = activity?.files ?? [];
        if (module.module_type === 'assign') {
          const assignments = await sourceClient.callOperation('get_course_assignments', { course_id: sourceCourse.course_id });
          files = assignments.assignments.find((entry) => entry.module_id === module.source_id)?.intro_files ?? [];
        }
        diagnostic.file_count = files.length;
        for (const file of files) await sourceClient.downloadFile(file.url);
      } catch (error) {
        diagnostic.error = error.message;
        diagnostic.details = error.details ?? {};
      }
      progress.source_read_diagnostics.push(diagnostic);
    }
    await targetAdapter.exportCourse(targetCourse.course_id);
    const planPath = path.join(results, `${runId}-authoring.plan.json`);
    progress.phase = 'plan';
    save();
    const strict = invoke('authoring', 'strict-plan', ['plan', '--source-profile', 'm45plugin',
      '--source-course-id', String(sourceCourse.course_id), '--target-profile', 'm53plugin',
      '--target-course-id', String(targetCourse.course_id), '--unsupported-policy', 'error',
      '--plan-file', path.join(results, `${runId}-authoring-strict.plan.json`), ...common], [0, 3]);
    assert.equal(strict.applicable, false, 'Unexported Assignment plugin configuration must remain an explicit gap');
    assert.equal(strict.unsupported.filter((entry) => entry.kind === 'assignment.settings').length, 4);
    assert.ok(strict.actions.every((action) => action.kind !== 'module.create' || action.fields.module_type !== 'assign'));
    progress.assignment_strict_guard_verified = true;
    const plan = invoke('authoring', 'plan', ['plan', '--source-profile', 'm45plugin',
      '--source-course-id', String(sourceCourse.course_id), '--target-profile', 'm53plugin',
      '--target-course-id', String(targetCourse.course_id), '--unsupported-policy', 'degrade',
      '--plan-file', planPath, ...common], [0, 3]);
    assert.equal(plan.applicable, true, JSON.stringify(plan.unsupported));
    assert.equal(plan.unsupported.length, 4);
    assert.ok(plan.unsupported.every((entry) => entry.kind === 'assignment.settings'
      && entry.transformation === 'assignment_selected_settings'
      && entry.reason === 'selected_configuration_incomplete'
      && JSON.stringify(entry.losses) === JSON.stringify(['submission_plugin_configuration_not_exported'])));
    assert.equal(plan.skipped.length, 0, 'No authoring entity may be silently skipped');
    progress.allowed_gaps = plan.unsupported;
    progress.assignment_transformation = 'assignment_selected_settings';
    assert.equal(plan.actions.filter((action) => action.kind === 'module.create').length, seeded.length);
    invoke('authoring', 'approve', ['approve', planPath, '--yes', ...common]);
    progress.phase = 'apply';
    save();
    const job = invoke('authoring', 'apply', ['apply', planPath, '--plan-digest', plan.digest, '--allow-write', ...common]);
    assert.equal(job.status, 'succeeded');
    invoke('authoring', 'verify', ['verify', '--plan-id', plan.plan_id, '--job-id', job.job_id, ...common]);
    const source = await sourceAdapter.exportCourse(sourceCourse.course_id);
    const target = await targetAdapter.exportCourse(targetCourse.course_id);
    assert.equal(target.course.summary, source.course.summary);
    assert.equal(target.course.summary_format, 'html');
    const sourceModules = source.sections.flatMap((section) => section.modules);
    const targetModules = target.sections.flatMap((section) => section.modules);
    for (const entry of seeded) {
      const action = plan.actions.find((candidate) => candidate.kind === 'module.create'
        && candidate.source_key === `module:${entry.source_module_id}`);
      const result = job.results.find((candidate) => candidate.action_id === action.action_id && candidate.status === 'succeeded');
      const from = sourceModules.find((module) => module.source_id === entry.source_module_id);
      const to = targetModules.find((module) => module.source_id === result.result.module_id);
      assert.ok(from && to);
      const fromContent = entry.type === 'assign' ? from.authoring.content : from.authoring.settings;
      const toContent = entry.type === 'assign' ? to.authoring.content : to.authoring.settings;
      const textField = entry.type === 'assign' || entry.type === 'url' ? 'intro' : 'content';
      const formatField = `${textField}_format`;
      assert.equal(fromContent[formatField], entry.constant, 'Source fixture must retain its requested format');
      assert.equal(toContent[formatField], entry.constant);
      assert.equal(toContent[textField], fromContent[textField]);
      if (entry.type === 'assign') {
        assert.equal(toContent.activity, fromContent.activity);
        assert.equal(toContent.activity_format, entry.constant);
      }
      const fromFiles = entry.type === 'assign' ? fromContent.intro_files : from.authoring.files;
      const toFiles = entry.type === 'assign' ? toContent.intro_files : to.authoring.files;
      assert.equal(fromFiles.length, 2);
      assert.deepEqual(toFiles.map(identity).sort(), fromFiles.map(identity).sort());
      progress.cases.push({ ...entry, target_module_id: to.source_id, text_verified: true,
        format_verified: true, asset_count: toFiles.length, byte_hashes_match: true });
    }
    progress.phase = 'repeat-plan';
    save();
    const repeat = invoke('authoring', 'repeat-plan', ['plan', '--source-profile', 'm45plugin',
      '--source-course-id', String(sourceCourse.course_id), '--target-profile', 'm53plugin',
      '--target-course-id', String(targetCourse.course_id), '--unsupported-policy', 'degrade',
      '--plan-file', path.join(results, `${runId}-authoring-repeat.plan.json`), ...common], [0, 3]);
    assert.equal(repeat.applicable, true, JSON.stringify(repeat.unsupported));
    assert.equal(repeat.actions.length, 0, 'The rich authoring fixture must converge without writes');
    progress.phase = 'verified';
    progress.summary_format_verified = true;
    progress.repeat_action_count = repeat.actions.length;
    progress.source_site = source.site;
    progress.target_site = target.site;
    save();
    return progress;
  } catch (error) {
    progress.error = redact(error.message);
    progress.error_details = JSON.parse(redact(JSON.stringify(error.details ?? {})));
    save();
    throw new Error(`Authoring qualification failed during ${progress.phase}: ${redact(error.message)}`);
  }
}
