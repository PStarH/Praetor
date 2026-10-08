import { reportSilentFailure } from '@praetor/core';
import { createVerifiedPostgresPool } from '@praetor/postgres-runtime';
import type { QueryResultRow } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

import { getDirname, getRequire } from '../esmCompat';
const __dirname = getDirname(import.meta.url);
const require = getRequire(import.meta.url);

const DEFAULT_STATE_DIR = fs.existsSync(path.resolve(process.cwd(), '.praetor'))
  ? '.praetor'
  : (fs.existsSync(path.resolve(process.cwd(), '.commander')) ? '.commander' : '.praetor');
const DEFAULT_DB_PATH = path.resolve(process.cwd(), DEFAULT_STATE_DIR, 'api_state.db');

export type ApiStoreBackend = 'sqlite' | 'memory' | 'postgres';

export interface ApiTaskRow {
  id: string;
  client_id: string;
  agent_id: string | null;
  description: string;
  priority: string;
  status: string;
  input_json: string;
  artifact_id: string | null;
  progress: number;
  error: string | null;
  messages_json: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface ApiArtifactRow {
  id: string;
  task_id: string;
  content_type: string;
  content: string;
  url: string | null;
  metadata_json: string;
  created_at: string;
}

export interface ApiCheckpointRow {
  id: string;
  mission_id: string | null;
  task_id: string;
  type: string;
  status: string;
  risk_score: number;
  risk_level: string;
  required_approvals_json: string;
  current_approvals_json: string;
  created_at: string;
  expires_at: string | null;
  approved_at: string | null;
  fallback_action: string;
  context_json: string;
}

export interface ApiCheckpointConfigRow {
  mission_id: string;
  mode: string;
  risk_threshold: number | null;
  approvers_json: string;
  timeout: number | null;
  fallback_on_timeout: string;
}

export interface MissionCheckpoints {
  missionId: string;
  checkpoints: ApiCheckpointRow[];
  status: 'ok' | 'not_implemented';
  note?: string;
}

export interface SqliteApiStore {
  readonly backend: Exclude<ApiStoreBackend, 'postgres'>;
  readonly dbPath: string;
  close(): void;
  listTasksByStatus(status: string): ApiTaskRow[];
  listTasksByClient(clientId: string): ApiTaskRow[];
  listTasksByAgent(agentId: string): ApiTaskRow[];
  listAllTasks(): ApiTaskRow[];
  getTask(id: string): ApiTaskRow | null;
  putTask(row: ApiTaskRow): ApiTaskRow;
  deleteTask(id: string): void;
  getArtifact(id: string): ApiArtifactRow | null;
  putArtifact(row: ApiArtifactRow): ApiArtifactRow;
  getArtifactsByTask(taskId: string): ApiArtifactRow[];
  getCheckpoint(id: string): ApiCheckpointRow | null;
  putCheckpoint(row: ApiCheckpointRow): ApiCheckpointRow;
  listCheckpoints(missionId?: string): ApiCheckpointRow[];
  getPendingCheckpointsForApprover(approverId: string): ApiCheckpointRow[];
  getPendingCheckpointsByMission(missionId: string): ApiCheckpointRow[];
  approveCheckpoint(
    checkpointId: string,
    reviewerId: string,
    reason?: string,
    conditions?: string[],
  ): ApiCheckpointRow | null;
  rejectCheckpoint(
    checkpointId: string,
    reviewerId: string,
    reason: string,
  ): ApiCheckpointRow | null;
  expireCheckpoints(now: Date): ApiCheckpointRow[];
  addCheckpointEvidence(
    checkpointId: string,
    evidence: { type: string; timestamp: string; content: string; source: string },
  ): ApiCheckpointRow | null;
  getCheckpointConfig(missionId: string): ApiCheckpointConfigRow | null;
  putCheckpointConfig(row: ApiCheckpointConfigRow): ApiCheckpointConfigRow;
  getCheckpointStats(missionId?: string): {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    mandatoryCount: number;
    conditionalCount: number;
    automaticCount: number;
    averageApprovalTime: number | null;
  };
  cleanup(): void;
}

/** Async PostgreSQL-backed API store. */
export interface PostgresApiStore {
  readonly backend: 'postgres';
  readonly connectionString: string;
  close(): Promise<void>;
  listTasksByStatus(status: string): Promise<ApiTaskRow[]>;
  listTasksByClient(clientId: string): Promise<ApiTaskRow[]>;
  listTasksByAgent(agentId: string): Promise<ApiTaskRow[]>;
  listAllTasks(): Promise<ApiTaskRow[]>;
  getTask(id: string): Promise<ApiTaskRow | null>;
  putTask(row: ApiTaskRow): Promise<ApiTaskRow>;
  deleteTask(id: string): Promise<void>;
  getArtifact(id: string): Promise<ApiArtifactRow | null>;
  putArtifact(row: ApiArtifactRow): Promise<ApiArtifactRow>;
  getArtifactsByTask(taskId: string): Promise<ApiArtifactRow[]>;
  getCheckpoint(id: string): Promise<ApiCheckpointRow | null>;
  putCheckpoint(row: ApiCheckpointRow): Promise<ApiCheckpointRow>;
  listCheckpoints(missionId?: string): Promise<ApiCheckpointRow[]>;
  getPendingCheckpointsForApprover(approverId: string): Promise<ApiCheckpointRow[]>;
  getPendingCheckpointsByMission(missionId: string): Promise<ApiCheckpointRow[]>;
  approveCheckpoint(
    checkpointId: string,
    reviewerId: string,
    reason?: string,
    conditions?: string[],
  ): Promise<ApiCheckpointRow | null>;
  rejectCheckpoint(
    checkpointId: string,
    reviewerId: string,
    reason: string,
  ): Promise<ApiCheckpointRow | null>;
  expireCheckpoints(now: Date): Promise<ApiCheckpointRow[]>;
  addCheckpointEvidence(
    checkpointId: string,
    evidence: { type: string; timestamp: string; content: string; source: string },
  ): Promise<ApiCheckpointRow | null>;
  getCheckpointConfig(missionId: string): Promise<ApiCheckpointConfigRow | null>;
  putCheckpointConfig(row: ApiCheckpointConfigRow): Promise<ApiCheckpointConfigRow>;
  getCheckpointStats(missionId?: string): Promise<{
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    expired: number;
    mandatoryCount: number;
    conditionalCount: number;
    automaticCount: number;
    averageApprovalTime: number | null;
  }>;
  cleanup(): Promise<void>;
}

export type ApiStore = SqliteApiStore | PostgresApiStore;

function createMemoryApiStore(dbPath: string): SqliteApiStore {
  const tasks = new Map<string, ApiTaskRow>();
  const artifacts = new Map<string, ApiArtifactRow>();
  const checkpoints = new Map<string, ApiCheckpointRow>();
  const configs = new Map<string, ApiCheckpointConfigRow>();

  const store: SqliteApiStore = {
    backend: 'memory',
    dbPath,
    close() {},
    listTasksByStatus(status: string) {
      return Array.from(tasks.values()).filter((t) => t.status === status);
    },
    listTasksByClient(clientId: string) {
      return Array.from(tasks.values()).filter((t) => t.client_id === clientId);
    },
    listTasksByAgent(agentId: string) {
      return Array.from(tasks.values()).filter((t) => t.agent_id === agentId);
    },
    listAllTasks() {
      return Array.from(tasks.values());
    },
    getTask(id: string) {
      return tasks.get(id) ?? null;
    },
    putTask(row: ApiTaskRow) {
      tasks.set(row.id, row);
      return row;
    },
    deleteTask(id: string) {
      tasks.delete(id);
    },
    getArtifact(id: string) {
      return artifacts.get(id) ?? null;
    },
    putArtifact(row: ApiArtifactRow) {
      artifacts.set(row.id, row);
      return row;
    },
    getArtifactsByTask(taskId: string) {
      return Array.from(artifacts.values()).filter((a) => a.task_id === taskId);
    },
    getCheckpoint(id: string) {
      return checkpoints.get(id) ?? null;
    },
    putCheckpoint(row: ApiCheckpointRow) {
      checkpoints.set(row.id, row);
      return row;
    },
    listCheckpoints(missionId?: string) {
      const rows = Array.from(checkpoints.values());
      if (!missionId) return rows;
      return rows.filter((c) => c.mission_id === missionId);
    },
    getPendingCheckpointsForApprover(approverId: string) {
      return Array.from(checkpoints.values()).filter((c) => {
        if (c.status !== 'pending') return false;
        let required: string[] = [];
        try {
          required = JSON.parse(c.required_approvals_json);
        } catch (err) {
          reportSilentFailure(err, 'apiStore:174');
          required = [];
        }
        return required.includes(approverId);
      });
    },
    getPendingCheckpointsByMission(missionId: string) {
      return Array.from(checkpoints.values()).filter(
        (c) => c.mission_id === missionId && c.status === 'pending',
      );
    },
    approveCheckpoint(
      checkpointId: string,
      reviewerId: string,
      reason?: string,
      conditions?: string[],
    ) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({
        approved: true,
        reviewerId,
        reviewedAt: new Date().toISOString(),
        reason,
        conditions,
      });
      const required = JSON.parse(checkpoint.required_approvals_json || '[]');
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      if (approvals.length >= required.length) {
        checkpoint.status = 'approved';
        checkpoint.approved_at = new Date().toISOString();
      }
      checkpoints.set(checkpointId, checkpoint);
      return checkpoint;
    },
    rejectCheckpoint(checkpointId: string, reviewerId: string, reason: string) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({ approved: false, reviewerId, reviewedAt: new Date().toISOString(), reason });
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      checkpoint.status = 'rejected';
      checkpoints.set(checkpointId, checkpoint);
      return checkpoint;
    },
    expireCheckpoints(now: Date) {
      const expired: ApiCheckpointRow[] = [];
      for (const checkpoint of checkpoints.values()) {
        if (checkpoint.status !== 'pending' || !checkpoint.expires_at) continue;
        if (new Date(checkpoint.expires_at) < now) {
          checkpoint.status = checkpoint.fallback_action === 'proceed' ? 'approved' : 'expired';
          if (checkpoint.status === 'approved') checkpoint.approved_at = new Date().toISOString();
          checkpoints.set(checkpoint.id, checkpoint);
          expired.push(checkpoint);
        }
      }
      return expired;
    },
    addCheckpointEvidence(
      checkpointId: string,
      evidence: { type: string; timestamp: string; content: string; source: string },
    ) {
      const checkpoint = checkpoints.get(checkpointId);
      if (!checkpoint) return null;
      const context = JSON.parse(checkpoint.context_json || '{}');
      context.evidence = context.evidence || [];
      context.evidence.push(evidence);
      checkpoint.context_json = JSON.stringify(context);
      checkpoints.set(checkpoint.id, checkpoint);
      return checkpoint;
    },
    getCheckpointConfig(missionId: string) {
      return configs.get(missionId) ?? null;
    },
    putCheckpointConfig(row: ApiCheckpointConfigRow) {
      configs.set(row.mission_id, row);
      return row;
    },
    getCheckpointStats(missionId?: string) {
      if (!missionId) {
        return statsFromRows(Array.from(checkpoints.values()));
      }
      const mission = checkpointsForMission(missionId);
      const rows =
        mission.status === 'not_implemented'
          ? Array.from(checkpoints.values()).filter((c) => c.mission_id === missionId)
          : mission.checkpoints;
      return statsFromRows(rows);
    },
    cleanup() {
      tasks.clear();
      artifacts.clear();
      checkpoints.clear();
      configs.clear();
    },
  };
  return store;
}

function createSqliteApiStore(dbPath: string): SqliteApiStore {
  let Database: new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
      all<T = Record<string, unknown>>(...params: unknown[]): T[];
    };
    pragma(pragma: string): unknown;
    close(): void;
  };
  try {
    Database = require('better-sqlite3');
  } catch (err) {
    reportSilentFailure(err, 'apiStore:281');
    throw new Error(
      'SqliteApiStore requires "better-sqlite3". Install it with: pnpm add better-sqlite3',
    );
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tasks (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      agent_id TEXT,
      description TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'pending',
      input_json TEXT NOT NULL DEFAULT '{}',
      artifact_id TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      messages_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      content_type TEXT NOT NULL,
      content TEXT NOT NULL,
      url TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_governance_checkpoints (
      id TEXT PRIMARY KEY,
      mission_id TEXT,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      risk_score INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'LOW',
      required_approvals_json TEXT NOT NULL DEFAULT '[]',
      current_approvals_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      expires_at TEXT,
      approved_at TEXT,
      fallback_action TEXT NOT NULL DEFAULT 'abort',
      context_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS api_governance_configs (
      mission_id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      risk_threshold INTEGER,
      approvers_json TEXT NOT NULL DEFAULT '[]',
      timeout INTEGER,
      fallback_on_timeout TEXT NOT NULL DEFAULT 'abort'
    );

    CREATE INDEX IF NOT EXISTS idx_api_tasks_status ON api_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_api_tasks_client ON api_tasks(client_id);
    CREATE INDEX IF NOT EXISTS idx_api_tasks_agent ON api_tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_api_artifacts_task ON api_artifacts(task_id);
    CREATE INDEX IF NOT EXISTS idx_api_ck_mission ON api_governance_checkpoints(mission_id);
    CREATE INDEX IF NOT EXISTS idx_api_ck_status ON api_governance_checkpoints(status);
  `);

  const stmtListByStatus = db.prepare(
    `SELECT * FROM api_tasks WHERE status = ? ORDER BY created_at ASC`,
  );
  const stmtListByClient = db.prepare(
    `SELECT * FROM api_tasks WHERE client_id = ? ORDER BY created_at ASC`,
  );
  const stmtListByAgent = db.prepare(
    `SELECT * FROM api_tasks WHERE agent_id = ? ORDER BY created_at ASC`,
  );
  const stmtListAll = db.prepare(`SELECT * FROM api_tasks ORDER BY created_at ASC`);
  const stmtGetTask = db.prepare(`SELECT * FROM api_tasks WHERE id = ? LIMIT 1`);
  const stmtPutTask = db.prepare(`
    INSERT OR REPLACE INTO api_tasks
      (id, client_id, agent_id, description, priority, status, input_json, artifact_id, progress, error, messages_json, created_at, started_at, completed_at, updated_at)
    VALUES (@id, @clientId, @agentId, @description, @priority, @status, @inputJson, @artifactId, @progress, @error, @messagesJson, @createdAt, @startedAt, @completedAt, @updatedAt)
  `);
  const stmtDeleteTask = db.prepare(`DELETE FROM api_tasks WHERE id = ?`);
  const stmtGetArtifact = db.prepare(`SELECT * FROM api_artifacts WHERE id = ? LIMIT 1`);
  const stmtPutArtifact = db.prepare(`
    INSERT OR REPLACE INTO api_artifacts (id, task_id, content_type, content, url, metadata_json, created_at)
    VALUES (@id, @taskId, @contentType, @content, @url, @metadataJson, @createdAt)
  `);
  const stmtArtifactsByTask = db.prepare(
    `SELECT * FROM api_artifacts WHERE task_id = ? ORDER BY created_at ASC`,
  );
  const stmtGetCheckpoint = db.prepare(
    `SELECT * FROM api_governance_checkpoints WHERE id = ? LIMIT 1`,
  );
  const stmtPutCheckpoint = db.prepare(`
    INSERT OR REPLACE INTO api_governance_checkpoints
      (id, mission_id, task_id, type, status, risk_score, risk_level, required_approvals_json, current_approvals_json, created_at, expires_at, approved_at, fallback_action, context_json)
    VALUES (@id, @missionId, @taskId, @type, @status, @riskScore, @riskLevel, @requiredApprovalsJson, @currentApprovalsJson, @createdAt, @expiresAt, @approvedAt, @fallbackAction, @contextJson)
  `);
  const stmtListCheckpoints = db.prepare(
    `SELECT * FROM api_governance_checkpoints ORDER BY created_at ASC`,
  );
  const stmtPendingByApprover = db.prepare(`
    SELECT * FROM api_governance_checkpoints
    WHERE status = 'pending' AND json_extract(required_approvals_json, '$') LIKE ?
    ORDER BY created_at ASC
  `);
  const stmtPendingByMission = db.prepare(`
    SELECT * FROM api_governance_checkpoints
    WHERE mission_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `);
  const stmtGetConfig = db.prepare(
    `SELECT * FROM api_governance_configs WHERE mission_id = ? LIMIT 1`,
  );
  const stmtPutConfig = db.prepare(`
    INSERT OR REPLACE INTO api_governance_configs (mission_id, mode, risk_threshold, approvers_json, timeout, fallback_on_timeout)
    VALUES (@missionId, @mode, @riskThreshold, @approversJson, @timeout, @fallbackOnTimeout)
  `);
  const stmtStats = db.prepare(`SELECT * FROM api_governance_checkpoints`);

  const store: SqliteApiStore = {
    backend: 'sqlite',
    dbPath,
    close() {
      try {
        db.close();
      } catch (err) {
        reportSilentFailure(err, 'apiStore:417');
      }
    },
    listTasksByStatus(status: string) {
      return stmtListByStatus.all(status) as ApiTaskRow[];
    },
    listTasksByClient(clientId: string) {
      return stmtListByClient.all(clientId) as ApiTaskRow[];
    },
    listTasksByAgent(agentId: string) {
      return stmtListByAgent.all(agentId) as ApiTaskRow[];
    },
    listAllTasks() {
      return stmtListAll.all() as ApiTaskRow[];
    },
    getTask(id: string) {
      return (stmtGetTask.get(id) as ApiTaskRow | undefined) ?? null;
    },
    putTask(row: ApiTaskRow) {
      stmtPutTask.run(row);
      return row;
    },
    deleteTask(id: string) {
      stmtDeleteTask.run(id);
    },
    getArtifact(id: string) {
      return (stmtGetArtifact.get(id) as ApiArtifactRow | undefined) ?? null;
    },
    putArtifact(row: ApiArtifactRow) {
      stmtPutArtifact.run(row);
      return row;
    },
    getArtifactsByTask(taskId: string) {
      return stmtArtifactsByTask.all(taskId) as ApiArtifactRow[];
    },
    getCheckpoint(id: string) {
      return (stmtGetCheckpoint.get(id) as ApiCheckpointRow | undefined) ?? null;
    },
    putCheckpoint(row: ApiCheckpointRow) {
      stmtPutCheckpoint.run(row);
      return row;
    },
    listCheckpoints(missionId?: string) {
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      if (!missionId) return rows;
      return rows.filter((c) => c.mission_id === missionId);
    },
    getPendingCheckpointsForApprover(approverId: string) {
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      return rows.filter((c) => {
        if (c.status !== 'pending') return false;
        try {
          const required = JSON.parse(c.required_approvals_json || '[]');
          return required.includes(approverId);
        } catch (err) {
          reportSilentFailure(err, 'apiStore:472');
          return false;
        }
      });
    },
    getPendingCheckpointsByMission(missionId: string) {
      return stmtPendingByMission.all(missionId) as ApiCheckpointRow[];
    },
    approveCheckpoint(
      checkpointId: string,
      reviewerId: string,
      reason?: string,
      conditions?: string[],
    ) {
      const checkpoint = stmtGetCheckpoint.get(checkpointId) as ApiCheckpointRow | undefined;
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({
        approved: true,
        reviewerId,
        reviewedAt: new Date().toISOString(),
        reason,
        conditions,
      });
      const required = JSON.parse(checkpoint.required_approvals_json || '[]');
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      if (approvals.length >= required.length) {
        checkpoint.status = 'approved';
        checkpoint.approved_at = new Date().toISOString();
      }
      stmtPutCheckpoint.run(checkpoint);
      return checkpoint;
    },
    rejectCheckpoint(checkpointId: string, reviewerId: string, reason: string) {
      const checkpoint = stmtGetCheckpoint.get(checkpointId) as ApiCheckpointRow | undefined;
      if (!checkpoint) return null;
      const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
      approvals.push({ approved: false, reviewerId, reviewedAt: new Date().toISOString(), reason });
      checkpoint.current_approvals_json = JSON.stringify(approvals);
      checkpoint.status = 'rejected';
      stmtPutCheckpoint.run(checkpoint);
      return checkpoint;
    },
    expireCheckpoints(now: Date) {
      const expired: ApiCheckpointRow[] = [];
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      for (const checkpoint of rows) {
        if (checkpoint.status !== 'pending' || !checkpoint.expires_at) continue;
        if (new Date(checkpoint.expires_at) < now) {
          checkpoint.status = checkpoint.fallback_action === 'proceed' ? 'approved' : 'expired';
          if (checkpoint.status === 'approved') checkpoint.approved_at = new Date().toISOString();
          stmtPutCheckpoint.run(checkpoint);
          expired.push(checkpoint);
        }
      }
      return expired;
    },
    addCheckpointEvidence(
      checkpointId: string,
      evidence: { type: string; timestamp: string; content: string; source: string },
    ) {
      const rows = stmtListCheckpoints.all() as ApiCheckpointRow[];
      const checkpoint = rows.find((c) => c.id === checkpointId);
      if (!checkpoint) return null;
      const context = JSON.parse(checkpoint.context_json || '{}');
      context.evidence = context.evidence || [];
      context.evidence.push(evidence);
      checkpoint.context_json = JSON.stringify(context);
      stmtPutCheckpoint.run(checkpoint);
      return checkpoint;
    },
    getCheckpointConfig(missionId: string) {
      return (stmtGetConfig.get(missionId) as ApiCheckpointConfigRow | undefined) ?? null;
    },
    putCheckpointConfig(row: ApiCheckpointConfigRow) {
      stmtPutConfig.run(row);
      return row;
    },
    getCheckpointStats(missionId?: string) {
      if (!missionId) {
        return statsFromRows([]);
      }
      const mission = checkpointsForMission(missionId);
      const rows =
        mission.status === 'not_implemented'
          ? (stmtListCheckpoints.all() as ApiCheckpointRow[])
          : mission.checkpoints;
      return statsFromRows(rows);
    },
    cleanup() {
      db.exec('DELETE FROM api_tasks');
      db.exec('DELETE FROM api_artifacts');
      db.exec('DELETE FROM api_governance_checkpoints');
      db.exec('DELETE FROM api_governance_configs');
    },
  };
  return store;
}

function createPostgresApiStore(connectionString: string, manageSchema: boolean): PostgresApiStore {
  const pool = createVerifiedPostgresPool({ connectionString });

  const exec = async (sql: string, values?: unknown[]): Promise<void> => {
    await pool.query(sql, values);
  };

  const queryOne = async <T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<T | undefined> => {
    const { rows } = await pool.query<T>(sql, values);
    return rows[0];
  };

  const queryAll = async <T extends QueryResultRow = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<T[]> => {
    const { rows } = await pool.query<T>(sql, values);
    return rows;
  };

  const initSchema = async (): Promise<void> => {
    await exec(`
      CREATE TABLE IF NOT EXISTS api_tasks (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        agent_id TEXT,
        description TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'pending',
        input_json TEXT NOT NULL DEFAULT '{}',
        artifact_id TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        messages_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        content_type TEXT NOT NULL,
        content TEXT NOT NULL,
        url TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_governance_checkpoints (
        id TEXT PRIMARY KEY,
        mission_id TEXT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'LOW',
        required_approvals_json TEXT NOT NULL DEFAULT '[]',
        current_approvals_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        approved_at TEXT,
        fallback_action TEXT NOT NULL DEFAULT 'abort',
        context_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS api_governance_configs (
        mission_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        risk_threshold INTEGER,
        approvers_json TEXT NOT NULL DEFAULT '[]',
        timeout INTEGER,
        fallback_on_timeout TEXT NOT NULL DEFAULT 'abort'
      );

      CREATE INDEX IF NOT EXISTS idx_api_tasks_status ON api_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_api_tasks_client ON api_tasks(client_id);
      CREATE INDEX IF NOT EXISTS idx_api_tasks_agent ON api_tasks(agent_id);
      CREATE INDEX IF NOT EXISTS idx_api_artifacts_task ON api_artifacts(task_id);
      CREATE INDEX IF NOT EXISTS idx_api_ck_mission ON api_governance_checkpoints(mission_id);
      CREATE INDEX IF NOT EXISTS idx_api_ck_status ON api_governance_checkpoints(status);
    `);
  };

  const schemaPromise = manageSchema
    ? initSchema().catch((err) => {
        reportSilentFailure(err, 'apiStore:pg-schema');
        throw err;
      })
    : Promise.resolve();

  const rowToTask = (row: Record<string, unknown>): ApiTaskRow => ({
    id: String(row.id),
    client_id: String(row.client_id),
    agent_id: row.agent_id != null ? String(row.agent_id) : null,
    description: String(row.description),
    priority: String(row.priority),
    status: String(row.status),
    input_json: String(row.input_json),
    artifact_id: row.artifact_id != null ? String(row.artifact_id) : null,
    progress: Number(row.progress),
    error: row.error != null ? String(row.error) : null,
    messages_json: String(row.messages_json),
    created_at: String(row.created_at),
    started_at: row.started_at != null ? String(row.started_at) : null,
    completed_at: row.completed_at != null ? String(row.completed_at) : null,
    updated_at: String(row.updated_at),
  });

  const rowToArtifact = (row: Record<string, unknown>): ApiArtifactRow => ({
    id: String(row.id),
    task_id: String(row.task_id),
    content_type: String(row.content_type),
    content: String(row.content),
    url: row.url != null ? String(row.url) : null,
    metadata_json: String(row.metadata_json),
    created_at: String(row.created_at),
  });

  const rowToCheckpoint = (row: Record<string, unknown>): ApiCheckpointRow => ({
    id: String(row.id),
    mission_id: row.mission_id != null ? String(row.mission_id) : null,
    task_id: String(row.task_id),
    type: String(row.type),
    status: String(row.status),
    risk_score: Number(row.risk_score),
    risk_level: String(row.risk_level),
    required_approvals_json: String(row.required_approvals_json),
    current_approvals_json: String(row.current_approvals_json),
    created_at: String(row.created_at),
    expires_at: row.expires_at != null ? String(row.expires_at) : null,
    approved_at: row.approved_at != null ? String(row.approved_at) : null,
    fallback_action: String(row.fallback_action),
    context_json: String(row.context_json),
  });

  const rowToConfig = (row: Record<string, unknown>): ApiCheckpointConfigRow => ({
    mission_id: String(row.mission_id),
    mode: String(row.mode),
    risk_threshold: row.risk_threshold != null ? Number(row.risk_threshold) : null,
    approvers_json: String(row.approvers_json),
    timeout: row.timeout != null ? Number(row.timeout) : null,
    fallback_on_timeout: String(row.fallback_on_timeout),
  });

  const awaitSchema = async <T>(fn: () => Promise<T>): Promise<T> => {
    await schemaPromise;
    return fn();
  };

  const store: PostgresApiStore = {
    backend: 'postgres',
    connectionString,
    close: async () => {
      try {
        await pool.end();
      } catch (err) {
        reportSilentFailure(err, 'apiStore:pg-close');
      }
    },
    listTasksByStatus: (status: string) =>
      awaitSchema(() =>
        queryAll('SELECT * FROM api_tasks WHERE status = $1 ORDER BY created_at ASC', [
          status,
        ]).then((rows) => rows.map(rowToTask)),
      ),
    listTasksByClient: (clientId: string) =>
      awaitSchema(() =>
        queryAll('SELECT * FROM api_tasks WHERE client_id = $1 ORDER BY created_at ASC', [
          clientId,
        ]).then((rows) => rows.map(rowToTask)),
      ),
    listTasksByAgent: (agentId: string) =>
      awaitSchema(() =>
        queryAll('SELECT * FROM api_tasks WHERE agent_id = $1 ORDER BY created_at ASC', [
          agentId,
        ]).then((rows) => rows.map(rowToTask)),
      ),
    listAllTasks: () =>
      awaitSchema(() =>
        queryAll('SELECT * FROM api_tasks ORDER BY created_at ASC').then((rows) =>
          rows.map(rowToTask),
        ),
      ),
    getTask: (id: string) =>
      awaitSchema(() =>
        queryOne('SELECT * FROM api_tasks WHERE id = $1 LIMIT 1', [id]).then((row) =>
          row ? rowToTask(row) : null,
        ),
      ),
    putTask: (row: ApiTaskRow) =>
      awaitSchema(async () => {
        await exec(
          `INSERT INTO api_tasks
            (id, client_id, agent_id, description, priority, status, input_json, artifact_id, progress, error, messages_json, created_at, started_at, completed_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
           ON CONFLICT (id) DO UPDATE SET
             client_id = EXCLUDED.client_id,
             agent_id = EXCLUDED.agent_id,
             description = EXCLUDED.description,
             priority = EXCLUDED.priority,
             status = EXCLUDED.status,
             input_json = EXCLUDED.input_json,
             artifact_id = EXCLUDED.artifact_id,
             progress = EXCLUDED.progress,
             error = EXCLUDED.error,
             messages_json = EXCLUDED.messages_json,
             created_at = EXCLUDED.created_at,
             started_at = EXCLUDED.started_at,
             completed_at = EXCLUDED.completed_at,
             updated_at = EXCLUDED.updated_at`,
          [
            row.id,
            row.client_id,
            row.agent_id,
            row.description,
            row.priority,
            row.status,
            row.input_json,
            row.artifact_id,
            row.progress,
            row.error,
            row.messages_json,
            row.created_at,
            row.started_at,
            row.completed_at,
            row.updated_at,
          ],
        );
        return row;
      }),
    deleteTask: (id: string) =>
      awaitSchema(() => exec('DELETE FROM api_tasks WHERE id = $1', [id])),
    getArtifact: (id: string) =>
      awaitSchema(() =>
        queryOne('SELECT * FROM api_artifacts WHERE id = $1 LIMIT 1', [id]).then((row) =>
          row ? rowToArtifact(row) : null,
        ),
      ),
    putArtifact: (row: ApiArtifactRow) =>
      awaitSchema(async () => {
        await exec(
          `INSERT INTO api_artifacts (id, task_id, content_type, content, url, metadata_json, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE SET
             task_id = EXCLUDED.task_id,
             content_type = EXCLUDED.content_type,
             content = EXCLUDED.content,
             url = EXCLUDED.url,
             metadata_json = EXCLUDED.metadata_json,
             created_at = EXCLUDED.created_at`,
          [
            row.id,
            row.task_id,
            row.content_type,
            row.content,
            row.url,
            row.metadata_json,
            row.created_at,
          ],
        );
        return row;
      }),
    getArtifactsByTask: (taskId: string) =>
      awaitSchema(() =>
        queryAll('SELECT * FROM api_artifacts WHERE task_id = $1 ORDER BY created_at ASC', [
          taskId,
        ]).then((rows) => rows.map(rowToArtifact)),
      ),
    getCheckpoint: (id: string) =>
      awaitSchema(() =>
        queryOne('SELECT * FROM api_governance_checkpoints WHERE id = $1 LIMIT 1', [id]).then(
          (row) => (row ? rowToCheckpoint(row) : null),
        ),
      ),
    putCheckpoint: (row: ApiCheckpointRow) =>
      awaitSchema(async () => {
        await exec(
          `INSERT INTO api_governance_checkpoints
            (id, mission_id, task_id, type, status, risk_score, risk_level, required_approvals_json, current_approvals_json, created_at, expires_at, approved_at, fallback_action, context_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (id) DO UPDATE SET
             mission_id = EXCLUDED.mission_id,
             task_id = EXCLUDED.task_id,
             type = EXCLUDED.type,
             status = EXCLUDED.status,
             risk_score = EXCLUDED.risk_score,
             risk_level = EXCLUDED.risk_level,
             required_approvals_json = EXCLUDED.required_approvals_json,
             current_approvals_json = EXCLUDED.current_approvals_json,
             created_at = EXCLUDED.created_at,
             expires_at = EXCLUDED.expires_at,
             approved_at = EXCLUDED.approved_at,
             fallback_action = EXCLUDED.fallback_action,
             context_json = EXCLUDED.context_json`,
          [
            row.id,
            row.mission_id,
            row.task_id,
            row.type,
            row.status,
            row.risk_score,
            row.risk_level,
            row.required_approvals_json,
            row.current_approvals_json,
            row.created_at,
            row.expires_at,
            row.approved_at,
            row.fallback_action,
            row.context_json,
          ],
        );
        return row;
      }),
    listCheckpoints: (missionId?: string) =>
      awaitSchema(async () => {
        const rows = await queryAll(
          'SELECT * FROM api_governance_checkpoints ORDER BY created_at ASC',
        );
        if (!missionId) return rows.map(rowToCheckpoint);
        return rows.filter((c) => c.mission_id === missionId).map(rowToCheckpoint);
      }),
    getPendingCheckpointsForApprover: (approverId: string) =>
      awaitSchema(async () => {
        const rows = await queryAll(
          "SELECT * FROM api_governance_checkpoints WHERE status = 'pending' ORDER BY created_at ASC",
        );
        return rows.map(rowToCheckpoint).filter((c) => {
          try {
            const required = JSON.parse(c.required_approvals_json || '[]');
            return Array.isArray(required) && required.includes(approverId);
          } catch (err) {
            reportSilentFailure(err, 'apiStore:pg-approver');
            return false;
          }
        });
      }),
    getPendingCheckpointsByMission: (missionId: string) =>
      awaitSchema(() =>
        queryAll(
          "SELECT * FROM api_governance_checkpoints WHERE mission_id = $1 AND status = 'pending' ORDER BY created_at ASC",
          [missionId],
        ).then((rows) => rows.map(rowToCheckpoint)),
      ),
    approveCheckpoint: (
      checkpointId: string,
      reviewerId: string,
      reason?: string,
      conditions?: string[],
    ) =>
      awaitSchema(async () => {
        const row = await queryOne(
          'SELECT * FROM api_governance_checkpoints WHERE id = $1 LIMIT 1',
          [checkpointId],
        );
        if (!row) return null;
        const checkpoint = rowToCheckpoint(row);
        const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
        approvals.push({
          approved: true,
          reviewerId,
          reviewedAt: new Date().toISOString(),
          reason,
          conditions,
        });
        const required = JSON.parse(checkpoint.required_approvals_json || '[]');
        checkpoint.current_approvals_json = JSON.stringify(approvals);
        if (approvals.length >= required.length) {
          checkpoint.status = 'approved';
          checkpoint.approved_at = new Date().toISOString();
        }
        await store.putCheckpoint(checkpoint);
        return checkpoint;
      }),
    rejectCheckpoint: (checkpointId: string, reviewerId: string, reason: string) =>
      awaitSchema(async () => {
        const row = await queryOne(
          'SELECT * FROM api_governance_checkpoints WHERE id = $1 LIMIT 1',
          [checkpointId],
        );
        if (!row) return null;
        const checkpoint = rowToCheckpoint(row);
        const approvals = JSON.parse(checkpoint.current_approvals_json || '[]');
        approvals.push({
          approved: false,
          reviewerId,
          reviewedAt: new Date().toISOString(),
          reason,
        });
        checkpoint.current_approvals_json = JSON.stringify(approvals);
        checkpoint.status = 'rejected';
        await store.putCheckpoint(checkpoint);
        return checkpoint;
      }),
    expireCheckpoints: (now: Date) =>
      awaitSchema(async () => {
        const expired: ApiCheckpointRow[] = [];
        const rows = await queryAll(
          "SELECT * FROM api_governance_checkpoints WHERE status = 'pending' AND expires_at IS NOT NULL",
        );
        for (const row of rows) {
          const checkpoint = rowToCheckpoint(row);
          if (new Date(checkpoint.expires_at!) < now) {
            checkpoint.status = checkpoint.fallback_action === 'proceed' ? 'approved' : 'expired';
            if (checkpoint.status === 'approved') checkpoint.approved_at = new Date().toISOString();
            await store.putCheckpoint(checkpoint);
            expired.push(checkpoint);
          }
        }
        return expired;
      }),
    addCheckpointEvidence: (
      checkpointId: string,
      evidence: { type: string; timestamp: string; content: string; source: string },
    ) =>
      awaitSchema(async () => {
        const row = await queryOne(
          'SELECT * FROM api_governance_checkpoints WHERE id = $1 LIMIT 1',
          [checkpointId],
        );
        if (!row) return null;
        const checkpoint = rowToCheckpoint(row);
        const context = JSON.parse(checkpoint.context_json || '{}');
        context.evidence = context.evidence || [];
        context.evidence.push(evidence);
        checkpoint.context_json = JSON.stringify(context);
        await store.putCheckpoint(checkpoint);
        return checkpoint;
      }),
    getCheckpointConfig: (missionId: string) =>
      awaitSchema(() =>
        queryOne('SELECT * FROM api_governance_configs WHERE mission_id = $1 LIMIT 1', [
          missionId,
        ]).then((row) => (row ? rowToConfig(row) : null)),
      ),
    putCheckpointConfig: (row: ApiCheckpointConfigRow) =>
      awaitSchema(async () => {
        await exec(
          `INSERT INTO api_governance_configs (mission_id, mode, risk_threshold, approvers_json, timeout, fallback_on_timeout)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (mission_id) DO UPDATE SET
             mode = EXCLUDED.mode,
             risk_threshold = EXCLUDED.risk_threshold,
             approvers_json = EXCLUDED.approvers_json,
             timeout = EXCLUDED.timeout,
             fallback_on_timeout = EXCLUDED.fallback_on_timeout`,
          [
            row.mission_id,
            row.mode,
            row.risk_threshold,
            row.approvers_json,
            row.timeout,
            row.fallback_on_timeout,
          ],
        );
        return row;
      }),
    getCheckpointStats: (missionId?: string) =>
      awaitSchema(async () => {
        if (!missionId) {
          return statsFromRows([]);
        }
        const mission = checkpointsForMission(missionId);
        const rows =
          mission.status === 'not_implemented'
            ? (await queryAll('SELECT * FROM api_governance_checkpoints')).map(rowToCheckpoint)
            : mission.checkpoints;
        return statsFromRows(rows);
      }),
    cleanup: () =>
      awaitSchema(async () => {
        await exec('DELETE FROM api_tasks');
        await exec('DELETE FROM api_artifacts');
        await exec('DELETE FROM api_governance_checkpoints');
        await exec('DELETE FROM api_governance_configs');
      }),
  };

  return store;
}

export function createApiStore(options?: {
  backend?: ApiStoreBackend;
  dbPath?: string;
  connectionString?: string;
  forceMemory?: boolean;
  manageSchema?: boolean;
}): ApiStore {
  const backend =
    options?.backend ??
    (process.env.API_STORE_BACKEND as ApiStoreBackend) ??
    (process.env.DATABASE_URL ? 'postgres' : 'sqlite');
  const dbPath = options?.dbPath ?? DEFAULT_DB_PATH;

  if (options?.forceMemory || backend === 'memory') {
    return createMemoryApiStore(dbPath);
  }

  if (backend === 'postgres') {
    const connectionString = options?.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('PostgreSQL backend requires DATABASE_URL or options.connectionString');
    }
    return createPostgresApiStore(
      connectionString,
      options?.manageSchema ?? process.env.NODE_ENV !== 'production',
    );
  }

  try {
    return createSqliteApiStore(dbPath);
  } catch (err) {
    reportSilentFailure(err, 'apiStore:sqlite-fallback');
    console.warn(
      '[apiStore] SQLite backend failed (likely missing better-sqlite3 native bindings). Falling back to in-memory store. Set API_STORE_BACKEND=memory to silence this warning.',
    );
    return createMemoryApiStore(dbPath);
  }
}

function checkpointsForMission(missionId: string): MissionCheckpoints {
  return {
    missionId,
    checkpoints: [],
    status: 'not_implemented',
    note: 'Direct SQLite checkpoint aggregation is not yet implemented',
  };
}

function statsFromRows(rows: ApiCheckpointRow[]) {
  const approved = rows.filter((c) => c.status === 'approved').length;
  const approvalTimes = rows
    .filter((c) => c.status === 'approved' && c.approved_at)
    .map((c) => new Date(c.approved_at!).getTime() - new Date(c.created_at).getTime());
  const averageApprovalTime =
    approvalTimes.length === 0
      ? null
      : approvalTimes.reduce((a, b) => a + b, 0) / approvalTimes.length;
  return {
    total: rows.length,
    pending: rows.filter((c) => c.status === 'pending').length,
    approved,
    rejected: rows.filter((c) => c.status === 'rejected').length,
    expired: rows.filter((c) => c.status === 'expired').length,
    mandatoryCount: rows.filter((c) => c.type === 'mandatory').length,
    conditionalCount: rows.filter((c) => c.type === 'conditional').length,
    automaticCount: rows.filter((c) => c.type === 'automatic').length,
    averageApprovalTime,
  };
}
