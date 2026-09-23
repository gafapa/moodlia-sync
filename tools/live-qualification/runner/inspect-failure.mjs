import Database from 'better-sqlite3';
import fs from 'node:fs';
import contract from 'moodlia/contract' with { type: 'json' };
import { createSyncSiteAdapter } from 'moodlia-sync/adaptive';

const root = '/qualification';
const results = `${root}/results`;
const database = new Database(`${results}/public032-final-state.sqlite`, { readonly: true });
const jobs = database.prepare('SELECT job_id, status, payload FROM sync_jobs ORDER BY updated_at').all()
  .map((row) => {
    const payload = JSON.parse(row.payload);
    return {
      job_id: row.job_id,
      status: row.status,
      error: payload.error,
      verification: payload.verification,
      results: payload.results.map((result) => ({
        action_id: result.action_id,
        status: result.status,
        result: result.result,
        resolved_fields: result.resolved_fields
      }))
    };
  });
database.close();

const plans = ['core-to-core', 'core-to-moodlia'].map((name) => {
  const plan = JSON.parse(fs.readFileSync(`${results}/public032-final-${name}.plan.json`, 'utf8'));
  return {
    name,
    plan_id: plan.plan_id,
    actions: plan.actions.map((action) => ({
      action_id: action.action_id,
      kind: action.kind,
      source_key: action.source_key,
      target_id: action.target_id,
      fields: action.fields
    }))
  };
});

const targetFixture = JSON.parse(fs.readFileSync(`${results}/m53plugin.json`, 'utf8'));
const targetAdapter = createSyncSiteAdapter({
  profile: {
    name: 'm53plugin',
    url: 'http://127.0.0.1:18531',
    backend: 'moodlia',
    allow_insecure: true,
    credentials: { moodlia: { token: targetFixture.token } }
  },
  moodliaContract: contract
});
const targetModel = await targetAdapter.exportCourse(targetFixture.target_course_ids[0]);
console.log(JSON.stringify({
  plans,
  jobs,
  target: {
    course: targetModel.course,
    sections: targetModel.sections.map((section) => ({
      source_id: section.source_id,
      name: section.name,
      order: section.order,
      section_number: section.section_number,
      summary: section.summary,
      summary_format: section.summary_format,
      visible: section.visible
    }))
  }
}, null, 2));
