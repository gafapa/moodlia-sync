import fs from 'node:fs';

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log(JSON.stringify({
  applicable: plan.applicable,
  actions: plan.actions.map((action) => ({ kind: action.kind, source_key: action.source_key })),
  skipped: plan.skipped,
  unsupported: plan.unsupported
}, null, 2));
