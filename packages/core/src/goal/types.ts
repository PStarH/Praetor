/**
 * Goal Module — 多 Agent 目标驱动执行
 *
 * Phase 1 of the drive/swarm roadmap:
 * manager agent decomposes → worker agents execute → critic agent reviews → loop
 *
 * @legacy `GoalStatus` uses lowercase state names that are NOT compatible with
 * the V2 canonical state machine (`RunState` / `StepState` in
 * `@praetor/contracts`). New code must use `RunState` / `StepState` instead.
 * This type will be migrated or deleted during WP7. Do NOT add new features
 * that depend on `GoalStatus`.
 */

// ============================================================================
// Goal Tree
// ============================================================================

export interface GoalNode {
  id: string;
  goal: string;
  parentId: string | null;
  status: GoalStatus;
  workerOutput?: string;
  critique?: CritiqueResult;
  subGoals: GoalNode[];
  dependencies: string[]; // IDs of sub-goals that must complete first
  roundAssigned?: number;
  roundCompleted?: number;
  metadata?: Record<string, unknown>;
}

export type GoalStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 're_opened';

// ============================================================================
// Critique
// ============================================================================

export interface CritiqueResult {
  passed: boolean;
  findings: CritiqueFinding[];
  summary: string;
}

export interface CritiqueFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: CritiqueCategory;
  description: string;
  location?: string;
  suggestion?: string;
}

export type CritiqueCategory =
  | 'correctness'
  | 'completeness'
  | 'edge_case'
  | 'security'
  | 'style'
  | 'performance'
  | 'maintainability'
  | 'test_coverage';

// ============================================================================
// Ledger
// ============================================================================

export interface RoundLedger {
  round: number;
  goalSnapshot: GoalNode[];
  findingsTotal: number;
  findingsResolved: number;
  findingsNew: number;
  improvementRate: number; // negative = regressing
  tokensUsed: number;
  totalTokensUsed: number;
  decision: RoundDecision;
  decisionReason: string;
  summary: string;
  timestamp: string;
}

export type RoundDecision =
  'continue' | 'stop_achieved' | 'stop_plateau' | 'stop_budget' | 'stop_max_rounds' | 'ask_user';

// ============================================================================
// Config & Result
// ============================================================================

export interface GoalConfig {
  maxRounds: number;
  budgetTokens: number;
  mode: 'quick' | 'balanced' | 'thorough';
  /** Model to use for manager/critic LLM calls (default: gpt-4o-mini) */
  model?: string;
}

export const DEFAULT_GOAL_CONFIG: GoalConfig = {
  maxRounds: 10,
  budgetTokens: 500_000,
  mode: 'balanced',
  model: 'gpt-4o-mini',
};

export interface GoalResult {
  goal: string;
  status: 'completed' | 'partial' | 'failed';
  totalRounds: number;
  totalTokensUsed: number;
  totalDurationMs: number;
  ledger: RoundLedger[];
  finalGoalTree: GoalNode[];
  summary: string;
}

// ============================================================================
// Manager Agent — structured LLM outputs
// ============================================================================

/**
 * Manager's decomposition output: break a goal into sub-goals.
 */
export interface ManagerDecomposition {
  subGoals: Array<{
    goal: string;
    dependencies: string[]; // references to sibling sub-goals by index or id
    notes?: string;
  }>;
  reasoning: string;
}

/**
 * Manager's review output: assess a round of work.
 */
export interface ManagerReview {
  /** For each completed sub-goal: is it truly done? */
  goalAssessments: Array<{
    goalId: string;
    status: 'completed' | 'needs_rework' | 're_open';
    reason: string;
  }>;
  /** New sub-goals discovered during review */
  newSubGoals: Array<{ goal: string; dependencies: string[] }>;
  /** Overall assessment */
  overallStatus: 'on_track' | 'needs_improvement' | 'stuck';
  overallSummary: string;
}

// ============================================================================
// Critic Agent — structured LLM output
// ============================================================================

export interface CriticOutput {
  passed: boolean;
  findings: Array<{
    severity: CritiqueFinding['severity'];
    category: CritiqueCategory;
    description: string;
    location?: string;
    suggestion?: string;
  }>;
  summary: string;
}
