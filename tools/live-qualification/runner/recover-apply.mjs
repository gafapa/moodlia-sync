import Database from 'better-sqlite3';
import fs from 'node:fs';

const [statePath, planId, outputPath] = process.argv.slice(2);
const database = new Database(statePath, { readonly: true });
const row = database.prepare('SELECT payload FROM sync_jobs WHERE plan_id = ? AND status = ? ORDER BY updated_at DESC LIMIT 1')
  .get(planId, 'succeeded');
database.close();
if (!row) throw new Error(`No successful job exists for plan ${planId}.`);
fs.writeFileSync(outputPath, `${JSON.stringify(JSON.parse(row.payload), null, 2)}\n`, { mode: 0o600 });
