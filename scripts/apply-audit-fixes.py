#!/usr/bin/env python3
"""Apply the audit fixes: SQLite persistence, sandbox hard-fail, public API, clean demos."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import stat

ROOT = pathlib.Path(__file__).resolve().parent.parent

# ============================================================================
# Helpers
# ============================================================================

def read(p: pathlib.Path) -> str:
    return p.read_text()

def write(p: pathlib.Path, data: str) -> None:
    p.write_text(data)

def patch(p: pathlib.Path, old: str, new: str) -> None:
    data = read(p)
    if old not in data:
        raise SystemExit(f"pattern not found in {p}")
    write(p, data.replace(old, new, 1))

def patch_all(p: pathlib.Path, old: str, new: str) -> None:
    data = read(p)
    if old not in data:
        raise SystemExit(f"pattern not found in {p}")
    write(p, data.replace(old, new))

# ============================================================================
# T2: SQLite persistence for API layer
# ============================================================================

print("=== T2: SQLite persistence ===")

# --------------------------------------------------------------------------
# apps/api/src/a2aTask.ts
# --------------------------------------------------------------------------
a2a_task = read(ROOT / "apps/api/src/a2aTask.ts")

# Add SQLite bootstrap after uuid import
a2a_task = a2a_task.replace(
    '''import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================''',
    '''import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// SQLite bootstrap
// ============================================================================

let BetterSqlite3: { new (filePath: string): BetterSqlite3DB } | null = null;
try {
  BetterSqlite3 = require('better-sqlite3');
} catch {
  /* not installed — will fall back to in-memory Map */
}

interface BetterSqlite3Stmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}
interface BetterSqlite3DB {
  prepare(sql: string): BetterSqlite3Stmt;
  pragma(sql: string): void;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

function openTaskDb(filePath: string): BetterSqlite3DB | null {
  if (!BetterSqlite3) return null;
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = new BetterSqlite3(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

function openArtifactDb(filePath: string): BetterSqlite3DB | null {
  if (!BetterSqlite3) return null;
  const dir = path.dirname(filePath);
  if (dir) fs.mkdirSync(dir, { recursive: true });
  const db = new BetterSqlite3(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  return db;
}

const DEFAULT_TASK_DB = '.commander/tasks.db';
const DEFAULT_ARTIFACT_DB = '.commander/artifacts.db';

// ============================================================================
// Types
// ============================================================================''',
    1,
)

# Rewrite TaskManager class
a2a_task = a2a_task.replace(
    '''export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private stateMachine = new TaskStateMachine();

  /**
   * Create a new task
   */
  create(''',
    '''export class TaskManager {
  private db: BetterSqlite3DB | null = null;
  private stateMachine = new TaskStateMachine();
  private stmtInsert!: BetterSqlite3Stmt;
  private stmtGet!: BetterSqlite3Stmt;
  private stmtGetAll!: BetterSqlite3Stmt;
  private stmtUpdateStatus!: BetterSqlite3Stmt;
  private stmtDelete!: BetterSqlite3Stmt;
  private stmtListByClient!: BetterSqlite3Stmt;
  private stmtListByAgent!: BetterSqlite3Stmt;
  private stmtListByStatus!: BetterSqlite3Stmt;
  private inMemoryTasks = new Map<string, Task>();

  constructor(dbPath?: string) {
    const resolved = dbPath ?? DEFAULT_TASK_DB;
    this.db = openTaskDb(resolved);
    if (!this.db) {
      console.warn('[TaskManager] better-sqlite3 not available; using in-memory fallback');
      return;
    }
    this.prepareStatements();
  }

  private prepareStatements(): void {
    if (!this.db) return;
    const d = this.db;
    this.stmtInsert = d.prepare(`
      INSERT INTO tasks (id, client_id, agent_id, description, priority, status, input_json, artifact_id, progress, error, messages_json, created_at, started_at, completed_at, updated_at)
      VALUES (@id, @clientId, @agentId, @description, @priority, @status, @inputJson, @artifactId, @progress, @error, @messagesJson, @createdAt, @startedAt, @completedAt, @updatedAt)
    `);
    this.stmtGet = d.prepare(`SELECT * FROM tasks WHERE id = ?`);
    this.stmtGetAll = d.prepare(`SELECT * FROM tasks`);
    this.stmtUpdateStatus = d.prepare(`
      UPDATE tasks SET status = @status, progress = @progress, error = @error, agent_id = @agentId, artifact_id = @artifactId, started_at = @startedAt, completed_at = @completedAt, updated_at = @updatedAt WHERE id = @id
    `);
    this.stmtDelete = d.prepare(`DELETE FROM tasks WHERE id = ?`);
    this.stmtListByClient = d.prepare(`SELECT * FROM tasks WHERE client_id = ?`);
    this.stmtListByAgent = d.prepare(`SELECT * FROM tasks WHERE agent_id = ?`);
    this.stmtListByStatus = d.prepare(`SELECT * FROM tasks WHERE status = ?`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
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
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id);
    `);
  }

  private taskToRow(t: Task) -> dict:
    return {
      id: t.id,
      clientId: t.clientId,
      agentId: t.agentId ?? null,
      description: t.description,
      priority: t.priority,
      status: t.status,
      inputJson: json.dumps(t.input),
      artifactId: t.artifact?.id ?? null,
      progress: t.progress,
      error: t.error ?? null,
      messagesJson: json.dumps(t.messages),
      createdAt: t.createdAt,
      startedAt: t.startedAt ?? null,
      completedAt: t.completedAt ?? null,
      updatedAt: t.updatedAt,
    }

  private rowToTask(row: any) -> Task:
    data = dict(row)
    data['input'] = json.loads(data.pop('input_json', '{}'))
    data['messages'] = json.loads(data.pop('messages_json', '[]'))
    # artifact is loaded separately via ArtifactManager
    data['artifact'] = None
    return Task(**data)

  /**
   * Create a new task
   */
  create(''',
    1,
)

# We need to replace the method bodies too. Let's do a full file rewrite for TaskManager section.
# Actually, the simplest approach is to replace the entire TaskManager class body.

print("NOTE: Full class rewrite via Python is complex; switching to Write tool for complete file rewrite.")
