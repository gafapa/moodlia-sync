import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openSqliteDatabase, SqliteSyncStateStore } from '../sync/index.mjs';

const execFileAsync = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/state-0.3.6.sqlite', import.meta.url));
const storeModule = pathToFileURL(fileURLToPath(new URL('../sync/state-store.mjs', import.meta.url))).href;

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'moodlia-sync-store-'));
}

test('opens a state database written by moodle-core-cli 0.3.6 without losing records', () => {
  const directory = temporaryDirectory();
  try {
    const databasePath = path.join(directory, 'state.sqlite');
    fs.copyFileSync(fixture, databasePath);
    const store = new SqliteSyncStateStore(databasePath);
    try {
      assert.equal(store.getPlan('plan-036').digest, 'sha256:036');
      assert.equal(store.getJob('job-036').status, 'partially_applied');
      assert.deepEqual(store.getBinding('binding-036').mappings, { groups: { 'g:1': 501 } });
      assert.equal(store.getApproval('plan-036').consumed_at, null);
      const job = { schema_version: 1, job_id: 'job-new', plan_id: 'plan-036', status: 'queued', updated_at: new Date().toISOString(), results: [] };
      assert.equal(store.consumeApprovalAndSaveJob('plan-036', 'sha256:036', job), true);
      assert.equal(store.consumeApprovalAndSaveJob('plan-036', 'sha256:036', job), false);
    } finally {
      store.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a missing native driver becomes an actionable dependency_unavailable error', () => {
  class MissingBindings {
    constructor() {
      throw new Error('Could not locate the bindings file. Tried: build/Release/better_sqlite3.node');
    }
  }
  assert.throws(() => openSqliteDatabase(':memory:', MissingBindings), (error) => {
    assert.equal(error.code, 'dependency_unavailable');
    assert.match(error.message, /npm approve-scripts better-sqlite3 && npm rebuild better-sqlite3/);
    assert.equal(error.details.dependency, 'better-sqlite3');
    return true;
  });
  class Mismatched {
    constructor() {
      throw Object.assign(new Error('was compiled against NODE_MODULE_VERSION 127'), { code: 'ERR_DLOPEN_FAILED' });
    }
  }
  assert.throws(() => new SqliteSyncStateStore(path.join(os.tmpdir(), 'unused.sqlite'), { DatabaseImplementation: Mismatched }), {
    code: 'dependency_unavailable'
  });
  class Unrelated {
    constructor() {
      throw new Error('SQLITE_CANTOPEN');
    }
  }
  assert.throws(() => openSqliteDatabase(':memory:', Unrelated), /SQLITE_CANTOPEN/);
});

test('two processes contending for one binding lease: exactly one wins', async () => {
  const directory = temporaryDirectory();
  try {
    const databasePath = path.join(directory, 'state.sqlite');
    new SqliteSyncStateStore(databasePath).close();
    const script = `
      import { SqliteSyncStateStore } from ${JSON.stringify(storeModule)};
      const store = new SqliteSyncStateStore(process.argv[1]);
      const expires = new Date(Date.now() + 60_000).toISOString();
      let acquired = false;
      for (let attempt = 0; attempt < 50 && !acquired; attempt += 1) {
        try {
          acquired = store.acquireLease('binding-1', process.argv[2], expires);
          break;
        } catch (error) {
          if (!String(error.code).startsWith('SQLITE_BUSY')) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      store.close();
      console.log(JSON.stringify({ owner: process.argv[2], acquired }));
    `;
    const run = (owner) => execFileAsync(process.execPath, ['--input-type=module', '-e', script, databasePath, owner]);
    const results = (await Promise.all([run('worker-a'), run('worker-b')])).map(({ stdout }) => JSON.parse(stdout));
    assert.equal(results.filter((entry) => entry.acquired).length, 1, JSON.stringify(results));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
