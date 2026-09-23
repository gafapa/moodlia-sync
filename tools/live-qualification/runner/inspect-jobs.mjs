import Database from 'better-sqlite3';

const database = new Database(process.argv[2], { readonly: true });
const jobs = database.prepare('SELECT job_id, plan_id, status, payload FROM sync_jobs ORDER BY updated_at').all()
  .map((row) => ({
    job_id: row.job_id,
    plan_id: row.plan_id,
    status: row.status,
    error: JSON.parse(row.payload).error,
    results: JSON.parse(row.payload).results.map((result) => ({
      action_id: result.action_id,
      status: result.status,
      result: result.result,
      resolved_fields: result.resolved_fields
    }))
  }));
database.close();
console.log(JSON.stringify(jobs, null, 2));
