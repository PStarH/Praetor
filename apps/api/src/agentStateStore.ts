import fs from 'fs';
import path from 'path';
import { AgentState } from '@praetor/core';
import { atomicWriteFileSync, readJsonFileSafe } from './atomicWrite';

import { getDirname, getRequire } from './esmCompat';
const __dirname = getDirname(import.meta.url);
const require = getRequire(import.meta.url);

/** Override `COMMANDER_AGENT_STATE_FILE` to relocate the agent-state JSON file. Default keeps the original `__dirname/../data/agent-state.json` path so production runs are untouched. Env var MUST be set before this module is required (module-load capture). */
const AGENT_STATE_FILE =
  process.env['COMMANDER_AGENT_STATE_FILE'] ?? path.resolve(__dirname, '../data/agent-state.json');

export interface UpsertAgentStateInput {
  projectId: string;
  agentId: string;
  summary?: string;
  preferences?: string;
  tags?: string[];
}

export class AgentStateStore {
  private items: AgentState[];

  constructor(private readonly filePath = AGENT_STATE_FILE) {
    this.items = this.load();
  }

  get(projectId: string, agentId: string): AgentState | undefined {
    return this.items.find((item) => item.projectId === projectId && item.agentId === agentId);
  }

  upsert(input: UpsertAgentStateInput): AgentState {
    const now = new Date().toISOString();
    const existing = this.get(input.projectId, input.agentId);

    const safeTags = Array.isArray(input.tags)
      ? input.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 8)
      : (existing?.tags ?? []);

    if (existing) {
      existing.summary = input.summary ?? existing.summary;
      existing.preferences = input.preferences ?? existing.preferences;
      existing.tags = safeTags;
      existing.updatedAt = now;
      this.persist();
      return existing;
    }

    const created: AgentState = {
      projectId: input.projectId,
      agentId: input.agentId,
      summary: input.summary,
      preferences: input.preferences,
      tags: safeTags,
      updatedAt: now,
    };

    this.items.push(created);
    this.persist();
    return created;
  }

  private load(): AgentState[] {
    if (!fs.existsSync(this.filePath)) {
      this.write([]);
      return [];
    }
    // REL-3: quarantine a corrupt file instead of returning [] and then
    // overwriting it on the next persist() — which would lose recoverable state
    // permanently. readJsonFileSafe moves a corrupt file aside and reseeds.
    const parsed = readJsonFileSafe<AgentState[]>(this.filePath, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  private persist() {
    this.write(this.items);
  }

  private write(items: AgentState[]) {
    // REL-3: atomic write so a crash mid-write cannot truncate the state file.
    atomicWriteFileSync(this.filePath, JSON.stringify(items, null, 2));
  }
}
