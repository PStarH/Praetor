import type { PolicyEffect } from '@praetor/contracts';

export type { PolicyEffect } from '@praetor/contracts';

export type PolicyDenyClass =
  | 'deny_shell'
  | 'deny_network'
  | 'deny_delete'
  | 'deny_payment'
  | 'deny_secret_read'
  | 'deny_force_push'
  | 'deny_off_hours'
  | 'deny_tenant_disabled';

export type PolicyPhase = 'begin' | 'tool' | 'lifecycle';

export type ToolCategory =
  | 'shell'
  | 'network'
  | 'file_write'
  | 'file_read'
  | 'destructive'
  | 'mcp'
  | 'compute'
  | 'api'
  | 'unknown';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PolicyRuleAst {
  id: string;
  name: string;
  effect: 'allow' | 'deny' | 'require_approval' | 'deny_class';
  denyClass?: PolicyDenyClass;
  body: PolicyExpr;
  /**
   * `if { ... }` guard. The rule fires only when both `body` and `condition`
   * evaluate truthy; a rule without a condition fires on `body` alone.
   */
  condition?: PolicyExpr;
  priority: number;
}

export interface PolicyPackAst {
  name: string;
  version: number;
  rules: PolicyRuleAst[];
  defaults: {
    allow: boolean;
    require_approval: boolean;
  };
  raw: string;
  parsedAt: number;
}

export type PolicyExpr =
  | { kind: 'literal'; value: LiteralValue }
  | { kind: 'ref'; path: string[] }
  | { kind: 'call'; name: string; ns?: string; args: PolicyExpr[] }
  | { kind: 'unary'; op: 'not'; arg: PolicyExpr }
  | { kind: 'binary'; op: PolicyBinOp; left: PolicyExpr; right: PolicyExpr }
  | { kind: 'list'; items: PolicyExpr[] }
  | { kind: 'object'; fields: { key: string; value: PolicyExpr }[] };

export type PolicyBinOp = '==' | '!=' | '>' | '<' | '>=' | '<=' | 'in' | 'and' | 'or';

export type LiteralValue =
  string | number | boolean | null | LiteralValue[] | { [k: string]: LiteralValue };

export interface CompensableActionSummary {
  actionId: string;
  toolName: string;
  externalSystem?: string;
  destructive: boolean;
  riskLevel: RiskLevel;
  idempotencyKey: string;
  executedAt?: number;
  result?: unknown;
  error?: string;
}

export interface PolicyRunContext {
  id: string;
  state: 'PENDING' | 'EXECUTING' | 'VERIFYING' | 'COMMITTED' | 'ABORTED' | 'COMPENSATED' | 'PAUSED';
  fencingEpoch: number;
  intentHash: string;
  tenantId?: string;
  agentId: string;
  goal: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  actionsSoFar: CompensableActionSummary[];
}

export interface PolicyToolContext {
  name: string;
  externalSystem?: string;
  riskLevel: RiskLevel;
  destructive: boolean;
  isReadOnly: boolean;
  isIdempotent: boolean;
  category: ToolCategory;
}

export interface PolicyActionContext {
  args: Record<string, unknown>;
  idempotencyKey: string;
  stepNumber: number;
  callSite: 'agent' | 'http' | 'plugin' | 'scheduler';
  leaseToken: string;
  fencingEpoch: number;
}

export interface PolicyTenantContext {
  id: string | null;
  config: {
    tokenBudget: number;
    maxConcurrency: number;
    maxRunsPerMinute: number;
    maxActionsPerRun: number;
    allowShell: boolean;
    allowNetwork: boolean;
    requiresApprovalBypass: boolean;
    policyPack?: string;
  };
}

export interface PolicyMetricsContext {
  tokensUsedThisRun: number;
  tokensUsedThisHour: number;
  actionsThisRun: number;
  destructiveThisRun: number;
  estimatedCostUsd: number;
}

export interface PolicyTimeContext {
  now: number;
  hourOfDay: number;
  isWeekend: boolean;
}

export interface PolicyInput {
  phase: PolicyPhase;
  run: PolicyRunContext;
  tool: PolicyToolContext;
  action: PolicyActionContext;
  tenant: PolicyTenantContext;
  metrics: PolicyMetricsContext;
  time: PolicyTimeContext;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  denyClass?: PolicyDenyClass;
  decisionPath: string[];
  matchedRule: string | null;
  riskScore: number;
  budget: BudgetSnapshot;
  latencyMs: number;
  cached: boolean;
  cacheable: boolean;
  decisionId: string;
  packVersion: number;
  packName: string;
  tenantId: string | null;
  runId: string;
}

export interface BudgetSnapshot {
  tokensUsed: number;
  tokensBudget: number;
  actionsUsed: number;
  actionsBudget: number;
  estimatedCostUsd: number;
}

export type BuiltinFn = (args: LiteralValue[]) => LiteralValue;

export interface BuiltinRegistry {
  [name: string]: BuiltinFn;
}

export interface ConflictReport {
  severity: 'info' | 'warning' | 'critical';
  ruleA: string;
  ruleB: string;
  reason: string;
  inputsAffected?: number;
}

export interface PolicyEngineOptions {
  maxEvaluationDepth?: number;
  /** Total expression nodes a single rule may visit before evaluation fails closed. */
  maxEvaluationNodes?: number;
  evaluationTimeoutMs?: number;
  defaultPackVersion?: number;
}

export interface PolicyEngineStats {
  evaluations: number;
  cacheHits: number;
  cacheMisses: number;
  denials: number;
  allows: number;
  approvals: number;
  denyClasses: Record<string, number>;
  avgLatencyMs: number;
  p99LatencyMs: number;
  maxLatencyMs: number;
  errors: number;
  cyclesDetected: number;
  timeouts: number;
}
