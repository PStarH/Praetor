import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONTRACTS_VERSION,
  CONTRACT_SCHEMAS,
  CONTRACT_VERSION,
  KERNEL_ERROR_CODES,
  OPENAPI_V1_SPEC,
  RUN_STATES,
  STEP_STATES,
  TERMINAL_RUN_STATES,
  TERMINAL_STEP_STATES,
  detectBreakingChanges,
  isCompatibleSchemaVersion,
  isTerminalRunState,
  isTerminalStepState,
  isValidRunTransition,
  isValidStepTransition,
  snapshotContracts,
  validateResource,
  validateRunTransition,
  validateStepTransition,
} from './index.js';

describe('@praetor/contracts state machine', () => {
  it('has stable canonical run states', () => {
    assert.deepStrictEqual(RUN_STATES, [
      'PENDING',
      'RUNNING',
      'PAUSED',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'COMPENSATING',
      'COMPENSATED',
    ]);
  });

  it('has stable canonical step states', () => {
    assert.deepStrictEqual(STEP_STATES, [
      'PENDING',
      'RUNNING',
      'WAITING_FOR_HUMAN',
      'WAITING_FOR_RECONCILIATION',
      'RETRY_WAIT',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'SKIPPED',
    ]);
  });

  it('rejects terminal state transitions', () => {
    for (const state of TERMINAL_RUN_STATES) {
      assert.equal(isValidRunTransition(state, 'RUNNING'), false);
      assert.equal(validateRunTransition(state, 'RUNNING').ok, false);
    }
    for (const state of TERMINAL_STEP_STATES) {
      assert.equal(isValidStepTransition(state, 'RUNNING'), false);
      assert.equal(validateStepTransition(state, 'RUNNING').ok, false);
    }
  });

  it('allows valid pause/resume/cancel transitions', () => {
    assert.equal(isValidRunTransition('PENDING', 'PAUSED'), true);
    assert.equal(isValidRunTransition('RUNNING', 'PAUSED'), true);
    assert.equal(isValidRunTransition('PAUSED', 'RUNNING'), true);
    assert.equal(isValidRunTransition('RUNNING', 'CANCELLED'), true);
    assert.equal(isValidRunTransition('PAUSED', 'CANCELLED'), true);
    assert.equal(isValidRunTransition('PENDING', 'CANCELLED'), true);
  });

  it('allows timer deadlines to fail non-terminal waiting steps', () => {
    assert.equal(validateStepTransition('PENDING', 'FAILED').ok, true);
    assert.equal(validateStepTransition('RETRY_WAIT', 'FAILED').ok, true);
    assert.equal(validateStepTransition('WAITING_FOR_HUMAN', 'FAILED').ok, true);
    assert.equal(validateStepTransition('FAILED', 'RUNNING').ok, false);
  });

  it('allows an answered human interaction to release its waiting step', () => {
    assert.equal(validateStepTransition('WAITING_FOR_HUMAN', 'RETRY_WAIT').ok, true);
  });

  it('allows cancelling a step parked awaiting reconciliation', () => {
    // kernel `cancelRun` cancels every non-terminal step, including
    // WAITING_FOR_RECONCILIATION; the transition table must permit it or the
    // cancel path throws INVALID_TRANSITION before the UPDATE runs.
    assert.equal(validateStepTransition('WAITING_FOR_RECONCILIATION', 'CANCELLED').ok, true);
    assert.equal(isValidStepTransition('WAITING_FOR_RECONCILIATION', 'CANCELLED'), true);
  });

  it('allows deadlines to fail runs before execution or while paused', () => {
    assert.equal(validateRunTransition('PENDING', 'FAILED').ok, true);
    assert.equal(validateRunTransition('PAUSED', 'FAILED').ok, true);
  });

  it('classifies terminal states correctly', () => {
    for (const state of RUN_STATES) {
      assert.equal(isTerminalRunState(state), TERMINAL_RUN_STATES.has(state));
    }
    for (const state of STEP_STATES) {
      assert.equal(isTerminalStepState(state), TERMINAL_STEP_STATES.has(state));
    }
  });

  it('rejects invalid run transitions', () => {
    assert.equal(isValidRunTransition('PENDING', 'SUCCEEDED'), false);
    assert.equal(isValidRunTransition('SUCCEEDED', 'PENDING'), false);
    assert.equal(isValidRunTransition('FAILED', 'RUNNING'), false);
  });
});

describe('@praetor/contracts resources', () => {
  it('exports all 15 canonical resources', () => {
    const resources = [
      'OrganizationV2',
      'ProjectV2',
      'EnvironmentV2',
      'PrincipalV2',
      'RunV2',
      'StepV2',
      'WorkGraphV2',
      'InteractionV2',
      'ArtifactV2',
      'PolicyBundleV2',
      'WorkerV2',
      'EffectV2',
      'AgentDefinitionV2',
      'ToolDefinitionV2',
      'ConnectorDefinitionV2',
    ];
    const snap = snapshotContracts();
    // The resource surface must be exactly the canonical 15 — `includes` alone
    // would accept duplicate, reordered or extra entries.
    assert.deepEqual([...snap.resources].sort(), [...resources].sort());

    // Each canonical resource must also have a JSON schema registered under the
    // camelCase name (`RunV2` → `run`). This couples two independently
    // maintained surfaces instead of re-asserting the literal above.
    const camel = (name: string): string => {
      const bare = name.replace(/V2$/, '');
      return bare.charAt(0).toLowerCase() + bare.slice(1);
    };
    for (const r of resources) {
      assert.ok(
        snap.schemaNames.includes(camel(r)),
        `Resource ${r} has no schema (${camel(r)}) in snapshotContracts().schemaNames`,
      );
    }
  });
});

describe('@praetor/contracts event envelope', () => {
  it('uses tenantId (not tenant) per ADR 007', () => {
    // Verify the field is named tenantId by checking the schema.
    const eventSchema = CONTRACT_SCHEMAS.kernelEvent;
    const props = (eventSchema as any).properties;
    assert.ok(props.tenantId, 'kernelEvent schema must have tenantId property');
    assert.equal(props.tenant, undefined, 'kernelEvent schema must NOT have tenant property');
  });
});

describe('@praetor/contracts JSON schemas', () => {
  it('has schemas for all resources + event + error', () => {
    const expected = [
      'organization',
      'project',
      'environment',
      'principal',
      'run',
      'step',
      'workGraph',
      'interaction',
      'artifact',
      'policyBundle',
      'worker',
      'effect',
      'agentDefinition',
      'toolDefinition',
      'connectorDefinition',
      'kernelEvent',
      'kernelError',
      'actionProposeRequest',
      'actionDecision',
      'actionSimulation',
      'governedAction',
      'actionApprovalRequest',
      'actionCompensationRequest',
      'actionCompensationApprovalRequest',
      'actionRejectionRequest',
      'actionSimulationResponse',
      'actionResponse',
      'actionProposeResponse',
      'actionReconcileAccepted',
      'actionEvidence',
      'actionError',
      'actionKillSwitch',
      'actionKillSwitchUpdate',
      'actionKillSwitchListResponse',
      'actionKillSwitchResponse',
    ];
    for (const name of expected) {
      assert.ok(name in CONTRACT_SCHEMAS, `Schema ${name} missing from CONTRACT_SCHEMAS`);
    }
    assert.equal(Object.keys(CONTRACT_SCHEMAS).length, expected.length);
  });

  it('each schema has $id, type, required, and properties', () => {
    for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) {
      const s = schema as any;
      assert.ok(s.$id, `Schema ${name} missing $id`);
      assert.ok(s.type, `Schema ${name} missing type`);
      assert.ok(Array.isArray(s.required), `Schema ${name} missing required array`);
      assert.ok(
        s.properties && typeof s.properties === 'object',
        `Schema ${name} missing properties`,
      );
    }
  });

  it('run schema enforces uppercase state enum', () => {
    const runSchema = CONTRACT_SCHEMAS.run as any;
    const stateEnum = runSchema.properties.state.enum;
    assert.deepStrictEqual(stateEnum, [...RUN_STATES]);
  });

  it('step schema enforces uppercase state enum', () => {
    const stepSchema = CONTRACT_SCHEMAS.step as any;
    const stateEnum = stepSchema.properties.state.enum;
    assert.deepStrictEqual(stateEnum, [...STEP_STATES]);
  });

  it('effect schema has all 8 effect statuses', () => {
    const effectSchema = CONTRACT_SCHEMAS.effect as any;
    const statuses = effectSchema.properties.status.enum;
    assert.deepStrictEqual(statuses, [
      'ADMITTED',
      'EXECUTING',
      'COMPLETION_UNKNOWN',
      'CONFIRMED_NOT_APPLIED',
      'COMPLETED',
      'FAILED',
      'COMPENSATED',
      'REJECTED',
    ]);
  });

  it('effect schema accepts CONFIRMED_NOT_APPLIED, a real kernel terminal state', () => {
    const result = validateResource('effect', {
      id: 'effect-1',
      runId: 'run-1',
      stepId: 'step-1',
      tenantId: 'tenant-1',
      kind: 'http.post',
      status: 'CONFIRMED_NOT_APPLIED',
      idempotencyKey: 'idem-key-12345',
      policyDecisionId: 'policy-1',
      arguments: {},
      fencingEpoch: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it('connector schema has data classification enum', () => {
    const connectorSchema = CONTRACT_SCHEMAS.connectorDefinition as any;
    const classifications = connectorSchema.properties.dataClassification.enum;
    assert.ok(classifications.includes('pii'));
    assert.ok(classifications.includes('phi'));
  });
});

describe('@praetor/contracts OpenAPI V1 spec', () => {
  it('has correct metadata', () => {
    assert.equal(OPENAPI_V1_SPEC.openapi, '3.1.0');
    assert.equal(OPENAPI_V1_SPEC.info.title, 'Commander V1 Resource API');
  });

  it('has paths for all V1 resources', () => {
    const pathKeys = Object.keys(OPENAPI_V1_SPEC.paths);
    assert.ok(pathKeys.some((p) => p.includes('/runs')));
    assert.ok(pathKeys.some((p) => p.includes('/runs/{runId}/steps')));
    assert.ok(pathKeys.some((p) => p.includes('/runs/{runId}/workgraph')));
    assert.ok(pathKeys.some((p) => p.includes('/interactions')));
    assert.ok(pathKeys.some((p) => p.includes('/artifacts')));
    assert.ok(pathKeys.some((p) => p.includes('/effects')));
    assert.ok(pathKeys.some((p) => p.includes('/policy-bundles')));
    assert.ok(pathKeys.some((p) => p.includes('/agents')));
    assert.ok(pathKeys.some((p) => p.includes('/tools')));
    assert.ok(pathKeys.some((p) => p.includes('/connectors')));
  });

  it('run creation returns 202 (async)', () => {
    const runPost = (OPENAPI_V1_SPEC.paths as any)['/runs'].post;
    assert.ok('202' in runPost.responses, 'POST /runs must have 202 response');
  });

  it('uses ApiKeyAuth and requires Idempotency-Key on writes', () => {
    assert.ok('ApiKeyAuth' in (OPENAPI_V1_SPEC.components as any).securitySchemes);
    const runPost = (OPENAPI_V1_SPEC.paths as any)['/runs'].post;
    const paramNames = runPost.parameters.map((p: any) => p.$ref ?? p.name);
    assert.ok(
      paramNames.some((n: string) => n?.includes('IdempotencyKey') || n === 'Idempotency-Key'),
    );
  });

  it('all component schemas are defined', () => {
    const schemas = (OPENAPI_V1_SPEC.components as any).schemas;
    const expected = [
      'Run',
      'Step',
      'WorkGraph',
      'Interaction',
      'Artifact',
      'PolicyBundle',
      'Effect',
      'AgentDefinition',
      'ToolDefinition',
      'ConnectorDefinition',
      'KernelEvent',
      'Error',
      'CreateRunRequest',
      'CreateInteractionResponseRequest',
    ];
    for (const name of expected) {
      assert.ok(name in schemas, `Schema ${name} missing from OpenAPI components`);
    }
  });
});

describe('@praetor/contracts compatibility', () => {
  it('contract version matches', () => {
    assert.equal(CONTRACT_VERSION, CONTRACTS_VERSION);
    assert.equal(CONTRACT_VERSION, 'v2');
  });

  it('isCompatibleSchemaVersion accepts v2', () => {
    assert.equal(isCompatibleSchemaVersion('v2'), true);
    assert.equal(isCompatibleSchemaVersion('v1'), false);
    assert.equal(isCompatibleSchemaVersion('v3'), false);
  });

  it('isCompatibleSchemaVersion accepts the canonical VersionedContract form', () => {
    // versioned.ts publishes 'commander.run/v2' etc.; quoting the current
    // contract version verbatim must not read as incompatible.
    assert.equal(isCompatibleSchemaVersion('commander.run/v2'), true);
    assert.equal(isCompatibleSchemaVersion('commander.effect/v2'), true);
    assert.equal(isCompatibleSchemaVersion('commander.grant/v1'), false);
    assert.equal(isCompatibleSchemaVersion(''), false);
  });

  it('snapshotContracts returns all resources, states, and error codes', () => {
    const snap = snapshotContracts();
    assert.equal(snap.version, 'v2');
    assert.equal(snap.resources.length, 15);
    assert.ok(snap.runStates.length >= 8);
    assert.ok(snap.stepStates.length >= 8);
    assert.ok(snap.errorCodes.length >= 20);
    assert.ok(snap.schemaNames.length >= 17);
  });

  it('detectBreakingChanges identifies removed resources', () => {
    const baseline = snapshotContracts();
    const current = snapshotContracts();
    // Simulate a removed resource
    current.resources = current.resources.filter((r) => r !== 'EffectV2');
    const changes = detectBreakingChanges(baseline, current);
    assert.ok(changes.length > 0);
    assert.ok(changes.some((c) => c.includes('EffectV2')));
  });

  it('detectBreakingChanges identifies removed states', () => {
    const baseline = snapshotContracts();
    const current = snapshotContracts();
    current.runStates = current.runStates.filter((s) => s !== 'COMPENSATING');
    const changes = detectBreakingChanges(baseline, current);
    assert.ok(changes.some((c) => c.includes('COMPENSATING')));
  });

  it('detectBreakingChanges returns empty for identical snapshots', () => {
    const snap = snapshotContracts();
    const changes = detectBreakingChanges(snap, snap);
    assert.deepStrictEqual(changes, []);
  });

  it('committed baseline has no breaking drift from current snapshot', () => {
    const baselinePath = join(__dirname, '../snapshots/contract-snapshot.baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as ReturnType<
      typeof snapshotContracts
    >;
    const current = snapshotContracts();
    const changes = detectBreakingChanges(baseline, current);
    assert.deepStrictEqual(changes, [], `baseline drift detected: ${changes.join('; ')}`);
  });

  it('error codes are stable', () => {
    assert.ok(KERNEL_ERROR_CODES.includes('DUPLICATE_INTERACTION'));
    assert.ok(KERNEL_ERROR_CODES.includes('LEASE_LOST'));
    assert.ok(KERNEL_ERROR_CODES.includes('VERSION_CONFLICT'));
    assert.ok(KERNEL_ERROR_CODES.includes('POLICY_DENIED'));
    assert.ok(KERNEL_ERROR_CODES.includes('CAPABILITY_DENIED'));
  });
});

describe('@praetor/contracts action rejection request', () => {
  it('requires an accountability reason', () => {
    // A rejection is an operator decision recorded for audit. `required: []`
    // made an empty object a valid rejection, so the contract proved nothing
    // about who rejected or why.
    const empty = validateResource('actionRejectionRequest', {});
    assert.equal(empty.ok, false, 'a reason-less rejection must not validate');
    assert.ok(
      empty.errors.some((e) => e.includes('reason')),
      `expected a missing-reason error, got: ${empty.errors.join('; ')}`,
    );
    assert.equal(
      validateResource('actionRejectionRequest', { reason: 'policy violation' }).ok,
      true,
    );
  });
});
