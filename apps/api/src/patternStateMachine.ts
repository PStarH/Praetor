/**
 * Commander Pattern Switching State Machine
 * LangGraph-inspired with Multi-Pattern Orchestration Support
 *
 * @legacy This module uses lowercase state names and a parallel state model
 * that is NOT compatible with the V2 canonical state machine defined in
 * `@praetor/contracts` (see `RUN_STATES` / `STEP_STATES`). All new code must
 * use the V2 contracts state machine. This module will be deleted during WP7
 * migration. Do NOT add new features here.
 *
 * Extensions:
 * 1. Conditional routing (LangGraph-style conditional_edges)
 * 2. Pattern switching (Orchestrator-Worker, Hierarchical, Swarm)
 * 3. Dynamic transition evaluation
 */
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Pattern Types
// ============================================================================
export type OrchestrationPattern =
  | 'orchestrator-worker' // 中央控制器分配任务
  | 'hierarchical' // 树状层级管理
  | 'swarm' // 去中心化自主选择
  | 'pipeline'; // 线性管道处理

export interface PatternConfig {
  type: OrchestrationPattern;
  maxAgents?: number; // 最大 agent 数量
  consensusRequired?: boolean; // 是否需要共识
  conflictResolution?: '投票' | '仲裁' | '优先级' | '最后写优先';
}

// ============================================================================
// Conditional Routing Types (LangGraph-style)
// ============================================================================
export type RoutingCondition = (state: AgentState) => string | Promise<string>;

export interface ConditionalEdge {
  id: string;
  condition: RoutingCondition;
  description?: string;
}

export interface ConditionalEdgeMap {
  [sourceState: string]: ConditionalEdge[];
}

// ============================================================================
// Extended State Machine Config
// ============================================================================
export interface PatternStateMachineConfig {
  id: string;
  name: string;
  initialState: string;
  states: StateDefinition[];
  // Standard transitions (deterministic)
  transitions: StateTransition[];
  // Conditional transitions (dynamic routing)
  conditionalEdges?: ConditionalEdgeMap;
  // Pattern configuration
  pattern: PatternConfig;
  // Governance
  governanceCheckpoints: GovernanceCheckpoint[];
  checkpointInterval?: number;
  maxHistorySize?: number;
  enableAutoRecovery?: boolean;
}

// ============================================================================
// Core State (reuse from state-machine.ts concepts)
// ============================================================================
export interface AgentState {
  id: string;
  currentStep: string;
  context: Record<string, any>;
  memory: EpisodeMemory;
  governanceMode: 'SINGLE' | 'GUARDED' | 'MANUAL';
  metadata: StateMetadata;
  // Pattern extension
  activePattern?: OrchestrationPattern;
  subagentResults?: Record<string, any>;
}

export interface EpisodeMemory {
  taskId: string;
  messages: MemoryMessage[];
  decisions: Decision[];
  createdAt: number;
  lastUpdated: number;
}

export interface MemoryMessage {
  role: 'user' | 'assistant' | 'system' | 'agent';
  content: string;
  agentName?: string;
  timestamp: number;
}

export interface Decision {
  id: string;
  type:
    | 'task_delegation'
    | 'tool_call'
    | 'governance_approval'
    | 'pattern_switch'
    | 'conflict_resolution';
  agentName: string;
  action: string;
  reasoning: string;
  timestamp: number;
  outcome?: 'success' | 'failure' | 'pending';
}

export interface StateMetadata {
  missionId: string;
  parentStateId?: string;
  version: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StateTransition {
  id: string;
  from: string;
  to: string;
  condition?: (state: AgentState) => boolean | Promise<boolean>;
  onEnter?: (state: AgentState) => AgentState | Promise<AgentState>;
  onExit?: (state: AgentState) => AgentState | Promise<AgentState>;
  metadata?: {
    description?: string;
    governanceRequired?: boolean;
    riskLevel?: 'low' | 'medium' | 'high';
  };
}

export interface GovernanceCheckpoint {
  mode: 'SINGLE' | 'GUARDED' | 'MANUAL';
  riskScore: number;
  requiredApprovals: string[];
  timeout: number;
  fallbackAction: 'abort' | 'proceed_with_caution' | 'escalate';
}

export interface StateDefinition {
  name: string;
  type: 'start' | 'intermediate' | 'end' | 'error';
  onEnter?: (state: AgentState) => AgentState | Promise<AgentState>;
  onExit?: (state: AgentState) => AgentState | Promise<AgentState>;
  timeout?: number;
  retryPolicy?: {
    maxRetries: number;
    backoffMs: number;
    exponentialBackoff: boolean;
  };
}

// ============================================================================
// Pattern Switching Logic
// ============================================================================
export class PatternSwitcher {
  /**
   * 根据任务特征选择最佳编排模式
   */
  static selectPattern(task: {
    complexity: 'simple' | 'moderate' | 'complex';
    uncertainty: 'low' | 'medium' | 'high';
    teamSize: number;
    deadline: number | null; // ms
  }): OrchestrationPattern {
    // 简单任务 + 低不确定性 → Pipeline / Orchestrator-Worker
    if (task.complexity === 'simple' && task.uncertainty === 'low') {
      return 'pipeline';
    }

    // 中等复杂度 → Orchestrator-Worker
    if (task.complexity === 'moderate') {
      return 'orchestrator-worker';
    }

    // 复杂 + 高不确定性 + 大团队 → Hierarchical
    if (task.complexity === 'complex' && task.teamSize > 5) {
      return 'hierarchical';
    }

    // 探索性任务 → Swarm
    if (task.uncertainty === 'high') {
      return 'swarm';
    }

    // 默认
    return 'orchestrator-worker';
  }

  /**
   * 获取模式描述
   */
  static getPatternDescription(pattern: OrchestrationPattern): string {
    const descriptions: Record<OrchestrationPattern, string> = {
      'orchestrator-worker': '中央控制器(Orchestrator)分配任务给 Worker，Worker 汇报结果',
      hierarchical: '树状层级管理，Manager 管理 Sub-manager，Sub-manager 管理 Worker',
      swarm: '去中心化，Agent 间直接通信，自主协调，无单点故障',
      pipeline: '线性管道，阶段顺序执行，每阶段输出作为下阶段输入',
    };
    return descriptions[pattern];
  }
}

// ============================================================================
// Pattern State Machine Implementation
// ============================================================================
export class PatternStateMachine {
  private config: PatternStateMachineConfig;
  private currentState: AgentState;
  private stateHistory: AgentState[] = [];
  private pendingGovernanceApprovals: Map<string, GovernanceCheckpoint> = new Map();

  constructor(config: PatternStateMachineConfig) {
    this.config = config;
    this.currentState = this.createInitialState();
  }

  private createInitialState(): AgentState {
    const now = Date.now();
    return {
      id: this.generateId(),
      currentStep: this.config.initialState,
      context: {},
      memory: {
        taskId: this.generateId(),
        messages: [],
        decisions: [],
        createdAt: now,
        lastUpdated: now,
      },
      governanceMode: 'SINGLE',
      metadata: {
        missionId: this.generateId(),
        version: 1,
        tags: [],
        createdAt: now,
        updatedAt: now,
      },
      activePattern: this.config.pattern.type,
      subagentResults: {},
    };
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get current state
   */
  getCurrentState(): AgentState {
    return this.currentState;
  }

  /**
   * Find a transition by from/to
   */
  private findTransition(from: string, to: string): StateTransition | undefined {
    return this.config.transitions.find((t) => t.from === from && t.to === to);
  }

  /**
   * Find all transitions from a state
   */
  private getTransitionsFrom(state: string): StateTransition[] {
    return this.config.transitions.filter((t) => t.from === state);
  }

  /**
   * Evaluate conditional edges from current state
   * Returns the target state based on condition evaluation
   */
  async evaluateConditionalEdges(): Promise<string | null> {
    const conditionalEdges = this.config.conditionalEdges?.[this.currentState.currentStep];
    if (!conditionalEdges || conditionalEdges.length === 0) {
      return null;
    }

    // Evaluate each condition in order, return first match
    for (const edge of conditionalEdges) {
      const targetState = await edge.condition(this.currentState);
      if (targetState) {
        return targetState;
      }
    }

    return null;
  }

  /**
   * Standard transition (deterministic)
   */
  async transition(targetState: string): Promise<TransitionResult> {
    const transition = this.findTransition(this.currentState.currentStep, targetState);
    if (!transition) {
      return {
        success: false,
        error: `No valid transition from ${this.currentState.currentStep} to ${targetState}`,
      };
    }

    // Check condition
    if (transition.condition && !(await transition.condition(this.currentState))) {
      return {
        success: false,
        error: `Transition condition not satisfied for ${transition.id}`,
      };
    }

    // Governance check
    if (transition.metadata?.governanceRequired || this.currentState.governanceMode === 'MANUAL') {
      if (this.currentState.governanceMode === 'MANUAL') {
        return {
          success: false,
          error: 'Governance approval required in MANUAL mode',
        };
      }
    }

    return this.executeTransition(transition);
  }

  /**
   * Conditional transition (dynamic routing)
   */
  async transitionConditional(): Promise<TransitionResult> {
    const targetState = await this.evaluateConditionalEdges();
    if (!targetState) {
      return {
        success: false,
        error: `No conditional edge matched from ${this.currentState.currentStep}`,
      };
    }

    const transition = this.findTransition(this.currentState.currentStep, targetState);
    if (!transition) {
      return {
        success: false,
        error: `Conditional transition defined but no matching transition to ${targetState}`,
      };
    }

    return this.executeTransition(transition);
  }

  /**
   * Execute a transition
   */
  private async executeTransition(transition: StateTransition): Promise<TransitionResult> {
    try {
      let newState = { ...this.currentState };

      // Execute onExit
      if (transition.onExit) {
        newState = await transition.onExit(newState);
      }

      // Update state
      const fromStep = newState.currentStep;
      newState.currentStep = transition.to;
      newState.metadata.updatedAt = Date.now();
      newState.metadata.version++;

      // Execute onEnter
      if (transition.onEnter) {
        newState = await transition.onEnter(newState);
      }

      // Record decision
      newState.memory.decisions.push({
        id: this.generateId(),
        type: 'task_delegation',
        agentName: 'StateMachine',
        action: `Transition: ${fromStep} → ${transition.to}`,
        reasoning: transition.metadata?.description || 'Standard transition',
        timestamp: Date.now(),
        outcome: 'success',
      });

      // Save to history
      this.stateHistory.push(this.currentState);
      if (this.config.maxHistorySize) {
        this.stateHistory = this.stateHistory.slice(-this.config.maxHistorySize);
      }

      this.currentState = newState;

      return {
        success: true,
        newState,
      };
    } catch (error) {
      return {
        success: false,
        error: `Transition failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Switch to a different orchestration pattern
   */
  async switchPattern(newPattern: OrchestrationPattern): Promise<TransitionResult> {
    if (this.currentState.activePattern === newPattern) {
      return {
        success: true,
        newState: this.currentState,
      };
    }

    const oldPattern = this.currentState.activePattern;
    this.currentState.activePattern = newPattern;
    this.currentState.metadata.updatedAt = Date.now();

    // Record pattern switch decision
    this.currentState.memory.decisions.push({
      id: this.generateId(),
      type: 'pattern_switch',
      agentName: 'StateMachine',
      action: `Pattern switch: ${oldPattern} → ${newPattern}`,
      reasoning: `PatternSwitcher.selectPattern() returned: ${PatternSwitcher.getPatternDescription(newPattern)}`,
      timestamp: Date.now(),
      outcome: 'pending',
    });

    return {
      success: true,
      newState: this.currentState,
    };
  }

  /**
   * Add subagent result (for orchestrator-worker pattern)
   */
  addSubagentResult(agentId: string, result: unknown): void {
    if (!this.currentState.subagentResults) {
      this.currentState.subagentResults = {};
    }
    this.currentState.subagentResults[agentId] = {
      result,
      timestamp: Date.now(),
    };
  }

  /**
   * Get subagent results
   */
  getSubagentResults(): Record<string, any> {
    return this.currentState.subagentResults || {};
  }

  /**
   * Get state history
   */
  getStateHistory(): AgentState[] {
    return [...this.stateHistory];
  }

  /**
   * Check if in terminal state
   */
  isTerminal(): boolean {
    const currentDef = this.config.states.find((s) => s.name === this.currentState.currentStep);
    return currentDef?.type === 'end' || currentDef?.type === 'error';
  }

  /**
   * Get active pattern
   */
  getActivePattern(): OrchestrationPattern {
    return this.currentState.activePattern || this.config.pattern.type;
  }

  /**
   * Generate state visualization for Battle Report
   */
  generateVisualization(): StateVisualization {
    return {
      missionId: this.currentState.metadata.missionId,
      currentStep: this.currentState.currentStep,
      activePattern: this.getActivePattern(),
      patternDescription: PatternSwitcher.getPatternDescription(this.getActivePattern()),
      stateHistory: this.stateHistory.map((s) => s.currentStep),
      decisionCount: this.currentState.memory.decisions.length,
      subagentCount: Object.keys(this.currentState.subagentResults || {}).length,
      isComplete: this.isTerminal(),
    };
  }
}

export interface TransitionResult {
  success: boolean;
  newState?: AgentState;
  error?: string;
}

export interface StateVisualization {
  missionId: string;
  currentStep: string;
  activePattern: OrchestrationPattern;
  patternDescription: string;
  stateHistory: string[];
  decisionCount: number;
  subagentCount: number;
  isComplete: boolean;
}

// ============================================================================
// Predefined Pattern Configurations
// ============================================================================
export function createOrchestratorWorkerConfig(): PatternStateMachineConfig {
  return {
    id: 'orchestrator-worker-v1',
    name: 'Orchestrator-Worker Pattern',
    initialState: 'initialized',
    states: [
      { name: 'initialized', type: 'start' },
      { name: 'planning', type: 'intermediate' },
      { name: 'delegating', type: 'intermediate' },
      { name: 'executing', type: 'intermediate' },
      { name: 'evaluating', type: 'intermediate' },
      { name: 'completed', type: 'end' },
      { name: 'failed', type: 'error' },
    ],
    transitions: [
      { id: 't1', from: 'initialized', to: 'planning' },
      { id: 't2', from: 'planning', to: 'delegating' },
      { id: 't3', from: 'delegating', to: 'executing' },
      { id: 't4', from: 'executing', to: 'evaluating' },
      { id: 't5', from: 'evaluating', to: 'completed' },
      { id: 't6', from: 'executing', to: 'failed' },
      { id: 't7', from: 'planning', to: 'failed' },
    ],
    conditionalEdges: {
      evaluating: [
        {
          id: 'ce1',
          condition: (state) => {
            // If all subagents succeeded, go to completed
            const results = state.subagentResults || {};
            const allSuccess = Object.values(results).every((r: unknown) => {
              const entry = r as { result?: { success?: unknown } } | undefined;
              return entry?.result?.success === true;
            });
            return allSuccess ? 'completed' : 'failed';
          },
          description: 'Check all subagent results',
        },
      ],
    },
    pattern: {
      type: 'orchestrator-worker',
      maxAgents: 10,
      conflictResolution: '仲裁',
    },
    governanceCheckpoints: [],
  };
}

export function createSwarmConfig(): PatternStateMachineConfig {
  return {
    id: 'swarm-v1',
    name: 'Swarm Pattern (Decentralized)',
    initialState: 'initialized',
    states: [
      { name: 'initialized', type: 'start' },
      { name: 'discovering', type: 'intermediate' }, // Agent 发现彼此
      { name: 'coordinating', type: 'intermediate' }, // 自主协调
      { name: 'executing', type: 'intermediate' },
      { name: 'consensus', type: 'intermediate' }, // 共识达成
      { name: 'completed', type: 'end' },
      { name: 'failed', type: 'error' },
    ],
    transitions: [
      { id: 's1', from: 'initialized', to: 'discovering' },
      { id: 's2', from: 'discovering', to: 'coordinating' },
      { id: 's3', from: 'coordinating', to: 'executing' },
      { id: 's4', from: 'executing', to: 'consensus' },
      { id: 's5', from: 'consensus', to: 'completed' },
      { id: 's6', from: 'executing', to: 'failed' },
    ],
    pattern: {
      type: 'swarm',
      maxAgents: 20,
      consensusRequired: true,
      conflictResolution: '投票',
    },
    governanceCheckpoints: [],
  };
}

export function createHierarchicalConfig(): PatternStateMachineConfig {
  return {
    id: 'hierarchical-v1',
    name: 'Hierarchical Pattern',
    initialState: 'initialized',
    states: [
      { name: 'initialized', type: 'start' },
      { name: 'decomposing', type: 'intermediate' }, // 任务分解
      { name: 'delegating', type: 'intermediate' }, // 委派给 manager
      { name: 'managing', type: 'intermediate' }, // Manager 管理
      { name: 'reporting', type: 'intermediate' }, // 向上汇报
      { name: 'completed', type: 'end' },
      { name: 'failed', type: 'error' },
    ],
    transitions: [
      { id: 'h1', from: 'initialized', to: 'decomposing' },
      { id: 'h2', from: 'decomposing', to: 'delegating' },
      { id: 'h3', from: 'delegating', to: 'managing' },
      { id: 'h4', from: 'managing', to: 'reporting' },
      { id: 'h5', from: 'reporting', to: 'completed' },
      { id: 'h6', from: 'managing', to: 'failed' },
    ],
    pattern: {
      type: 'hierarchical',
      maxAgents: 50,
      conflictResolution: '优先级',
    },
    governanceCheckpoints: [],
  };
}

// ============================================================================
// Factory
// ============================================================================
export class PatternStateMachineFactory {
  private static configs: Map<string, PatternStateMachineConfig> = new Map([
    ['orchestrator-worker', createOrchestratorWorkerConfig()],
    ['swarm', createSwarmConfig()],
    ['hierarchical', createHierarchicalConfig()],
  ]);

  static create(type: OrchestrationPattern): PatternStateMachine {
    const config = this.configs.get(type);
    if (!config) {
      throw new Error(`Unknown pattern type: ${type}`);
    }
    return new PatternStateMachine(config);
  }

  static registerConfig(name: string, config: PatternStateMachineConfig): void {
    this.configs.set(name, config);
  }

  static getAvailablePatterns(): OrchestrationPattern[] {
    return Array.from(this.configs.keys()) as OrchestrationPattern[];
  }
}
