import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { MoodleClientError } from 'moodlia/core/transport';

const NATIVE_DRIVER_FIX = 'npm approve-scripts better-sqlite3 && npm rebuild better-sqlite3';

function isNativeDriverFailure(error) {
  const message = String(error?.message ?? '');
  return error?.code === 'ERR_DLOPEN_FAILED'
    || message.includes('Could not locate the bindings file')
    || message.includes('NODE_MODULE_VERSION')
    || message.includes('better_sqlite3.node');
}

/**
 * Opens the SQLite database, turning a missing or mismatched native driver
 * (for example when npm blocked its install script) into an actionable error.
 */
export function openSqliteDatabase(databasePath, DatabaseImplementation = Database) {
  try {
    return new DatabaseImplementation(databasePath);
  } catch (error) {
    if (!isNativeDriverFailure(error)) throw error;
    throw new MoodleClientError(
      'dependency_unavailable',
      `The native SQLite driver (better-sqlite3) is not built for this Node.js runtime. Run: ${NATIVE_DRIVER_FIX}`,
      { dependency: 'better-sqlite3', fix: NATIVE_DRIVER_FIX, node_version: process.version },
      error
    );
  }
}

function serialize(value) {
  return JSON.stringify(value);
}

function deserialize(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

export class MemorySyncStateStore {
  constructor() {
    this.plans = new Map();
    this.jobs = new Map();
    this.bindings = new Map();
    this.approvals = new Map();
    this.leases = new Map();
  }

  savePlan(plan) { this.plans.set(plan.plan_id, structuredClone(plan)); }
  getPlan(id) { return this.plans.has(id) ? structuredClone(this.plans.get(id)) : null; }
  saveJob(job) { this.jobs.set(job.job_id, structuredClone(job)); }
  getJob(id) { return this.jobs.has(id) ? structuredClone(this.jobs.get(id)) : null; }
  listJobs() { return [...this.jobs.values()].map((job) => structuredClone(job)); }
  saveBinding(binding) { this.bindings.set(binding.binding_id, structuredClone(binding)); }
  getBinding(id) { return this.bindings.has(id) ? structuredClone(this.bindings.get(id)) : null; }
  saveApproval(approval) { this.approvals.set(approval.plan_id, structuredClone(approval)); }
  getApproval(planId) { return this.approvals.has(planId) ? structuredClone(this.approvals.get(planId)) : null; }
  consumeApprovalAndSaveJob(planId, digest, job, now = new Date().toISOString()) {
    const approval = this.approvals.get(planId);
    if (!approval || approval.digest !== digest || approval.consumed_at || Date.parse(approval.expires_at) <= Date.parse(now)) {
      return false;
    }
    this.approvals.set(planId, { ...structuredClone(approval), consumed_at: now });
    this.jobs.set(job.job_id, structuredClone(job));
    return true;
  }
  acquireLease(bindingId, owner, expiresAt, now = new Date().toISOString()) {
    const current = this.leases.get(bindingId);
    if (current && current.owner !== owner && Date.parse(current.expires_at) > Date.parse(now)) return false;
    this.leases.set(bindingId, { binding_id: bindingId, owner, acquired_at: now, expires_at: expiresAt });
    return true;
  }
  releaseLease(bindingId, owner) {
    if (this.leases.get(bindingId)?.owner === owner) this.leases.delete(bindingId);
  }
  close() {}
}

export class SqliteSyncStateStore {
  constructor(databasePath, { DatabaseImplementation = Database } = {}) {
    if (typeof databasePath !== 'string' || databasePath.trim() === '') {
      throw new TypeError('databasePath is required.');
    }
    this.databasePath = path.resolve(databasePath);
    this.database = openSqliteDatabase(this.databasePath, DatabaseImplementation);
    if (process.platform !== 'win32') fs.chmodSync(this.databasePath, 0o600);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('schema_version', '1');
      CREATE TABLE IF NOT EXISTS sync_plans (
        plan_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_jobs (
        job_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_bindings (
        binding_id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_approvals (
        plan_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        approved_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_leases (
        binding_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      UPDATE sync_meta SET value = '2' WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 2;
    `);
  }

  savePlan(plan) {
    this.database.prepare(`
      INSERT INTO sync_plans(plan_id, digest, created_at, expires_at, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET digest=excluded.digest, expires_at=excluded.expires_at, payload=excluded.payload
    `).run(plan.plan_id, plan.digest, plan.created_at, plan.expires_at, serialize(plan));
  }

  getPlan(id) {
    const row = this.database.prepare('SELECT payload FROM sync_plans WHERE plan_id = ?').get(id);
    return deserialize(row?.payload);
  }

  saveJob(job) {
    this.database.prepare(`
      INSERT INTO sync_jobs(job_id, plan_id, status, updated_at, payload)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, payload=excluded.payload
    `).run(job.job_id, job.plan_id, job.status, job.updated_at, serialize(job));
  }

  getJob(id) {
    const row = this.database.prepare('SELECT payload FROM sync_jobs WHERE job_id = ?').get(id);
    return deserialize(row?.payload);
  }

  listJobs() {
    return this.database.prepare('SELECT payload FROM sync_jobs ORDER BY updated_at DESC')
      .all().map((row) => deserialize(row.payload));
  }

  saveBinding(binding) {
    const updatedAt = binding.updated_at ?? new Date().toISOString();
    this.database.prepare(`
      INSERT INTO sync_bindings(binding_id, updated_at, payload)
      VALUES (?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET updated_at=excluded.updated_at, payload=excluded.payload
    `).run(binding.binding_id, updatedAt, serialize({ ...binding, updated_at: updatedAt }));
  }

  getBinding(id) {
    const row = this.database.prepare('SELECT payload FROM sync_bindings WHERE binding_id = ?').get(id);
    return deserialize(row?.payload);
  }

  saveApproval(approval) {
    this.database.prepare(`
      INSERT INTO sync_approvals(plan_id, digest, approved_at, expires_at, consumed_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id) DO UPDATE SET digest=excluded.digest, approved_at=excluded.approved_at,
        expires_at=excluded.expires_at, consumed_at=excluded.consumed_at, payload=excluded.payload
    `).run(
      approval.plan_id,
      approval.digest,
      approval.approved_at,
      approval.expires_at,
      approval.consumed_at ?? null,
      serialize(approval)
    );
  }

  getApproval(planId) {
    const row = this.database.prepare('SELECT payload FROM sync_approvals WHERE plan_id = ?').get(planId);
    return deserialize(row?.payload);
  }

  consumeApprovalAndSaveJob(planId, digest, job, now = new Date().toISOString()) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database.prepare('SELECT payload FROM sync_approvals WHERE plan_id = ?').get(planId);
      const approval = deserialize(row?.payload);
      if (!approval || approval.digest !== digest || approval.consumed_at
        || Date.parse(approval.expires_at) <= Date.parse(now)) {
        this.database.exec('ROLLBACK');
        return false;
      }
      const consumed = { ...approval, consumed_at: now };
      this.database.prepare(`
        UPDATE sync_approvals SET consumed_at = ?, payload = ? WHERE plan_id = ?
      `).run(now, serialize(consumed), planId);
      this.database.prepare(`
        INSERT INTO sync_jobs(job_id, plan_id, status, updated_at, payload)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, payload=excluded.payload
      `).run(job.job_id, job.plan_id, job.status, job.updated_at, serialize(job));
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  acquireLease(bindingId, owner, expiresAt, now = new Date().toISOString()) {
    const result = this.database.prepare(`
      INSERT INTO sync_leases(binding_id, owner, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET owner=excluded.owner, acquired_at=excluded.acquired_at,
        expires_at=excluded.expires_at
      WHERE sync_leases.owner=excluded.owner OR sync_leases.expires_at <= excluded.acquired_at
    `).run(bindingId, owner, now, expiresAt);
    return result.changes > 0;
  }

  releaseLease(bindingId, owner) {
    this.database.prepare('DELETE FROM sync_leases WHERE binding_id = ? AND owner = ?').run(bindingId, owner);
  }

  close() { this.database.close(); }
}
