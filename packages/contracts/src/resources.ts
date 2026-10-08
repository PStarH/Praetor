/**
 * Versioned V2 resource shapes for public SDK/API consumption.
 *
 * These types intentionally omit internal implementation fields and never
 * import from @praetor/core. They are the public contract.
 */

import type { RunState, StepState } from './states.js';

export const CONTRACTS_VERSION = 'v2' as const;

export interface OrganizationV2 {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectV2 {
  id: string;
  organizationId: string;
  name: string;
  createdAt: string;
}

export interface EnvironmentV2 {
  id: string;
  projectId: string;
  name: string;
}

export interface PrincipalV2 {
  id: string;
  tenantId: string;
  subject: string;
  roles: string[];
}

export interface RunV2 {
  id: string;
  tenantId: string;
  state: RunState;
  version: number;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  policySnapshotId: string;
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  terminalAt?: string;
  metadata: Record<string, unknown>;
}

export interface StepV2 {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  state: StepState;
  version: number;
  attempt: number;
  maxAttempts: number;
  priority: number;
  dependencies: string[];
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkGraphV2 {
  id: string;
  tenantId: string;
  profile: 'run' | 'swarm' | 'drive' | 'goal' | 'company';
  goal: string;
  hash: string;
  schemaVersion: string;
  nodeCount: number;
  nodes: Array<{ id: string; kind: string; dependencies: string[] }>;
  createdAt: string;
}

export interface InteractionV2 {
  id: string;
  runId: string;
  stepId?: string;
  tenantId: string;
  status: 'pending' | 'answered' | 'expired' | 'cancelled';
  prompt: string;
  response?: unknown;
  createdAt: string;
  expiresAt?: string;
}

export interface ArtifactV2 {
  id: string;
  runId: string;
  tenantId: string;
  name: string;
  contentType: string;
  uri?: string;
  digest?: string;
  createdAt: string;
}

export interface PolicyBundleV2 {
  name: string;
  version: number;
  snapshotId: string;
  effectDefaults: { allow: boolean; requireApproval: boolean };
}

export interface WorkerV2 {
  id: string;
  kind: string;
  version: string;
  capabilities: string[];
  status: 'ACTIVE' | 'DRAINING' | 'OFFLINE';
  tenantIds: string[];
  registeredAt: string;
  lastHeartbeatAt: string;
}

// ---------------------------------------------------------------------------

export type EffectStatus =
  | 'ADMITTED'
  | 'EXECUTING'
  | 'COMPLETION_UNKNOWN'
  | 'CONFIRMED_NOT_APPLIED'
  | 'COMPLETED'
  | 'FAILED'
  | 'COMPENSATED'
  | 'REJECTED';

/**
 * A single intended external side effect with idempotency key, policy decision,
 * and audit context. Effects are the only permitted path to trigger external
 * writes (API calls, database writes, file mutations).
 */
export interface EffectV2 {
  id: string;
  runId: string;
  stepId: string;
  tenantId: string;
  /** The tool or operation that produced this effect (e.g., "http.post", "git.push"). */
  kind: string;
  status: EffectStatus;
  /** Idempotency key — duplicate submissions with the same key are deduplicated. */
  idempotencyKey: string;
  /** Policy decision snapshot that authorized this effect. */
  policyDecisionId: string;
  /** The arguments that will be passed to the effect executor. */
  arguments: Record<string, unknown>;
  /** The result of the effect execution, if completed. */
  result?: {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
  /** Fencing epoch at the time of admission — stale epochs are rejected. */
  fencingEpoch: number;
  createdAt: string;
  completedAt?: string;
}

// ---------------------------------------------------------------------------

/**
 * Versioned definition of an agent — its model, system prompt, tool allowlist,
 * and capability requirements. Stored as a versioned resource so runs can pin
 * to a specific definition snapshot.
 */
export interface AgentDefinitionV2 {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  /** Model identifier (e.g., "gpt-4o", "claude-sonnet-4-20250514"). */
  model: string;
  /** System prompt template — may contain {{placeholders}}. */
  systemPrompt: string;
  /** Tool IDs this agent is allowed to invoke. */
  toolAllowlist: string[];
  /** Capability requirements (e.g., ["network.fetch", "file.write"]). */
  requiredCapabilities: string[];
  /** Max concurrent step executions for this agent. */
  maxConcurrency: number;
  /** Execution timeout in milliseconds. */
  timeoutMs: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------

export type ToolRiskLevel = 'safe' | 'elevated' | 'irreversible';

/**
 * Versioned definition of a tool — its schema, risk classification, and
 * capability requirements. Tools are referenced by AgentDefinition and
 * validated by the Effect Broker before execution.
 */
export interface ToolDefinitionV2 {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  /** Human-readable description. */
  description: string;
  /** Risk classification — irreversible tools require human approval. */
  riskLevel: ToolRiskLevel;
  /** JSON Schema for the tool's input arguments. */
  inputSchema: Record<string, unknown>;
  /** Capability requirements for executing this tool. */
  requiredCapabilities: string[];
  /** Whether this tool produces external side effects (requires Effect Broker). */
  hasExternalEffects: boolean;
  /** Maximum execution time in milliseconds. */
  timeoutMs: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------

export type ConnectorAuthMode = 'api_key' | 'oauth2' | 'hmac' | 'mtls' | 'none';

/**
 * Versioned definition of an external connector — its endpoint, authentication
 * mode, and data classification. Connectors are referenced by tools and
 * validated by the Secret Broker before credential issuance.
 */
export interface ConnectorDefinitionV2 {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  /** Base URL or endpoint pattern for the external service. */
  endpoint: string;
  /** Authentication mode required for this connector. */
  authMode: ConnectorAuthMode;
  /** Secret scopes required (e.g., ["slack:chat:write", "github:repo:read"]). */
  requiredScopes: string[];
  /** Data classification for egress enforcement (e.g., "pii", "phi", "internal"). */
  dataClassification: string;
  /** Destination allowlist for network egress. */
  egressAllowlist: string[];
  /** Whether this connector is enabled for production use. */
  enabled: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
