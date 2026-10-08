import { reportSilentFailure } from '@praetor/core';
import fs from 'fs';
import path from 'path';
import { createApiStore } from './stores';
import type { ApiStore } from './stores/apiStore';
import { atomicWriteFileSync, readJsonFileSafe } from './atomicWrite';
import { getDirname, getRequire } from './esmCompat';
const __dirname = getDirname(import.meta.url);
const require = getRequire(import.meta.url);

import {
  Agent,
  ExecutionLog,
  Mission,
  MissionPriority,
  MissionStatus,
  MissionRiskLevel,
  MissionGovernanceMode,
  WarRoomData,
  createSeedWarRoomData,
  getProjectWarRoomSnapshot,
} from '@praetor/core';

/** Override `COMMANDER_WARROOM_FILE` to relocate the JSON-backed war-room store. Default keeps the original `__dirname/../data/war-room.json` path so production runs are untouched. Env var MUST be set before this module is required (module-load capture). */
const DATA_FILE =
  process.env['COMMANDER_WARROOM_FILE'] ?? path.resolve(__dirname, '../data/war-room.json');

/** Override `COMMANDER_SQLITE_WARROOM_FILE` to relocate the SQLite-backed war-room store (used when `WARROOM_STORAGE=sqlite`). Default keeps the original `__dirname/../data/war-room.sqlite` path so production runs are untouched. Env var MUST be set before this module is required (module-load capture). */
const SQLITE_DATA_FILE =
  process.env['COMMANDER_SQLITE_WARROOM_FILE'] ??
  path.resolve(__dirname, '../data/war-room.sqlite');

interface CreateMissionInput {
  projectId: string;
  title: string;
  objective: string;
  assignedAgentId: string;
  priority: MissionPriority;
  riskLevel?: MissionRiskLevel;
  governanceMode?: MissionGovernanceMode;
}

interface UpdateMissionInput {
  title?: string;
  objective?: string;
  assignedAgentId?: string;
  priority?: MissionPriority;
  status?: MissionStatus;
  riskLevel?: MissionRiskLevel;
  governanceMode?: MissionGovernanceMode;
}

interface CreateLogInput {
  missionId: string;
  level: ExecutionLog['level'];
  message: string;
}

export interface GovernanceStats {
  totalMissions: number;
  highRiskMissions: number;
  manualGovernanceMissions: number;
  pendingApprovalMissions: number;
  completionRate: number;
  manualApprovalRate: number;
}

// ---------------------------------------------------------------------------
// Common interface shared by JSON and SQLite stores
// ---------------------------------------------------------------------------

export interface IWarRoomStore {
  listProjects(): WarRoomData['projects'];
  getGovernanceStats(projectId: string): GovernanceStats;
  getPendingApprovals(projectId: string): Mission[];
  getProjectSnapshot(projectId: string): ReturnType<typeof getProjectWarRoomSnapshot>;
  listAgents(projectId: string): Agent[];
  createMission(input: CreateMissionInput): Mission;
  updateMission(
    missionId: string,
    input: UpdateMissionInput,
    options?: { bypassGovernance?: boolean },
  ): Mission;
  createLog(input: CreateLogInput): ExecutionLog;
  /** Release resources (e.g., close database connections). No-op for JSON store. */
  close(): void;
}

// ---------------------------------------------------------------------------
// JSON file-based store (original, unchanged behaviour)
// ---------------------------------------------------------------------------

export class WarRoomStore implements IWarRoomStore {
  private data: WarRoomData;

  constructor(private readonly filePath = DATA_FILE) {
    this.data = this.load();
  }

  listProjects() {
    return [...this.data.projects];
  }

  /**
   * 获取治理统计数据 (Governance Observer v1)
   */
  getGovernanceStats(projectId: string): GovernanceStats {
    const missions = this.data.missions.filter((m) => m.projectId === projectId);
    const total = missions.length;
    const highRisk = missions.filter(
      (m) => m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL',
    ).length;
    const manualGovernance = missions.filter((m) => m.governanceMode === 'MANUAL').length;
    const pendingApproval = missions.filter(
      (m) =>
        m.governanceMode === 'MANUAL' &&
        (m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL') &&
        m.status !== 'DONE',
    ).length;
    const completed = missions.filter((m) => m.status === 'DONE').length;
    const manualApprovalRate = total > 0 ? (manualGovernance / total) * 100 : 0;

    return {
      totalMissions: total,
      highRiskMissions: highRisk,
      manualGovernanceMissions: manualGovernance,
      pendingApprovalMissions: pendingApproval,
      completionRate: total > 0 ? (completed / total) * 100 : 0,
      manualApprovalRate,
    };
  }

  /**
   * 获取需要审批的任务列表
   */
  getPendingApprovals(projectId: string): Mission[] {
    return this.data.missions.filter(
      (m) =>
        m.projectId === projectId &&
        m.governanceMode === 'MANUAL' &&
        (m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL') &&
        m.status !== 'DONE',
    );
  }

  getProjectSnapshot(projectId: string) {
    return getProjectWarRoomSnapshot(this.data, projectId);
  }

  listAgents(projectId: string): Agent[] {
    return this.data.agents.filter((agent) => agent.projectId === projectId);
  }

  createMission(input: CreateMissionInput): Mission {
    const project = this.data.projects.find((item) => item.id === input.projectId);
    if (!project) {
      throw new Error('PROJECT_NOT_FOUND');
    }

    const agent = this.assertProjectAgent(input.projectId, input.assignedAgentId);
    const now = new Date().toISOString();

    const riskLevel = input.riskLevel ?? getDefaultRiskLevel(input.priority);
    const governanceMode =
      input.governanceMode ?? getDefaultGovernanceMode(riskLevel, input.priority);

    const mission: Mission = {
      id: this.nextId('mission'),
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      status: 'PLANNED',
      priority: input.priority,
      riskLevel,
      governanceMode,
      assignedAgentId: agent.id,
      createdAt: now,
      updatedAt: now,
    };

    this.data.missions.push(mission);
    project.updatedAt = now;

    this.data.logs.push({
      id: this.nextId('log'),
      projectId: input.projectId,
      missionId: mission.id,
      agentId: agent.id,
      level: 'INFO',
      message: `Mission created and assigned to ${agent.name}.`,
      createdAt: now,
    });

    this.persist();
    return mission;
  }

  updateMission(
    missionId: string,
    input: UpdateMissionInput,
    options?: { bypassGovernance?: boolean },
  ): Mission {
    const mission = this.data.missions.find((item) => item.id === missionId);
    if (!mission) {
      throw new Error('MISSION_NOT_FOUND');
    }

    const bypassGovernance = options?.bypassGovernance ?? false;

    if (input.assignedAgentId) {
      this.assertProjectAgent(mission.projectId, input.assignedAgentId);
      mission.assignedAgentId = input.assignedAgentId;
    }

    if (typeof input.title === 'string') {
      mission.title = input.title;
    }

    if (typeof input.objective === 'string') {
      mission.objective = input.objective;
    }

    if (input.priority) {
      mission.priority = input.priority;
    }

    if (input.riskLevel) {
      mission.riskLevel = input.riskLevel;
    }

    if (input.governanceMode) {
      mission.governanceMode = input.governanceMode;
    }

    const previousStatus = mission.status;
    if (input.status) {
      // 对 MANUAL 治理模式下的高风险任务，普通状态变更不允许直接标记为 DONE，需显式审批
      const isHighRisk = mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
      if (
        !bypassGovernance &&
        input.status === 'DONE' &&
        mission.governanceMode === 'MANUAL' &&
        isHighRisk
      ) {
        throw new Error('MISSION_REQUIRES_APPROVAL');
      }

      mission.status = input.status;
    }

    const now = new Date().toISOString();
    mission.updatedAt = now;

    if (mission.status === 'RUNNING' && !mission.startedAt) {
      mission.startedAt = now;
    }

    if (mission.status === 'DONE' && previousStatus !== 'DONE') {
      mission.completedAt = now;
    } else if (mission.status !== 'DONE' && previousStatus === 'DONE') {
      delete mission.completedAt;
    }

    const project = this.data.projects.find((item) => item.id === mission.projectId);
    if (project) {
      project.updatedAt = now;
    }

    if (input.status && input.status !== previousStatus) {
      this.data.logs.push({
        id: this.nextId('log'),
        projectId: mission.projectId,
        missionId: mission.id,
        agentId: mission.assignedAgentId,
        level: input.status === 'BLOCKED' ? 'WARN' : input.status === 'DONE' ? 'SUCCESS' : 'INFO',
        message: `Mission status changed from ${previousStatus} to ${input.status}.`,
        createdAt: now,
      });
    }

    this.persist();
    return mission;
  }

  createLog(input: CreateLogInput): ExecutionLog {
    const mission = this.data.missions.find((item) => item.id === input.missionId);
    if (!mission) {
      throw new Error('MISSION_NOT_FOUND');
    }

    const now = new Date().toISOString();
    const log: ExecutionLog = {
      id: this.nextId('log'),
      projectId: mission.projectId,
      missionId: mission.id,
      agentId: mission.assignedAgentId,
      level: input.level,
      message: input.message,
      createdAt: now,
    };

    mission.updatedAt = now;
    const agent = this.data.agents.find((item) => item.id === mission.assignedAgentId);
    if (agent) {
      agent.lastHeartbeatAt = now;
    }

    const project = this.data.projects.find((item) => item.id === mission.projectId);
    if (project) {
      project.updatedAt = now;
    }

    this.data.logs.push(log);
    this.persist();
    return log;
  }

  private assertProjectAgent(projectId: string, agentId: string): Agent {
    const agent = this.data.agents.find((item) => {
      return item.projectId === projectId && item.id === agentId;
    });

    if (!agent) {
      throw new Error('AGENT_NOT_FOUND');
    }

    return agent;
  }

  private load(): WarRoomData {
    if (!fs.existsSync(this.filePath)) {
      const seed = createSeedWarRoomData();
      const normalizedSeed = normalizeWarRoomData(seed);
      this.write(normalizedSeed);
      return normalizedSeed;
    }

    // REL-3: a corrupt war-room file must not throw from load() — that crash-loops
    // the boot path. readJsonFileSafe quarantines the corrupt file and returns the
    // seed so we reseed instead of dying.
    const parsed = readJsonFileSafe<WarRoomData>(this.filePath, createSeedWarRoomData());
    const normalized = normalizeWarRoomData(parsed);

    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      this.write(normalized);
    }

    return normalized;
  }

  private persist() {
    this.write(this.data);
  }

  private write(data: WarRoomData) {
    // REL-3: atomic write so a crash mid-write cannot truncate the war-room file
    // (a truncated file makes the next load() throw and crash-loops boot).
    atomicWriteFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  private nextId(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** No-op for JSON file store — nothing to close. */
  close(): void {}
}

// ---------------------------------------------------------------------------
// SQLite-backed store (opt-in via WARROOM_STORAGE=sqlite)
// ---------------------------------------------------------------------------

/**
 * better-sqlite3 Database type. We declare a structural type here so the
 * module compiles even when better-sqlite3 is not installed (it is an
 * optional peer dependency for the SQLite backend only).
 */
interface BetterSqlite3Database {
  exec(sql: string): BetterSqlite3Database;
  prepare(sql: string): BetterSqlite3Statement;
  pragma(pragma: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export class SqliteWarRoomStore implements IWarRoomStore {
  private readonly db: BetterSqlite3Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? SQLITE_DATA_FILE;

    // Dynamically require better-sqlite3 so the dependency is optional for
    // users who only need the JSON store.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    let Database: new (filename: string) => BetterSqlite3Database;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Database = require('better-sqlite3');
    } catch (err) {
      reportSilentFailure(err, 'store:394');
      throw new Error(
        'SqliteWarRoomStore requires the "better-sqlite3" package. ' +
          'Install it with: npm install better-sqlite3',
      );
    }

    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new Database(resolvedPath);

    // Enable WAL mode for better concurrent read performance
    this.db.exec('PRAGMA journal_mode = WAL');
    // Enable foreign keys
    this.db.exec('PRAGMA foreign_keys = ON');

    this.createTables();
    this.seedIfEmpty();
  }

  // -- Schema ---------------------------------------------------------------

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        codename    TEXT NOT NULL,
        objective   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        name              TEXT NOT NULL,
        callsign          TEXT NOT NULL,
        role              TEXT NOT NULL,
        model             TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'READY',
        specialty         TEXT NOT NULL,
        governance_role   TEXT NOT NULL DEFAULT 'EXECUTOR',
        last_heartbeat_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS missions (
        id                TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        title             TEXT NOT NULL,
        objective         TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'PLANNED',
        priority          TEXT NOT NULL DEFAULT 'MEDIUM',
        risk_level        TEXT NOT NULL DEFAULT 'MEDIUM',
        governance_mode   TEXT NOT NULL DEFAULT 'AUTO',
        assigned_agent_id TEXT NOT NULL,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL,
        started_at        TEXT,
        completed_at      TEXT,
        FOREIGN KEY (project_id)        REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_agent_id) REFERENCES agents(id)
      );

      CREATE TABLE IF NOT EXISTS execution_logs (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL,
        mission_id  TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        level       TEXT NOT NULL DEFAULT 'INFO',
        message     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id)   REFERENCES agents(id)
      );

      -- Indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_agents_project_id       ON agents(project_id);
      CREATE INDEX IF NOT EXISTS idx_missions_project_id     ON missions(project_id);
      CREATE INDEX IF NOT EXISTS idx_missions_agent_id       ON missions(assigned_agent_id);
      CREATE INDEX IF NOT EXISTS idx_missions_status         ON missions(status);
      CREATE INDEX IF NOT EXISTS idx_missions_governance     ON missions(governance_mode, risk_level, status);
      CREATE INDEX IF NOT EXISTS idx_logs_project_id         ON execution_logs(project_id);
      CREATE INDEX IF NOT EXISTS idx_logs_mission_id         ON execution_logs(mission_id);
      CREATE INDEX IF NOT EXISTS idx_logs_agent_id           ON execution_logs(agent_id);
      CREATE INDEX IF NOT EXISTS idx_logs_created_at         ON execution_logs(created_at);
    `);
  }

  // -- Seed data ------------------------------------------------------------

  private seedIfEmpty(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM projects').get() as { cnt: number };
    if (row.cnt > 0) {
      return;
    }

    const seed = normalizeWarRoomData(createSeedWarRoomData());
    const insertProject = this.db.prepare(
      `INSERT INTO projects (id, name, codename, objective, status, created_at, updated_at)
       VALUES (@id, @name, @codename, @objective, @status, @createdAt, @updatedAt)`,
    );
    const insertAgent = this.db.prepare(
      `INSERT INTO agents (id, project_id, name, callsign, role, model, status, specialty, governance_role, last_heartbeat_at)
       VALUES (@id, @projectId, @name, @callsign, @role, @model, @status, @specialty, @governanceRole, @lastHeartbeatAt)`,
    );
    const insertMission = this.db.prepare(
      `INSERT INTO missions (id, project_id, title, objective, status, priority, risk_level, governance_mode, assigned_agent_id, created_at, updated_at, started_at, completed_at)
       VALUES (@id, @projectId, @title, @objective, @status, @priority, @riskLevel, @governanceMode, @assignedAgentId, @createdAt, @updatedAt, @startedAt, @completedAt)`,
    );
    const insertLog = this.db.prepare(
      `INSERT INTO execution_logs (id, project_id, mission_id, agent_id, level, message, created_at)
       VALUES (@id, @projectId, @missionId, @agentId, @level, @message, @createdAt)`,
    );

    this.db.exec('BEGIN');
    try {
      for (const p of seed.projects) {
        insertProject.run(p);
      }
      for (const a of seed.agents) {
        insertAgent.run(a);
      }
      for (const m of seed.missions) {
        insertMission.run({
          ...m,
          startedAt: m.startedAt ?? null,
          completedAt: m.completedAt ?? null,
        });
      }
      for (const l of seed.logs) {
        insertLog.run(l);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // -- Public interface -----------------------------------------------------

  listProjects(): WarRoomData['projects'] {
    const rows = this.db.prepare('SELECT * FROM projects').all();
    return rows.map(rowToProject);
  }

  getGovernanceStats(projectId: string): GovernanceStats {
    const missions = this.getMissionsByProject(projectId);
    const total = missions.length;
    const highRisk = missions.filter(
      (m) => m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL',
    ).length;
    const manualGovernance = missions.filter((m) => m.governanceMode === 'MANUAL').length;
    const pendingApproval = missions.filter(
      (m) =>
        m.governanceMode === 'MANUAL' &&
        (m.riskLevel === 'HIGH' || m.riskLevel === 'CRITICAL') &&
        m.status !== 'DONE',
    ).length;
    const completed = missions.filter((m) => m.status === 'DONE').length;
    const manualApprovalRate = total > 0 ? (manualGovernance / total) * 100 : 0;

    return {
      totalMissions: total,
      highRiskMissions: highRisk,
      manualGovernanceMissions: manualGovernance,
      pendingApprovalMissions: pendingApproval,
      completionRate: total > 0 ? (completed / total) * 100 : 0,
      manualApprovalRate,
    };
  }

  getPendingApprovals(projectId: string): Mission[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM missions
       WHERE project_id = ?
         AND governance_mode = 'MANUAL'
         AND risk_level IN ('HIGH', 'CRITICAL')
         AND status != 'DONE'`,
      )
      .all(projectId);
    return rows.map(rowToMission);
  }

  getProjectSnapshot(projectId: string): ReturnType<typeof getProjectWarRoomSnapshot> {
    const data = this.toWarRoomDataForProject(projectId);
    return getProjectWarRoomSnapshot(data, projectId);
  }

  listAgents(projectId: string): Agent[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE project_id = ?').all(projectId);
    return rows.map(rowToAgent);
  }

  createMission(input: CreateMissionInput): Mission {
    const project = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(input.projectId);
    if (!project) {
      throw new Error('PROJECT_NOT_FOUND');
    }

    const agent = this.assertProjectAgent(input.projectId, input.assignedAgentId);
    const now = new Date().toISOString();

    const riskLevel = input.riskLevel ?? getDefaultRiskLevel(input.priority);
    const governanceMode =
      input.governanceMode ?? getDefaultGovernanceMode(riskLevel, input.priority);

    const missionId = nextId('mission');
    const mission: Mission = {
      id: missionId,
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      status: 'PLANNED',
      priority: input.priority,
      riskLevel,
      governanceMode,
      assignedAgentId: agent.id,
      createdAt: now,
      updatedAt: now,
    };

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO missions (id, project_id, title, objective, status, priority, risk_level, governance_mode, assigned_agent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          mission.id,
          mission.projectId,
          mission.title,
          mission.objective,
          mission.status,
          mission.priority,
          mission.riskLevel,
          mission.governanceMode,
          mission.assignedAgentId,
          mission.createdAt,
          mission.updatedAt,
        );

      this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, input.projectId);

      this.db
        .prepare(
          `INSERT INTO execution_logs (id, project_id, mission_id, agent_id, level, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nextId('log'),
          input.projectId,
          mission.id,
          agent.id,
          'INFO',
          `Mission created and assigned to ${agent.name}.`,
          now,
        );

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return mission;
  }

  updateMission(
    missionId: string,
    input: UpdateMissionInput,
    options?: { bypassGovernance?: boolean },
  ): Mission {
    const row = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId);
    if (!row) {
      throw new Error('MISSION_NOT_FOUND');
    }

    const mission = rowToMission(row);
    const bypassGovernance = options?.bypassGovernance ?? false;

    if (input.assignedAgentId) {
      this.assertProjectAgent(mission.projectId, input.assignedAgentId);
      mission.assignedAgentId = input.assignedAgentId;
    }

    if (typeof input.title === 'string') {
      mission.title = input.title;
    }

    if (typeof input.objective === 'string') {
      mission.objective = input.objective;
    }

    if (input.priority) {
      mission.priority = input.priority;
    }

    if (input.riskLevel) {
      mission.riskLevel = input.riskLevel;
    }

    if (input.governanceMode) {
      mission.governanceMode = input.governanceMode;
    }

    const previousStatus = mission.status;
    if (input.status) {
      const isHighRisk = mission.riskLevel === 'HIGH' || mission.riskLevel === 'CRITICAL';
      if (
        !bypassGovernance &&
        input.status === 'DONE' &&
        mission.governanceMode === 'MANUAL' &&
        isHighRisk
      ) {
        throw new Error('MISSION_REQUIRES_APPROVAL');
      }

      mission.status = input.status;
    }

    const now = new Date().toISOString();
    mission.updatedAt = now;

    if (mission.status === 'RUNNING' && !mission.startedAt) {
      mission.startedAt = now;
    }

    if (mission.status === 'DONE' && previousStatus !== 'DONE') {
      mission.completedAt = now;
    } else if (mission.status !== 'DONE' && previousStatus === 'DONE') {
      mission.completedAt = undefined;
    }

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `UPDATE missions SET
           title = ?, objective = ?, status = ?, priority = ?,
           risk_level = ?, governance_mode = ?, assigned_agent_id = ?,
           updated_at = ?, started_at = ?, completed_at = ?
         WHERE id = ?`,
        )
        .run(
          mission.title,
          mission.objective,
          mission.status,
          mission.priority,
          mission.riskLevel,
          mission.governanceMode,
          mission.assignedAgentId,
          mission.updatedAt,
          mission.startedAt ?? null,
          mission.completedAt ?? null,
          mission.id,
        );

      this.db
        .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
        .run(now, mission.projectId);

      if (input.status && input.status !== previousStatus) {
        const logLevel =
          input.status === 'BLOCKED' ? 'WARN' : input.status === 'DONE' ? 'SUCCESS' : 'INFO';
        this.db
          .prepare(
            `INSERT INTO execution_logs (id, project_id, mission_id, agent_id, level, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            nextId('log'),
            mission.projectId,
            mission.id,
            mission.assignedAgentId,
            logLevel,
            `Mission status changed from ${previousStatus} to ${input.status}.`,
            now,
          );
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return mission;
  }

  createLog(input: CreateLogInput): ExecutionLog {
    const missionRow = this.db.prepare('SELECT * FROM missions WHERE id = ?').get(input.missionId);
    if (!missionRow) {
      throw new Error('MISSION_NOT_FOUND');
    }

    const mission = rowToMission(missionRow);
    const now = new Date().toISOString();
    const logId = nextId('log');
    const log: ExecutionLog = {
      id: logId,
      projectId: mission.projectId,
      missionId: mission.id,
      agentId: mission.assignedAgentId,
      level: input.level,
      message: input.message,
      createdAt: now,
    };

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO execution_logs (id, project_id, mission_id, agent_id, level, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          log.id,
          log.projectId,
          log.missionId,
          log.agentId,
          log.level,
          log.message,
          log.createdAt,
        );

      this.db.prepare('UPDATE missions SET updated_at = ? WHERE id = ?').run(now, mission.id);

      this.db
        .prepare('UPDATE agents SET last_heartbeat_at = ? WHERE id = ?')
        .run(now, mission.assignedAgentId);

      this.db
        .prepare('UPDATE projects SET updated_at = ? WHERE id = ?')
        .run(now, mission.projectId);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return log;
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }

  // -- Private helpers ------------------------------------------------------

  private assertProjectAgent(projectId: string, agentId: string): Agent {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE project_id = ? AND id = ?')
      .get(projectId, agentId);

    if (!row) {
      throw new Error('AGENT_NOT_FOUND');
    }

    return rowToAgent(row);
  }

  private getMissionsByProject(projectId: string): Mission[] {
    const rows = this.db.prepare('SELECT * FROM missions WHERE project_id = ?').all(projectId);
    return rows.map(rowToMission);
  }

  /**
   * Materialise a WarRoomData snapshot scoped to a single project so that the
   * existing `getProjectWarRoomSnapshot` helper from @praetor/core can be
   * reused without modification.
   */
  private toWarRoomDataForProject(projectId: string): WarRoomData {
    const projectRow = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    const project = projectRow ? [rowToProject(projectRow)] : [];
    const agents = this.listAgents(projectId);
    const missions = this.getMissionsByProject(projectId);
    const logRows = this.db
      .prepare('SELECT * FROM execution_logs WHERE project_id = ?')
      .all(projectId);
    const logs = logRows.map(rowToExecutionLog);

    return { projects: project, agents, missions, logs };
  }
}

// ---------------------------------------------------------------------------
// Row-to-model mappers
// ---------------------------------------------------------------------------

function rowToProject(row: Record<string, unknown>): WarRoomData['projects'][number] {
  return {
    id: String(row.id),
    name: String(row.name),
    codename: String(row.codename),
    objective: String(row.objective),
    status: String(row.status) as WarRoomData['projects'][number]['status'],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToAgent(row: Record<string, unknown>): Agent {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    name: String(row.name),
    callsign: String(row.callsign),
    role: String(row.role),
    model: String(row.model),
    status: String(row.status) as Agent['status'],
    specialty: String(row.specialty),
    governanceRole: String(row.governance_role) as Agent['governanceRole'],
    lastHeartbeatAt: String(row.last_heartbeat_at),
  };
}

function rowToMission(row: Record<string, unknown>): Mission {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    objective: String(row.objective),
    status: String(row.status) as MissionStatus,
    priority: String(row.priority) as MissionPriority,
    riskLevel: String(row.risk_level) as MissionRiskLevel,
    governanceMode: String(row.governance_mode) as MissionGovernanceMode,
    assignedAgentId: String(row.assigned_agent_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at != null ? String(row.started_at) : undefined,
    completedAt: row.completed_at != null ? String(row.completed_at) : undefined,
  };
}

function rowToExecutionLog(row: Record<string, unknown>): ExecutionLog {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    missionId: String(row.mission_id),
    agentId: String(row.agent_id),
    level: String(row.level) as ExecutionLog['level'],
    message: String(row.message),
    createdAt: String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getDefaultRiskLevel(priority: MissionPriority): MissionRiskLevel {
  switch (priority) {
    case 'CRITICAL':
    case 'HIGH':
      return 'HIGH';
    case 'MEDIUM':
      return 'MEDIUM';
    case 'LOW':
    default:
      return 'LOW';
  }
}

function getDefaultGovernanceMode(
  riskLevel: MissionRiskLevel,
  priority: MissionPriority,
): MissionGovernanceMode {
  if (riskLevel === 'HIGH' || priority === 'CRITICAL') {
    return 'MANUAL';
  }

  if (riskLevel === 'MEDIUM') {
    return 'GUARDED';
  }

  return 'AUTO';
}

function normalizeWarRoomData(data: WarRoomData): WarRoomData {
  return {
    ...data,
    agents: data.agents.map((agent) => ({
      ...agent,
      governanceRole:
        agent.governanceRole ??
        (agent.id === 'agent-builder'
          ? 'EXECUTOR'
          : agent.id === 'agent-scout' || agent.id === 'agent-sentinel'
            ? 'SENATE'
            : 'EXECUTOR'),
    })),
    missions: data.missions.map((mission) => {
      const priority = mission.priority ?? 'MEDIUM';
      const riskLevel = mission.riskLevel ?? getDefaultRiskLevel(priority);
      const governanceMode =
        mission.governanceMode ?? getDefaultGovernanceMode(riskLevel, priority);
      return {
        ...mission,
        priority,
        riskLevel,
        governanceMode,
      };
    }),
  };
}

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Factory: create the right store based on environment
// ---------------------------------------------------------------------------

/**
 * Create a WarRoomStore backed by JSON files or SQLite depending on the
 * `WARROOM_STORAGE` environment variable.
 *
 * WarRoomStore is the missions/UI store only — not the /v1 durable run authority
 * (that is the shared kernel via POST/GET /v1/runs*).
 *
 * - `WARROOM_STORAGE=sqlite` -- uses SqliteWarRoomStore (requires better-sqlite3)
 * - anything else (default)  -- uses the original JSON file-based WarRoomStore
 */
export function createWarRoomStore(): IWarRoomStore {
  const backend = (process.env['WARROOM_STORAGE'] ?? '').toLowerCase();

  if (backend === 'sqlite') {
    return new SqliteWarRoomStore();
  }

  return new WarRoomStore();
}

// ---------------------------------------------------------------------------
// Shared A2A API store (wired when API_STORE_BACKEND=postgres)
// ---------------------------------------------------------------------------

/** Global ApiStore instance selected by API_STORE_BACKEND / DATABASE_URL. */
export const apiStore: ApiStore = createApiStore();
