import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { commandFailureCode, runHelmTenantCutoverCli } from './helm-tenant-cutover.js';
import * as lifecycleHarness from './helm-lifecycle-kind.js';
import {
  aggregateScenarioPass,
  aggregateScenarioChecks,
  assertHelmVersion,
  assertNegativeCanaryResult,
  assertProofPodContract,
  captureFinalCutoverFailureDiagnostics,
  observeExecFileFailures,
  buildExternalPostgresResources,
  buildLifecycleValues,
  bootstrapFailureEvidence,
  bootstrapFailureStage,
  uncaughtExceptionEvidence,
  calicoImagesForArchitecture,
  kindNodeImageForArchitecture,
  leafCertificateExtensions,
  nodeInventoriesContainExactReference,
  namespaceCleanupArgs,
  prerequisiteAdmissionCleanupCommands,
  postgresImageForArchitecture,
  productionImageReferences,
  productionImageBuildArguments,
  reusableProductionImageDigest,
  controlPlaneReadinessSelectors,
  proofReaderName,
  selectLifecycleScenarios,
  sanitizeEvidence,
  kindClusterExists,
  proofTemplatesPresent,
  parseOwnerFailureEvidence,
  ownerFailureEvidenceRecord,
  processFailureLocation,
  classifyRolloutObservation,
  classifyRolloutFailureJson,
  retainRolloutObservation,
  retainRolloutFailureEvidence,
  productionImageSourceRevision,
  proofReaderCanIArgs,
  proofReaderCanIResultPasses,
  prerequisiteRetryableFailure,
  runLifecycleScenario,
  runBootstrapStage,
  serviceAccountTokenArgs,
  waitForCleanupCheck,
  KIND_NODE_IMAGE,
  CALICO_URL,
} from './helm-lifecycle-kind.js';

describe('helm-lifecycle-kind helpers', () => {
  it('continues to contain execFile process and stdio errors after the first failure', () => {
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr }) as ChildProcess;
    let failures = 0;

    observeExecFileFailures(child, () => {
      failures += 1;
    });

    child.emit('error', new Error('first process failure'));
    assert.doesNotThrow(() => child.emit('error', new Error('subsequent process failure')));
    assert.doesNotThrow(() => stdin.emit('error', new Error('stdin failure')));
    assert.doesNotThrow(() => stdout.emit('error', new Error('stdout failure')));
    assert.doesNotThrow(() => stderr.emit('error', new Error('stderr failure')));
    assert.equal(failures, 5);
  });

  it('fails closed through the callable cutover CLI entrypoint', async () => {
    await assert.rejects(
      () => runHelmTenantCutoverCli(['invalid'], process.cwd()),
      /TENANT_CUTOVER_CLI_ARGUMENT_INVALID/,
    );
  });

  it('fails closed before invalid Helm values reach network prerequisites', () => {
    const materialize = (
      lifecycleHarness as typeof lifecycleHarness & {
        materializeNetworkPrerequisiteValues?: (
          values: string,
          apiProofSpkiSha256: string,
          release: string,
        ) => Record<string, unknown>;
      }
    ).materializeNetworkPrerequisiteValues;
    assert.equal(typeof materialize, 'function');

    for (const values of [
      'tenantAuthority: [',
      'tenantAuthority:\n  chartContentSha256: ' + 'c'.repeat(64) + '\nnetworkPolicy: {}\n',
    ]) {
      assert.throws(
        () => materialize!(values, 'a'.repeat(64), 'release-a'),
        /TENANT_POLICY_RELEASE_VALUES_INVALID/,
      );
    }
  });

  it('retains the rejected Kubernetes object type for invalid creates', () => {
    const createObjects = [
      { kind: 'ConfigMap', metadata: {} },
      {
        kind: 'Job',
        metadata: { labels: { 'commander.io/tenant-cutover-owner-execution': 'opaque' } },
      },
      {
        kind: 'Job',
        metadata: { labels: { 'commander.io/tenant-authority-proof-reader': 'true' } },
      },
    ];

    assert.deepEqual(
      createObjects.map((object) =>
        commandFailureCode(
          'kubectl',
          ['create', '--filename', '-'],
          JSON.stringify(object),
          'The ' + object.kind + ' is invalid',
        ),
      ),
      [
        'TENANT_CUTOVER_KUBECTL_CREATE_CONFIGMAP_INVALID',
        'TENANT_CUTOVER_KUBECTL_CREATE_OWNER_JOB_INVALID',
        'TENANT_CUTOVER_KUBECTL_CREATE_PROOF_JOB_INVALID',
      ],
    );
  });

  it('selects an API pod with a startup failure before a lexically earlier healthy pod', () => {
    const selectPod = (
      lifecycleHarness as typeof lifecycleHarness & {
        selectFailingApiPodName?: (items: unknown[]) => string | undefined;
      }
    ).selectFailingApiPodName;
    assert.equal(typeof selectPod, 'function');

    assert.equal(
      selectPod!([
        {
          metadata: { name: 'api-healthy-a' },
          status: {
            containerStatuses: [{ state: { running: {} }, lastState: {} }],
          },
        },
        {
          metadata: { name: 'api-crashing-z' },
          status: {
            containerStatuses: [
              { state: { waiting: { reason: 'CrashLoopBackOff' } }, lastState: {} },
            ],
          },
        },
      ]),
      'api-crashing-z',
    );
  });

  it('selects the failing API init container when the main container never started', () => {
    const selectContainer = (
      lifecycleHarness as typeof lifecycleHarness & {
        selectFailingApiContainerName?: (status: unknown) => string | undefined;
      }
    ).selectFailingApiContainerName;
    assert.equal(typeof selectContainer, 'function');

    assert.equal(
      selectContainer!({
        initContainerStatuses: [
          {
            name: 'migration-gate',
            state: { waiting: { reason: 'CrashLoopBackOff' } },
          },
        ],
        containerStatuses: [{ name: 'api', state: { waiting: { reason: 'PodInitializing' } } }],
      }),
      'migration-gate',
    );
  });

  it('selects a terminated API init container when Kubernetes records no waiting reason', () => {
    const selectContainer = (
      lifecycleHarness as typeof lifecycleHarness & {
        selectFailingApiContainerName?: (status: unknown) => string | undefined;
      }
    ).selectFailingApiContainerName;
    assert.equal(typeof selectContainer, 'function');

    assert.equal(
      selectContainer!({
        initContainerStatuses: [
          {
            name: 'api-proof-tls-materialize',
            state: { terminated: { reason: 'Error', exitCode: 1 } },
          },
        ],
        containerStatuses: [{ name: 'api', state: { waiting: { reason: 'PodInitializing' } } }],
      }),
      'api-proof-tls-materialize',
    );
  });

  it('retains only an allowlisted API startup code and hash from pod logs', () => {
    const diagnostic = (
      lifecycleHarness as typeof lifecycleHarness & {
        apiPodStartupFailureDiagnostic?: (
          logs: string,
          container: string,
          transport?: 'kubectl_logs' | 'kubectl_logs_unavailable',
        ) => string;
      }
    ).apiPodStartupFailureDiagnostic;
    assert.equal(typeof diagnostic, 'function');

    const logs = [
      'Error: TASK1_READINESS_CERT_FILE_OWNER_INVALID',
      'postgres://api:secret@database/commander',
      'opaque-api-startup-marker-3281',
    ].join('\n');
    const result = diagnostic!(logs, 'api');

    assert.match(
      result,
      /^code=TASK1_READINESS_CERT_FILE_OWNER_INVALID;producer=api_entrypoint;transport=kubectl_logs;container=api;log_sha256=[a-f0-9]{64}$/,
    );
    assert.doesNotMatch(result, /secret|opaque-api-startup-marker-3281/);
    assert.match(
      diagnostic!('opaque-api-startup-marker-9142', 'api-proof-tls-materialize'),
      /^code=TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED;producer=api_entrypoint;transport=kubectl_logs;container=api-proof-tls-materialize;log_sha256=[a-f0-9]{64}$/,
    );
    assert.match(
      diagnostic!('Error [ERR_MODULE_NOT_FOUND]: Cannot find package', 'api'),
      /^code=COMMANDER_API_RUNTIME_MODULE_NOT_FOUND;producer=api_entrypoint;transport=kubectl_logs;container=api;log_sha256=[a-f0-9]{64}$/,
    );
    assert.match(
      diagnostic!('Error: DATABASE_URL_REQUIRED', 'api'),
      /^code=DATABASE_URL_REQUIRED;producer=api_entrypoint;transport=kubectl_logs;container=api;log_sha256=[a-f0-9]{64}$/,
    );
    const migrationGateResult = diagnostic!(
      'COMMANDER_MIGRATION_FAILED stage=await code=MIGRATION_GATE_DATABASE_UNAVAILABLE',
      'migration-gate',
    );
    assert.match(
      migrationGateResult,
      /^code=COMMANDER_MIGRATION_FAILED;producer=api_entrypoint;transport=kubectl_logs;container=migration-gate;migration_gate_code=MIGRATION_GATE_DATABASE_UNAVAILABLE;log_sha256=[a-f0-9]{64}$/,
    );
    const migrationGateEvidence = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-external',
          passed: false,
          durationMs: 1,
          events: [],
          assertions: [],
          error: 'TENANT_CUTOVER_API_POD_STARTUP_FAILED:' + migrationGateResult,
        },
      ],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(migrationGateEvidence.scenarios[0]?.apiStartupFailure, {
      code: 'COMMANDER_MIGRATION_FAILED',
      producer: 'api_entrypoint',
      transport: 'kubectl_logs',
      container: 'migration-gate',
      migrationGateCode: 'MIGRATION_GATE_DATABASE_UNAVAILABLE',
      logSha256: migrationGateResult.match(/log_sha256=([a-f0-9]{64})$/)?.[1],
    });
    assert.match(
      diagnostic!('COMMANDER_API_STARTUP_FAILED: opaque startup detail', 'api'),
      /^code=COMMANDER_API_STARTUP_FAILED;producer=api_entrypoint;transport=kubectl_logs;container=api;log_sha256=[a-f0-9]{64}$/,
    );

    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 1,
          events: [],
          assertions: [],
          error:
            'TENANT_CUTOVER_API_POD_STARTUP_FAILED:' +
            result +
            '\npostgres://api:secret@database/commander opaque-api-startup-marker-3281',
        },
      ],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0]?.apiStartupFailure, {
      code: 'TASK1_READINESS_CERT_FILE_OWNER_INVALID',
      producer: 'api_entrypoint',
      transport: 'kubectl_logs',
      container: 'api',
      logSha256: result.match(/log_sha256=([a-f0-9]{64})$/)?.[1],
    });
    assert.equal(JSON.stringify(sanitized).includes('opaque-api-startup-marker-3281'), false);
  });

  it('retains only allowlisted API container termination facts', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 1,
          events: [],
          assertions: [],
          error:
            'TENANT_CUTOVER_API_POD_STARTUP_FAILED:code=TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED;' +
            'producer=api_entrypoint;transport=kubectl_logs;container=api-proof-tls-materialize;' +
            'termination_reason=Error;exit_code=1;log_sha256=' +
            'a'.repeat(64) +
            ';message=postgres://api:secret@database/commander',
        },
        {
          name: 'fresh-external',
          passed: false,
          durationMs: 1,
          events: [],
          assertions: [],
          error:
            'TENANT_CUTOVER_API_POD_STARTUP_FAILED:code=TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED;' +
            'producer=api_entrypoint;transport=kubectl_logs;termination_reason=Error;exit_code=999;' +
            'log_sha256=' +
            'b'.repeat(64),
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.apiStartupFailure, {
      code: 'TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED',
      producer: 'api_entrypoint',
      transport: 'kubectl_logs',
      terminationReason: 'Error',
      exitCode: 1,
      logSha256: 'a'.repeat(64),
      container: 'api-proof-tls-materialize',
    });
    assert.equal(JSON.stringify(sanitized).includes('postgres://'), false);
    assert.equal(sanitized.scenarios[1]?.apiStartupFailure, undefined);
  });

  it('extracts only an allowlisted terminated API container state', () => {
    const facts = (
      lifecycleHarness as typeof lifecycleHarness & {
        apiPodTerminationFacts?: (status: unknown) => unknown;
      }
    ).apiPodTerminationFacts;
    assert.equal(typeof facts, 'function');

    assert.deepEqual(
      facts!({
        containerStatuses: [
          {
            name: 'api',
            lastState: {
              terminated: {
                reason: 'Error',
                exitCode: 1,
                message: 'postgres://api:secret@database/commander',
              },
            },
          },
        ],
      }),
      { terminationReason: 'Error', exitCode: 1 },
    );
    assert.equal(
      facts!({
        containerStatuses: [
          { name: 'api', lastState: { terminated: { reason: 'SecretValue', exitCode: 1 } } },
        ],
      }),
      undefined,
    );
  });

  it('uses current API logs when the previous container has no classified startup failure', () => {
    const selectLogs = (
      lifecycleHarness as typeof lifecycleHarness & {
        selectApiPodStartupLogs?: (
          previousLogs: string,
          currentLogs: string,
          container: 'api',
        ) => string;
      }
    ).selectApiPodStartupLogs;
    assert.equal(typeof selectLogs, 'function');

    assert.equal(
      selectLogs!(
        'opaque previous output',
        'COMMANDER_API_STARTUP_FAILED: database unavailable',
        'api',
      ),
      'COMMANDER_API_STARTUP_FAILED: database unavailable',
    );
    assert.equal(
      selectLogs!(
        'DATABASE_URL_REQUIRED',
        'COMMANDER_API_STARTUP_FAILED: database unavailable',
        'api',
      ),
      'DATABASE_URL_REQUIRED',
    );
  });

  it('classifies finite rollout query, output-limit, empty, and nonterminal outcomes', () => {
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 1,
        stdout: '',
        stderr: 'private query failure',
      }),
      { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_QUERY_FAILED' },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 1,
        stdout: '',
        stderr: 'private oversized output',
        errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      }),
      { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT' },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stdout: 'x'.repeat(1024 * 1024 + 1),
        stderr: '',
      }),
      { kind: 'query-failure', code: 'TENANT_CUTOVER_ROLLOUT_OUTPUT_LIMIT' },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          items: [
            {
              kind: 'Pod',
              metadata: {
                labels: { 'app.kubernetes.io/component': 'worker' },
                annotations: { ignored: 'x'.repeat(128 * 1024) },
              },
              status: { conditions: [{ type: 'Ready', status: 'False' }] },
            },
          ],
        }),
      }),
      {
        kind: 'success',
        evidence: {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: 'POD_NOT_READY',
        },
      },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stdout: JSON.stringify({ items: [] }),
        stderr: '',
      }),
      { kind: 'success', evidence: { code: 'TENANT_CUTOVER_ROLLOUT_EMPTY' } },
    );
    assert.deepEqual(
      classifyRolloutObservation({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          items: [
            {
              kind: 'Pod',
              metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
              status: { conditions: [{ type: 'Ready', status: 'False', message: 'private' }] },
            },
          ],
        }),
      }),
      {
        kind: 'success',
        evidence: {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: 'POD_NOT_READY',
        },
      },
    );
  });

  it('selects terminal then pod, job, deployment and fixed component tie-breaks', () => {
    const observation = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Deployment',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: { conditions: [{ type: 'Available', status: 'False' }] },
          },
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: { active: 1 },
          },
          {
            kind: 'Pod',
            metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
            status: { conditions: [{ type: 'Ready', status: 'False' }] },
          },
          {
            kind: 'Pod',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    });
    assert.deepEqual(observation, {
      kind: 'terminal',
      evidence: {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Pod',
        component: 'api',
        reasonCode: 'POD_CRASH_LOOP_BACKOFF',
      },
    });
  });

  it('maps every nonterminal resource kind to its fixed reason code', () => {
    for (const [item, expected] of [
      [
        {
          kind: 'Deployment',
          metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
          status: { conditions: [{ type: 'Available', status: 'False', message: 'private' }] },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Deployment',
          component: 'api',
          reasonCode: 'DEPLOYMENT_UNAVAILABLE',
        },
      ],
      [
        {
          kind: 'Job',
          metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
          status: { active: 1 },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Job',
          component: 'migration',
          reasonCode: 'JOB_ACTIVE',
        },
      ],
      [
        {
          kind: 'Pod',
          metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
          status: { conditions: [{ type: 'Ready', status: 'False', message: 'private' }] },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: 'POD_NOT_READY',
        },
      ],
    ] as const) {
      assert.deepEqual(
        classifyRolloutObservation({
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({ items: [item] }),
        }),
        { kind: 'success', evidence: expected },
      );
    }
  });

  it('retains terminal evidence but replaces nonterminal state on successful healthy and empty polls', () => {
    const unready = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: { active: 1 },
          },
        ],
      }),
    });
    const healthy = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Deployment',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: { conditions: [{ type: 'Available', status: 'True' }] },
          },
        ],
      }),
    });
    const disappeared = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({ items: [] }),
    });
    const terminal = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: {
              conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }],
            },
          },
        ],
      }),
    });

    const earlyUnready = retainRolloutObservation(undefined, unready);
    assert.deepEqual(earlyUnready, {
      nonterminal: {
        code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
        resourceKind: 'Job',
        component: 'migration',
        reasonCode: 'JOB_ACTIVE',
      },
    });
    assert.deepEqual(retainRolloutObservation(earlyUnready, healthy), {});
    assert.deepEqual(retainRolloutObservation(earlyUnready, disappeared), {
      nonterminal: { code: 'TENANT_CUTOVER_ROLLOUT_EMPTY' },
    });
    const terminalState = retainRolloutObservation(earlyUnready, terminal);
    assert.deepEqual(retainRolloutObservation(terminalState, disappeared), terminalState);
  });

  it('retains a terminal observation captured after the cutover command fails', async () => {
    const terminal = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Deployment',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: {
              conditions: [
                { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' },
              ],
            },
          },
        ],
      }),
    });
    let startupCaptureCalls = 0;

    const diagnostics = await captureFinalCutoverFailureDiagnostics(
      'tenant-release',
      undefined,
      undefined,
      {
        observe: async (release) => {
          assert.equal(release, 'tenant-release');
          return terminal;
        },
        captureApiStartupFailure: async (release, observation) => {
          startupCaptureCalls += 1;
          assert.equal(release, 'tenant-release');
          assert.equal(observation, terminal);
          return undefined;
        },
      },
    );

    assert.deepEqual(diagnostics.rolloutObservation, {
      terminal: {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Deployment',
        component: 'api',
        reasonCode: 'DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED',
      },
    });
    assert.equal(startupCaptureCalls, 1);
  });

  it('replaces an early unclassified API startup capture with final classified evidence', async () => {
    const terminal = classifyRolloutObservation({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        items: [
          {
            kind: 'Pod',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    });
    const early = {
      code: 'TENANT_CUTOVER_API_POD_LOG_UNCLASSIFIED' as const,
      producer: 'api_entrypoint' as const,
      transport: 'kubectl_logs' as const,
      container: 'migration-gate' as const,
      logSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    };
    const final = {
      code: 'COMMANDER_API_STARTUP_FAILED' as const,
      producer: 'api_entrypoint' as const,
      transport: 'kubectl_logs' as const,
      container: 'migration-gate' as const,
      terminationReason: 'Error' as const,
      exitCode: 1,
      logSha256: 'a'.repeat(64),
    };
    let startupCaptureCalls = 0;

    const diagnostics = await captureFinalCutoverFailureDiagnostics(
      'tenant-release',
      { terminal: terminal.evidence },
      early,
      {
        observe: async () => terminal,
        captureApiStartupFailure: async () => {
          startupCaptureCalls += 1;
          return final;
        },
      },
    );

    assert.equal(startupCaptureCalls, 1);
    assert.deepEqual(diagnostics.apiStartupFailure, final);
  });

  it('sanitizes finite rollout observation records and rejects malicious extra fields', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_ROLLOUT_NONTERMINAL:resource_kind=Job;component=migration;reason_code=JOB_ACTIVE\nsecret=private',
        },
      ],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0], {
      name: 'fresh-bundled',
      passed: false,
      durationMs: 100,
      failureCodes: ['HELM_TENANT_CUTOVER_FAILED', 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL'],
      rolloutObservation: {
        code: 'TENANT_CUTOVER_ROLLOUT_NONTERMINAL',
        resourceKind: 'Job',
        component: 'migration',
        reasonCode: 'JOB_ACTIVE',
      },
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /private|secret/i);

    const malformed = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_ROLLOUT_NONTERMINAL:resource_kind=Job;component=migration;reason_code=JOB_ACTIVE;secret=private',
        },
      ],
      passed: false,
      sanitized: false,
    });
    assert.equal(malformed.scenarios[0]?.rolloutObservation, undefined);
  });

  it('retains a fixed current-proof revision mutation failure after proof cleanup', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          failedStage: 'current-proof',
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_PROOF_CREATED_HELM_REVISION:TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED\\nsecret=private',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0], {
      name: 'fresh-bundled',
      passed: false,
      durationMs: 100,
      failedStage: 'current-proof',
      failureCodes: [
        'HELM_TENANT_CUTOVER_FAILED',
        'TENANT_CUTOVER_PROOF_CREATED_HELM_REVISION',
        'TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED',
      ],
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /private|secret/i);
  });

  it('retains fixed current-proof validation failure codes after proof cleanup', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          failedStage: 'current-proof',
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_PROOF_RECEIPT_INVALID:TENANT_CUTOVER_PROOF_REVISION_MISMATCH:TENANT_CUTOVER_RESTORE_PROJECTION_DRIFT:TENANT_CUTOVER_RESTORE_PROOF_REQUIRED:TENANT_CUTOVER_RETAINED_CHART_DRIFT:TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED\\nsecret=private',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, [
      'HELM_TENANT_CUTOVER_FAILED',
      'TENANT_CUTOVER_PROOF_RECEIPT_INVALID',
      'TENANT_CUTOVER_PROOF_REVISION_MISMATCH',
      'TENANT_CUTOVER_RESTORE_PROJECTION_DRIFT',
      'TENANT_CUTOVER_RESTORE_PROOF_REQUIRED',
      'TENANT_CUTOVER_RETAINED_CHART_DRIFT',
      'TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED',
    ]);
    assert.doesNotMatch(JSON.stringify(sanitized), /private|secret/i);
  });

  it('retains fixed current-proof failures that occur before a rollout resource exists', () => {
    const currentProofFailureCodes = [
      'TENANT_CUTOVER_OWNER_RESPONSE_INVALID',
      'TENANT_CUTOVER_PROOF_CURRENT_CHANGED',
      'TENANT_CUTOVER_RESTORE_EVIDENCE_INVALID',
      'TENANT_CUTOVER_RESTORE_HISTORY_INVALID',
      'TENANT_CUTOVER_RESTORE_PROJECTION_INVALID',
      'TENANT_CUTOVER_RESTORE_SECRET_MAPPING_INVALID',
      'TENANT_CUTOVER_PROOF_JOB_INVALID',
      'TENANT_CUTOVER_PROOF_OWNER_SECRET_CREATE_FAILED',
      'TENANT_CUTOVER_PROOF_OWNER_SECRET_INVALID',
      'TENANT_CUTOVER_PROOF_JOB_CREATE_FAILED',
    ];

    for (const failureCode of currentProofFailureCodes) {
      const sanitized = sanitizeEvidence({
        generatedAt: '2024-01-01T00:00:00Z',
        cluster: 'test',
        kindNodeImage: KIND_NODE_IMAGE,
        chartPath: '/private/chart',
        calicoUrl: CALICO_URL,
        scenarios: [
          {
            name: 'fresh-bundled',
            passed: false,
            durationMs: 100,
            events: [],
            assertions: [],
            failedStage: 'current-proof',
            error:
              'HELM_TENANT_CUTOVER_FAILED:' +
              failureCode +
              ':TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED\\nsecret=private',
          },
        ],
        passed: false,
        sanitized: false,
      });

      assert.deepEqual(sanitized.scenarios[0]?.failureCodes, [
        'HELM_TENANT_CUTOVER_FAILED',
        failureCode,
        'TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED',
      ]);
      assert.doesNotMatch(JSON.stringify(sanitized), /secret=private/i);
    }
  });

  it('classifies exact controller rollout failures without retaining object data', () => {
    for (const [item, expected] of [
      [
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: {
            name: 'tenant-secret-deployment',
            namespace: 'tenant-secret-namespace',
            uid: 'sensitive-uid',
            labels: { 'app.kubernetes.io/component': 'api' },
          },
          status: {
            conditions: [
              {
                type: 'Progressing',
                status: 'False',
                reason: 'ProgressDeadlineExceeded',
                message: 'private probe endpoint failed',
              },
            ],
          },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Deployment',
          component: 'api',
          reasonCode: 'DEPLOYMENT_PROGRESS_DEADLINE_EXCEEDED',
        },
      ],
      [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {
            name: 'tenant-migration-secret',
            labels: { 'app.kubernetes.io/component': 'migration' },
          },
          status: { conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }] },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Job',
          component: 'migration',
          reasonCode: 'JOB_DEADLINE_EXCEEDED',
        },
      ],
      [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {
            name: 'tenant-proof-secret',
            labels: { 'commander.io/tenant-authority-proof-reader': 'true' },
          },
          status: {
            conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }],
          },
        },
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Job',
          component: 'tenant-cutover-proof',
          reasonCode: 'JOB_BACKOFF_LIMIT_EXCEEDED',
        },
      ],
    ] as const) {
      const classified = classifyRolloutFailureJson(
        JSON.stringify({ kind: 'List', items: [item] }),
      );
      assert.deepEqual(classified, expected);
      assert.doesNotMatch(
        JSON.stringify(classified),
        /tenant-secret|tenant-secret-namespace|sensitive-uid|private probe/i,
      );
    }
  });

  it('classifies exact pod rollout failures without container detail', () => {
    for (const [status, expectedReason] of [
      [
        { conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable' }] },
        'POD_UNSCHEDULABLE',
      ],
      [
        { containerStatuses: [{ state: { waiting: { reason: 'ImagePullBackOff' } } }] },
        'POD_IMAGE_PULL_FAILED',
      ],
      [
        {
          initContainerStatuses: [{ state: { waiting: { reason: 'CreateContainerConfigError' } } }],
        },
        'POD_CONTAINER_CONFIG_ERROR',
      ],
      [
        { containerStatuses: [{ state: { waiting: { reason: 'RunContainerError' } } }] },
        'POD_CONTAINER_START_FAILED',
      ],
      [
        { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
        'POD_CRASH_LOOP_BACKOFF',
      ],
      [
        {
          containerStatuses: [
            {
              lastState: { terminated: { reason: 'OOMKilled' } },
              state: { waiting: { reason: 'CrashLoopBackOff' } },
            },
          ],
        },
        'POD_OOM_KILLED',
      ],
    ] as const) {
      assert.deepEqual(
        classifyRolloutFailureJson(
          JSON.stringify({
            kind: 'List',
            items: [
              {
                kind: 'Pod',
                metadata: {
                  name: 'tenant-pod-secret',
                  labels: { 'app.kubernetes.io/component': 'worker' },
                },
                status: { ...status, message: 'secret SQL detail' },
              },
            ],
          }),
        ),
        {
          code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
          resourceKind: 'Pod',
          component: 'worker',
          reasonCode: expectedReason,
        },
      );
    }
  });

  it('classifies a failed migration Pod termination before Helm atomic cleanup', () => {
    assert.deepEqual(
      classifyRolloutFailureJson(
        JSON.stringify({
          kind: 'List',
          items: [
            {
              kind: 'Pod',
              metadata: {
                name: 'tenant-migration-secret',
                labels: { 'commander.io/migration-client-v2': 'true' },
              },
              status: {
                phase: 'Failed',
                containerStatuses: [{ state: { terminated: { reason: 'Error', exitCode: 1 } } }],
              },
            },
          ],
        }),
      ),
      {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Pod',
        component: 'migration',
        reasonCode: 'POD_CONTAINER_TERMINATED',
      },
    );
  });

  it('classifies a failed proof Pod termination before Helm atomic cleanup', () => {
    assert.deepEqual(
      classifyRolloutFailureJson(
        JSON.stringify({
          kind: 'List',
          items: [
            {
              kind: 'Pod',
              metadata: {
                name: 'tenant-proof-secret',
                labels: { 'commander.io/tenant-authority-proof-reader': 'true' },
              },
              status: {
                phase: 'Failed',
                containerStatuses: [{ state: { terminated: { reason: 'Error', exitCode: 1 } } }],
              },
            },
          ],
        }),
      ),
      {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Pod',
        component: 'tenant-cutover-proof',
        reasonCode: 'POD_CONTAINER_TERMINATED',
      },
    );
  });

  it('classifies a failed zero-backoff Job before its failure condition propagates', () => {
    assert.deepEqual(
      classifyRolloutFailureJson(
        JSON.stringify({
          kind: 'List',
          items: [
            {
              kind: 'Job',
              metadata: {
                name: 'tenant-proof-secret',
                labels: { 'commander.io/tenant-authority-proof-reader': 'true' },
              },
              spec: { backoffLimit: 0 },
              status: { failed: 1 },
            },
          ],
        }),
      ),
      {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Job',
        component: 'tenant-cutover-proof',
        reasonCode: 'JOB_BACKOFF_LIMIT_EXCEEDED',
      },
    );
  });

  it('maps migration and proof Pods from fixed labels rather than names', () => {
    const migration = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Pod',
            metadata: {
              name: 'sensitive-randomized-name',
              labels: { 'commander.io/migration-client-v2': 'true' },
            },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    );
    const proof = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Pod',
            metadata: {
              name: 'sensitive-proof-name',
              labels: { 'commander.io/tenant-authority-proof-reader': 'true' },
            },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    );
    assert.equal(migration?.component, 'migration');
    assert.equal(proof?.component, 'tenant-cutover-proof');
  });

  it('rejects malformed, unknown, and oversized rollout observations', () => {
    assert.equal(classifyRolloutFailureJson('not-json'), undefined);
    assert.equal(
      classifyRolloutFailureJson(
        JSON.stringify({
          items: [
            {
              kind: 'Pod',
              metadata: { labels: { 'app.kubernetes.io/component': 'unknown' } },
              status: { containerStatuses: [{ state: { waiting: { reason: 'PrivateReason' } } }] },
            },
          ],
        }),
      ),
      undefined,
    );
    assert.equal(
      classifyRolloutFailureJson(JSON.stringify({ items: Array.from({ length: 65 }) })),
      undefined,
    );
    assert.equal(classifyRolloutFailureJson('x'.repeat(65 * 1024)), undefined);
  });

  it('selects one deterministic highest-priority rollout failure', () => {
    const classified = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Deployment',
            metadata: { labels: { 'app.kubernetes.io/component': 'api' } },
            status: {
              conditions: [
                { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded' },
              ],
            },
          },
          {
            kind: 'Pod',
            metadata: { labels: { 'app.kubernetes.io/component': 'worker' } },
            status: { containerStatuses: [{ state: { waiting: { reason: 'CrashLoopBackOff' } } }] },
          },
        ],
      }),
    );
    assert.deepEqual(classified, {
      code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
      resourceKind: 'Pod',
      component: 'worker',
      reasonCode: 'POD_CRASH_LOOP_BACKOFF',
    });
  });

  it('retains observed evidence when a later atomic rollback observation is empty', () => {
    const observed = classifyRolloutFailureJson(
      JSON.stringify({
        items: [
          {
            kind: 'Job',
            metadata: { labels: { 'app.kubernetes.io/component': 'migration' } },
            status: {
              conditions: [{ type: 'Failed', status: 'True', reason: 'DeadlineExceeded' }],
            },
          },
        ],
      }),
    );
    assert.deepEqual(retainRolloutFailureEvidence(observed, undefined), observed);
  });

  it('sanitizes a valid rollout record and excludes hostile raw content', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/tenant-secret/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [{ message: 'private event' }],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_HELM_COMMAND_FAILED:TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED:resource_kind=Job;component=migration;reason_code=JOB_DEADLINE_EXCEEDED\nname=tenant-secret;message=private SQL SELECT;stderr=secret',
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0], {
      name: 'fresh-bundled',
      passed: false,
      durationMs: 100,
      failureCodes: [
        'HELM_TENANT_CUTOVER_FAILED',
        'TENANT_CUTOVER_HELM_COMMAND_FAILED',
        'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
      ],
      rolloutFailure: {
        code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
        resourceKind: 'Job',
        component: 'migration',
        reasonCode: 'JOB_DEADLINE_EXCEEDED',
      },
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /tenant-secret|private|SELECT|stderr|secret/i);
  });

  it('retains rollout failure details when an owner record follows the canonical record', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED:resource_kind=Job;component=migration;reason_code=JOB_BACKOFF_LIMIT_EXCEEDED:code=TENANT_CUTOVER_OWNER_JOB_LOG_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;log_sha256=' +
            'f'.repeat(64),
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.rolloutFailure, {
      code: 'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
      resourceKind: 'Job',
      component: 'migration',
      reasonCode: 'JOB_BACKOFF_LIMIT_EXCEEDED',
    });
  });

  it('rejects malformed rollout records and preserves existing Helm failure codes', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_HELM_COMMAND_FAILED:TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED:TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED:resource_kind=Pod;component=api;reason_code=POD_CRASH_LOOP_BACKOFF;name=tenant-secret',
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    });
    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, [
      'HELM_TENANT_CUTOVER_FAILED',
      'TENANT_CUTOVER_HELM_COMMAND_FAILED',
      'TENANT_CUTOVER_ROLLOUT_RESOURCE_UNCLASSIFIED',
      'TENANT_CUTOVER_ROLLOUT_RESOURCE_FAILED',
    ]);
    assert.equal(sanitized.scenarios[0]?.rolloutFailure, undefined);
  });

  it('retains the fixed proof Job failure code', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_PROOF_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=rollout_proof;proof_code=TENANT_CUTOVER_KUBERNETES_PROOF_INVALID;proof_invariant=task1KubernetesProofObserver.ts:1012:7;log_sha256=' +
            '8'.repeat(64),
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, [
      'HELM_TENANT_CUTOVER_FAILED',
      'TENANT_CUTOVER_PROOF_JOB_FAILED',
      'COMMANDER_MIGRATION_FAILED',
    ]);
  });

  it('retains only a parsed allowlisted owner failure record and source revision', () => {
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=owner_pool_connect;log_sha256=' +
          'a'.repeat(64),
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'owner_pool_connect',
        logSha256: 'a'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_PROOF_HOOK_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=' +
          'b'.repeat(64),
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_initialize',
        logSha256: 'b'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_PROOF_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=rollout_proof;proof_code=TENANT_CUTOVER_KUBERNETES_PROOF_INVALID;proof_invariant=task1KubernetesProofObserver.js:812:9;log_sha256=' +
          '8'.repeat(64),
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'rollout_proof',
        proofCode: 'TENANT_CUTOVER_KUBERNETES_PROOF_INVALID',
        proofInvariant: 'task1KubernetesProofObserver.js:812:9',
        logSha256: '8'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=TASK1_CLOSURE_BASELINE_REQUIRED;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
          '9'.repeat(64) +
          '\nNAME READY STATUS secret raw detail',
      ),
      {
        code: 'TASK1_CLOSURE_BASELINE_REQUIRED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        logSha256: '9'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_OWNER_JOB_FAILED:code=TENANT_CUTOVER_OWNER_JOB_POD_UNAVAILABLE;producer=owner_entrypoint;transport=kubectl_logs_unavailable;owner_stage=lifecycle_transaction;log_sha256=' +
          'a'.repeat(64),
      ),
      {
        code: 'TENANT_CUTOVER_OWNER_JOB_POD_UNAVAILABLE',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs_unavailable',
        ownerStage: 'lifecycle_transaction',
        logSha256: 'a'.repeat(64),
      },
    );
    for (const ownerStage of [
      'lifecycle_pinned_manifest_validation',
      'lifecycle_prepared_request_validation',
      'lifecycle_table_discovery',
      'lifecycle_initialization_planning',
      'lifecycle_descriptor_transaction',
      'lifecycle_peer_reobservation',
      'lifecycle_peer_reobservation_input_consistency',
      'lifecycle_peer_reobservation_candidate_binding_validation',
      'lifecycle_peer_reobservation_observed_binding_validation',
      'lifecycle_peer_reobservation_binding_consistency',
    ] as const) {
      assert.deepEqual(
        parseOwnerFailureEvidence(
          'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=' +
            ownerStage +
            ';log_sha256=' +
            'f'.repeat(64),
        ),
        {
          code: 'COMMANDER_MIGRATION_FAILED',
          producer: 'owner_entrypoint',
          transport: 'kubectl_logs',
          ownerStage,
          logSha256: 'f'.repeat(64),
        },
      );
    }
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=origin_classification;origin_classification_step=role_envelope;log_sha256=' +
          'e'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        snapshotValidation: 'origin_classification',
        originClassificationStep: 'role_envelope',
        logSha256: 'e'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_validation=identity_validation;log_sha256=' +
          'd'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        snapshotValidation: 'identity_validation',
        logSha256: 'd'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;snapshot_transaction=begin;log_sha256=' +
          'c'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        snapshotTransaction: 'begin',
        logSha256: 'c'.repeat(64),
      },
    );
    assert.deepEqual(
      parseOwnerFailureEvidence(
        'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_prebootstrap_snapshot;snapshot=s0;catalog_step=functions;log_sha256=' +
          'b'.repeat(64) +
          '\nNAME   READY   STATUS\npod/postgres-0   1/1   Running',
      ),
      {
        code: 'COMMANDER_MIGRATION_FAILED',
        producer: 'owner_entrypoint',
        transport: 'kubectl_logs',
        ownerStage: 'lifecycle_prebootstrap_snapshot',
        snapshot: 's0',
        catalogStep: 'functions',
        logSha256: 'b'.repeat(64),
      },
    );
    assert.equal(
      productionImageSourceRevision({ GITHUB_SHA: 'b'.repeat(40) }, () => 'c'.repeat(40)),
      'b'.repeat(40),
    );
    assert.equal(
      productionImageSourceRevision({}, () => 'c'.repeat(40)),
      'c'.repeat(40),
    );
    assert.equal(
      parseOwnerFailureEvidence(
        'code=PRIVATE_SECRET_VALUE;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
          'f'.repeat(64),
      ),
      undefined,
    );
    assert.equal(
      parseOwnerFailureEvidence(
        'code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=rollout_proof;proof_code=PRIVATE_PROOF_CODE;proof_invariant=task1KubernetesProofObserver.ts:0:0;log_sha256=' +
          '7'.repeat(64),
      ),
      undefined,
    );
    assert.equal(parseOwnerFailureEvidence('postgres://owner:secret@db private detail'), undefined);
  });

  it('serializes a parsed owner failure without retaining the child-process output', () => {
    const record = ownerFailureEvidenceRecord({
      code: 'COMMANDER_MIGRATION_FAILED',
      producer: 'owner_entrypoint',
      transport: 'kubectl_logs',
      ownerStage: 'lifecycle_initialize',
      logSha256: 'c'.repeat(64),
    });

    assert.equal(
      record,
      'code=COMMANDER_MIGRATION_FAILED;producer=owner_entrypoint;transport=kubectl_logs;owner_stage=lifecycle_initialize;log_sha256=' +
        'c'.repeat(64),
    );
    assert.doesNotMatch(record, /secret|postgres|stderr|output/i);
  });

  it('pins Kubernetes 1.33.2 and the expected digest', () => {
    assert.match(KIND_NODE_IMAGE, /kindest\/node:v1\.33\.2/);
    assert.match(KIND_NODE_IMAGE, /sha256:[a-f0-9]{64}/);
  });

  it('selects immutable Kind node manifests for both supported CI architectures', () => {
    assert.equal(
      kindNodeImageForArchitecture('x64'),
      'kindest/node:v1.33.2@sha256:18e6c8f260d51cda4bc32d9f1a4852f9e693c7b667aa14321996ed7c411fc121',
    );
    assert.equal(
      kindNodeImageForArchitecture('arm64'),
      'kindest/node:v1.33.2@sha256:2206121406df04dd321ea04919c7a1a3c3b12220770b4a62dc5e57e2cfab4dad',
    );
    assert.throws(() => kindNodeImageForArchitecture('ia32'), /KIND_ARCHITECTURE_UNSUPPORTED/);
  });

  it('selects immutable Calico and PostgreSQL manifests for both supported architectures', () => {
    assert.deepEqual(calicoImagesForArchitecture('arm64'), [
      'docker.io/calico/cni:v3.29.0@sha256:173ea2834c655eeee3aa9c3491c7ef6d75a2de1e622e127f524f02a4e1918f17',
      'docker.io/calico/node:v3.29.0@sha256:f74ff658399ab2c7deb7cb28f2eccccd303d22bfd674b32547a8e6d83a44ac7c',
      'docker.io/calico/kube-controllers:v3.29.0@sha256:38d28083aad4783556c4172df0cfcca30e31b1a323017bb74988ea95ca391c14',
    ]);
    assert.deepEqual(calicoImagesForArchitecture('x64'), [
      'docker.io/calico/cni:v3.29.0@sha256:10643eba882c49d2558ee1f047ab4b42283c4b3e9e0864e4007e46c9faf5d50e',
      'docker.io/calico/node:v3.29.0@sha256:ec9fc719f8b51397fff195d60c7d12d4149fa08c3167a6485e7691119560451f',
      'docker.io/calico/kube-controllers:v3.29.0@sha256:10a8342ee971aeb53cfe94599f1ba7048ff815e43689014cd436cc46d4d7d1e0',
    ]);
    assert.equal(
      postgresImageForArchitecture('arm64'),
      'docker.io/library/postgres:16-alpine@sha256:7ae1143a9f249af815f056751a122a86d7e44ddce0926f2b227e3d5c434444f4',
    );
    assert.throws(() => calicoImagesForArchitecture('ia32'), /KIND_ARCHITECTURE_UNSUPPORTED/);
  });

  it('uses ECDSA-compatible key usage for live fixture leaf certificates', () => {
    const extensions = leafCertificateExtensions(['postgres.default.svc']);
    assert.match(extensions, /keyUsage=critical,digitalSignature\n/);
    assert.doesNotMatch(extensions, /keyEncipherment/);
  });

  it('bounds namespace cleanup and requires every control-plane component after image imports', () => {
    assert.deepEqual(namespaceCleanupArgs('commander-lifecycle'), [
      'delete',
      'namespace',
      'commander-lifecycle',
      '--ignore-not-found=true',
      '--wait=true',
      '--timeout=120s',
    ]);
    assert.deepEqual(controlPlaneReadinessSelectors(), [
      'component=etcd',
      'component=kube-apiserver',
      'component=kube-controller-manager',
      'component=kube-scheduler',
    ]);
  });

  it('authenticates operator kubectl calls with the issued ServiceAccount token', () => {
    assert.deepEqual(serviceAccountTokenArgs('issued-service-account-token', ['get', 'pods']), [
      '--token',
      'issued-service-account-token',
      'get',
      'pods',
    ]);
  });

  it('builds an exact administrator token review for the issued operator credential', () => {
    const tokenReview = (
      lifecycleHarness as typeof lifecycleHarness & {
        operatorTokenReview?: (token: string) => Record<string, unknown>;
      }
    ).operatorTokenReview;
    assert.equal(typeof tokenReview, 'function');

    assert.deepEqual(tokenReview!('issued-service-account-token'), {
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenReview',
      spec: {
        token: 'issued-service-account-token',
      },
    });
    assert.throws(
      () => tokenReview!('issued service account token'),
      /TENANT_POLICY_OPERATOR_TOKEN_INVALID/,
    );
  });

  it('accepts only an authenticated operator token review for the expected subject', () => {
    const verifyTokenReview = (
      lifecycleHarness as typeof lifecycleHarness & {
        verifyOperatorTokenReview?: (review: unknown, subject: string) => void;
      }
    ).verifyOperatorTokenReview;
    assert.equal(typeof verifyTokenReview, 'function');

    const subject = 'system:serviceaccount:commander-lifecycle:tenant-migration-operator';
    assert.doesNotThrow(() =>
      verifyTokenReview!({ status: { authenticated: true, user: { username: subject } } }, subject),
    );
    assert.throws(
      () => verifyTokenReview!({ status: { authenticated: false } }, subject),
      /TENANT_POLICY_OPERATOR_TOKEN_INVALID/,
    );
    assert.throws(
      () =>
        verifyTokenReview!(
          {
            status: {
              authenticated: true,
              user: { username: 'system:serviceaccount:commander-lifecycle:other' },
            },
          },
          subject,
        ),
      /TENANT_POLICY_SUBJECT_MISMATCH/,
    );
  });

  it('builds exact administrator subject access reviews for the issued operator subject', () => {
    const accessReview = (
      lifecycleHarness as typeof lifecycleHarness & {
        operatorSubjectAccessReview?: (
          subject: string,
          verb: string,
          resource: string,
          name?: string,
        ) => Record<string, unknown>;
      }
    ).operatorSubjectAccessReview;
    assert.equal(typeof accessReview, 'function');

    assert.deepEqual(
      accessReview!(
        'system:serviceaccount:commander-lifecycle:tenant-migration-operator',
        'delete',
        'validatingadmissionpolicies.admissionregistration.k8s.io',
        'tenant-policy-guard',
      ),
      {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SubjectAccessReview',
        spec: {
          user: 'system:serviceaccount:commander-lifecycle:tenant-migration-operator',
          resourceAttributes: {
            verb: 'delete',
            group: 'admissionregistration.k8s.io',
            resource: 'validatingadmissionpolicies',
            name: 'tenant-policy-guard',
          },
        },
      },
    );
  });

  it('accepts only explicit administrator subject access decisions', () => {
    const verifyAccessReview = (
      lifecycleHarness as typeof lifecycleHarness & {
        verifyOperatorSubjectAccessReview?: (review: unknown) => boolean;
      }
    ).verifyOperatorSubjectAccessReview;
    assert.equal(typeof verifyAccessReview, 'function');
    assert.equal(verifyAccessReview!({ status: { allowed: true } }), true);
    assert.equal(verifyAccessReview!({ status: { allowed: false } }), false);
    assert.throws(
      () => verifyAccessReview!({ status: {} }),
      /TENANT_POLICY_OPERATOR_RBAC_REVIEW_FAILED/,
    );
  });

  it('retries only transient admission readiness failures', () => {
    assert.equal(prerequisiteRetryableFailure('TENANT_POLICY_ADMISSION_NOT_READY'), true);
    assert.equal(
      prerequisiteRetryableFailure(
        'TENANT_CUTOVER_KUBECTL_CREATE_SELF_SUBJECT_ACCESS_REVIEW_FORBIDDEN',
      ),
      false,
    );
    assert.equal(
      prerequisiteRetryableFailure('TENANT_CUTOVER_KUBECTL_CREATE_TOKEN_REVIEW_FORBIDDEN'),
      false,
    );
    assert.equal(
      prerequisiteRetryableFailure('TENANT_CUTOVER_KUBECTL_CREATE_NETWORK_POLICY_FORBIDDEN'),
      false,
    );
    assert.equal(prerequisiteRetryableFailure('TENANT_POLICY_SUBJECT_MISMATCH'), false);
  });

  it('isolates operator commands from administrator client credentials', () => {
    const tokenOnlyKubeconfig = (
      lifecycleHarness as typeof lifecycleHarness & {
        tokenOnlyKubeconfig?: (server: string, certificateAuthorityData: string) => string;
      }
    ).tokenOnlyKubeconfig;
    const operatorKubectlArgs = (
      lifecycleHarness as typeof lifecycleHarness & {
        operatorKubectlArgs?: (
          token: string,
          kubeconfigPath: string,
          commandArgs: readonly string[],
        ) => string[];
      }
    ).operatorKubectlArgs;

    assert.equal(typeof tokenOnlyKubeconfig, 'function');
    assert.equal(typeof operatorKubectlArgs, 'function');

    const kubeconfig = tokenOnlyKubeconfig!(
      'https://127.0.0.1:6443',
      Buffer.from('public-ca').toString('base64'),
    );
    assert.match(kubeconfig, /server: https:\/\/127\.0\.0\.1:6443/);
    assert.match(kubeconfig, /certificate-authority-data: cHVibGljLWNh/);
    assert.doesNotMatch(kubeconfig, /client-certificate|client-key|token:/);
    assert.deepEqual(
      operatorKubectlArgs!('issued-service-account-token', '/tmp/operator-kubeconfig', [
        'get',
        'pods',
      ]),
      [
        '--kubeconfig',
        '/tmp/operator-kubeconfig',
        '--token',
        'issued-service-account-token',
        'get',
        'pods',
      ],
    );
  });

  it('removes the prerequisite admission binding before its policy', () => {
    assert.deepEqual(prerequisiteAdmissionCleanupCommands('tenant-policy-guard'), [
      [
        'delete',
        'validatingadmissionpolicybindings.admissionregistration.k8s.io',
        'tenant-policy-guard',
        '--ignore-not-found=true',
        '--wait=true',
      ],
      [
        'delete',
        'validatingadmissionpolicies.admissionregistration.k8s.io',
        'tenant-policy-guard',
        '--ignore-not-found=true',
        '--wait=true',
      ],
    ]);
  });

  it('requires the exact supported Helm runtime', () => {
    assert.doesNotThrow(() => assertHelmVersion('v3.17.3+ge4da497'));
    assert.doesNotThrow(() => assertHelmVersion('v3.17.3'));
    assert.throws(() => assertHelmVersion('v3.17.3-rc.1'), /HELM_VERSION_INVALID/);
    assert.throws(() => assertHelmVersion('v4.2.3+g43e8b7f'), /HELM_VERSION_INVALID/);
  });

  it('builds digest-pinned production values with all six database roles sealed', () => {
    const values = buildLifecycleValues({
      namespace: 'commander-lifecycle',
      release: 'cmdr-live',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      databaseSpkiSha256: 'b'.repeat(64),
      logLevel: 'info',
      kubernetesApiServiceIp: '10.96.0.1',
      kubernetesApiEndpointIp: '172.18.0.2',
    });
    assert.match(values, /repository: commander-lifecycle-api/);
    assert.match(values, new RegExp(`digest: sha256:${'a'.repeat(64)}`));
    assert.match(values, /bundled: true\n    user: postgres/);
    assert.match(values, /existingSecret: cmdr-live-database-tls/);
    assert.match(values, /redis:\n  enabled: true/);
    assert.match(values, /redis:\n  enabled: true\n  persistence:\n    enabled: false/);
    assert.match(
      values,
      /migrationOperator:\n    subject: system:serviceaccount:commander-lifecycle:tenant-migration-operator/,
    );
    assert.match(
      values,
      /kubernetesApiCidrs:\n      - 10\.96\.0\.1\/32\n      - 172\.18\.0\.2\/32/,
    );
    for (const role of ['owner', 'app', 'tenant-authority', 'scheduler', 'worker', 'adapter-ops']) {
      assert.match(values, new RegExp(`- ${role}`));
    }
    assert.doesNotMatch(values, /commander-lifecycle-noop/);
  });

  it('retains the bundled database Secret reference across lifecycle upgrades', () => {
    const values = buildLifecycleValues({
      namespace: 'commander-lifecycle',
      release: 'cmdr-live',
      imageDigest: 'sha256:' + 'a'.repeat(64),
      databaseSpkiSha256: 'b'.repeat(64),
      logLevel: 'warn',
      kubernetesApiServiceIp: '10.96.0.1',
      kubernetesApiEndpointIp: '172.18.0.2',
      database: { kind: 'bundled', secretName: 'cmdr-live-database-bootstrap' },
    });
    assert.match(
      values,
      /bundled: true\n    user: postgres\n    existingSecret: cmdr-live-database-bootstrap/,
    );
  });

  it('builds a real external PostgreSQL TLS lifecycle configuration', () => {
    const values = buildLifecycleValues({
      namespace: 'commander-lifecycle',
      release: 'cmdr-external',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      databaseSpkiSha256: 'b'.repeat(64),
      logLevel: 'info',
      kubernetesApiServiceIp: '10.96.0.1',
      kubernetesApiEndpointIp: '172.18.0.2',
      database: {
        kind: 'external',
        secretName: 'cmdr-external-database',
        caSecret: 'cmdr-external-database-ca',
        bootstrapAuthoritySecret: 'cmdr-external-bootstrap',
        serviceNamespace: 'external-db',
        serviceName: 'external-postgres',
        podIp: '10.244.0.42',
      },
    });
    assert.match(values, /bundled: false/);
    assert.match(values, /existingSecret: cmdr-external-database/);
    assert.match(values, /caSecret: cmdr-external-database-ca/);
    assert.match(values, /bootstrapAuthoritySecret: cmdr-external-bootstrap/);
    assert.match(
      values,
      /egress:\n    databaseCidrs:\n      - 10\.244\.0\.42\/32\n    kubernetesApiCidrs:\n      - 10\.96\.0\.1\/32\n      - 172\.18\.0\.2\/32/,
    );
    assert.match(
      values,
      /databaseEndpoints:\n    - roles:\n        - owner\n        - app\n        - tenant-authority\n        - scheduler\n        - worker\n        - adapter-ops\n      cidr:\n        cidr: 10\.244\.0\.42\/32\n        port: 5432\n/,
    );
    assert.doesNotMatch(values, /existingSecret: cmdr-external-database-tls/);
  });

  it('provisions external PostgreSQL with TLS and the exact six-role E2 envelope', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const serialized = JSON.stringify(resources);
    assert.match(serialized, /ssl=on/);
    assert.match(serialized, /ssl_ca_file=\/run\/commander\/database-tls\/ca\.crt/);
    assert.match(serialized, /ssl_cert_file=\/run\/commander\/database-tls\/tls\.crt/);
    assert.match(serialized, /ssl_key_file=\/run\/commander\/database-tls\/tls\.key/);
    assert.match(serialized, /external-postgres-tls/);
    for (const role of [
      'commander_owner',
      'commander_app',
      'commander_tenant_authority',
      'commander_scheduler',
      'commander_worker',
      'commander_adapter_ops',
    ]) {
      assert.match(serialized, new RegExp(`CREATE ROLE ${role}`));
    }
    assert.equal((resources as { items?: unknown[] }).items?.length, 3);
  });

  it('pins owner memberships to the exact PostgreSQL 16 privilege envelope', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const externalInit = JSON.stringify(resources);
    const bundledInit = readFileSync(
      resolve('deploy/helm/commander/templates/configmap-database-init.yaml'),
      'utf8',
    );
    for (const role of [
      'commander_app',
      'commander_tenant_authority',
      'commander_scheduler',
      'commander_worker',
      'commander_adapter_ops',
    ]) {
      const grant = new RegExp(
        `GRANT ${role} TO commander_owner WITH ADMIN OPTION, INHERIT FALSE, SET TRUE;`,
      );
      assert.match(externalInit, grant);
      assert.match(bundledInit, grant);
    }
  });

  it('pins fresh E2 database ownership and removes ambient PUBLIC access', () => {
    const resources = buildExternalPostgresResources({
      namespace: 'external-db',
      image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
      credentialsSecret: 'external-postgres-credentials',
      tlsSecret: 'external-postgres-tls',
    });
    const initializers = [
      JSON.stringify(resources),
      readFileSync(resolve('deploy/helm/commander/templates/configmap-database-init.yaml'), 'utf8'),
    ];
    for (const initializer of initializers) {
      assert.match(
        initializer,
        /ALTER DATABASE (?:commander|\$\{POSTGRES_DB\}) OWNER TO commander_owner;/,
      );
      assert.match(initializer, /ALTER SCHEMA public OWNER TO commander_owner;/);
      assert.match(
        initializer,
        /REVOKE ALL ON DATABASE (?:commander|\$\{POSTGRES_DB\}) FROM PUBLIC;/,
      );
      assert.match(initializer, /REVOKE ALL ON SCHEMA public FROM PUBLIC;/);
      assert.doesNotMatch(initializer, /GRANT ALL PRIVILEGES ON DATABASE/);
      assert.doesNotMatch(initializer, /GRANT CREATE ON SCHEMA public TO commander_owner/);
      for (const role of [
        'commander_app',
        'commander_tenant_authority',
        'commander_scheduler',
        'commander_worker',
        'commander_adapter_ops',
      ]) {
        assert.match(
          initializer,
          new RegExp(`GRANT CONNECT ON DATABASE (?:commander|\\$\\{POSTGRES_DB\\}) TO ${role};`),
        );
        assert.match(initializer, new RegExp(`GRANT USAGE ON SCHEMA public TO ${role};`));
      }
    }
  });

  it('creates both fresh E2 fixtures with exact role attributes and app settings', () => {
    const initializers = [
      JSON.stringify(
        buildExternalPostgresResources({
          namespace: 'external-db',
          image: `docker.io/library/postgres:16-alpine@sha256:${'c'.repeat(64)}`,
          credentialsSecret: 'external-postgres-credentials',
          tlsSecret: 'external-postgres-tls',
        }),
      ),
      readFileSync(resolve('deploy/helm/commander/templates/configmap-database-init.yaml'), 'utf8'),
    ];
    const roleAttributes = new Map([
      ['commander_owner', 'NOSUPERUSER NOCREATEDB CREATEROLE INHERIT NOREPLICATION BYPASSRLS'],
      ['commander_app', 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS'],
      [
        'commander_tenant_authority',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
      [
        'commander_scheduler',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS',
      ],
      [
        'commander_worker',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
      [
        'commander_adapter_ops',
        'NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
      ],
    ]);
    for (const initializer of initializers) {
      for (const [role, attributes] of roleAttributes) {
        assert.match(
          initializer,
          new RegExp(`CREATE ROLE ${role} WITH LOGIN PASSWORD '[^']+' ${attributes};`),
        );
      }
      assert.match(initializer, /ALTER ROLE commander_app SET statement_timeout = '55s';/);
      assert.match(
        initializer,
        /ALTER ROLE commander_app SET idle_in_transaction_session_timeout = '10s';/,
      );
    }
  });

  it('pins external role probes to the validated Service address while retaining TLS hostname', () => {
    const source = readFileSync(resolve(__dirname, 'helm-lifecycle-kind.ts'), 'utf8');
    assert.match(
      source,
      /assertExternalRoleConnections\(\s*hostname: string,\s*hostAddress: string,?\s*\)/,
    );
    assert.match(source, /hostaddr=\$\{hostAddress\} port=5432 dbname=commander/);
    assert.match(source, /podIp: string/);
    assert.match(source, /assertExternalRoleConnections\(external\.hostname, external\.podIp\)/);
  });

  it('selects the complete real lifecycle matrix and rejects unknown scenarios', () => {
    assert.deepEqual(selectLifecycleScenarios(), [
      'real-bundled',
      'real-external-tls',
      'failed-rollout-recovery',
    ]);
    assert.deepEqual(selectLifecycleScenarios('real-external-tls'), ['real-external-tls']);
    assert.throws(() => selectLifecycleScenarios('external-postgres'), /KIND_SCENARIO_INVALID/);
  });

  it('keeps failed-rollout recovery state outside the atomic Helm release', () => {
    const source = readFileSync(resolve(__dirname, 'helm-lifecycle-kind.ts'), 'utf8');
    const recoveryStart = source.indexOf('async function runFailedRolloutRecovery(');
    const recoveryEnd = source.indexOf('\nconst SCENARIO_EVIDENCE_NAMES', recoveryStart);
    assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
    const recovery = source.slice(recoveryStart, recoveryEnd);

    assert.match(
      recovery,
      /const databaseTarget = \{\s*namespace: EXTERNAL_DATABASE_NAMESPACE,\s*statefulSet: 'external-postgres',\s*\};/,
    );
    assert.match(recovery, /for \(const namespace of \[NAMESPACE, EXTERNAL_DATABASE_NAMESPACE\]\)/);
    assert.match(
      recovery,
      /const external = await createExternalDatabaseFixture\(\{ directory: stateDirectory, release \}\);/,
    );
    assert.match(recovery, /database: \{\n          kind: 'external' as const,/);
    assert.doesNotMatch(recovery, /statefulSet: `\$\{release\}-postgres`/);
  });

  it('fails the top-level harness when any selected scenario fails', () => {
    assert.equal(aggregateScenarioPass([{ passed: true }, { passed: false }]), false);
    assert.equal(aggregateScenarioPass([{ passed: true }, { passed: true }]), true);
    assert.equal(aggregateScenarioPass([]), false);
  });

  it('waits for controller-owned resources to disappear after Helm uninstall', async () => {
    let checks = 0;
    await waitForCleanupCheck(
      async () => {
        checks += 1;
        if (checks === 1) throw new Error('HELM_UNINSTALL_CLEANUP_FAILED');
      },
      'HELM_UNINSTALL_CLEANUP_FAILED',
      { timeoutMs: 1_000, pollIntervalMs: 0 },
    );

    assert.equal(checks, 2);
  });

  it('classifies Helm uninstall failures into fixed safe codes', () => {
    const classify = (
      lifecycleHarness as typeof lifecycleHarness & {
        classifyHelmUninstallFailure?: (result: {
          stdout: string;
          stderr: string;
          exitCode: number;
        }) => string;
      }
    ).classifyHelmUninstallFailure;
    assert.equal(typeof classify, 'function');

    assert.equal(
      classify!({
        stdout: '',
        stderr: 'Error: timed out waiting for the condition: postgres://private:secret@db',
        exitCode: 1,
      }),
      'HELM_UNINSTALL_WAIT_TIMEOUT',
    );
    assert.equal(
      classify!({
        stdout: '',
        stderr: 'Error: uninstall: Release not loaded: cmdr-live: release: not found',
        exitCode: 1,
      }),
      'HELM_UNINSTALL_RELEASE_NOT_FOUND',
    );
    assert.equal(
      classify!({
        stdout: '',
        stderr: 'Error: configmaps "release-projection" not found',
        exitCode: 1,
      }),
      'HELM_UNINSTALL_FAILED',
    );
    assert.equal(
      classify!({
        stdout: '',
        stderr: 'Error: services "cmdr-live-api" is forbidden: private detail',
        exitCode: 1,
      }),
      'HELM_UNINSTALL_DELETE_FORBIDDEN',
    );

    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error: 'HELM_UNINSTALL_WAIT_TIMEOUT: postgres://private:secret@database/commander',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, ['HELM_UNINSTALL_WAIT_TIMEOUT']);
    assert.doesNotMatch(JSON.stringify(sanitized), /postgres|private|secret/i);
  });

  it('retries only transient mid-delete Helm uninstall failures', () => {
    const isTransient = (
      lifecycleHarness as typeof lifecycleHarness & {
        isTransientHelmUninstallDeleteFailure?: (result: {
          stdout: string;
          stderr: string;
          exitCode: number;
        }) => boolean;
      }
    ).isTransientHelmUninstallDeleteFailure;
    assert.equal(typeof isTransient, 'function');

    assert.equal(
      isTransient!({
        stdout: '',
        stderr:
          'Error: uninstallation completed with 1 error(s): deletion failed: pod "cmdr-live-api-0": internal error',
        exitCode: 1,
      }),
      true,
    );
    assert.equal(
      isTransient!({
        stdout: '',
        stderr: 'Error: timed out waiting for the condition: private detail',
        exitCode: 1,
      }),
      false,
    );
    assert.equal(
      isTransient!({
        stdout: '',
        stderr: 'Error: uninstall: Release not loaded: cmdr-live: release: not found',
        exitCode: 1,
      }),
      false,
    );
    assert.equal(
      isTransient!({
        stdout: '',
        stderr: 'Error: services "cmdr-live-api" is forbidden: private detail',
        exitCode: 1,
      }),
      false,
    );
    assert.equal(isTransient!({ stdout: 'uninstalled', stderr: '', exitCode: 0 }), false);
  });

  it('retains only fixed Helm uninstall residual resource kinds', () => {
    const resourceKinds = (
      lifecycleHarness as typeof lifecycleHarness & {
        helmUninstallResidualResourceKinds?: (output: string) => string[];
      }
    ).helmUninstallResidualResourceKinds;
    const podComponents = (
      lifecycleHarness as typeof lifecycleHarness & {
        helmUninstallResidualPodComponents?: (value: unknown) => string[];
      }
    ).helmUninstallResidualPodComponents;
    assert.equal(typeof resourceKinds, 'function');
    assert.equal(typeof podComponents, 'function');

    assert.deepEqual(
      resourceKinds!(
        [
          'statefulset.apps/cmdr-live-redis',
          'pod/cmdr-live-api-private',
          'secret/cmdr-live-api-secret',
          'horizontalpodautoscaler.autoscaling/cmdr-live-api',
          'poddisruptionbudget.policy/cmdr-live-api',
          'ingress.networking.k8s.io/cmdr-live',
          'clusterrole.rbac.authorization.k8s.io/cmdr-live-tenant-prerequisite-operator',
          'clusterrolebinding.rbac.authorization.k8s.io/cmdr-live-tenant-prerequisite-operator',
          'unknown.example/private-object',
        ].join('\n'),
      ),
      [
        'clusterrole',
        'clusterrolebinding',
        'horizontalpodautoscaler',
        'ingress',
        'pod',
        'poddisruptionbudget',
        'secret',
        'statefulset',
      ],
    );
    assert.deepEqual(
      podComponents!({
        items: [
          { metadata: { labels: { 'app.kubernetes.io/component': 'redis' } } },
          { metadata: { labels: { 'app.kubernetes.io/component': 'api' } } },
          { metadata: { labels: { 'app.kubernetes.io/component': 'private' } } },
          { metadata: { labels: { 'app.kubernetes.io/component': 'postgres' } } },
        ],
      }),
      ['api', 'postgres', 'redis'],
    );

    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_UNINSTALL_DELETE_FAILED;residual_inventory=available;residual_kinds=pod,secret,statefulset;residual_pod_components=api,redis;residual_terminating_pod_components=redis: postgres://private:secret@database/commander',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0], {
      name: 'fresh-bundled',
      passed: false,
      durationMs: 100,
      failureCodes: ['HELM_UNINSTALL_DELETE_FAILED'],
      helmUninstallResidual: {
        inventory: 'available',
        resourceKinds: ['pod', 'secret', 'statefulset'],
        podComponents: ['api', 'redis'],
        terminatingPodComponents: ['redis'],
      },
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /postgres|private|database|cmdr-live/i);
  });

  it('retains canonical failed external database role classes without diagnostics', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'real-external-tls-install-upgrade-current-uninstall',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          failedStage: 'network-prerequisites',
          error:
            'EXTERNAL_DATABASE_SIX_ROLE_AUTHENTICATION_FAILED;failed_roles=app:authentication,worker:tls\npod/private-diagnostic',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.externalDatabaseRoleFailures, [
      { role: 'app', failureClass: 'authentication' },
      { role: 'worker', failureClass: 'tls' },
    ]);
    assert.doesNotMatch(JSON.stringify(sanitized), /postgres:\/\/|private|secret/i);
  });

  it('retains only allowlisted terminating Helm uninstall Pod components', () => {
    const terminatingPodComponents = (
      lifecycleHarness as typeof lifecycleHarness & {
        helmUninstallResidualTerminatingPodComponents?: (value: unknown) => string[];
      }
    ).helmUninstallResidualTerminatingPodComponents;
    assert.equal(typeof terminatingPodComponents, 'function');

    assert.deepEqual(
      terminatingPodComponents!({
        items: [
          {
            metadata: {
              labels: { 'app.kubernetes.io/component': 'postgres' },
              deletionTimestamp: '2026-08-31T19:12:59Z',
            },
          },
          { metadata: { labels: { 'app.kubernetes.io/component': 'api' } } },
          {
            metadata: {
              labels: { 'app.kubernetes.io/component': 'redis' },
              deletionTimestamp: '2026-08-31T19:12:59Z',
            },
          },
          {
            metadata: {
              labels: { 'app.kubernetes.io/component': 'private' },
              deletionTimestamp: '2026-08-31T19:12:59Z',
            },
          },
        ],
      }),
      ['postgres', 'redis'],
    );

    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_UNINSTALL_DELETE_FAILED;residual_inventory=available;residual_kinds=networkpolicy,pod;residual_pod_components=api,postgres,redis;residual_terminating_pod_components=postgres,redis: postgres://private:secret@database/commander',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.helmUninstallResidual, {
      inventory: 'available',
      resourceKinds: ['networkpolicy', 'pod'],
      podComponents: ['api', 'postgres', 'redis'],
      terminatingPodComponents: ['postgres', 'redis'],
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /private|secret|database|cmdr-live/i);
  });

  it('does not make successful lifecycle proofs depend on observing an ephemeral hook Pod', () => {
    const source = readFileSync(resolve(__dirname, 'helm-lifecycle-kind.ts'), 'utf8');
    assert.doesNotMatch(source, /LIVE_PROOF_POD_NOT_OBSERVED/);
    assert.match(source, /post-install challenged API proof appended a durable proof row/);
    assert.match(source, /post-upgrade challenged API proof appended another proof row/);
    assert.match(source, /recovered rollout ran the challenged proof Job and appended a proof row/);
  });

  it('includes RBAC and NetworkPolicy results in each scenario pass decision', () => {
    assert.equal(
      aggregateScenarioChecks({
        assertions: [{ passed: true }],
        rbac: [{ passed: false }],
        networkPolicy: [{ passed: true }],
      }),
      false,
    );
    assert.equal(
      aggregateScenarioChecks({
        assertions: [{ passed: true }],
        rbac: [{ passed: true }],
        networkPolicy: [{ passed: true }],
      }),
      true,
    );
    assert.equal(aggregateScenarioChecks({ assertions: [], rbac: [], networkPolicy: [] }), false);
  });

  it('uses Kubernetes TYPE/NAME grammar for the named proof service RBAC check', () => {
    assert.deepEqual(
      proofReaderCanIArgs({
        verb: 'get',
        resource: 'services',
        resourceName: 'cmdr-live-api-proof',
        identity:
          'system:serviceaccount:commander-lifecycle:commander-proof-reader-0123456789abcdef',
        namespace: 'commander-lifecycle',
      }),
      [
        'auth',
        'can-i',
        'get',
        'services/cmdr-live-api-proof',
        '--as',
        'system:serviceaccount:commander-lifecycle:commander-proof-reader-0123456789abcdef',
        '-n',
        'commander-lifecycle',
      ],
    );
  });

  it('uses the Kubernetes subresource flag for the proof-reader pod-log denial check', () => {
    assert.deepEqual(
      proofReaderCanIArgs({
        verb: 'get',
        resource: 'pods/log',
        resourceName: '',
        identity:
          'system:serviceaccount:commander-lifecycle:commander-proof-reader-0123456789abcdef',
        namespace: 'commander-lifecycle',
      }),
      [
        'auth',
        'can-i',
        'get',
        'pods',
        '--subresource=log',
        '--as',
        'system:serviceaccount:commander-lifecycle:commander-proof-reader-0123456789abcdef',
        '-n',
        'commander-lifecycle',
      ],
    );
  });

  it('accepts the canonical nonzero denial result for proof-reader RBAC checks', () => {
    assert.equal(
      proofReaderCanIResultPasses({ expected: 'yes', exitCode: 0, stdout: 'yes\n' }),
      true,
    );
    assert.equal(
      proofReaderCanIResultPasses({ expected: 'no', exitCode: 1, stdout: 'no\n' }),
      true,
    );
    assert.equal(
      proofReaderCanIResultPasses({ expected: 'no', exitCode: 0, stdout: 'no\n' }),
      false,
    );
    assert.equal(
      proofReaderCanIResultPasses({ expected: 'no', exitCode: 1, stdout: 'yes\n' }),
      false,
    );
  });

  it('maps the local production tag to the exact Kind containerd digest reference', () => {
    assert.deepEqual(productionImageReferences(`sha256:${'a'.repeat(64)}`), {
      source: 'docker.io/library/commander-lifecycle-api:kind',
      target: `docker.io/library/commander-lifecycle-api@sha256:${'a'.repeat(64)}`,
    });
    assert.throws(() => productionImageReferences('sha256:bad'), /PRODUCTION_IMAGE_DIGEST_INVALID/);
  });

  it('passes the checked-out source revision into the production image build', () => {
    const args = productionImageBuildArguments('a'.repeat(40));
    assert.ok(args.includes('--build-arg'));
    assert.ok(args.includes('COMMANDER_SOURCE_REVISION=' + 'a'.repeat(40)));
    assert.throws(
      () => productionImageBuildArguments('not-a-revision'),
      /PRODUCTION_IMAGE_SOURCE_REVISION_INVALID/,
    );
  });

  it('reuses a local production image only when its exact repo digest matches its image ID', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    assert.equal(
      reusableProductionImageDigest({
        imageId: digest,
        repoDigests: [`commander-lifecycle-api@${digest}`],
      }),
      digest,
    );
    assert.throws(
      () =>
        reusableProductionImageDigest({
          imageId: digest,
          repoDigests: [`commander-lifecycle-api@sha256:${'b'.repeat(64)}`],
        }),
      /PRODUCTION_IMAGE_REUSE_INVALID/,
    );
    assert.throws(
      () => reusableProductionImageDigest({ imageId: digest, repoDigests: [] }),
      /PRODUCTION_IMAGE_REUSE_INVALID/,
    );
  });

  it('omits a source revision claim for a reused image digest', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/chart',
      calicoUrl: CALICO_URL,
      image: { digest: 'sha256:' + 'a'.repeat(64) },
      scenarios: [],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.image, { digest: 'sha256:' + 'a'.repeat(64) });
  });

  it('skips a Kind image import only when every node has the exact digest reference', () => {
    const exact = `docker.io/library/postgres:16-alpine@sha256:${'a'.repeat(64)}`;
    assert.equal(
      nodeInventoriesContainExactReference(
        [
          { node: 'control-plane', references: [exact] },
          { node: 'worker', references: ['postgres:16-alpine', exact] },
        ],
        exact,
      ),
      true,
    );
    assert.equal(
      nodeInventoriesContainExactReference(
        [
          { node: 'control-plane', references: [exact] },
          { node: 'worker', references: ['postgres:16-alpine'] },
        ],
        exact,
      ),
      false,
    );
    assert.equal(nodeInventoriesContainExactReference([], exact), false);
  });

  it('requires the exact proof-reader identity and projected token contract', () => {
    const serviceAccountName = proofReaderName('commander-lifecycle', 'cmdr-live');
    assert.match(serviceAccountName, /^commander-proof-reader-[a-f0-9]{16}$/);
    assert.doesNotThrow(() =>
      assertProofPodContract(
        {
          spec: {
            serviceAccountName,
            automountServiceAccountToken: false,
            volumes: [
              {
                name: 'proof-api-token',
                projected: {
                  sources: [
                    {
                      serviceAccountToken: {
                        audience: 'commander-tenant-cutover-proof/v1',
                        expirationSeconds: 600,
                        path: 'identity-token',
                      },
                    },
                    {
                      serviceAccountToken: {
                        expirationSeconds: 600,
                        path: 'api-token',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
        serviceAccountName,
      ),
    );
    assert.throws(
      () =>
        assertProofPodContract(
          {
            spec: {
              serviceAccountName: 'default',
              automountServiceAccountToken: true,
              volumes: [],
            },
          },
          serviceAccountName,
        ),
      /PROOF_POD_CONTRACT_INVALID/,
    );
  });

  it('accepts only the explicit NetworkPolicy timeout sentinel as a negative canary', () => {
    assert.doesNotThrow(() => assertNegativeCanaryResult({ exitCode: 42, reason: 'Error' }));
    assert.throws(
      () => assertNegativeCanaryResult({ exitCode: 1, reason: 'Error' }),
      /NETWORK_POLICY_NEGATIVE_CANARY_INVALID/,
    );
  });

  it('pins the Calico manifest URL', () => {
    assert.match(CALICO_URL, /projectcalico\/calico\/v3\.29\.0/);
  });

  it('detects proof job templates in a chart directory', () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'kind-chart-'));
    writeFileSync(resolve(tmp, 'Chart.yaml'), 'name: test\nversion: 0.0.1\n');
    writeFileSync(resolve(tmp, 'values.yaml'), '{}\n');
    const templatesDir = resolve(tmp, 'templates');
    mkdirSync(templatesDir, { recursive: true });
    // No templates yet.
    assert.equal(proofTemplatesPresent(tmp), false);

    // Create the template.
    writeFileSync(resolve(templatesDir, 'tenant-cutover-prove-job.yaml'), 'kind: Job\n');
    assert.equal(proofTemplatesPresent(tmp), true);
  });

  it('runs the live Kind workflow for every production proof dependency', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    const pushTrigger = workflow.match(/  push:\n[\s\S]*?(?=\n\njobs:)/)?.[0];

    assert.ok(pushTrigger, 'the lifecycle workflow must retain a push trigger');
    for (const path of [
      'apps/api/**',
      'deploy/helm/commander/**',
      'packages/**',
      'scripts/**',
      '.dockerignore',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig*.json',
    ]) {
      assert.ok(
        pushTrigger.includes("      - '" + path + "'"),
        path + ' must trigger the push lifecycle proof',
      );
    }
    assert.match(workflow, /run: pnpm exec tsx scripts\/helm-lifecycle-kind\.ts run/);
  });

  it('runs the lifecycle release gate for every pull request synchronization', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');

    assert.match(workflow, /^  pull_request:\s*$/m);
    assert.doesNotMatch(workflow, /  pull_request:\n    paths:/);
  });

  it('builds Kind lifecycle workspace runtime dependencies before the harness', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    const kindJob = workflow.match(/  kind:\n[\s\S]*?(?=\n  [a-z]|$)/)?.[0];

    assert.ok(kindJob, 'the Kind lifecycle job must exist');
    const build = kindJob.indexOf('pnpm --filter @praetor/postgres-runtime build');
    const harness = kindJob.indexOf('pnpm exec tsx scripts/helm-lifecycle-kind.ts run');
    assert.ok(build >= 0, 'the Kind lifecycle job must build workspace runtime dependencies');
    assert.ok(build < harness, 'workspace runtime dependencies must build before the harness');
    assert.match(
      kindJob,
      /pnpm --filter @commander\/postgres-runtime build\n          pnpm --filter @commander\/contracts build\n          pnpm --filter @commander\/plugin-sdk build\n          pnpm --filter @commander\/effect-broker build\n          pnpm --filter @commander\/kernel build\n          pnpm --filter @commander\/action-adapters build\n          pnpm --filter @commander\/core build\n          pnpm --filter @commander\/worker-plane build/,
    );
  });

  it('fails closed when sanitized Kind evidence cannot be uploaded', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    const uploadStep = workflow.match(/- name: Upload sanitized evidence\n[\s\S]*$/)?.[0];

    assert.ok(uploadStep, 'the Kind lifecycle workflow must upload sanitized evidence');
    // Supply chain: remote actions are pinned to an immutable 40-hex commit SHA
    // with the human-readable ref kept as a trailing comment. The assertion may
    // not require the tag form, or it fails the pinning hardening.
    assert.match(uploadStep, /uses: actions\/upload-artifact@(?:[0-9a-f]{40} # v4|v4)\b/);
    assert.match(uploadStep, /if: always\(\)/);
    assert.match(uploadStep, /name: kind-lifecycle-evidence/);
    assert.match(uploadStep, /path: kind-lifecycle-evidence\.json/);
    assert.match(uploadStep, /if-no-files-found: error/);
    assert.match(uploadStep, /retention-days: 30/);
  });

  it('seeds sanitized bootstrap evidence before Kind provisioning', () => {
    const workflow = readFileSync(resolve('.github/workflows/helm-lifecycle.yml'), 'utf8');
    const runtimeBuild = workflow.indexOf('Build Kind lifecycle runtime packages');
    const seed = workflow.indexOf('Seed Kind bootstrap evidence');
    const kind = workflow.search(/uses: helm\/kind-action@(?:[0-9a-f]{40} # v1|v1)\b/);
    const provisionFailure = workflow.indexOf('Record Kind provisioning failure');
    const harnessSeed = workflow.indexOf('Seed Kind harness evidence');
    const harness = workflow.indexOf('pnpm exec tsx scripts/helm-lifecycle-kind.ts run');

    assert.ok(runtimeBuild >= 0);
    assert.ok(seed > runtimeBuild, 'bootstrap evidence must have built runtime dependencies');
    assert.ok(seed < kind, 'bootstrap evidence must exist before Kind provisioning');
    assert.ok(
      provisionFailure > kind,
      'Kind provisioning failures must overwrite bootstrap evidence',
    );
    assert.ok(harnessSeed > provisionFailure, 'harness evidence must follow Kind provisioning');
    assert.ok(harnessSeed < harness, 'the harness must replace its pending evidence');
    assert.ok(kind < harness, 'the harness must replace bootstrap evidence after provisioning');
    assert.match(
      workflow,
      /name: Seed Kind bootstrap evidence\n        run: pnpm exec tsx scripts\/helm-lifecycle-kind\.ts bootstrap-evidence/,
    );
    assert.match(
      workflow,
      /id: provision-kind\n        uses: helm\/kind-action@(?:[0-9a-f]{40} # v1|v1)\b/,
    );
    assert.match(
      workflow,
      /name: Record Kind provisioning failure\n        if: \$\{\{ always\(\) && steps\.provision-kind\.outcome == 'failure' \}\}\n        run: pnpm exec tsx scripts\/helm-lifecycle-kind\.ts bootstrap-evidence kind-provisioning/,
    );
    assert.match(
      workflow,
      /name: Seed Kind harness evidence\n        if: \$\{\{ success\(\) && steps\.provision-kind\.outcome == 'success' \}\}\n        run: pnpm exec tsx scripts\/helm-lifecycle-kind\.ts bootstrap-evidence harness-bootstrap/,
    );
  });

  it('creates a canonical sanitized artifact for a harness bootstrap failure', () => {
    const evidence = bootstrapFailureEvidence();

    assert.equal(evidence.cluster, 'commander-helm-lifecycle');
    assert.equal(evidence.kindNodeImage, KIND_NODE_IMAGE);
    assert.equal(evidence.calicoUrl, CALICO_URL);
    assert.deepEqual(evidence.scenarios, []);
    assert.deepEqual(evidence.bootstrapFailure, {
      stage: 'harness-bootstrap',
      code: 'KIND_LIFECYCLE_BOOTSTRAP_FAILED',
    });
    assert.equal(evidence.passed, false);
    assert.equal(evidence.sanitized, true);
    assert.doesNotMatch(JSON.stringify(evidence), /opaque|private|postgres|secret/i);

    assert.deepEqual(bootstrapFailureEvidence('kind-provisioning').bootstrapFailure, {
      stage: 'kind-provisioning',
      code: 'KIND_LIFECYCLE_KIND_PROVISION_FAILED',
    });
  });

  it('retains a fixed process-failure classification for an uncaught scenario exception', () => {
    const error = Object.assign(new Error('opaque private postgres://secret'), { code: 'EPIPE' });
    const evidence = uncaughtExceptionEvidence('scenario-execution', 'uncaughtException', error);

    assert.deepEqual(evidence.bootstrapFailure, {
      stage: 'scenario-execution',
      code: 'KIND_LIFECYCLE_BOOTSTRAP_FAILED',
    });
    assert.deepEqual(evidence.processFailure, {
      source: 'uncaught-exception',
      code: 'KIND_LIFECYCLE_UNCAUGHT_EXCEPTION',
      cause: 'EPIPE',
      location: 'node-runtime',
    });
    assert.doesNotMatch(JSON.stringify(evidence), /opaque|private|postgres|secret/i);
  });

  it('classifies uncaught-error stack locations without retaining the stack text', () => {
    const error = new Error('opaque private postgres://secret');
    error.stack =
      'Error: opaque private postgres://secret\n' +
      '    at operation (/workspace/scripts/helm-tenant-cutover.ts:2450:1)';

    assert.equal(processFailureLocation(error), 'tenant-cutover');
    assert.doesNotMatch(
      JSON.stringify(uncaughtExceptionEvidence('scenario-execution', 'uncaughtException', error)),
      /opaque|private|postgres|secret/i,
    );
  });

  it('retains a fixed process-failure classification for an unhandled rejection', () => {
    const evidence = uncaughtExceptionEvidence('scenario-execution', 'unhandledRejection');

    assert.deepEqual(evidence.processFailure, {
      source: 'unhandled-rejection',
      code: 'KIND_LIFECYCLE_UNHANDLED_REJECTION',
      cause: 'UNKNOWN',
      location: 'unknown',
    });
    assert.doesNotMatch(JSON.stringify(evidence), /opaque|private|postgres|secret/i);
  });

  it('captures a fixed preflight stage without retaining bootstrap error details', async () => {
    await assert.rejects(
      () =>
        runBootstrapStage('calico-install', async () => {
          throw new Error('opaque private postgres://api:secret@database/commander diagnostic');
        }),
      (error: unknown) => {
        assert.equal(bootstrapFailureStage(error), 'calico-install');
        assert.equal(
          error instanceof Error ? error.message : '',
          'KIND_LIFECYCLE_BOOTSTRAP_FAILED',
        );
        assert.doesNotMatch(String(error), /opaque|private|postgres|secret/i);
        return true;
      },
    );
    assert.deepEqual(bootstrapFailureEvidence('calico-install').bootstrapFailure, {
      stage: 'calico-install',
      code: 'KIND_LIFECYCLE_BOOTSTRAP_FAILED',
    });
  });

  it('persists the current preflight stage before invoking its operation', async () => {
    const evidencePath = resolve(process.cwd(), 'kind-lifecycle-evidence.json');
    rmSync(evidencePath, { force: true });

    try {
      await runBootstrapStage('calico-install', async () => {
        const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
          bootstrapFailure?: unknown;
        };
        assert.deepEqual(evidence.bootstrapFailure, {
          stage: 'calico-install',
          code: 'KIND_LIFECYCLE_BOOTSTRAP_FAILED',
        });
      });
    } finally {
      rmSync(evidencePath, { force: true });
    }
  });

  it('retains an unexpected scenario exception as fixed sanitized evidence', async () => {
    const scenario = await runLifecycleScenario('real-bundled', async () => {
      throw new Error('sensitive implementation detail');
    });

    assert.deepEqual(scenario, {
      name: 'real-bundled-install-upgrade-current-uninstall',
      passed: false,
      durationMs: scenario.durationMs,
      events: [],
      assertions: [],
      failedStage: 'scenario-execution',
      error: 'KIND_LIFECYCLE_SCENARIO_EXECUTION_FAILED',
    });
    assert.deepEqual(
      sanitizeEvidence({
        generatedAt: '2024-01-01T00:00:00Z',
        cluster: 'test',
        kindNodeImage: KIND_NODE_IMAGE,
        chartPath: 'test',
        calicoUrl: CALICO_URL,
        scenarios: [scenario],
        passed: false,
        sanitized: false,
      }).scenarios[0],
      {
        name: 'real-bundled-install-upgrade-current-uninstall',
        passed: false,
        durationMs: scenario.durationMs,
        failedStage: 'scenario-execution',
        failureCodes: ['KIND_LIFECYCLE_SCENARIO_EXECUTION_FAILED'],
      },
    );
  });

  it('omits raw scenario diagnostics and retains only canonical safe evidence fields', () => {
    const evidence = {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/secret/chart',
      calicoUrl: CALICO_URL,
      image: { digest: `sha256:${'a'.repeat(64)}`, sourceRevision: 'b'.repeat(40) },
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [{ message: 'kubectl event secret-token private SQL SELECT' }],
          assertions: [
            {
              description: 'raw assertion',
              passed: false,
              detail: 'postgres://owner:secret@db:5432/commander SELECT private_value',
            },
          ],
          error:
            'HELM_TENANT_CUTOVER_FAILED: TENANT_CUTOVER_OWNER_JOB_FAILED:code=TASK1_CLOSURE_BASELINE_REQUIRED;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
            'd'.repeat(64) +
            '\nNAME READY STATUS COMMANDER_PRIVATE_SECRET_VALUE raw SQL SELECT private_value',
        },
      ],
      ownerFailureEvidence: [
        {
          code: 'COMMANDER_MIGRATION_FAILED' as const,
          producer: 'owner_entrypoint' as const,
          transport: 'kubectl_logs' as const,
          ownerStage: 'lifecycle_prebootstrap_snapshot',
          snapshot: 's0',
          catalogStep: 'functions',
          logSha256: 'c'.repeat(64),
        },
        {
          code: 'COMMANDER_MIGRATION_FAILED' as const,
          producer: 'owner_entrypoint' as const,
          transport: 'kubectl_logs' as const,
          ownerStage: 'rollout_proof',
          proofCode: 'TENANT_CUTOVER_KUBERNETES_PROOF_INVALID' as const,
          proofInvariant: 'task1KubernetesProofObserver.ts:1012:7',
          logSha256: '8'.repeat(64),
        },
      ],
      passed: false,
      sanitized: false,
    } satisfies Parameters<typeof sanitizeEvidence>[0];
    const sanitized = sanitizeEvidence(evidence);
    assert.deepEqual(sanitized, {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      calicoUrl: CALICO_URL,
      image: { digest: `sha256:${'a'.repeat(64)}`, sourceRevision: 'b'.repeat(40) },
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          failedChecks: [{ group: 'scenario', index: 1 }],
          failureCodes: [
            'HELM_TENANT_CUTOVER_FAILED',
            'TENANT_CUTOVER_OWNER_JOB_FAILED',
            'TASK1_CLOSURE_BASELINE_REQUIRED',
          ],
        },
      ],
      ownerFailureEvidence: evidence.ownerFailureEvidence,
      passed: false,
      sanitized: true,
    });
    assert.doesNotMatch(
      JSON.stringify(sanitized),
      /secret|private|SELECT|event|assertion|postgres/i,
    );
  });

  it('retains only indexes of failed checks when a scenario returns assertions', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [{ message: 'private detail' }],
          assertions: [
            { description: 'first check', passed: true },
            { description: 'failed check', passed: false, detail: 'postgres://secret' },
          ],
          rbac: [{ description: 'rbac check', passed: false, detail: 'private rbac detail' }],
          networkPolicy: [
            { description: 'network check', passed: true },
            { description: 'second network check', passed: false },
          ],
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failedChecks, [
      { group: 'scenario', index: 2 },
      { group: 'rbac', index: 1 },
      { group: 'networkPolicy', index: 2 },
    ]);
    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, ['PROOF_READER_RBAC_INVALID']);
    assert.doesNotMatch(JSON.stringify(sanitized), /private|postgres|description|detail/i);
  });

  it('retains a fixed lifecycle failure code without raw command output', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error: 'API_DEPLOYMENT_NOT_AVAILABLE: postgres://private:secret@database/commander',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, ['API_DEPLOYMENT_NOT_AVAILABLE']);
    assert.doesNotMatch(JSON.stringify(sanitized), /postgres|private|secret/i);
  });

  it('retains an allowlisted child failure code after an untrusted tool prefix', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error: [
            'tool-wrapper: private command context',
            'TENANT_CUTOVER_OWNER_JOB_FAILED: postgres://owner:secret@database/commander',
          ].join('\n'),
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, ['TENANT_CUTOVER_OWNER_JOB_FAILED']);
    assert.doesNotMatch(JSON.stringify(sanitized), /tool-wrapper|private|postgres|secret/i);
  });

  it('retains the fixed database peer-binding failure without child output', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'HELM_TENANT_CUTOVER_FAILED:TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID:postgres://owner:secret@database/commander',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, [
      'HELM_TENANT_CUTOVER_FAILED',
      'TENANT_CUTOVER_DATABASE_PEER_INPUT_INVALID',
    ]);
    assert.doesNotMatch(JSON.stringify(sanitized), /postgres:\/\/owner:secret@database/i);
  });

  it('retains only a fixed lifecycle failure stage when a scenario error has no safe code', () => {
    const evidence = {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          failedStage: 'cutover-install',
          error: 'opaque private detail',
        },
      ],
      passed: false,
      sanitized: false,
    } satisfies Parameters<typeof sanitizeEvidence>[0];

    const sanitized = sanitizeEvidence(evidence);
    assert.equal(sanitized.scenarios[0]?.failedStage, 'cutover-install');
    assert.doesNotMatch(JSON.stringify(sanitized), /private|detail/i);
  });

  it('retains a fixed network prerequisite substage without scenario diagnostics', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          failedStage: 'network-prerequisites',
          networkPrerequisiteStage: 'operator-verify',
          error: 'opaque private detail',
        },
      ],
      passed: false,
      sanitized: false,
    } satisfies Parameters<typeof sanitizeEvidence>[0]);

    assert.equal(sanitized.scenarios[0]?.networkPrerequisiteStage, 'operator-verify');
    assert.doesNotMatch(JSON.stringify(sanitized), /private|detail/i);
  });

  it('retains the fixed admission readiness code without raw command output', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error: 'TENANT_POLICY_ADMISSION_NOT_READY: opaque private detail',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, ['TENANT_POLICY_ADMISSION_NOT_READY']);
    assert.doesNotMatch(JSON.stringify(sanitized), /private|detail/i);
  });

  it('retains fixed tenant-policy prerequisite failure codes without raw command output', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'TENANT_POLICY_ADMISSION_MISMATCH:TENANT_POLICY_ADMISSION_PROOF_FAILED: opaque private detail',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0]?.failureCodes, [
      'TENANT_POLICY_ADMISSION_MISMATCH',
      'TENANT_POLICY_ADMISSION_PROOF_FAILED',
    ]);
    assert.doesNotMatch(JSON.stringify(sanitized), /private|detail/i);
  });

  it('retains the fixed over-broad admission RBAC tuple without raw command output', () => {
    const sanitized = sanitizeEvidence({
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error: 'TENANT_POLICY_ADMISSION_RBAC_POLICY_CREATE_ALLOWED: opaque private detail',
        },
      ],
      passed: false,
      sanitized: false,
    });

    assert.deepEqual(sanitized.scenarios[0], {
      name: 'fresh-bundled',
      passed: false,
      durationMs: 100,
      failureCodes: ['TENANT_POLICY_ADMISSION_RBAC_POLICY_CREATE_ALLOWED'],
      admissionRbacFailure: {
        verb: 'create',
        resource: 'validatingadmissionpolicies.admissionregistration.k8s.io',
      },
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /private|detail/i);
  });

  it('rejects unallowlisted and oversized prefixed diagnostic candidates', () => {
    const oversized = 'COMMANDER_' + 'A'.repeat(512);
    const evidence = {
      generatedAt: '2024-01-01T00:00:00Z',
      cluster: 'test',
      kindNodeImage: KIND_NODE_IMAGE,
      chartPath: '/private/secret/chart',
      calicoUrl: CALICO_URL,
      scenarios: [
        {
          name: 'fresh-bundled',
          passed: false,
          durationMs: 100,
          events: [],
          assertions: [],
          error:
            'COMMANDER_EXFILTRATED_BASE32_PAYLOAD ' + oversized + ' HELM_TENANT_CUTOVER_FAILED',
        },
      ],
      ownerFailureEvidence: [],
      passed: false,
      sanitized: false,
    } satisfies Parameters<typeof sanitizeEvidence>[0];

    assert.deepEqual(sanitizeEvidence(evidence).scenarios[0]?.failureCodes, [
      'HELM_TENANT_CUTOVER_FAILED',
    ]);
    assert.equal(
      parseOwnerFailureEvidence(
        'code=COMMANDER_EXFILTRATED_BASE32_PAYLOAD;producer=owner_entrypoint;transport=kubectl_logs;log_sha256=' +
          'a'.repeat(64),
      ),
      undefined,
    );
  });

  it('reports cluster existence without throwing', () => {
    const exists = kindClusterExists('commander-helm-lifecycle');
    assert.equal(typeof exists, 'boolean');
  });
});
