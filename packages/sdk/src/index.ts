/**
 * @praetor/sdk — Commander Agent SDK
 *
 * Embed Commander's multi-agent orchestration in your own applications.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { CommanderClient, Topology } from '@praetor/sdk';
 *
 * const client = new CommanderClient({ provider: 'openai' });
 * await client.connect();
 *
 * // Simple execution
 * const result = await client.run('analyze this repository');
 * console.log(result.summary);
 *
 * // Agent-based execution
 * const reviewer = client.createAgent({
 *   name: 'code-reviewer',
 *   role: 'Review code for bugs',
 *   tools: ['file_read', 'file_search'],
 *   topology: Topology.SINGLE,
 * });
 *
 * const handle = client.submitTask(reviewer, { goal: 'Find bugs in src/' });
 * const taskResult = await client.awaitTask(handle.id);
 *
 * await client.disconnect();
 * ```
 *
 * ## Events
 *
 * ```typescript
 * const unsub = client.onEvent((event) => {
 *   console.log(`[${event.type}]`, event.data);
 * });
 * ```
 *
 * ## Memory
 *
 * ```typescript
 * await client.writeMemory('Learned: use SQLite for local storage', {
 *   importance: 0.8,
 *   tags: ['best-practice', 'storage'],
 * });
 * const memories = client.queryMemory({ keywords: ['storage'], limit: 5 });
 * ```
 */

// ── Core Client ──────────────────────────────────────────────────────────
export { CommanderClient, PraetorClient, Agent, createClient } from './commanderClient';

// ── Topology ─────────────────────────────────────────────────────────────
export { Topology } from './types';

// ── Core Types ───────────────────────────────────────────────────────────
export type {
  // Client
  CommanderClientConfig,
  CommanderClientConfig as PraetorClientConfig,

  // Execution
  ExecutionResult,
  ExecutionStatus,
  ExecutionStepSummary,
  // Events
  ExecutionEvent,
  ExecutionEventType,
  // Agent
  AgentConfig,
  AgentSnapshot,
  // Task
  Task,
  TaskHandle,
  // Memory
  MemoryWriteOptions,
  MemoryQueryOptions,
  MemoryItem,
  MemoryStats,
  // Session & System
  SessionSummary,
  SystemStatus,
  // Reliability
  SDKReliabilityStats,
  // Tool Error Rows
  SentryRow,
} from './types';

// ── Architecture V2 stable resources ─────────────────────────────────────
export { SDK_API_VERSION, SDK_V1_RESOURCES } from './v1/resources';
export type {
  RunV1,
  RunStateV1,
  RunStatusV1,
  StepV1,
  StepStateV1,
  WorkGraphV1,
  InteractionV1,
  ArtifactV1,
  PolicyBundleV1,
  SdkV1Resource,
  ActionEffect,
  ActionDecision,
  ActionSimulation,
  GovernedActionState,
  GovernedAction,
  ProposeActionInput,
  ActionApprovalInput,
  ActionCompensationInput,
  ActionCompensationApprovalInput,
  ActionCompensationResult,
  ActionCompensationApprovalResult,
  SimulateActionResult,
  ProposeActionResult,
  RequestReconcileResult,
  ActionEvidenceBundle,
  GatewayErrorDetail,
  GatewayErrorResponse,
  KillSwitchScope,
  KillSwitch,
  KillSwitchUpdateInput,
  ActionEvidenceJwk,
  ActionEvidenceJwks,
  ActionEvidenceVerification,
} from './v1/resources';
export {
  CommanderGatewayClient,
  PraetorGatewayClient,
  CommanderGatewayError,
  PraetorGatewayError,
  verifyActionEvidence,
} from './v1/client';
export type { GatewayClientOptions, GatewayRun } from './v1/client';

