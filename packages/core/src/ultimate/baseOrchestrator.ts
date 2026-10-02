import { getGlobalLogger } from '../logging';
import { callLLMJSON } from '../runtime/llmJsonExtractor';
import { validateShape } from '../runtime/structuredOutput';
import type { LLMProvider } from '../runtime/types';

// ============================================================================
// Shared node-status type
// ============================================================================

export type NodeStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 're_opened';

// ============================================================================
// Base node interface — the minimal contract for tree operations
// ============================================================================

export interface BaseNode {
  id: string;
  goal: string;
  parentId: string | null;
  status: NodeStatus;
  workerOutput?: string;
  critique?: {
    passed: boolean;
    findings: Array<{
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      category: string;
      description: string;
      location?: string;
      suggestion?: string;
    }>;
    summary: string;
  };
  /** Child nodes — concrete types may use a different property name (e.g. subGoals) */
  subNodes?: BaseNode[];
  dependencies: string[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Generic tree helpers
// ============================================================================

export function generateNodeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getChildNodes<T extends BaseNode>(node: T): T[] {
  const children =
    (node as unknown as Record<string, unknown>).subNodes ??
    (node as unknown as Record<string, unknown>).subGoals ??
    [];
  return children as T[];
}

export function findNodeById<T extends BaseNode>(nodes: T[], id: string): T | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNodeById(getChildNodes(n), id);
    if (found) return found;
  }
  return undefined;
}

export function collectAllNodes<T extends BaseNode>(nodes: T[]): T[] {
  const result: T[] = [];
  for (const n of nodes) {
    result.push(n);
    result.push(...collectAllNodes(getChildNodes(n)));
  }
  return result;
}

export function countActiveNodes<T extends BaseNode>(nodes: T[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened') count++;
    count += countActiveNodes(getChildNodes(n));
  }
  return count;
}

export function cloneTree<T extends BaseNode>(nodes: T[]): T[] {
  return nodes.map((n) => ({
    ...n,
    critique: n.critique ? { ...n.critique, findings: [...n.critique.findings] } : undefined,
    subNodes: cloneTree(getChildNodes(n)) as unknown as T['subNodes'],
  })) as T[];
}

export function getPendingNodes<T extends BaseNode>(nodes: T[]): T[] {
  const result: T[] = [];
  for (const n of nodes) {
    if (n.status === 'pending' || n.status === 're_opened') result.push(n);
    result.push(...getPendingNodes(getChildNodes(n)));
  }
  return result;
}

// ============================================================================
// Shared LLM JSON wrapper with shape validation
// ============================================================================

export interface LLMJSONResult<T> {
  data: T;
  tokens: number;
}

export async function callLLMWithValidation<T>(
  provider: LLMProvider,
  model: string,
  prompt: string,
  userMessage: string,
  shape: { [K: string]: 'string' | 'number' | 'boolean' | 'object' | 'array' },
  logLabel: string,
  logMethod: string,
): Promise<LLMJSONResult<T> | null> {
  const result = await callLLMJSON<T>(provider, model, prompt, userMessage);
  if (
    result &&
    !validateShape(
      result.data,
      shape as Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>,
    )
  ) {
    getGlobalLogger().warn(logLabel, `${logMethod}: LLM response failed shape validation`);
    return null;
  }
  return result;
}

// ============================================================================
// Shared worker execution
// ============================================================================

export interface WorkerExecuteOptions {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  parentGoal: string;
  nodeGoal: string;
  dependencyContext: string;
  maxTokens?: number;
  temperature?: number;
}

export async function sharedWorkerExecute(
  opts: WorkerExecuteOptions,
): Promise<{ output: string; tokens: number } | null> {
  try {
    const response = await opts.provider.call({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        {
          role: 'user',
          content: `Parent Goal: ${opts.parentGoal}\n\nSub-Goal: ${opts.nodeGoal}${
            opts.dependencyContext
              ? `\n\nContext from dependencies:\n${opts.dependencyContext}`
              : ''
          }\n\nProvide your output.`,
        },
      ],
      temperature: opts.temperature ?? 0.3,
      maxTokens: opts.maxTokens ?? 4096,
    });
    return { output: response.content, tokens: response.usage?.totalTokens ?? 0 };
  } catch (err) {
    getGlobalLogger().error('BaseOrchestrator', 'Worker execution failed', err as Error);
    return null;
  }
}

// ============================================================================
// Shared critic execution
// ============================================================================

export interface CriticEvaluateOptions {
  provider: LLMProvider;
  model: string;
  criticPrompt: string;
  parentGoal: string;
  nodeGoal: string;
  workerOutput: string | undefined;
  logLabel: string;
}

export interface CriticOutput {
  passed: boolean;
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    category: string;
    description: string;
    location?: string;
    suggestion?: string;
  }>;
  summary: string;
}

export async function sharedCriticEvaluate(
  opts: CriticEvaluateOptions,
): Promise<{ data: CriticOutput; tokens: number } | null> {
  const context = `Parent Goal: ${opts.parentGoal}\nSub-Goal: ${opts.nodeGoal}\n\nWorker Output:\n${
    opts.workerOutput?.slice(0, 2000) ?? '(no output)'
  }`;
  const result = await callLLMJSON<CriticOutput>(
    opts.provider,
    opts.model,
    opts.criticPrompt,
    context,
  );
  if (
    result &&
    !validateShape(result.data, { passed: 'boolean', findings: 'array', summary: 'string' })
  ) {
    getGlobalLogger().warn(opts.logLabel, 'criticEvaluate: LLM response failed shape validation');
    return null;
  }
  return result;
}

// ============================================================================
// Shared manager decomposition
// ============================================================================

export interface DecompositionSubGoal {
  goal: string;
  dependencies: string[];
  notes?: string;
  complexity?: number;
}

export interface DecompositionOutput {
  subGoals: DecompositionSubGoal[];
  reasoning: string;
}

export async function sharedManagerDecompose(
  provider: LLMProvider,
  model: string,
  prompt: string,
  goal: string,
  logLabel: string,
): Promise<{ data: DecompositionOutput; tokens: number } | null> {
  return callLLMWithValidation<DecompositionOutput>(
    provider,
    model,
    prompt,
    `Goal: ${goal}`,
    { subGoals: 'array', reasoning: 'string' },
    logLabel,
    'managerDecompose',
  );
}

// ============================================================================
// Shared manager review
// ============================================================================

export interface ReviewAssessment {
  goalId: string;
  status: 'completed' | 'needs_rework' | 're_open';
  reason: string;
}

export interface ReviewOutput {
  goalAssessments: ReviewAssessment[];
  newSubGoals: Array<{ goal: string; dependencies: string[] }>;
  overallStatus: 'on_track' | 'needs_improvement' | 'stuck';
  overallSummary: string;
}

export async function sharedManagerReview(
  provider: LLMProvider,
  model: string,
  prompt: string,
  goal: string,
  round: number,
  contextItems: Array<{
    id: string;
    goal: string;
    status: NodeStatus;
    output?: string;
    critique?: BaseNode['critique'];
    childManagers?: Array<{
      id: string;
      goal: string;
      status: string;
      summary?: string;
    }>;
  }>,
  fusionReport: unknown | null,
  logLabel: string,
): Promise<{ data: ReviewOutput; tokens: number } | null> {
  if (contextItems.length === 0) return null;

  const parts = [
    `Original Goal: ${goal}`,
    `Round: ${round}`,
    '',
    'Completed work:',
    JSON.stringify(contextItems, null, 2),
  ];
  if (fusionReport) {
    parts.push('', 'Fusion conflict report:', JSON.stringify(fusionReport, null, 2));
  }

  const result = await callLLMJSON<ReviewOutput>(provider, model, prompt, parts.join('\n'));
  if (
    result &&
    !validateShape(result.data, {
      goalAssessments: 'array',
      newSubGoals: 'array',
      overallStatus: 'string',
      overallSummary: 'string',
    })
  ) {
    getGlobalLogger().warn(logLabel, 'managerReview: LLM response failed shape validation');
    return null;
  }
  return result;
}

// ============================================================================
// Shared tree builder
// ============================================================================

export interface BuildTreeOptions<T extends BaseNode> {
  subGoals: DecompositionSubGoal[];
  parentId: string | null;
  createNode: (id: string, sg: DecompositionSubGoal, parentId: string | null) => T;
}

export function buildTree<T extends BaseNode>(opts: BuildTreeOptions<T>): T[] {
  const { subGoals, parentId, createNode } = opts;
  const nodeMap = new Map<string, T>();
  const nodes: T[] = [];

  for (let i = 0; i < subGoals.length; i++) {
    const sg = subGoals[i];
    const id = generateNodeId('node');
    const node = createNode(id, sg, parentId);
    nodeMap.set(`idx:${i}`, node);
    nodeMap.set(id, node);
    nodes.push(node);
  }

  for (let i = 0; i < subGoals.length; i++) {
    const sg = subGoals[i];
    const node = nodeMap.get(`idx:${i}`);
    if (node && sg.dependencies.length > 0) {
      node.dependencies = sg.dependencies
        .map((depIdx) => nodeMap.get(`idx:${depIdx}`)?.id)
        .filter((id): id is string => !!id);
    }
  }

  return nodes;
}

// ============================================================================
// Shared apply-review logic
// ============================================================================

export function applyReview<T extends BaseNode>(nodes: T[], review: ReviewOutput): T[] {
  for (const assessment of review.goalAssessments) {
    const node = findNodeById(nodes, assessment.goalId);
    if (!node) continue;
    if (assessment.status === 'completed' && node.status !== 'failed') {
      node.status = 'completed';
    } else if (assessment.status === 'needs_rework' || assessment.status === 're_open') {
      node.status = 're_opened';
    }
  }
  return nodes;
}

// ============================================================================
// Shared plateau / decision helpers
// ============================================================================

export interface DecisionConfig {
  budgetTokens: number;
  maxRounds: number;
  mode: 'quick' | 'balanced' | 'thorough';
}

export interface DecisionResult {
  decision: string;
  reason: string;
}

export function computePlateauThreshold(mode: 'quick' | 'balanced' | 'thorough'): number {
  return mode === 'thorough' ? 5 : mode === 'balanced' ? 3 : 2;
}

export function hasCriticalFindings<T extends BaseNode>(nodes: T[]): boolean {
  return nodes.some((n) =>
    (n.critique?.findings ?? []).some((f) => f && (f.severity === 'critical' || f.severity === 'high')),
  );
}

export function computeFindingsFingerprint<T extends BaseNode>(nodes: T[]): Set<string> {
  const set = new Set<string>();
  for (const n of nodes) {
    if (n.critique?.findings) {
      for (const f of n.critique.findings) {
        if (f?.description) {
          set.add(f.description);
        }
      }
    }
  }
  return set;
}

export function computeImprovementRate(
  prevSet: Set<string> | null,
  currentSet: Set<string>,
): number {
  if (prevSet === null || prevSet.size === 0) return 1;
  let resolved = 0;
  for (const desc of prevSet) {
    if (!currentSet.has(desc)) resolved++;
  }
  return resolved / prevSet.size;
}

export function makeBaseDecision(
  round: number,
  totalTokensUsed: number,
  findingsCount: number,
  plateauRounds: number,
  allNodes: BaseNode[],
  config: DecisionConfig,
): DecisionResult {
  if (totalTokensUsed >= config.budgetTokens) {
    return { decision: 'stop_budget', reason: `Token budget (${config.budgetTokens}) exhausted.` };
  }

  if (round >= config.maxRounds) {
    return { decision: 'stop_max_rounds', reason: `Max rounds (${config.maxRounds}) reached.` };
  }

  const activeCount = allNodes.filter(
    (n) => n.status === 'pending' || n.status === 'in_progress' || n.status === 're_opened',
  ).length;

  if (activeCount === 0 && findingsCount === 0) {
    return { decision: 'stop_achieved', reason: 'All sub-goals completed with zero findings.' };
  }

  const plateauThreshold = computePlateauThreshold(config.mode);

  if (plateauRounds >= plateauThreshold && findingsCount <= 2) {
    if (!hasCriticalFindings(allNodes)) {
      return {
        decision: 'stop_plateau',
        reason: `Improvement plateaued after ${plateauRounds} rounds.`,
      };
    }
  }

  return {
    decision: 'continue',
    reason: `Active goals: ${activeCount}, findings: ${findingsCount}`,
  };
}

// ============================================================================
// Shared summary helpers
// ============================================================================

export function buildBaseSummary(params: {
  goal: string;
  status: string;
  rounds: number;
  completed: number;
  total: number;
  extraLines?: string[];
}): string {
  const lines = [
    `Goal: ${params.goal.slice(0, 120)}`,
    `Status: ${params.status}`,
    `Rounds: ${params.rounds}`,
    `Completed: ${params.completed}/${params.total} sub-goals`,
  ];
  if (params.extraLines) {
    lines.push(...params.extraLines);
  }
  return lines.join('\n');
}

// ============================================================================
// Shared prompts
// ============================================================================

export const SHARED_CRITIC_PROMPT = `You are a Critic Agent. Your role is ADVERSARIAL — actively find problems, edge cases, and improvements in the work submitted.

You MUST find issues. Even good work has room for improvement. Be thorough and specific.

For each finding, specify:
- severity: critical (blocks completion) | high (significant issue) | medium (should fix) | low (nice to have) | info (observation)
- category: correctness | completeness | edge_case | security | style | performance | maintainability | test_coverage
- description: specific, actionable description of the issue
- location: which part of the output has the issue (if applicable)
- suggestion: how to fix it

A "passed: true" result means NO critical or high findings remain.
Pass at least 2 findings per review — always find something to improve.

Output ONLY valid JSON with no markdown formatting.

Return:
{
  "passed": false,
  "findings": [
    { "severity": "medium", "category": "correctness", "description": "...", "location": "...", "suggestion": "..." }
  ],
  "summary": "brief assessment"
}`;

export const SHARED_WORKER_PROMPT = `You are a Worker Agent. Execute the assigned task thoroughly. Provide complete, production-quality output. Include code, explanations, and any relevant details.`;

export const SHARED_MANAGER_DECOMPOSE_PROMPT = `You are a Manager Agent. Your job is to break down a complex goal into smaller, independent sub-goals that can be worked on in parallel.

For each sub-goal, specify:
- goal: a concrete, actionable description
- dependencies: array of sibling sub-goal indices (0-based) that must be completed first
- notes: optional guidance for the worker agent

Rules:
- Each sub-goal should be achievable by a single agent in one pass
- Maximize parallelism (minimize dependencies between sub-goals)
- Output ONLY valid JSON with no markdown formatting
- Do NOT wrap the JSON in \`\`\`json or any other markers

Return:
{
  "subGoals": [
    { "goal": "description of sub-goal", "dependencies": [], "notes": "" }
  ],
  "reasoning": "brief explanation of your decomposition"
}`;

export const SHARED_MANAGER_REVIEW_PROMPT = `You are a Manager Agent. Review the completed work from this round.

You have:
1. The original goal and sub-goals
2. Each sub-goal's worker output
3. Each sub-goal's critic evaluation (findings and severity)

For each sub-goal, determine if it's truly:
- "completed": work is done and passes critique
- "needs_rework": work has issues that must be fixed
- "re_open": work was previously completed but new findings suggest it needs revisiting

You may also discover NEW sub-goals based on what was learned this round.

Rate the overall status:
- "on_track": everything is progressing well
- "needs_improvement": some items need rework but progress is happening
- "stuck": no progress or regressing; may need to change approach

Output ONLY valid JSON with no markdown formatting.

Return:
{
  "goalAssessments": [
    { "goalId": "...", "status": "completed|needs_rework|re_open", "reason": "..." }
  ],
  "newSubGoals": [],
  "overallStatus": "on_track|needs_improvement|stuck",
  "overallSummary": "brief assessment of overall progress"
}`;
