#!/usr/bin/env tsx
/**
 * Kind-backed controlled-change proof gate.
 *
 * The repository-owned driver creates the fixture, submits the governed
 * action, terminates/restarts the worker, and collects controller and signed
 * receipt observations. The proof gate fails closed when any fact is absent.
 */

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyEvidenceReceipt } from './verify-evidence.js';

const KUBERNETES_ROLLBACK_EFFECT_TYPE = 'connector.kubernetes.deployment.rollback';
type EvidenceReceipt = Parameters<typeof verifyEvidenceReceipt>[0];
type EvidenceJwks = Parameters<typeof verifyEvidenceReceipt>[1];

export type KubernetesRemoteOutcome = 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN';
export type KubernetesCompensationDisposition = 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN' | 'NOT_RUN';

export interface KubernetesMarkerObservation {
  marker: string;
  markerMatches: number;
  revision: string;
}

export interface KubernetesRollbackProofObservation {
  marker: string;
  expectedRevision: string;
  observations: readonly KubernetesMarkerObservation[];
  signedReceiptVerified: boolean;
  receiptCorrelated: boolean;
  prerequisites: {
    kindNamespaceReady: boolean;
    twoRevisionsObserved: boolean;
    governedRollbackAccepted: boolean;
    workerKilledAfterAcceptance: boolean;
    workerRestarted: boolean;
  };
  reconciliation: {
    outcome: KubernetesRemoteOutcome;
    startedAtMs: number;
    resolvedAtMs?: number;
    deadlineAtMs: number;
    observedAtMs: number;
    writeCount: number;
    writesDuringReconciliation: number;
    queryFirstRecoveryObserved: boolean;
    auditEvidenceAvailable: boolean;
    writeAuditIds: readonly string[];
  };
  compensationDisposition: KubernetesCompensationDisposition;
  compensationEffectId?: string;
  compensationRequestHash?: string;
  irreducibleUnknown: {
    injected: boolean;
    disposition: 'ESCALATED' | 'NOT_RUN';
    effectId?: string;
    escalationRecordId?: string;
    startedAtMs: number;
    deadlineAtMs: number;
    escalatedAtMs?: number;
    writesDuringReconciliation: number;
  };
}

export interface KubernetesRollbackProofResult {
  verdict: 'PROVEN' | 'NOT_READY';
  failures: string[];
  metrics: {
    remoteOutcome: KubernetesRemoteOutcome;
    reconciliationLatencyMs: number | null;
    duplicateWriteCount: number | null;
    writesDuringReconciliation: number | null;
    compensationDisposition: KubernetesCompensationDisposition;
    irreducibleUnknownDisposition: 'ESCALATED' | 'NOT_RUN';
  };
}

export function kubernetesRollbackProofExitCode(result: KubernetesRollbackProofResult): 0 | 1 {
  return result.verdict === 'PROVEN' ? 0 : 1;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isKubernetesRollbackProofObservation(
  value: unknown,
): value is KubernetesRollbackProofObservation {
  if (!isRecord(value)) return false;
  const observations = value.observations;
  const prerequisites = value.prerequisites;
  const reconciliation = value.reconciliation;
  const irreducibleUnknown = value.irreducibleUnknown;
  if (
    typeof value.marker !== 'string' ||
    typeof value.expectedRevision !== 'string' ||
    typeof value.signedReceiptVerified !== 'boolean' ||
    typeof value.receiptCorrelated !== 'boolean' ||
    !Array.isArray(observations) ||
    !isRecord(prerequisites) ||
    !isRecord(reconciliation) ||
    !isRecord(irreducibleUnknown)
  ) {
    return false;
  }
  if (
    !observations.every(
      (seen) =>
        isRecord(seen) &&
        typeof seen.marker === 'string' &&
        Number.isSafeInteger(seen.markerMatches) &&
        typeof seen.revision === 'string',
    )
  ) {
    return false;
  }
  const prerequisiteNames = [
    'kindNamespaceReady',
    'twoRevisionsObserved',
    'governedRollbackAccepted',
    'workerKilledAfterAcceptance',
    'workerRestarted',
  ];
  if (prerequisiteNames.some((name) => typeof prerequisites[name] !== 'boolean')) return false;
  if (
    typeof reconciliation.outcome !== 'string' ||
    !['APPLIED', 'NOT_APPLIED', 'UNKNOWN'].includes(reconciliation.outcome) ||
    typeof reconciliation.startedAtMs !== 'number' ||
    !validTimestamp(reconciliation.startedAtMs) ||
    typeof reconciliation.deadlineAtMs !== 'number' ||
    !validTimestamp(reconciliation.deadlineAtMs) ||
    typeof reconciliation.observedAtMs !== 'number' ||
    !validTimestamp(reconciliation.observedAtMs) ||
    (reconciliation.resolvedAtMs !== undefined &&
      (typeof reconciliation.resolvedAtMs !== 'number' ||
        !validTimestamp(reconciliation.resolvedAtMs))) ||
    !Number.isSafeInteger(reconciliation.writeCount) ||
    !Number.isSafeInteger(reconciliation.writesDuringReconciliation) ||
    typeof reconciliation.queryFirstRecoveryObserved !== 'boolean' ||
    typeof reconciliation.auditEvidenceAvailable !== 'boolean' ||
    !Array.isArray(reconciliation.writeAuditIds) ||
    !reconciliation.writeAuditIds.every((value) => typeof value === 'string' && value.length > 0)
  ) {
    return false;
  }
  if (
    typeof value.compensationDisposition !== 'string' ||
    !['APPLIED', 'NOT_APPLIED', 'UNKNOWN', 'NOT_RUN'].includes(value.compensationDisposition)
  ) {
    return false;
  }
  if (
    (value.compensationEffectId !== undefined && typeof value.compensationEffectId !== 'string') ||
    (value.compensationRequestHash !== undefined &&
      typeof value.compensationRequestHash !== 'string')
  ) {
    return false;
  }
  return (
    typeof irreducibleUnknown.injected === 'boolean' &&
    typeof irreducibleUnknown.disposition === 'string' &&
    ['ESCALATED', 'NOT_RUN'].includes(irreducibleUnknown.disposition) &&
    (irreducibleUnknown.effectId === undefined ||
      typeof irreducibleUnknown.effectId === 'string') &&
    (irreducibleUnknown.escalationRecordId === undefined ||
      typeof irreducibleUnknown.escalationRecordId === 'string') &&
    typeof irreducibleUnknown.startedAtMs === 'number' &&
    validTimestamp(irreducibleUnknown.startedAtMs) &&
    typeof irreducibleUnknown.deadlineAtMs === 'number' &&
    validTimestamp(irreducibleUnknown.deadlineAtMs) &&
    (irreducibleUnknown.escalatedAtMs === undefined ||
      (typeof irreducibleUnknown.escalatedAtMs === 'number' &&
        validTimestamp(irreducibleUnknown.escalatedAtMs))) &&
    Number.isSafeInteger(irreducibleUnknown.writesDuringReconciliation)
  );
}

export function assessKubernetesRollbackProof(
  observation: KubernetesRollbackProofObservation,
): KubernetesRollbackProofResult {
  if (!isKubernetesRollbackProofObservation(observation)) {
    return notReady('DRIVER_OBSERVATION_INVALID');
  }
  const failures: string[] = [];
  const prerequisiteEntries = Object.entries(observation.prerequisites);
  if (prerequisiteEntries.some(([, ready]) => ready !== true)) {
    failures.push('KIND_PROOF_PREREQUISITES_REQUIRED');
  }

  if (
    !observation.marker.trim() ||
    !observation.expectedRevision.trim() ||
    observation.observations.length < 2
  ) {
    failures.push('STABLE_MARKER_REVISION_OBSERVATION_REQUIRED');
  }
  for (const seen of observation.observations) {
    if (seen.markerMatches !== 1) {
      failures.push('MARKER_MATCH_COUNT_INVALID');
      break;
    }
    if (
      !seen.marker.trim() ||
      !seen.revision.trim() ||
      seen.marker !== observation.marker ||
      seen.revision !== observation.expectedRevision
    ) {
      failures.push('MARKER_REVISION_OBSERVATION_UNSTABLE');
      break;
    }
  }

  if (!observation.signedReceiptVerified) failures.push('SIGNED_RECEIPT_REQUIRED');
  if (!observation.receiptCorrelated) failures.push('SIGNED_RECEIPT_CORRELATION_REQUIRED');

  const reconciliation = observation.reconciliation;
  const timestampsValid =
    validTimestamp(reconciliation.startedAtMs) &&
    validTimestamp(reconciliation.deadlineAtMs) &&
    validTimestamp(reconciliation.observedAtMs) &&
    (reconciliation.resolvedAtMs === undefined || validTimestamp(reconciliation.resolvedAtMs));
  if (
    !timestampsValid ||
    reconciliation.deadlineAtMs < reconciliation.startedAtMs ||
    reconciliation.observedAtMs < reconciliation.startedAtMs
  ) {
    failures.push('RECONCILIATION_TIMING_INVALID');
  }
  if (
    reconciliation.resolvedAtMs !== undefined &&
    (reconciliation.resolvedAtMs < reconciliation.startedAtMs ||
      reconciliation.resolvedAtMs > reconciliation.observedAtMs)
  ) {
    failures.push('RECONCILIATION_TIMING_INVALID');
  }
  if (reconciliation.writesDuringReconciliation !== 0) {
    failures.push('RECONCILIATION_WRITE_FORBIDDEN');
  }
  if (!reconciliation.queryFirstRecoveryObserved) {
    failures.push('QUERY_FIRST_RECOVERY_REQUIRED');
  }
  if (!reconciliation.auditEvidenceAvailable) {
    failures.push('KUBERNETES_AUDIT_EVIDENCE_REQUIRED');
  }
  if (!Number.isSafeInteger(reconciliation.writeCount) || reconciliation.writeCount !== 1) {
    failures.push('REMOTE_WRITE_COUNT_INVALID');
  }
  if (
    reconciliation.writeAuditIds.length !== reconciliation.writeCount ||
    new Set(reconciliation.writeAuditIds).size !== reconciliation.writeAuditIds.length
  ) {
    failures.push('REMOTE_WRITE_AUDIT_INVALID');
  }
  if (reconciliation.outcome === 'UNKNOWN') {
    failures.push(
      reconciliation.observedAtMs > reconciliation.deadlineAtMs
        ? 'UNKNOWN_UNRESOLVED_BEYOND_DEADLINE'
        : 'UNKNOWN_RESOLUTION_PENDING',
    );
  } else if (reconciliation.resolvedAtMs === undefined) {
    failures.push('RECONCILIATION_RESOLUTION_REQUIRED');
  } else if (reconciliation.outcome === 'NOT_APPLIED') {
    failures.push('ROLLBACK_NOT_APPLIED');
  }
  if (
    reconciliation.resolvedAtMs !== undefined &&
    reconciliation.resolvedAtMs > reconciliation.deadlineAtMs
  ) {
    failures.push('RECONCILIATION_RESOLVED_AFTER_DEADLINE');
  }

  if (observation.compensationDisposition !== 'APPLIED') {
    failures.push('COMPENSATION_PROOF_REQUIRED');
  }
  if (
    !observation.compensationEffectId?.trim() ||
    !/^[a-f0-9]{64}$/.test(observation.compensationRequestHash ?? '')
  ) {
    failures.push('SIGNED_COMPENSATION_EVIDENCE_REQUIRED');
  }
  const unknown = observation.irreducibleUnknown;
  if (
    unknown.injected !== true ||
    unknown.disposition !== 'ESCALATED' ||
    !unknown.effectId?.trim() ||
    !unknown.escalationRecordId?.trim() ||
    unknown.escalatedAtMs === undefined
  ) {
    failures.push('UNKNOWN_ESCALATION_PROOF_REQUIRED');
  } else if (
    unknown.deadlineAtMs < unknown.startedAtMs ||
    unknown.escalatedAtMs < unknown.startedAtMs ||
    unknown.escalatedAtMs > unknown.deadlineAtMs
  ) {
    failures.push('UNKNOWN_ESCALATION_TIMING_INVALID');
  }
  if (unknown.writesDuringReconciliation !== 0) {
    failures.push('UNKNOWN_ESCALATION_WRITE_FORBIDDEN');
  }

  return {
    verdict: failures.length === 0 ? 'PROVEN' : 'NOT_READY',
    failures,
    metrics: {
      remoteOutcome: reconciliation.outcome,
      reconciliationLatencyMs:
        reconciliation.resolvedAtMs === undefined
          ? null
          : reconciliation.resolvedAtMs - reconciliation.startedAtMs,
      duplicateWriteCount: Math.max(0, reconciliation.writeCount - 1),
      writesDuringReconciliation: reconciliation.writesDuringReconciliation,
      compensationDisposition: observation.compensationDisposition,
      irreducibleUnknownDisposition: observation.irreducibleUnknown.disposition,
    },
  };
}

export interface KubernetesRollbackKindDriver {
  createDeploymentWithTwoRevisions(): Promise<{
    marker: string;
    expectedRevision: string;
    originalRevision: string;
  }>;
  submitGovernedRollback(input: {
    marker: string;
    expectedRevision: string;
    originalRevision: string;
  }): Promise<KubernetesGovernedRollbackSubmission>;
  killWorkerAfterAcceptedApiCall(): Promise<void>;
  restartWorker(): Promise<void>;
  collectObservation(input: {
    marker: string;
    expectedRevision: string;
    submission: KubernetesGovernedRollbackSubmission;
  }): Promise<
    Omit<
      KubernetesRollbackProofObservation,
      | 'marker'
      | 'expectedRevision'
      | 'signedReceiptVerified'
      | 'receiptCorrelated'
      | 'prerequisites'
    > & {
      receipt?: EvidenceReceipt;
      unknownReceipt?: EvidenceReceipt;
      unknownSubmission?: KubernetesGovernedRollbackSubmission;
    }
  >;
}

export interface KubernetesGovernedRollbackSubmission {
  accepted: true;
  tenantId: string;
  runId: string;
  effectId: string;
  actionDigest: string;
  requestHash: string;
  effectType: typeof KUBERNETES_ROLLBACK_EFFECT_TYPE;
  destination: string;
  marker: string;
  targetRevision: string;
}

export interface KubernetesRollbackCommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface KubernetesRollbackCommandOptions {
  stdin?: string;
}

export interface RepositoryKubernetesRollbackKindConfig {
  apiBaseUrl: string;
  apiKey: string;
  tenantId: string;
  cluster: string;
  namespace: string;
  deployment: string;
  workerNamespace: string;
  workerSelector: string;
  controlPlaneContainer: string;
  auditLogPath: string;
  deadlineMs: number;
}

export interface RepositoryKubernetesRollbackKindPorts {
  run(
    command: string,
    args: readonly string[],
    options?: KubernetesRollbackCommandOptions,
  ): Promise<KubernetesRollbackCommandResult>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function countReconciliationWrites(fingerprints: readonly string[]): number {
  let writes = 0;
  for (let index = 1; index < fingerprints.length; index += 1) {
    if (fingerprints[index] !== fingerprints[index - 1]) writes += 1;
  }
  return writes;
}

function actionMarker(tenantId: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${tenantId}\0${idempotencyKey}`).digest('hex');
}

function canonicalValueHash(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    const object = input as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function dnsLabel(value: string, label: string): string {
  if (!/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value) || value.length > 63) {
    throw new Error(`${label}_INVALID`);
  }
  return value;
}

function positiveDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30 * 60_000) {
    throw new Error('KIND_PROOF_DEADLINE_INVALID');
  }
  return value;
}

function deploymentManifest(input: {
  namespace: string;
  deployment: string;
  revision: '1' | '2';
}): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${input.deployment}
  namespace: ${input.namespace}
spec:
  replicas: 1
  revisionHistoryLimit: 4
  selector:
    matchLabels:
      app.kubernetes.io/name: ${input.deployment}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${input.deployment}
        proof-revision: "${input.revision}"
    spec:
      containers:
        - name: target
          image: registry.k8s.io/pause:3.10
          env:
            - name: PROOF_REVISION
              value: "${input.revision}"
`;
}

function namespaceManifest(namespace: string): string {
  return `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
`;
}

function ambiguousMarkerDeploymentManifest(input: {
  namespace: string;
  deployment: string;
  marker: string;
  targetRevision: string;
}): string {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${input.deployment}-unknown
  namespace: ${input.namespace}
  annotations:
    commander.io/action-marker: ${input.marker}
    commander.io/action-target-revision: "${input.targetRevision}"
spec:
  replicas: 0
  selector:
    matchLabels:
      app.kubernetes.io/name: ${input.deployment}-unknown
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${input.deployment}-unknown
    spec:
      containers:
        - name: target
          image: registry.k8s.io/pause:3.10
`;
}

function commandFailed(
  command: string,
  args: readonly string[],
  result: KubernetesRollbackCommandResult,
) {
  const detail = result.stderr.trim().slice(0, 256);
  throw new Error(
    `KIND_PROOF_COMMAND_FAILED:${command} ${args.join(' ')}${detail ? `: ${detail}` : ''}`,
  );
}

async function runCommand(
  ports: RepositoryKubernetesRollbackKindPorts,
  command: string,
  args: readonly string[],
  options?: KubernetesRollbackCommandOptions,
): Promise<string> {
  const result = await ports.run(command, args, options);
  if ((result.exitCode ?? 0) !== 0) commandFailed(command, args, result);
  return result.stdout;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value;
}

function safeJson(text: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}

class RepositoryKubernetesRollbackKindDriver implements KubernetesRollbackKindDriver {
  private readonly config: RepositoryKubernetesRollbackKindConfig;
  private readonly ports: RepositoryKubernetesRollbackKindPorts;
  private readonly context: string;
  private readonly idempotencyKey: string;
  private proposedAction:
    | {
        runId: string;
        effectId: string;
        actionDigest: string;
        simulationId: string;
        policySnapshotId: string;
        marker: string;
        targetRevision: string;
      }
    | undefined;
  private latestRevision: string | undefined;
  private acceptedAtMs: number | undefined;

  constructor(input: {
    config: RepositoryKubernetesRollbackKindConfig;
    ports: RepositoryKubernetesRollbackKindPorts;
  }) {
    this.config = {
      ...input.config,
      cluster: dnsLabel(input.config.cluster, 'KIND_PROOF_CLUSTER'),
      namespace: dnsLabel(input.config.namespace, 'KIND_PROOF_NAMESPACE'),
      deployment: dnsLabel(input.config.deployment, 'KIND_PROOF_DEPLOYMENT'),
      workerNamespace: dnsLabel(input.config.workerNamespace, 'KIND_PROOF_WORKER_NAMESPACE'),
      controlPlaneContainer: dnsLabel(
        input.config.controlPlaneContainer,
        'KIND_PROOF_CONTROL_PLANE_CONTAINER',
      ),
      deadlineMs: positiveDeadline(input.config.deadlineMs),
    };
    if (!this.config.apiBaseUrl.trim()) throw new Error('COMMANDER_API_BASE_URL_REQUIRED');
    if (!this.config.apiKey.trim()) throw new Error('COMMANDER_API_KEY_REQUIRED');
    if (!this.config.tenantId.trim()) throw new Error('COMMANDER_TENANT_ID_REQUIRED');
    if (!this.config.workerSelector.trim()) throw new Error('KIND_PROOF_WORKER_SELECTOR_REQUIRED');
    if (!/^\/[A-Za-z0-9._/-]+$/.test(this.config.auditLogPath)) {
      throw new Error('KIND_PROOF_AUDIT_LOG_PATH_INVALID');
    }
    this.ports = input.ports;
    this.context = `kind-${this.config.cluster}`;
    this.idempotencyKey = `kind-rollback-${randomUUID()}`;
  }

  private kubectlArgs(namespace?: string): string[] {
    return ['--context', this.context, ...(namespace ? ['--namespace', namespace] : [])];
  }

  private async apply(manifest: string): Promise<void> {
    await runCommand(this.ports, 'kubectl', [...this.kubectlArgs(), 'apply', '-f', '-'], {
      stdin: manifest,
    });
  }

  private async deploymentRevision(): Promise<string> {
    const stdout = await runCommand(this.ports, 'kubectl', [
      ...this.kubectlArgs(this.config.namespace),
      'get',
      `deployment/${this.config.deployment}`,
      '-o',
      'json',
    ]);
    const deployment = record(
      safeJson(stdout, 'KIND_DEPLOYMENT_JSON_INVALID'),
      'KIND_DEPLOYMENT_INVALID',
    );
    const metadata = record(deployment.metadata, 'KIND_DEPLOYMENT_METADATA_INVALID');
    const annotations = record(metadata.annotations, 'KIND_DEPLOYMENT_ANNOTATIONS_INVALID');
    const revision = requiredString(
      annotations['deployment.kubernetes.io/revision'],
      'KIND_DEPLOYMENT_REVISION_REQUIRED',
    );
    if (!/^[1-9][0-9]*$/.test(revision)) throw new Error('KIND_DEPLOYMENT_REVISION_INVALID');
    return revision;
  }

  private async waitForTargetRollout(): Promise<void> {
    await runCommand(this.ports, 'kubectl', [
      ...this.kubectlArgs(this.config.namespace),
      'rollout',
      'status',
      `deployment/${this.config.deployment}`,
      `--timeout=${Math.ceil(this.config.deadlineMs / 1_000)}s`,
    ]);
  }

  async createDeploymentWithTwoRevisions(): Promise<{
    marker: string;
    expectedRevision: string;
    originalRevision: string;
  }> {
    await this.apply(namespaceManifest(this.config.namespace));
    await this.apply(
      deploymentManifest({
        namespace: this.config.namespace,
        deployment: this.config.deployment,
        revision: '1',
      }),
    );
    await this.waitForTargetRollout();
    const expectedRevision = await this.deploymentRevision();
    await this.apply(
      deploymentManifest({
        namespace: this.config.namespace,
        deployment: this.config.deployment,
        revision: '2',
      }),
    );
    await this.waitForTargetRollout();
    const latestRevision = await this.deploymentRevision();
    if (latestRevision === expectedRevision) throw new Error('TWO_KUBERNETES_REVISIONS_REQUIRED');
    this.latestRevision = latestRevision;
    return {
      marker: actionMarker(this.config.tenantId, this.idempotencyKey),
      expectedRevision,
      originalRevision: latestRevision,
    };
  }

  private headers(): HeadersInit {
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      'x-tenant-id': this.config.tenantId,
    };
  }

  private apiUrl(path: string): URL {
    return new URL(
      path,
      this.config.apiBaseUrl.endsWith('/') ? this.config.apiBaseUrl : `${this.config.apiBaseUrl}/`,
    );
  }

  async submitGovernedRollback(input: {
    marker: string;
    expectedRevision: string;
    originalRevision: string;
  }): Promise<KubernetesGovernedRollbackSubmission> {
    if (input.originalRevision !== this.latestRevision && this.latestRevision !== undefined) {
      throw new Error('GOVERNED_ROLLBACK_ORIGINAL_REVISION_MISMATCH');
    }
    this.latestRevision = input.originalRevision;
    const destination = `k8s://${this.config.cluster}/${this.config.namespace}/deployments/${this.config.deployment}`;
    const envelope = {
      source: 'commander-kind-proof',
      package: '@praetor/action-adapters',
      model: 'controlled-change-proof',
      tool: 'kubernetes.deployment.rollback',
      destination,
      effectType: KUBERNETES_ROLLBACK_EFFECT_TYPE,
      args: {
        targetRevision: input.expectedRevision,
        reason: 'kind controlled-change rollback proof',
      },
      idempotencyKey: this.idempotencyKey,
    };
    const response = await this.ports.fetch(this.apiUrl('v1/actions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(envelope),
    });
    const payload = record(await response.json(), 'GOVERNED_ROLLBACK_RESPONSE_INVALID');
    if (response.status !== 202 || payload.idempotentReplay !== false) {
      throw new Error('GOVERNED_ROLLBACK_NOT_ACCEPTED');
    }
    const action = record(payload.action, 'GOVERNED_ROLLBACK_ACTION_INVALID');
    const simulation = record(action.simulation, 'GOVERNED_ROLLBACK_SIMULATION_INVALID');
    if (action.state !== 'AWAITING_APPROVAL') {
      throw new Error('GOVERNED_ROLLBACK_APPROVAL_GATE_REQUIRED');
    }
    const actionDigest = requiredString(action.actionDigest, 'GOVERNED_ROLLBACK_DIGEST_REQUIRED');
    if (!/^[a-f0-9]{64}$/.test(actionDigest) || simulation.actionDigest !== actionDigest) {
      throw new Error('GOVERNED_ROLLBACK_DIGEST_INVALID');
    }
    this.proposedAction = {
      runId: requiredString(action.runId, 'GOVERNED_ROLLBACK_RUN_REQUIRED'),
      effectId: requiredString(action.effectId, 'GOVERNED_ROLLBACK_EFFECT_REQUIRED'),
      actionDigest,
      simulationId: requiredString(
        simulation.simulationId,
        'GOVERNED_ROLLBACK_SIMULATION_REQUIRED',
      ),
      policySnapshotId: requiredString(
        simulation.policySnapshotId,
        'GOVERNED_ROLLBACK_POLICY_REQUIRED',
      ),
      marker: input.marker,
      targetRevision: input.expectedRevision,
    };
    return {
      accepted: true,
      tenantId: this.config.tenantId,
      runId: this.proposedAction.runId,
      effectId: this.proposedAction.effectId,
      actionDigest,
      requestHash: actionDigest,
      effectType: KUBERNETES_ROLLBACK_EFFECT_TYPE,
      destination,
      marker: input.marker,
      targetRevision: input.expectedRevision,
    };
  }

  async killWorkerAfterAcceptedApiCall(): Promise<void> {
    if (!this.proposedAction) throw new Error('WORKER_KILL_BEFORE_ACCEPTANCE_FORBIDDEN');
    await this.requestJson(`v1/actions/${encodeURIComponent(this.proposedAction.runId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        actionDigest: this.proposedAction.actionDigest,
        simulationId: this.proposedAction.simulationId,
        policySnapshotId: this.proposedAction.policySnapshotId,
      }),
    });
    const deadlineAtMs = this.ports.now() + this.config.deadlineMs;
    let accepted = false;
    while (this.ports.now() <= deadlineAtMs) {
      const observation = await this.observeDeployment({
        marker: this.proposedAction.marker,
        expectedRevision: this.proposedAction.targetRevision,
      });
      if (observation.observation.markerMatches === 1) {
        accepted = true;
        this.acceptedAtMs = this.ports.now();
        break;
      }
      await this.ports.sleep(25);
    }
    if (!accepted) throw new Error('KUBERNETES_API_ACCEPTANCE_NOT_OBSERVED');
    await runCommand(this.ports, 'kubectl', [
      ...this.kubectlArgs(this.config.workerNamespace),
      'delete',
      'pod',
      '--selector',
      this.config.workerSelector,
      '--wait=true',
    ]);
  }

  async restartWorker(): Promise<void> {
    if (!this.proposedAction) throw new Error('WORKER_RESTART_BEFORE_ACCEPTANCE_FORBIDDEN');
    await runCommand(this.ports, 'kubectl', [
      ...this.kubectlArgs(this.config.workerNamespace),
      'wait',
      '--for=condition=Ready',
      'pod',
      '--selector',
      this.config.workerSelector,
      `--timeout=${Math.ceil(this.config.deadlineMs / 1_000)}s`,
    ]);
  }

  private async requestJson(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.ports.fetch(this.apiUrl(path), {
      ...init,
      headers: { ...this.headers(), ...init?.headers },
    });
    const payload = record(await response.json(), 'COMMANDER_PROOF_RESPONSE_INVALID');
    if (!response.ok) {
      const error = isRecord(payload.error) ? payload.error : {};
      const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
      throw new Error(`COMMANDER_PROOF_REQUEST_FAILED:${code}`);
    }
    return payload;
  }

  private async observeDeployment(input: {
    marker: string;
    expectedRevision: string;
  }): Promise<{ observation: KubernetesMarkerObservation; applied: boolean; fingerprint: string }> {
    const stdout = await runCommand(this.ports, 'kubectl', [
      ...this.kubectlArgs(this.config.namespace),
      'get',
      'deployments',
      '-o',
      'json',
    ]);
    const list = record(
      safeJson(stdout, 'KIND_DEPLOYMENTS_JSON_INVALID'),
      'KIND_DEPLOYMENTS_INVALID',
    );
    if (!Array.isArray(list.items)) throw new Error('KIND_DEPLOYMENTS_ITEMS_INVALID');
    const matches = list.items.flatMap((value) => {
      if (!isRecord(value) || !isRecord(value.metadata)) return [];
      const annotations = isRecord(value.metadata.annotations) ? value.metadata.annotations : {};
      if (annotations['commander.io/action-marker'] !== input.marker) return [];
      const spec = isRecord(value.spec) ? value.spec : {};
      const template = isRecord(spec.template) ? spec.template : {};
      const templateMetadata = isRecord(template.metadata) ? template.metadata : {};
      const labels = isRecord(templateMetadata.labels) ? templateMetadata.labels : {};
      return [
        {
          marker: String(annotations['commander.io/action-marker'] ?? ''),
          revision: String(annotations['commander.io/action-target-revision'] ?? ''),
          proofRevision: String(labels['proof-revision'] ?? ''),
        },
      ];
    });
    const match = matches[0];
    return {
      observation: {
        marker: match?.marker ?? input.marker,
        markerMatches: matches.length,
        revision: match?.revision ?? '',
      },
      applied:
        matches.length === 1 &&
        match?.revision === input.expectedRevision &&
        match.proofRevision === '1',
      fingerprint: JSON.stringify(matches),
    };
  }

  private async actionMarkerWriteAudit(input: {
    marker: string;
    reconcileRequestedAtMs?: number;
  }): Promise<{ available: boolean; auditIds: string[]; writesDuringReconciliation: number }> {
    let stdout: string;
    try {
      stdout = await runCommand(this.ports, 'docker', [
        'exec',
        this.config.controlPlaneContainer,
        'tail',
        '-n',
        '10000',
        this.config.auditLogPath,
      ]);
    } catch {
      return { available: false, auditIds: [], writesDuringReconciliation: 0 };
    }
    const writes = stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        let event: Record<string, unknown>;
        try {
          event = record(JSON.parse(line), 'KIND_AUDIT_EVENT_INVALID');
        } catch {
          return [];
        }
        const objectRef = isRecord(event.objectRef) ? event.objectRef : {};
        const requestObject = isRecord(event.requestObject) ? event.requestObject : {};
        const metadata = isRecord(requestObject.metadata) ? requestObject.metadata : {};
        const annotations = isRecord(metadata.annotations) ? metadata.annotations : {};
        const responseStatus = isRecord(event.responseStatus) ? event.responseStatus : {};
        const auditId = typeof event.auditID === 'string' ? event.auditID : '';
        const atMs =
          typeof event.requestReceivedTimestamp === 'string'
            ? Date.parse(event.requestReceivedTimestamp)
            : Number.NaN;
        if (
          event.stage !== 'ResponseComplete' ||
          event.verb !== 'patch' ||
          objectRef.resource !== 'deployments' ||
          objectRef.namespace !== this.config.namespace ||
          objectRef.name !== this.config.deployment ||
          annotations['commander.io/action-marker'] !== input.marker ||
          typeof responseStatus.code !== 'number' ||
          responseStatus.code < 200 ||
          responseStatus.code >= 300 ||
          !auditId ||
          !Number.isFinite(atMs)
        ) {
          return [];
        }
        return [{ auditId, atMs }];
      });
    return {
      available: true,
      auditIds: writes.map((write) => write.auditId),
      writesDuringReconciliation:
        input.reconcileRequestedAtMs === undefined
          ? 0
          : writes.filter((write) => write.atMs >= input.reconcileRequestedAtMs!).length,
    };
  }

  private async requestGovernedCompensation(
    runId: string,
    originalEffectId: string,
  ): Promise<void> {
    if (!this.latestRevision) throw new Error('KIND_FORWARD_REVISION_REQUIRED');
    const forwardResponse = {
      deployment: this.config.deployment,
      namespace: this.config.namespace,
      revision: this.latestRevision,
      status: 'APPLIED',
      httpStatus: 200,
    };
    const response = await this.requestJson(
      `v1/actions/${encodeURIComponent(runId)}/compensations`,
      {
        method: 'POST',
        body: JSON.stringify({
          originalEffectId,
          adapterVersion: '1.0.0',
          compensationEffectType: 'compensate.kubernetes.deployment.rollback',
          compensationPatch: {
            targetRevision: this.latestRevision,
            reason: 'kind governed compensation proof',
          },
          forwardReceiptHash: canonicalValueHash(forwardResponse),
        }),
      },
    );
    const authorization = record(
      response.authorization,
      'KIND_COMPENSATION_AUTHORIZATION_REQUIRED',
    );
    if (response.state !== 'AWAITING_APPROVAL') {
      throw new Error('KIND_COMPENSATION_APPROVAL_GATE_REQUIRED');
    }
    const authorizationId = requiredString(
      authorization.id,
      'KIND_COMPENSATION_AUTHORIZATION_ID_REQUIRED',
    );
    await this.requestJson(
      `v1/actions/${encodeURIComponent(runId)}/compensations/${encodeURIComponent(authorizationId)}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({
          actionDigest: requiredString(
            authorization.actionDigest,
            'KIND_COMPENSATION_DIGEST_REQUIRED',
          ),
          policySnapshotId: requiredString(
            authorization.policySnapshotId,
            'KIND_COMPENSATION_POLICY_REQUIRED',
          ),
        }),
      },
    );
  }

  private async proveIrreducibleUnknown(): Promise<{
    submission: KubernetesGovernedRollbackSubmission;
    receipt?: EvidenceReceipt;
    observation: KubernetesRollbackProofObservation['irreducibleUnknown'];
  }> {
    if (!this.latestRevision) throw new Error('KIND_FORWARD_REVISION_REQUIRED');
    const idempotencyKey = `kind-rollback-unknown-${randomUUID()}`;
    const marker = actionMarker(this.config.tenantId, idempotencyKey);
    const destination = `k8s://${this.config.cluster}/${this.config.namespace}/deployments/${this.config.deployment}`;
    const envelope = {
      source: 'commander-kind-proof',
      package: '@praetor/action-adapters',
      model: 'controlled-change-proof-irreducible-unknown',
      tool: 'kubernetes.deployment.rollback',
      destination,
      effectType: KUBERNETES_ROLLBACK_EFFECT_TYPE,
      args: {
        targetRevision: this.latestRevision,
        reason: 'kind irreducible unknown proof',
      },
      idempotencyKey,
    };
    const proposed = await this.requestJson('v1/actions', {
      method: 'POST',
      body: JSON.stringify(envelope),
    });
    const action = record(proposed.action, 'KIND_UNKNOWN_ACTION_INVALID');
    const simulation = record(action.simulation, 'KIND_UNKNOWN_SIMULATION_INVALID');
    if (action.state !== 'AWAITING_APPROVAL' || proposed.idempotentReplay !== false) {
      throw new Error('KIND_UNKNOWN_APPROVAL_GATE_REQUIRED');
    }
    const submission: KubernetesGovernedRollbackSubmission = {
      accepted: true,
      tenantId: this.config.tenantId,
      runId: requiredString(action.runId, 'KIND_UNKNOWN_RUN_REQUIRED'),
      effectId: requiredString(action.effectId, 'KIND_UNKNOWN_EFFECT_REQUIRED'),
      actionDigest: requiredString(action.actionDigest, 'KIND_UNKNOWN_DIGEST_REQUIRED'),
      requestHash: requiredString(action.actionDigest, 'KIND_UNKNOWN_DIGEST_REQUIRED'),
      effectType: KUBERNETES_ROLLBACK_EFFECT_TYPE,
      destination,
      marker,
      targetRevision: this.latestRevision,
    };
    await runCommand(this.ports, 'kubectl', [
      ...this.kubectlArgs(this.config.namespace),
      'annotate',
      `deployment/${this.config.deployment}`,
      `commander.io/action-marker=${marker}`,
      `commander.io/action-target-revision=${this.latestRevision}`,
      '--overwrite',
    ]);
    await this.apply(
      ambiguousMarkerDeploymentManifest({
        namespace: this.config.namespace,
        deployment: this.config.deployment,
        marker,
        targetRevision: this.latestRevision,
      }),
    );
    const injectedAudit = await this.actionMarkerWriteAudit({ marker });
    const injectedAuditIds = new Set(injectedAudit.auditIds);
    const startedAtMs = this.ports.now();
    const deadlineAtMs = startedAtMs + this.config.deadlineMs;
    await this.requestJson(`v1/actions/${encodeURIComponent(submission.runId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        actionDigest: submission.actionDigest,
        simulationId: requiredString(simulation.simulationId, 'KIND_UNKNOWN_SIMULATION_REQUIRED'),
        policySnapshotId: requiredString(
          simulation.policySnapshotId,
          'KIND_UNKNOWN_POLICY_REQUIRED',
        ),
      }),
    });
    let reconcileRequested = false;
    let terminalState = '';
    while (this.ports.now() <= deadlineAtMs) {
      const status = await this.requestJson(`v1/actions/${encodeURIComponent(submission.runId)}`);
      terminalState = requiredString(
        record(status.action, 'KIND_UNKNOWN_STATUS_INVALID').state,
        'KIND_UNKNOWN_STATE_REQUIRED',
      );
      if (terminalState === 'ESCALATED') break;
      if (terminalState === 'COMPLETION_UNKNOWN' && !reconcileRequested) {
        await this.requestJson(`v1/actions/${encodeURIComponent(submission.runId)}/reconcile`, {
          method: 'POST',
          body: '{}',
        });
        reconcileRequested = true;
      }
      await this.ports.sleep(250);
    }
    let receipt: EvidenceReceipt | undefined;
    try {
      const evidence = await this.requestJson(
        `v1/actions/${encodeURIComponent(submission.runId)}/evidence`,
      );
      if (isRecord(evidence.verification) && evidence.verification.ok === true) {
        receipt = evidence.receipt as EvidenceReceipt;
      }
    } catch {
      receipt = undefined;
    }
    const finalAudit = await this.actionMarkerWriteAudit({ marker });
    const writesDuringReconciliation = finalAudit.auditIds.filter(
      (auditId) => !injectedAuditIds.has(auditId),
    ).length;
    const base = this.unknownFromReceipt(
      receipt,
      submission,
      startedAtMs,
      deadlineAtMs,
      writesDuringReconciliation,
    );
    return {
      submission,
      receipt,
      observation:
        terminalState === 'ESCALATED' &&
        reconcileRequested &&
        injectedAudit.available &&
        finalAudit.available
          ? base
          : { ...base, disposition: 'NOT_RUN' },
    };
  }

  private compensationFromReceipt(receipt: EvidenceReceipt | undefined): {
    disposition: KubernetesCompensationDisposition;
    effectId?: string;
    requestHash?: string;
  } {
    const effect = receipt?.effects.find(
      (candidate) => candidate.type === 'compensate.kubernetes.deployment.rollback',
    );
    if (!effect) return { disposition: 'NOT_RUN' };
    if (effect.state === 'COMPLETED') {
      return { disposition: 'APPLIED', effectId: effect.effectId, requestHash: effect.requestHash };
    }
    if (effect.state === 'CONFIRMED_NOT_APPLIED' || effect.state === 'FAILED') {
      return {
        disposition: 'NOT_APPLIED',
        effectId: effect.effectId,
        requestHash: effect.requestHash,
      };
    }
    return { disposition: 'UNKNOWN', effectId: effect.effectId, requestHash: effect.requestHash };
  }

  private unknownFromReceipt(
    receipt: EvidenceReceipt | undefined,
    submission: KubernetesGovernedRollbackSubmission,
    startedAtMs: number,
    deadlineAtMs: number,
    writesDuringReconciliation: number,
  ): KubernetesRollbackProofObservation['irreducibleUnknown'] {
    const effect = receipt?.effects.find(
      (candidate) =>
        candidate.effectId === submission.effectId &&
        candidate.type === KUBERNETES_ROLLBACK_EFFECT_TYPE &&
        candidate.state === 'COMPLETION_UNKNOWN',
    );
    if (!effect) {
      return {
        injected: false,
        disposition: 'NOT_RUN',
        startedAtMs,
        deadlineAtMs,
        writesDuringReconciliation,
      };
    }
    const escalation = receipt?.auditEvents.find(
      (event) =>
        event.type === 'effect.reconcile_escalated' && event.details.effectId === effect.effectId,
    );
    const escalationRecordId = escalation?.details.escalationRecordId;
    const escalatedAtMs = escalation ? Date.parse(escalation.at) : Number.NaN;
    return {
      injected: true,
      disposition:
        typeof escalationRecordId === 'string' && Number.isFinite(escalatedAtMs)
          ? 'ESCALATED'
          : 'NOT_RUN',
      effectId: effect.effectId,
      ...(typeof escalationRecordId === 'string' ? { escalationRecordId } : {}),
      startedAtMs,
      deadlineAtMs,
      ...(Number.isFinite(escalatedAtMs) ? { escalatedAtMs } : {}),
      writesDuringReconciliation,
    };
  }

  async collectObservation(input: {
    marker: string;
    expectedRevision: string;
    submission: KubernetesGovernedRollbackSubmission;
  }): ReturnType<KubernetesRollbackKindDriver['collectObservation']> {
    const proposed = this.proposedAction;
    if (!proposed || proposed.runId !== input.submission.runId) {
      throw new Error('GOVERNED_ROLLBACK_SUBMISSION_BINDING_INVALID');
    }
    const startedAtMs = this.ports.now();
    const deadlineAtMs = startedAtMs + this.config.deadlineMs;
    if (this.acceptedAtMs === undefined) {
      throw new Error('KUBERNETES_API_ACCEPTANCE_NOT_OBSERVED');
    }

    let terminalState = '';
    let reconcileRequested = false;
    let reconcileRequestedAtMs: number | undefined;
    const reconciliationFingerprints: string[] = [];
    while (this.ports.now() <= deadlineAtMs) {
      const status = await this.requestJson(`v1/actions/${encodeURIComponent(proposed.runId)}`);
      const action = record(status.action, 'GOVERNED_ROLLBACK_STATUS_INVALID');
      terminalState = requiredString(action.state, 'GOVERNED_ROLLBACK_STATE_REQUIRED');
      if (['SUCCEEDED', 'FAILED', 'ESCALATED'].includes(terminalState)) break;
      if (terminalState === 'COMPLETION_UNKNOWN') {
        reconciliationFingerprints.push((await this.observeDeployment(input)).fingerprint);
        if (!reconcileRequested) {
          await this.requestJson(`v1/actions/${encodeURIComponent(proposed.runId)}/reconcile`, {
            method: 'POST',
            body: '{}',
          });
          reconcileRequested = true;
          reconcileRequestedAtMs = this.ports.now();
        }
      }
      await this.ports.sleep(250);
    }

    const first = await this.observeDeployment(input);
    await this.ports.sleep(100);
    const second = await this.observeDeployment(input);
    const observedAtMs = this.ports.now();
    const stable = first.fingerprint === second.fingerprint;
    if (reconciliationFingerprints.length > 0) {
      reconciliationFingerprints.push(first.fingerprint, second.fingerprint);
    }
    const applied = first.applied && second.applied && stable;
    const markerMatches = Math.max(
      first.observation.markerMatches,
      second.observation.markerMatches,
    );
    const writeAudit = await this.actionMarkerWriteAudit({
      marker: input.marker,
      reconcileRequestedAtMs,
    });
    const writesDuringReconciliation = writeAudit.writesDuringReconciliation;
    const outcome: KubernetesRemoteOutcome = applied
      ? 'APPLIED'
      : markerMatches === 0 && stable
        ? 'NOT_APPLIED'
        : 'UNKNOWN';

    if (terminalState !== 'SUCCEEDED') {
      throw new Error(`KIND_FORWARD_TERMINAL_INVALID:${terminalState || 'DEADLINE'}`);
    }
    await this.requestGovernedCompensation(proposed.runId, proposed.effectId);

    let receipt: EvidenceReceipt | undefined;
    while (this.ports.now() <= deadlineAtMs) {
      try {
        const evidence = await this.requestJson(
          `v1/actions/${encodeURIComponent(proposed.runId)}/evidence`,
        );
        if (isRecord(evidence.verification) && evidence.verification.ok === true) {
          const candidate = evidence.receipt as EvidenceReceipt;
          receipt = candidate;
          if (this.compensationFromReceipt(candidate).disposition === 'APPLIED') break;
        }
      } catch {
        receipt = undefined;
      }
      await this.ports.sleep(250);
    }
    const compensation = this.compensationFromReceipt(receipt);
    const unknown = await this.proveIrreducibleUnknown();
    return {
      observations: [first.observation, second.observation],
      reconciliation: {
        outcome,
        startedAtMs,
        ...(outcome !== 'UNKNOWN' ? { resolvedAtMs: observedAtMs } : {}),
        deadlineAtMs,
        observedAtMs,
        writeCount: writeAudit.auditIds.length,
        writesDuringReconciliation,
        queryFirstRecoveryObserved: reconcileRequested,
        auditEvidenceAvailable: writeAudit.available,
        writeAuditIds: writeAudit.auditIds,
      },
      compensationDisposition: compensation.disposition,
      compensationEffectId: compensation.effectId,
      compensationRequestHash: compensation.requestHash,
      irreducibleUnknown: unknown.observation,
      receipt,
      unknownReceipt: unknown.receipt,
      unknownSubmission: unknown.submission,
    };
  }
}

export function createRepositoryKubernetesRollbackKindDriver(input: {
  config: RepositoryKubernetesRollbackKindConfig;
  ports: RepositoryKubernetesRollbackKindPorts;
}): KubernetesRollbackKindDriver {
  return new RepositoryKubernetesRollbackKindDriver(input);
}

function requiredEnv(value: string | undefined, code: string): string {
  if (!value?.trim()) throw new Error(code);
  return value.trim();
}

export function repositoryKubernetesRollbackKindConfigFromEnv(
  env: NodeJS.ProcessEnv,
): RepositoryKubernetesRollbackKindConfig {
  const deadlineRaw = env.COMMANDER_KUBERNETES_PROOF_DEADLINE_MS?.trim();
  const deadlineMs = deadlineRaw ? Number(deadlineRaw) : 60_000;
  return {
    apiBaseUrl: requiredEnv(
      env.COMMANDER_KUBERNETES_PROOF_API_URL ?? env.COMMANDER_API_URL,
      'COMMANDER_API_BASE_URL_REQUIRED',
    ),
    apiKey: requiredEnv(env.COMMANDER_API_KEY, 'COMMANDER_API_KEY_REQUIRED'),
    tenantId: requiredEnv(
      env.COMMANDER_KUBERNETES_PROOF_TENANT_ID ?? env.COMMANDER_CELL_TENANT_ID,
      'COMMANDER_TENANT_ID_REQUIRED',
    ),
    cluster: env.COMMANDER_KUBERNETES_CLUSTER?.trim() || 'commander',
    namespace:
      env.COMMANDER_KUBERNETES_PROOF_NAMESPACE?.trim() || `commander-rollback-proof-${process.pid}`,
    deployment: env.COMMANDER_KUBERNETES_PROOF_DEPLOYMENT?.trim() || 'rollback-target',
    workerNamespace: env.COMMANDER_KUBERNETES_WORKER_NAMESPACE?.trim() || 'commander',
    workerSelector:
      env.COMMANDER_KUBERNETES_WORKER_SELECTOR?.trim() || 'app.kubernetes.io/component=worker',
    controlPlaneContainer:
      env.COMMANDER_KUBERNETES_CONTROL_PLANE_CONTAINER?.trim() ||
      `${env.COMMANDER_KUBERNETES_CLUSTER?.trim() || 'commander'}-control-plane`,
    auditLogPath:
      env.COMMANDER_KUBERNETES_AUDIT_LOG_PATH?.trim() || '/var/log/kubernetes/audit.log',
    deadlineMs: positiveDeadline(deadlineMs),
  };
}

function repositoryKubernetesRollbackKindPorts(): RepositoryKubernetesRollbackKindPorts {
  return {
    run(command, args, options) {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(command, [...args], {
          cwd: process.cwd(),
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => {
          resolvePromise({ stdout, stderr, exitCode: code ?? 1 });
        });
        child.stdin.end(options?.stdin);
      });
    },
    fetch: globalThis.fetch.bind(globalThis),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  };
}

function validSubmission(
  value: unknown,
  fixture: { marker: string; expectedRevision: string; originalRevision: string },
): value is KubernetesGovernedRollbackSubmission {
  if (!isRecord(value)) return false;
  return (
    value.accepted === true &&
    typeof value.tenantId === 'string' &&
    value.tenantId.trim().length > 0 &&
    typeof value.runId === 'string' &&
    value.runId.trim().length > 0 &&
    typeof value.effectId === 'string' &&
    value.effectId.trim().length > 0 &&
    typeof value.actionDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.actionDigest) &&
    typeof value.requestHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.requestHash) &&
    value.effectType === KUBERNETES_ROLLBACK_EFFECT_TYPE &&
    typeof value.destination === 'string' &&
    /^k8s:\/\/[^/]+\/[^/]+\/deployments\/[^/]+$/.test(value.destination) &&
    value.marker === fixture.marker &&
    value.targetRevision === fixture.expectedRevision
  );
}

export function receiptMatchesGovernedRollback(
  receipt: EvidenceReceipt,
  submission: KubernetesGovernedRollbackSubmission,
  observation: KubernetesRollbackProofObservation,
  proofWindow: { startedAtMs: number; completedAtMs: number },
): boolean {
  const forwardEffects = receipt.effects.filter(
    (effect) => effect.effectId === submission.effectId,
  );
  const compensationEffects = receipt.effects.filter(
    (effect) => effect.effectId === observation.compensationEffectId,
  );
  const exportedAtMs = Date.parse(receipt.exportedAt);
  const signedAtMs = receipt.signature ? Date.parse(receipt.signature.signedAt) : Number.NaN;
  const timestampsFresh = [exportedAtMs, signedAtMs].every(
    (timestamp) =>
      Number.isFinite(timestamp) &&
      timestamp >= proofWindow.startedAtMs &&
      timestamp <= proofWindow.completedAtMs + 5_000,
  );
  return (
    timestampsFresh &&
    receipt.scope.tenantId === submission.tenantId &&
    receipt.scope.runId === submission.runId &&
    receipt.scope.effectId === submission.effectId &&
    receipt.actionDigest === submission.actionDigest &&
    receipt.terminalDisposition !== 'FAILED' &&
    forwardEffects.length === 1 &&
    forwardEffects[0]?.type === KUBERNETES_ROLLBACK_EFFECT_TYPE &&
    forwardEffects[0]?.state === 'COMPLETED' &&
    forwardEffects[0]?.requestHash === submission.requestHash &&
    compensationEffects.length === 1 &&
    compensationEffects[0]?.type === 'compensate.kubernetes.deployment.rollback' &&
    compensationEffects[0]?.state === 'COMPLETED' &&
    compensationEffects[0]?.requestHash === observation.compensationRequestHash
  );
}

export function receiptMatchesIrreducibleUnknown(
  receipt: EvidenceReceipt,
  submission: KubernetesGovernedRollbackSubmission,
  observation: KubernetesRollbackProofObservation['irreducibleUnknown'],
  proofWindow: { startedAtMs: number; completedAtMs: number },
): boolean {
  const effect = receipt.effects.filter((candidate) => candidate.effectId === submission.effectId);
  const escalation = receipt.auditEvents.filter(
    (event) =>
      event.type === 'effect.reconcile_escalated' &&
      event.details.effectId === submission.effectId &&
      event.details.escalationRecordId === observation.escalationRecordId,
  );
  const exportedAtMs = Date.parse(receipt.exportedAt);
  const signedAtMs = receipt.signature ? Date.parse(receipt.signature.signedAt) : Number.NaN;
  return (
    [exportedAtMs, signedAtMs].every(
      (timestamp) =>
        Number.isFinite(timestamp) &&
        timestamp >= proofWindow.startedAtMs &&
        timestamp <= proofWindow.completedAtMs + 5_000,
    ) &&
    receipt.scope.tenantId === submission.tenantId &&
    receipt.scope.runId === submission.runId &&
    receipt.scope.effectId === submission.effectId &&
    receipt.actionDigest === submission.actionDigest &&
    receipt.terminalDisposition === 'ESCALATED' &&
    effect.length === 1 &&
    effect[0]?.type === KUBERNETES_ROLLBACK_EFFECT_TYPE &&
    effect[0]?.state === 'COMPLETION_UNKNOWN' &&
    effect[0]?.requestHash === submission.requestHash &&
    escalation.length === 1
  );
}

export async function runKubernetesRollbackKindProof(
  driver: KubernetesRollbackKindDriver,
  options: { trustedJwks?: EvidenceJwks } = {},
): Promise<KubernetesRollbackProofResult> {
  const proofStartedAtMs = Date.now();
  const fixture = await driver.createDeploymentWithTwoRevisions();
  if (
    !isRecord(fixture) ||
    typeof fixture.marker !== 'string' ||
    !fixture.marker.trim() ||
    typeof fixture.expectedRevision !== 'string' ||
    !fixture.expectedRevision.trim() ||
    typeof fixture.originalRevision !== 'string' ||
    !fixture.originalRevision.trim()
  ) {
    return notReady('DRIVER_FIXTURE_INVALID');
  }
  const submission = await driver.submitGovernedRollback(fixture);
  if (!validSubmission(submission, fixture)) {
    return notReady('GOVERNED_ROLLBACK_ACCEPTANCE_REQUIRED');
  }
  await driver.killWorkerAfterAcceptedApiCall();
  await driver.restartWorker();
  const collected = await driver.collectObservation({ ...fixture, submission });
  const observation: KubernetesRollbackProofObservation = {
    marker: fixture.marker,
    expectedRevision: fixture.expectedRevision,
    observations: collected.observations,
    signedReceiptVerified: false,
    receiptCorrelated: false,
    prerequisites: {
      kindNamespaceReady: true,
      twoRevisionsObserved: true,
      governedRollbackAccepted: true,
      workerKilledAfterAcceptance: true,
      workerRestarted: true,
    },
    reconciliation: collected.reconciliation,
    compensationDisposition: collected.compensationDisposition,
    compensationEffectId: collected.compensationEffectId,
    compensationRequestHash: collected.compensationRequestHash,
    irreducibleUnknown: collected.irreducibleUnknown,
  };
  let signedReceiptVerified = false;
  let receiptCorrelated = false;
  if (collected.receipt !== undefined && options.trustedJwks !== undefined) {
    try {
      const unknownReceiptVerified =
        collected.unknownReceipt !== undefined &&
        verifyEvidenceReceipt(collected.unknownReceipt, options.trustedJwks).ok;
      signedReceiptVerified =
        verifyEvidenceReceipt(collected.receipt, options.trustedJwks).ok && unknownReceiptVerified;
      receiptCorrelated =
        signedReceiptVerified &&
        receiptMatchesGovernedRollback(collected.receipt, submission, observation, {
          startedAtMs: proofStartedAtMs,
          completedAtMs: Date.now(),
        }) &&
        collected.unknownReceipt !== undefined &&
        collected.unknownSubmission !== undefined &&
        receiptMatchesIrreducibleUnknown(
          collected.unknownReceipt,
          collected.unknownSubmission,
          observation.irreducibleUnknown,
          { startedAtMs: proofStartedAtMs, completedAtMs: Date.now() },
        );
    } catch {
      signedReceiptVerified = false;
      receiptCorrelated = false;
    }
  }

  const result = assessKubernetesRollbackProof({
    ...observation,
    signedReceiptVerified,
    receiptCorrelated,
  });
  if (options.trustedJwks === undefined) {
    result.verdict = 'NOT_READY';
    result.failures.unshift('TRUSTED_JWKS_REQUIRED');
  }
  return result;
}

function notReady(failure: string): KubernetesRollbackProofResult {
  return {
    verdict: 'NOT_READY',
    failures: [failure],
    metrics: {
      remoteOutcome: 'UNKNOWN',
      reconciliationLatencyMs: null,
      duplicateWriteCount: null,
      writesDuringReconciliation: null,
      compensationDisposition: 'NOT_RUN',
      irreducibleUnknownDisposition: 'NOT_RUN',
    },
  };
}

async function loadTrustedJwks(path: string | undefined): Promise<EvidenceJwks | undefined> {
  if (!path) return undefined;
  const parsed: unknown = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.keys)) {
    throw new Error('TRUSTED_JWKS_INVALID');
  }
  return parsed as unknown as EvidenceJwks;
}

function readArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = readArg(args, '--mode') ?? 'kind';
  if (mode !== 'kind') throw new Error('--mode must be kind');
  let result: KubernetesRollbackProofResult;
  try {
    const config = repositoryKubernetesRollbackKindConfigFromEnv(process.env);
    const driver = createRepositoryKubernetesRollbackKindDriver({
      config: {
        ...config,
        ...(readArg(args, '--cluster') ? { cluster: readArg(args, '--cluster')! } : {}),
        ...(readArg(args, '--namespace') ? { namespace: readArg(args, '--namespace')! } : {}),
        ...(readArg(args, '--deployment') ? { deployment: readArg(args, '--deployment')! } : {}),
      },
      ports: repositoryKubernetesRollbackKindPorts(),
    });
    const trustedJwks = await loadTrustedJwks(
      readArg(args, '--jwks') ?? process.env.COMMANDER_EVIDENCE_JWKS_FILE,
    );
    result = await runKubernetesRollbackKindProof(driver, { trustedJwks });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = message.match(/^[A-Z][A-Z0-9_]+/)?.[0] ?? 'KIND_PROOF_RUNTIME_FAILED';
    result = notReady(code);
  }
  const output = `${JSON.stringify(result)}\n`;
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(
    resolve('artifacts', `kubernetes-rollback-kind-${Date.now()}.json`),
    output,
    'utf8',
  );
  process.stdout.write(output);
  process.exitCode = kubernetesRollbackProofExitCode(result);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
