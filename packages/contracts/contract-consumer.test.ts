/**
 * Consumer-Driven Contract Test
 *
 * Validates that the SDK client's expected resource shapes match the contracts
 * package's actual types. This test acts as a gate: if the contracts package
 * changes in a way that breaks the SDK consumer, this test fails.
 *
 * Test areas:
 *   a) All SDK resources exist in contract schemas
 *   b) Run/Step state machine transitions match contract
 *   c) OpenAPI spec covers all contract resources
 *   d) Contract snapshot is stable (no breaking changes vs baseline)
 *   e) Validate resource examples against schemas
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  snapshotContracts,
  detectBreakingChanges,
  validateResource,
  OPENAPI_V1_SPEC,
  RUN_STATES,
  STEP_STATES,
  CONTRACT_SCHEMAS,
  type ContractSnapshot,
  type ContractSchemaName,
} from './src/index.js';

import { SDK_V1_RESOURCES } from '../sdk/src/v1/resources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Mapping: SDK resource names -> Contract resource names (V2)
// ---------------------------------------------------------------------------

const SDK_TO_CONTRACT_RESOURCE: Record<string, string> = {
  runs: 'RunV2',
  workgraphs: 'WorkGraphV2',
  interactions: 'InteractionV2',
  artifacts: 'ArtifactV2',
  'policy-bundles': 'PolicyBundleV2',
};

// ---------------------------------------------------------------------------
// Mapping: Contract resource names -> OpenAPI path keywords
// ---------------------------------------------------------------------------

const RESOURCE_TO_PATH_KEYWORD: Record<string, string> = {
  RunV2: 'runs',
  StepV2: 'steps',
  WorkGraphV2: 'workgraph',
  InteractionV2: 'interactions',
  ArtifactV2: 'artifacts',
  PolicyBundleV2: 'policy-bundles',
  EffectV2: 'effects',
  AgentDefinitionV2: 'agents',
  ToolDefinitionV2: 'tools',
  ConnectorDefinitionV2: 'connectors',
};

// Resources that are internal/infrastructure and not exposed via the REST API
const INTERNAL_RESOURCES = new Set([
  'OrganizationV2',
  'ProjectV2',
  'EnvironmentV2',
  'PrincipalV2',
  'WorkerV2',
]);

// ---------------------------------------------------------------------------
// Minimal valid examples for each contract schema
// ---------------------------------------------------------------------------

const ISO = '2026-01-01T00:00:00Z';
const HASH_64 = 'a'.repeat(64);
const ACTION_FIXTURE_DIR = join(__dirname, 'fixtures', 'actions', 'v1');

function actionFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ACTION_FIXTURE_DIR, `${name}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

const ACTION_PROPOSE_FIXTURE = actionFixture('propose');
const ACTION_APPROVAL_FIXTURE = actionFixture('approval');
const ACTION_COMPENSATION_FIXTURE = actionFixture('compensation');
const ACTION_COMPENSATION_APPROVAL_FIXTURE = actionFixture('compensation-approval');
const ACTION_RECONCILE_FIXTURE = actionFixture('reconcile');
const ACTION_EVIDENCE_FIXTURE = actionFixture('evidence');
const ACTION_ERROR_FIXTURE = actionFixture('error');
const ACTION_FIXTURE = ACTION_PROPOSE_FIXTURE.action as Record<string, unknown>;
const ACTION_DECISION_FIXTURE = ACTION_FIXTURE.decision as Record<string, unknown>;
const ACTION_SIMULATION_FIXTURE = ACTION_FIXTURE.simulation as Record<string, unknown>;
const ACTION_KILL_SWITCH_FIXTURE = {
  tenantId: 'tenant-1',
  scope: 'tool',
  value: 'ticket.create',
  enabled: true,
  reason: 'Incident response',
  actor: 'admin-1',
  updatedAt: ISO,
};

const RESOURCE_EXAMPLES: Record<ContractSchemaName, Record<string, unknown>> = {
  organization: {
    id: 'org-1',
    name: 'Acme Corp',
    createdAt: ISO,
  },
  project: {
    id: 'proj-1',
    organizationId: 'org-1',
    name: 'My Project',
    createdAt: ISO,
  },
  environment: {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'production',
  },
  principal: {
    id: 'prin-1',
    tenantId: 'tenant-1',
    subject: 'user@example.com',
    roles: ['admin'],
  },
  run: {
    id: 'run-1',
    tenantId: 'tenant-1',
    state: 'PENDING',
    version: 0,
    intentHash: HASH_64,
    workGraphHash: HASH_64,
    workGraphVersion: 'v1',
    policySnapshotId: 'policy-snap-1',
    createdAt: ISO,
    updatedAt: ISO,
    metadata: {},
  },
  step: {
    id: 'step-1',
    runId: 'run-1',
    tenantId: 'tenant-1',
    kind: 'agent',
    state: 'PENDING',
    version: 0,
    attempt: 0,
    maxAttempts: 3,
    priority: 0,
    dependencies: [],
    input: {},
    scheduledAt: ISO,
    createdAt: ISO,
    updatedAt: ISO,
  },
  workGraph: {
    id: 'wg-1',
    tenantId: 'tenant-1',
    profile: 'run',
    goal: 'Accomplish the task',
    hash: HASH_64,
    schemaVersion: 'v1',
    nodeCount: 1,
    nodes: [{ id: 'node-1', kind: 'task', dependencies: [] }],
    createdAt: ISO,
  },
  interaction: {
    id: 'itr-1',
    runId: 'run-1',
    tenantId: 'tenant-1',
    status: 'pending',
    prompt: 'Should we proceed?',
    createdAt: ISO,
  },
  artifact: {
    id: 'art-1',
    runId: 'run-1',
    tenantId: 'tenant-1',
    name: 'output.txt',
    contentType: 'text/plain',
    createdAt: ISO,
  },
  policyBundle: {
    name: 'default-policy',
    version: 1,
    snapshotId: 'snap-1',
    effectDefaults: { allow: true, requireApproval: false },
  },
  worker: {
    id: 'worker-1',
    kind: 'agent',
    version: '1.0.0',
    capabilities: ['agent'],
    status: 'ACTIVE',
    tenantIds: ['tenant-1'],
    registeredAt: ISO,
    lastHeartbeatAt: ISO,
  },
  effect: {
    id: 'eff-1',
    runId: 'run-1',
    stepId: 'step-1',
    tenantId: 'tenant-1',
    kind: 'http.post',
    status: 'ADMITTED',
    idempotencyKey: 'idem-key-12345678',
    policyDecisionId: 'dec-1',
    arguments: {},
    fencingEpoch: 0,
    createdAt: ISO,
  },
  agentDefinition: {
    id: 'agent-1',
    tenantId: 'tenant-1',
    name: 'Helper Agent',
    version: 1,
    model: 'gpt-4o',
    systemPrompt: 'You are a helpful assistant.',
    toolAllowlist: [],
    requiredCapabilities: [],
    maxConcurrency: 1,
    timeoutMs: 30000,
    metadata: {},
    createdAt: ISO,
    updatedAt: ISO,
  },
  toolDefinition: {
    id: 'tool-1',
    tenantId: 'tenant-1',
    name: 'File Reader',
    version: 1,
    description: 'Reads files from disk.',
    riskLevel: 'safe',
    inputSchema: {},
    requiredCapabilities: [],
    hasExternalEffects: false,
    timeoutMs: 30000,
    metadata: {},
    createdAt: ISO,
    updatedAt: ISO,
  },
  connectorDefinition: {
    id: 'conn-1',
    tenantId: 'tenant-1',
    name: 'Slack Connector',
    version: 1,
    endpoint: 'https://slack.com/api',
    authMode: 'api_key',
    requiredScopes: [],
    dataClassification: 'public',
    egressAllowlist: [],
    enabled: true,
    metadata: {},
    createdAt: ISO,
    updatedAt: ISO,
  },
  kernelEvent: {
    eventId: '00000000-0000-4000-8000-000000000000',
    aggregateType: 'run',
    aggregateId: 'run-1',
    sequence: 0,
    type: 'run.created',
    tenantId: 'tenant-1',
    runId: 'run-1',
    actor: 'gateway',
    schemaVersion: 'v2',
    payload: {},
    occurredAt: ISO,
  },
  kernelError: {
    code: 'LEASE_LOST',
    message: 'Worker lease expired',
    retryable: false,
  },
  actionProposeRequest: {
    source: 'sdk',
    package: '@praetor/sdk',
    model: 'gpt-5',
    tool: 'ticket.create',
    destination: 'demo://tickets/approval',
    effectType: 'demo.ticket.create',
    args: { title: 'Investigate incident' },
    idempotencyKey: 'action-key-0001',
  },
  actionDecision: ACTION_DECISION_FIXTURE,
  actionSimulation: ACTION_SIMULATION_FIXTURE,
  governedAction: ACTION_FIXTURE,
  actionApprovalRequest: {
    actionDigest: ACTION_SIMULATION_FIXTURE.actionDigest,
    simulationId: ACTION_SIMULATION_FIXTURE.simulationId,
    policySnapshotId: ACTION_SIMULATION_FIXTURE.policySnapshotId,
  },
  actionCompensationRequest: ACTION_COMPENSATION_FIXTURE,
  actionCompensationApprovalRequest: ACTION_COMPENSATION_APPROVAL_FIXTURE,
  actionRejectionRequest: {
    reason: 'operator rejected: change window closed',
  },
  actionSimulationResponse: { simulation: ACTION_SIMULATION_FIXTURE },
  actionResponse: ACTION_APPROVAL_FIXTURE,
  actionProposeResponse: ACTION_PROPOSE_FIXTURE,
  actionReconcileAccepted: ACTION_RECONCILE_FIXTURE,
  actionEvidence: ACTION_EVIDENCE_FIXTURE,
  actionError: ACTION_ERROR_FIXTURE,
  actionKillSwitch: ACTION_KILL_SWITCH_FIXTURE,
  actionKillSwitchUpdate: { enabled: true, reason: 'Incident response' },
  actionKillSwitchListResponse: { killSwitches: [ACTION_KILL_SWITCH_FIXTURE] },
  actionKillSwitchResponse: { killSwitch: ACTION_KILL_SWITCH_FIXTURE },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Consumer-Driven Contract Test — SDK vs Contracts', () => {
  // ── a) All SDK resources exist in contract schemas ──

  describe('a) SDK resources exist in contract schemas', () => {
    it('every SDK_V1_RESOURCES entry maps to a contract resource in the snapshot', () => {
      const snapshot = snapshotContracts();

      for (const sdkResource of SDK_V1_RESOURCES) {
        const contractName = SDK_TO_CONTRACT_RESOURCE[sdkResource];
        assert.ok(
          contractName,
          `SDK resource '${sdkResource}' has no mapping to a contract resource name`,
        );
        assert.ok(
          snapshot.resources.includes(contractName),
          `SDK resource '${sdkResource}' maps to '${contractName}' but it is missing from the contract snapshot`,
        );
      }
    });

    it('SDK_V1_RESOURCES is non-empty and covers core API resources', () => {
      assert.ok(SDK_V1_RESOURCES.length >= 5, 'SDK should expose at least 5 resources');
      for (const r of SDK_V1_RESOURCES) {
        assert.ok(SDK_TO_CONTRACT_RESOURCE[r], `Unexpected SDK resource: ${r}`);
      }
    });
  });

  // ── b) Run/Step state machine transitions match contract ──

  describe('b) State machine states match contract', () => {
    it('SDK run states match contract RUN_STATES', () => {
      const expectedRunStates = [
        'PENDING',
        'RUNNING',
        'PAUSED',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
        'COMPENSATING',
        'COMPENSATED',
      ];

      // The SDK's RunStateV1 is a re-export of RunState from @praetor/contracts.
      // Verify the contract's RUN_STATES matches the canonical set.
      assert.deepStrictEqual(
        [...RUN_STATES],
        expectedRunStates,
        'Contract RUN_STATES must match the canonical run state set',
      );

      // Every contract run state should be a valid SDK run state (type-level
      // compatibility is guaranteed by the re-export; here we verify at runtime
      // that the arrays are identical).
      for (const state of RUN_STATES) {
        assert.ok(
          expectedRunStates.includes(state),
          `Contract run state '${state}' is not in the expected SDK state set`,
        );
      }
    });

    it('SDK step states match contract STEP_STATES', () => {
      const expectedStepStates = [
        'PENDING',
        'RUNNING',
        'WAITING_FOR_HUMAN',
        'WAITING_FOR_RECONCILIATION',
        'RETRY_WAIT',
        'SUCCEEDED',
        'FAILED',
        'CANCELLED',
        'SKIPPED',
      ];

      assert.deepStrictEqual(
        [...STEP_STATES],
        expectedStepStates,
        'Contract STEP_STATES must match the canonical step state set',
      );

      for (const state of STEP_STATES) {
        assert.ok(
          expectedStepStates.includes(state),
          `Contract step state '${state}' is not in the expected SDK state set`,
        );
      }
    });

    it('contract snapshot runStates match RUN_STATES constant', () => {
      const snapshot = snapshotContracts();
      assert.deepStrictEqual(
        [...snapshot.runStates],
        [...RUN_STATES],
        'Snapshot runStates must match RUN_STATES',
      );
    });

    it('contract snapshot stepStates match STEP_STATES constant', () => {
      const snapshot = snapshotContracts();
      assert.deepStrictEqual(
        [...snapshot.stepStates],
        [...STEP_STATES],
        'Snapshot stepStates must match STEP_STATES',
      );
    });
  });

  // ── c) OpenAPI spec covers all contract resources ──

  describe('c) OpenAPI spec covers all contract resources', () => {
    it('every API-exposed contract resource has at least one OpenAPI path', () => {
      const snapshot = snapshotContracts();
      const pathKeys = Object.keys(OPENAPI_V1_SPEC.paths ?? {});

      for (const resource of snapshot.resources) {
        // Skip internal/infrastructure resources that are not exposed via REST
        if (INTERNAL_RESOURCES.has(resource)) continue;

        const keyword = RESOURCE_TO_PATH_KEYWORD[resource];
        assert.ok(
          keyword,
          `Resource '${resource}' is not internal but has no path keyword mapping`,
        );

        const hasPath = pathKeys.some((p) => p.includes(keyword));
        assert.ok(
          hasPath,
          `OpenAPI spec has no path covering contract resource '${resource}' (expected path containing '${keyword}')`,
        );
      }
    });

    it('all OpenAPI component schemas reference contract-defined resources', () => {
      const schemas = OPENAPI_V1_SPEC.components?.schemas ?? {};
      const schemaNames = Object.keys(schemas);

      // Every component schema should correspond to a contract schema or a
      // request/response wrapper.
      const contractSchemaNames = Object.keys(CONTRACT_SCHEMAS);
      const knownWrappers = new Set([
        'CreateRunRequest',
        'CreateInteractionResponseRequest',
        'Error',
      ]);

      for (const name of schemaNames) {
        if (knownWrappers.has(name)) continue;
        // Map OpenAPI schema name (PascalCase) to contract schema name (camelCase)
        // e.g., "AgentDefinition" -> "agentDefinition", "KernelEvent" -> "kernelEvent"
        const contractName = name.charAt(0).toLowerCase() + name.slice(1);
        assert.ok(
          contractSchemaNames.includes(contractName),
          `OpenAPI component schema '${name}' has no matching contract schema '${contractName}'`,
        );
      }
    });
  });

  // ── d) Contract snapshot is stable (no breaking changes vs baseline) ──

  describe('d) Contract snapshot stability', () => {
    it('current snapshot has no breaking changes vs baseline', () => {
      const baselinePath = join(__dirname, 'snapshots', 'contract-snapshot.baseline.json');
      const baselineRaw = readFileSync(baselinePath, 'utf-8');
      const baseline = JSON.parse(baselineRaw) as ContractSnapshot;

      const current = snapshotContracts();
      const changes = detectBreakingChanges(baseline, current);

      assert.deepStrictEqual(
        changes,
        [],
        `Breaking changes detected against baseline:\n${changes.join('\n')}`,
      );
    });

    it('baseline snapshot has the expected version', () => {
      const baselinePath = join(__dirname, 'snapshots', 'contract-snapshot.baseline.json');
      const baselineRaw = readFileSync(baselinePath, 'utf-8');
      const baseline = JSON.parse(baselineRaw) as ContractSnapshot;

      assert.equal(baseline.version, 'v2', 'Baseline version must be v2');
      assert.ok(baseline.resources.length >= 15, 'Baseline must have at least 15 resources');
      assert.ok(baseline.runStates.length >= 8, 'Baseline must have at least 8 run states');
      assert.ok(baseline.stepStates.length >= 8, 'Baseline must have at least 8 step states');
      assert.ok(baseline.errorCodes.length >= 20, 'Baseline must have at least 20 error codes');
      assert.ok(baseline.schemaNames.length >= 17, 'Baseline must have at least 17 schema names');
    });
  });

  // ── e) Validate resource examples ──

  describe('e) Resource examples validate against schemas', () => {
    for (const schemaName of Object.keys(CONTRACT_SCHEMAS) as ContractSchemaName[]) {
      it(`validateResource('${schemaName}', example) returns ok`, () => {
        const example = RESOURCE_EXAMPLES[schemaName];
        assert.ok(example, `No example defined for schema '${schemaName}'`);

        const result = validateResource(schemaName, example);
        assert.equal(
          result.ok,
          true,
          `Schema '${schemaName}' example failed validation: ${result.errors.join('; ')}`,
        );
        assert.equal(
          result.errors.length,
          0,
          `Unexpected errors for '${schemaName}': ${result.errors.join('; ')}`,
        );
      });
    }

    it('validateResource rejects a resource missing a required field', () => {
      const result = validateResource('run', {
        id: 'run-1',
        tenantId: 'tenant-1',
        // missing state, version, intentHash, etc.
      });
      assert.equal(result.ok, false, 'Should reject incomplete run');
      assert.ok(
        result.errors.some((e) => e.includes('state')),
        'Should report missing state field',
      );
    });

    it('validateResource rejects invalid enum value', () => {
      const result = validateResource('run', {
        ...RESOURCE_EXAMPLES.run,
        state: 'NOT_A_REAL_STATE',
      });
      assert.equal(result.ok, false, 'Should reject invalid enum');
      assert.ok(
        result.errors.some((e) => e.includes('state')),
        'Should report enum error for state',
      );
    });
  });
});
