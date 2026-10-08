/**
 * State Machine Architecture for Commander
 * Inspired by LangGraph's state machine model
 *
 * @legacy This is a legacy state machine implementation with its own state
 * model. The V2 canonical state machine is defined in `@praetor/contracts`
 * (`RUN_STATES` / `STEP_STATES` / `RUN_TRANSITIONS` / `STEP_TRANSITIONS`).
 * New code must use the V2 contracts. This module will be deleted during WP7
 * migration. Do NOT add new features here.
 *
 * Key features:
 * 1. Explicit state management with transitions
 * 2. Checkpoint mechanism for recovery
 * 3. Governance integration at state transitions
 * 4. Persistence layer for long-running tasks
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

import { atomicWriteFileSync, readJsonFileSafe } from './atomicWrite';
import { getDirname, getRequire } from './esmCompat';
const __dirname = getDirname(import.meta.url);
const require = getRequire(import.meta.url);

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Governance modes for human-in-the-loop control
 */
export type GovernanceMode = 'SINGLE' | 'GUARDED' | 'MANUAL';

/**
 * Agent state with full context
 */
export interface AgentState {
  currentStep: string;
  context: Record<string, any>;
  memory: EpisodeMemory;
  governanceMode: GovernanceMode;
  metadata: StateMetadata;
  ownership?: StateOwnership;
}

export interface StateOwnership {
  tenantId: string;
  ownerId?: string;
}

/**
 * Episodic memory for task context
 */
export interface EpisodeMemory {
  taskId: string;
  projectId: string;
  agentId: string;
  history: MemoryEntry[];
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Single memory entry
 */
export interface MemoryEntry {
  timestamp: string;
  type: 'observation' | 'action' | 'reflection' | 'decision';
  content: string;
  metadata?: Record<string, any>;
}

/**
 * State metadata
 */
export interface StateMetadata {
  createdAt: string;
  updatedAt: string;
  version: number;
  checkpointId?: string;
}

/**
 * State transition definition
 */
export interface StateTransition {
  id: string;
  from: string;
  to: string;
  condition?: (state: AgentState) => boolean;
  onEnter?: (state: AgentState) => AgentState;
  onExit?: (state: AgentState) => void;
  governanceRequired?: boolean;
  riskScore?: number;
}

/**
 * Governance checkpoint
 */
export interface GovernanceCheckpoint {
  id: string;
  stateId: string;
  mode: GovernanceMode;
  riskScore: number;
  requiredApprovals: string[];
  timeout: number;
  fallbackAction: 'abort' | 'proceed' | 'escalate';
  status: 'pending' | 'approved' | 'rejected' | 'timeout';
  approvals: ApprovalRecord[];
  createdAt: string;
  resolvedAt?: string;
}

/**
 * Approval record
 */
export interface ApprovalRecord {
  userId: string;
  action: 'approve' | 'reject';
  timestamp: string;
  comment?: string;
}

/**
 * State machine configuration
 */
export interface StateMachineConfig {
  id: string;
  name: string;
  initial: string;
  states: StateDefinition[];
  transitions: StateTransition[];
  persistence: PersistenceConfig;
}

/**
 * State definition
 */
export interface StateDefinition {
  name: string;
  type: 'start' | 'end' | 'checkpoint' | 'action' | 'waiting';
  governanceCheckpoint?: boolean;
  onEnter?: (state: AgentState) => AgentState;
  onExit?: (state: AgentState) => void;
}

/**
 * Persistence configuration
 */
export interface PersistenceConfig {
  enabled: boolean;
  path: string;
  checkpointInterval: number;
}

// ============================================================================
// Persistence Layer
// ============================================================================

const STATE_MACHINE_DIR = path.resolve(__dirname, '../data/state-machines');
const CHECKPOINTS_DIR = path.resolve(__dirname, '../data/checkpoints');
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function stateFilePath(taskId: string, stateDir: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error('Invalid taskId format');
  const root = path.resolve(stateDir);
  const resolved = path.resolve(root, `${taskId}.json`);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('State path is outside the persistence root');
  }
  return resolved;
}

/**
 * Persist state to disk
 */
function persistState(state: AgentState, config: PersistenceConfig): void {
  if (!config.enabled) return;

  const stateDir = path.resolve(config.path);
  fs.mkdirSync(stateDir, { recursive: true });

  // REL-3: atomic write so a crash mid-write cannot truncate the state file.
  const stateFile = stateFilePath(state.memory.taskId, stateDir);
  atomicWriteFileSync(stateFile, JSON.stringify(state, null, 2));
}

/**
 * Load state from disk
 */
function loadState(taskId: string, config: PersistenceConfig): AgentState | null {
  if (!config.enabled) return null;

  const stateFile = stateFilePath(taskId, config.path);
  // REL-4: quarantine corrupt files instead of throwing / silently failing parse.
  return readJsonFileSafe<AgentState | null>(stateFile, null);
}

/**
 * Save checkpoint
 */
function saveCheckpoint(state: AgentState): string {
  const checkpointId = uuidv4();
  const checkpointFile = path.join(CHECKPOINTS_DIR, `${checkpointId}.json`);

  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  // REL-3: atomic write so a crash mid-write cannot leave a half-written checkpoint.
  atomicWriteFileSync(
    checkpointFile,
    JSON.stringify(
      {
        ...state,
        metadata: {
          ...state.metadata,
          checkpointId,
        },
      },
      null,
      2,
    ),
  );

  return checkpointId;
}

/**
 * Load checkpoint
 *
 * Security: Use path.basename() to strip any directory traversal sequences
 * from checkpointId. Per OWASP Path Traversal prevention: never pass
 * user-controlled input directly to filesystem APIs.
 */
function loadCheckpoint(checkpointId: string): AgentState | null {
  // Security: Strip path separators to prevent traversal (e.g. "../../etc/passwd")
  const safeId = path.basename(checkpointId);
  const checkpointFile = path.join(CHECKPOINTS_DIR, `${safeId}.json`);
  // REL-4: quarantine corrupt files instead of throwing / silently failing parse.
  return readJsonFileSafe<AgentState | null>(checkpointFile, null);
}

// ============================================================================
// State Machine Implementation
// ============================================================================

/**
 * State Machine for Agent Workflow Management
 */
export class StateMachine {
  private config: StateMachineConfig;
  private currentState: AgentState | null = null;
  private transitions: Map<string, StateTransition[]> = new Map();
  private pendingCheckpoints: Map<string, GovernanceCheckpoint> = new Map();

  constructor(config: StateMachineConfig) {
    this.config = config;
    this.buildTransitionMap();
  }

  /**
   * Build transition lookup map for O(1) access
   */
  private buildTransitionMap(): void {
    for (const transition of this.config.transitions) {
      const existing = this.transitions.get(transition.from) || [];
      existing.push(transition);
      this.transitions.set(transition.from, existing);
    }
  }

  /**
   * Initialize state machine with a new task
   */
  initialize(
    taskId: string,
    projectId: string,
    agentId: string,
    ownership?: StateOwnership,
  ): AgentState {
    if (this.config.persistence.enabled) stateFilePath(taskId, this.config.persistence.path);
    const now = new Date().toISOString();

    const state: AgentState = {
      currentStep: this.config.initial,
      context: {},
      memory: {
        taskId,
        projectId,
        agentId,
        history: [],
        createdAt: now,
        updatedAt: now,
      },
      governanceMode: 'SINGLE',
      metadata: {
        createdAt: now,
        updatedAt: now,
        version: 1,
      },
      ownership,
    };

    this.currentState = state;
    persistState(state, this.config.persistence);

    return state;
  }

  /**
   * Resume from a checkpoint
   */
  resumeFromCheckpoint(
    checkpointId: string,
    authorize?: (state: AgentState) => boolean,
  ): AgentState | null {
    const state = loadCheckpoint(checkpointId);
    if (state && (!authorize || authorize(state))) {
      this.currentState = state;
      // Add memory entry about resume
      this.addMemoryEntry('observation', `Resumed from checkpoint ${checkpointId}`);
      return state;
    }
    return null;
  }

  /**
   * Get current state
   */
  getState(): AgentState | null {
    return this.currentState;
  }

  /**
   * Check if a transition is valid
   */
  canTransition(toState: string): boolean {
    if (!this.currentState) return false;

    const transitions = this.transitions.get(this.currentState.currentStep) || [];
    return transitions.some((t) => t.to === toState);
  }

  /**
   * Get available transitions from current state
   */
  getAvailableTransitions(): StateTransition[] {
    if (!this.currentState) return [];
    return this.transitions.get(this.currentState.currentStep) || [];
  }

  /**
   * Execute a state transition
   */
  async transition(
    toState: string,
    context?: Record<string, any>,
    governanceCheck?: (checkpoint: GovernanceCheckpoint) => Promise<boolean>,
  ): Promise<{ success: boolean; state?: AgentState; error?: string }> {
    if (!this.currentState) {
      return { success: false, error: 'No current state' };
    }

    const transitions = this.transitions.get(this.currentState.currentStep) || [];
    const transition = transitions.find((t) => t.to === toState);

    if (!transition) {
      return {
        success: false,
        error: `Invalid transition from ${this.currentState.currentStep} to ${toState}`,
      };
    }

    // Check condition if defined
    if (transition.condition && !transition.condition(this.currentState)) {
      return { success: false, error: 'Transition condition not satisfied' };
    }

    // Handle governance checkpoint if required
    if (transition.governanceRequired || this.currentState.governanceMode === 'MANUAL') {
      const checkpoint = this.createGovernanceCheckpoint(transition);
      this.pendingCheckpoints.set(checkpoint.id, checkpoint);

      if (governanceCheck) {
        const approved = await governanceCheck(checkpoint);
        if (!approved) {
          return { success: false, error: 'Governance checkpoint not approved' };
        }
      } else {
        // Store checkpoint for later resolution
        return {
          success: false,
          error: 'Governance checkpoint pending approval',
          state: this.currentState,
        };
      }
    }

    // Execute transition
    const fromState = this.currentState.currentStep;

    // Run onExit for current state
    const currentStateDef = this.config.states.find((s) => s.name === fromState);
    if (currentStateDef?.onExit) {
      currentStateDef.onExit(this.currentState);
    }

    // Update state
    this.currentState.currentStep = toState;
    if (context) {
      this.currentState.context = { ...this.currentState.context, ...context };
    }
    this.currentState.metadata.updatedAt = new Date().toISOString();
    this.currentState.metadata.version++;

    // Add memory entry
    this.addMemoryEntry('action', `Transitioned from ${fromState} to ${toState}`);

    // Run onEnter for new state
    const newStateDef = this.config.states.find((s) => s.name === toState);
    if (newStateDef?.onEnter) {
      this.currentState = newStateDef.onEnter(this.currentState);
    }

    // Save checkpoint for recovery
    const checkpointId = saveCheckpoint(this.currentState);
    this.currentState.metadata.checkpointId = checkpointId;

    // Persist state
    persistState(this.currentState, this.config.persistence);

    return { success: true, state: this.currentState };
  }

  /**
   * Create a governance checkpoint
   */
  private createGovernanceCheckpoint(transition: StateTransition): GovernanceCheckpoint {
    return {
      id: uuidv4(),
      stateId: this.currentState!.memory.taskId,
      mode: this.currentState!.governanceMode,
      riskScore: transition.riskScore ?? 0,
      requiredApprovals: [],
      timeout: 300000, // 5 minutes default
      fallbackAction: 'abort',
      status: 'pending',
      approvals: [],
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Approve a governance checkpoint
   */
  approveCheckpoint(checkpointId: string, userId: string, comment?: string): boolean {
    const checkpoint = this.pendingCheckpoints.get(checkpointId);
    if (!checkpoint) return false;

    checkpoint.approvals.push({
      userId,
      action: 'approve',
      timestamp: new Date().toISOString(),
      comment,
    });

    checkpoint.status = 'approved';
    checkpoint.resolvedAt = new Date().toISOString();

    this.pendingCheckpoints.delete(checkpointId);
    return true;
  }

  /**
   * Reject a governance checkpoint
   */
  rejectCheckpoint(checkpointId: string, userId: string, comment?: string): boolean {
    const checkpoint = this.pendingCheckpoints.get(checkpointId);
    if (!checkpoint) return false;

    checkpoint.approvals.push({
      userId,
      action: 'reject',
      timestamp: new Date().toISOString(),
      comment,
    });

    checkpoint.status = 'rejected';
    checkpoint.resolvedAt = new Date().toISOString();

    this.pendingCheckpoints.delete(checkpointId);
    return true;
  }

  /**
   * Add memory entry
   */
  addMemoryEntry(type: MemoryEntry['type'], content: string, metadata?: Record<string, any>): void {
    if (!this.currentState) return;

    this.currentState.memory.history.push({
      timestamp: new Date().toISOString(),
      type,
      content,
      metadata,
    });

    this.currentState.memory.updatedAt = new Date().toISOString();
    persistState(this.currentState, this.config.persistence);
  }

  /**
   * Get memory entries by type
   */
  getMemoryByType(type: MemoryEntry['type']): MemoryEntry[] {
    if (!this.currentState) return [];
    return this.currentState.memory.history.filter((e) => e.type === type);
  }

  /**
   * Generate state summary
   */
  generateSummary(): string {
    if (!this.currentState) return 'No active state';

    const reflections = this.getMemoryByType('reflection');
    const actions = this.getMemoryByType('action');

    return (
      `Task ${this.currentState.memory.taskId}:\n` +
      `- Current Step: ${this.currentState.currentStep}\n` +
      `- Governance Mode: ${this.currentState.governanceMode}\n` +
      `- Memory Entries: ${this.currentState.memory.history.length}\n` +
      `- Actions Taken: ${actions.length}\n` +
      `- Reflections: ${reflections.length}`
    );
  }

  /**
   * Check if in terminal state
   */
  isTerminal(): boolean {
    if (!this.currentState) return true;
    const stateDef = this.config.states.find((s) => s.name === this.currentState!.currentStep);
    return stateDef?.type === 'end';
  }

  /**
   * Get pending governance checkpoints
   */
  getPendingCheckpoints(): GovernanceCheckpoint[] {
    return Array.from(this.pendingCheckpoints.values());
  }
}

// ============================================================================
// Predefined State Machine Configurations
// ============================================================================

/**
 * Standard task execution state machine
 */
export function createStandardTaskStateMachine(): StateMachineConfig {
  return {
    id: 'standard-task-v1',
    name: 'Standard Task Execution',
    initial: 'initialized',
    states: [
      { name: 'initialized', type: 'start' },
      { name: 'planning', type: 'action' },
      { name: 'delegating', type: 'action' },
      { name: 'executing', type: 'action' },
      { name: 'evaluating', type: 'checkpoint', governanceCheckpoint: true },
      { name: 'completed', type: 'end' },
      { name: 'failed', type: 'end' },
    ],
    transitions: [
      { id: 't1', from: 'initialized', to: 'planning' },
      { id: 't2', from: 'planning', to: 'delegating' },
      { id: 't3', from: 'delegating', to: 'executing' },
      { id: 't4', from: 'executing', to: 'evaluating', governanceRequired: true, riskScore: 0.3 },
      { id: 't5', from: 'evaluating', to: 'completed' },
      { id: 't6', from: 'executing', to: 'failed' },
      { id: 't7', from: 'planning', to: 'failed' },
    ],
    persistence: {
      enabled: true,
      path: STATE_MACHINE_DIR,
      checkpointInterval: 60000,
    },
  };
}

/**
 * Research task state machine (more complex)
 */
export function createResearchTaskStateMachine(): StateMachineConfig {
  return {
    id: 'research-task-v1',
    name: 'Research Task Execution',
    initial: 'initialized',
    states: [
      { name: 'initialized', type: 'start' },
      { name: 'scoping', type: 'action' },
      { name: 'searching', type: 'action' },
      { name: 'analyzing', type: 'action' },
      { name: 'synthesizing', type: 'checkpoint', governanceCheckpoint: true },
      { name: 'reviewing', type: 'waiting' },
      { name: 'refining', type: 'action' },
      { name: 'completed', type: 'end' },
      { name: 'failed', type: 'end' },
    ],
    transitions: [
      { id: 't1', from: 'initialized', to: 'scoping' },
      { id: 't2', from: 'scoping', to: 'searching' },
      { id: 't3', from: 'searching', to: 'analyzing' },
      { id: 't4', from: 'analyzing', to: 'synthesizing', governanceRequired: true, riskScore: 0.5 },
      { id: 't5', from: 'synthesizing', to: 'reviewing' },
      { id: 't6', from: 'reviewing', to: 'refining' },
      { id: 't7', from: 'refining', to: 'completed' },
      { id: 't8', from: 'reviewing', to: 'completed' },
      { id: 't9', from: 'scoping', to: 'failed' },
      { id: 't10', from: 'searching', to: 'failed' },
    ],
    persistence: {
      enabled: true,
      path: STATE_MACHINE_DIR,
      checkpointInterval: 60000,
    },
  };
}

/**
 * Factory for creating state machines
 */
export class StateMachineFactory {
  private static configs: Map<string, StateMachineConfig> = new Map([
    ['standard', createStandardTaskStateMachine()],
    ['research', createResearchTaskStateMachine()],
  ]);

  static create(type: 'standard' | 'research'): StateMachine {
    const config = this.configs.get(type);
    if (!config) {
      throw new Error(`Unknown state machine type: ${type}`);
    }
    return new StateMachine(config);
  }

  static registerConfig(name: string, config: StateMachineConfig): void {
    this.configs.set(name, config);
  }

  static getAvailableTypes(): string[] {
    return Array.from(this.configs.keys());
  }
}

// ============================================================================
// Export Types and Utilities
// ============================================================================

export type {
  AgentState as AgentStateType,
  StateTransition as StateTransitionType,
  GovernanceCheckpoint as GovernanceCheckpointType,
};
