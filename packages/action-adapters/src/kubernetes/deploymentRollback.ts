import { createHash } from 'node:crypto';
import {
  commanderActionMarker,
  compensationIdempotencyKey,
  KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
} from '@praetor/contracts';
import { AdapterExecutionError } from '@praetor/effect-broker';
import type { EffectRemoteOutcome } from '@praetor/effect-broker';
import { adapterFetch, readJsonResponse, type FetchFn } from '../http.js';
import type {
  ActionAdapter,
  AdapterCompensateInput,
  AdapterExecuteInput,
  AdapterQueryInput,
  KubernetesCredentialProvider,
} from '../types.js';
import { parseKubernetesDeploymentDestination } from '../types.js';

export type KubernetesObservedOutcome = 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN';

export { KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR };

const ACTION_MARKER_ANNOTATION = 'commander.io/action-marker';
const ACTION_ORIGINAL_REVISION_ANNOTATION = 'commander.io/action-original-revision';
const ACTION_TARGET_REVISION_ANNOTATION = 'commander.io/action-target-revision';
const ACTION_TEMPLATE_HASH_ANNOTATION = 'commander.io/action-template-sha256';
const COMPENSATION_MARKER_ANNOTATION = 'commander.io/compensation-marker';
const COMPENSATION_TARGET_REVISION_ANNOTATION = 'commander.io/compensation-target-revision';
const COMPENSATION_TEMPLATE_HASH_ANNOTATION = 'commander.io/compensation-template-sha256';
const ROLLBACK_REASON_ANNOTATION = 'commander.io/rollback-reason';
const REVISION_ANNOTATION = 'deployment.kubernetes.io/revision';
const MAX_REASON_LENGTH = 1_024;
const MAX_TEMPLATE_BYTES = 256 * 1_024;

interface KubernetesDeploymentSummary {
  name: string;
  namespace: string;
  uid?: string;
  resourceVersion?: string;
  revision?: string;
  annotations: Record<string, string>;
  selector: Record<string, string>;
  template?: Record<string, unknown>;
  templateHash?: string;
  rolloutComplete: boolean;
}

interface KubernetesRollbackTarget {
  template: Record<string, unknown>;
  templateHash: string;
}

interface Observation {
  classification: KubernetesObservedOutcome;
  deployments: KubernetesDeploymentSummary[];
  httpStatus?: number;
  matched?: KubernetesDeploymentSummary;
}

export interface KubernetesDeploymentRollbackAdapterOptions {
  credentials: KubernetesCredentialProvider;
  fetch?: FetchFn;
}

function executionError(
  message: string,
  code: string,
  commitState: 'NOT_COMMITTED' | 'UNKNOWN',
  details?: Record<string, unknown>,
): AdapterExecutionError {
  return new AdapterExecutionError(message, {
    code,
    commitState,
    retryMode: commitState === 'UNKNOWN' ? 'QUERY_FIRST' : 'NEVER',
    details,
  });
}

function requiredRevision(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw executionError(
      `${label} must be a positive integer string`,
      'KUBERNETES_REVISION_INVALID',
      'NOT_COMMITTED',
    );
  }
  return value;
}

function requiredReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_REASON_LENGTH) {
    throw executionError(
      `reason must be between 1 and ${MAX_REASON_LENGTH} characters`,
      'KUBERNETES_REASON_INVALID',
      'NOT_COMMITTED',
    );
  }
  return value;
}

function requiredExecuteArgs(value: unknown): { targetRevision: string; reason: string } {
  const args = objectRecord(value);
  if (
    !args ||
    Object.keys(args).length !== 2 ||
    !Object.keys(args).every((key) => key === 'targetRevision' || key === 'reason')
  ) {
    throw executionError(
      'Kubernetes rollback arguments contain an unsupported key',
      'KUBERNETES_ARGUMENTS_INVALID',
      'NOT_COMMITTED',
    );
  }
  return {
    targetRevision: requiredRevision(args.targetRevision, 'targetRevision'),
    reason: requiredReason(args.reason),
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = objectRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function templateHash(template: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(template)).digest('hex');
}

function stringMap(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  const record = objectRecord(value);
  if (!record) return result;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function deploymentSummary(value: unknown): KubernetesDeploymentSummary | null {
  const deployment = objectRecord(value);
  const record = objectRecord(deployment?.metadata);
  if (!record) return null;
  if (typeof record.name !== 'string' || typeof record.namespace !== 'string') return null;
  const annotations = stringMap(record.annotations);
  const spec = objectRecord(deployment?.spec);
  const selector = objectRecord(spec?.selector);
  const template = objectRecord(spec?.template) ?? undefined;
  const status = objectRecord(deployment?.status);
  const generation = typeof record.generation === 'number' ? record.generation : undefined;
  const observedGeneration =
    typeof status?.observedGeneration === 'number' ? status.observedGeneration : undefined;
  const replicas = typeof status?.replicas === 'number' ? status.replicas : undefined;
  const updatedReplicas =
    typeof status?.updatedReplicas === 'number' ? status.updatedReplicas : undefined;
  const availableReplicas =
    typeof status?.availableReplicas === 'number' ? status.availableReplicas : undefined;
  const unavailableReplicas =
    typeof status?.unavailableReplicas === 'number' ? status.unavailableReplicas : 0;
  return {
    name: record.name,
    namespace: record.namespace,
    uid: typeof record.uid === 'string' ? record.uid : undefined,
    resourceVersion:
      typeof record.resourceVersion === 'string' ? record.resourceVersion : undefined,
    revision: annotations[REVISION_ANNOTATION],
    annotations,
    selector: stringMap(selector?.matchLabels),
    template,
    templateHash: template ? templateHash(template) : undefined,
    rolloutComplete:
      generation !== undefined &&
      observedGeneration !== undefined &&
      observedGeneration >= generation &&
      replicas !== undefined &&
      updatedReplicas === replicas &&
      availableReplicas === replicas &&
      unavailableReplicas === 0,
  };
}

function evidence(
  deployment: string,
  namespace: string,
  status: KubernetesObservedOutcome,
  httpStatus: number,
  revision?: string,
): Record<string, unknown> {
  return {
    deployment,
    namespace,
    ...(revision ? { revision } : {}),
    status,
    httpStatus,
  };
}

function toRemoteOutcome(
  observation: Observation,
  deployment: string,
  namespace: string,
  evidenceRevision?: string,
): EffectRemoteOutcome {
  if (observation.classification === 'APPLIED') {
    return {
      status: 'APPLIED',
      response: evidence(
        deployment,
        namespace,
        'APPLIED',
        observation.httpStatus ?? 200,
        evidenceRevision ?? observation.matched?.revision,
      ),
    };
  }
  if (observation.classification === 'NOT_APPLIED') {
    return {
      status: 'NOT_APPLIED',
      response: evidence(deployment, namespace, 'NOT_APPLIED', observation.httpStatus ?? 200),
    };
  }
  return {
    status: 'UNKNOWN',
    error: {
      code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
      message: 'Remote outcome is not yet provable',
    },
  };
}

export function createKubernetesDeploymentRollbackAdapter(
  options: KubernetesDeploymentRollbackAdapterOptions,
): ActionAdapter {
  const rawFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) =>
    adapterFetch(rawFetch, url, init);

  async function requestContext(tenantId: string, destination: string) {
    const parsed = parseKubernetesDeploymentDestination(destination);
    const token = await options.credentials.getToken(tenantId, parsed.cluster, parsed.namespace);
    const server = options.credentials.getServer(tenantId, parsed.cluster, parsed.namespace);
    const collectionPath = `/apis/apps/v1/namespaces/${encodeURIComponent(parsed.namespace)}/deployments`;
    const collectionUrl = new URL(collectionPath, server);
    return { ...parsed, token, collectionUrl };
  }

  function headers(token: string, contentType?: string): HeadersInit {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': contentType ?? 'application/json',
    };
  }

  function targetAnnotations(markerAnnotation: string): {
    revision: string;
    templateHash: string;
  } {
    return markerAnnotation === ACTION_MARKER_ANNOTATION
      ? {
          revision: ACTION_TARGET_REVISION_ANNOTATION,
          templateHash: ACTION_TEMPLATE_HASH_ANNOTATION,
        }
      : {
          revision: COMPENSATION_TARGET_REVISION_ANNOTATION,
          templateHash: COMPENSATION_TEMPLATE_HASH_ANNOTATION,
        };
  }

  async function resolveRollbackTarget(
    input: Pick<AdapterExecuteInput, 'tenantId' | 'destination' | 'signal'>,
    deployment: KubernetesDeploymentSummary,
    targetRevision: string,
  ): Promise<KubernetesRollbackTarget> {
    if (!deployment.uid || Object.keys(deployment.selector).length === 0) {
      throw executionError(
        'Kubernetes deployment lacks a stable owner uid or matchLabels selector',
        'KUBERNETES_DEPLOYMENT_SELECTOR_INVALID',
        'NOT_COMMITTED',
      );
    }
    const context = await requestContext(input.tenantId, input.destination);
    const selector = Object.entries(deployment.selector)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const replicasetsUrl = new URL(
      `/apis/apps/v1/namespaces/${encodeURIComponent(context.namespace)}/replicasets`,
      context.collectionUrl,
    );
    replicasetsUrl.searchParams.set('labelSelector', selector);
    let response: Response;
    try {
      response = await fetchImpl(replicasetsUrl, {
        headers: headers(context.token),
        signal: input.signal,
      });
    } catch {
      throw executionError(
        'Kubernetes ReplicaSet history query failed',
        'KUBERNETES_REPLICASET_QUERY_FAILED',
        'NOT_COMMITTED',
      );
    }
    if (!response.ok) {
      throw executionError(
        `Kubernetes ReplicaSet history query failed with HTTP ${response.status}`,
        'KUBERNETES_REPLICASET_QUERY_FAILED',
        'NOT_COMMITTED',
        { httpStatus: response.status },
      );
    }
    let payload: { items?: unknown[] };
    try {
      payload = await readJsonResponse<{ items?: unknown[] }>(response);
    } catch {
      throw executionError(
        'Kubernetes ReplicaSet history response was invalid',
        'KUBERNETES_REPLICASET_RESPONSE_INVALID',
        'NOT_COMMITTED',
      );
    }
    const matches = (payload.items ?? []).filter((value) => {
      const replicaSet = objectRecord(value);
      const metadata = objectRecord(replicaSet?.metadata);
      const annotations = stringMap(metadata?.annotations);
      const owners = Array.isArray(metadata?.ownerReferences) ? metadata.ownerReferences : [];
      return (
        annotations[REVISION_ANNOTATION] === targetRevision &&
        owners.some((owner) => {
          const entry = objectRecord(owner);
          return entry?.kind === 'Deployment' && entry.uid === deployment.uid;
        })
      );
    });
    if (matches.length !== 1) {
      throw executionError(
        matches.length === 0
          ? 'Kubernetes target revision was not found'
          : 'Multiple ReplicaSets matched the target revision',
        matches.length === 0
          ? 'KUBERNETES_TARGET_REVISION_NOT_FOUND'
          : 'KUBERNETES_TARGET_REVISION_AMBIGUOUS',
        matches.length === 0 ? 'NOT_COMMITTED' : 'UNKNOWN',
        { matchCount: matches.length, targetRevision },
      );
    }
    const replicaSet = objectRecord(matches[0]);
    const template = objectRecord(objectRecord(replicaSet?.spec)?.template);
    if (!template) {
      throw executionError(
        'Kubernetes target ReplicaSet lacks a pod template',
        'KUBERNETES_TARGET_TEMPLATE_INVALID',
        'NOT_COMMITTED',
      );
    }
    if (Buffer.byteLength(canonicalJson(template), 'utf8') > MAX_TEMPLATE_BYTES) {
      throw executionError(
        'Kubernetes target pod template exceeds the adapter request bound',
        'KUBERNETES_TARGET_TEMPLATE_TOO_LARGE',
        'NOT_COMMITTED',
      );
    }
    return { template, templateHash: templateHash(template) };
  }

  async function observe(
    input: Pick<AdapterQueryInput, 'tenantId' | 'destination' | 'signal'>,
    markerAnnotation: string,
    marker: string,
    expectedRevision: string,
  ): Promise<Observation> {
    const context = await requestContext(input.tenantId, input.destination);
    let response: Response;
    try {
      response = await fetchImpl(context.collectionUrl, {
        headers: headers(context.token),
        signal: input.signal,
      });
    } catch {
      return { classification: 'UNKNOWN', deployments: [] };
    }
    if (response.status === 404) {
      // A missing collection is an unavailable observation, not proof that a
      // prior marker was never committed (the namespace/API may have gone away).
      return { classification: 'UNKNOWN', deployments: [], httpStatus: 404 };
    }
    if (response.status === 409 || response.status === 429 || response.status >= 500) {
      return { classification: 'UNKNOWN', deployments: [], httpStatus: response.status };
    }
    if (!response.ok) {
      throw executionError(
        `Kubernetes deployment query failed with HTTP ${response.status}`,
        'KUBERNETES_QUERY_FAILED',
        'NOT_COMMITTED',
        { httpStatus: response.status },
      );
    }
    let payload: { items?: unknown[] };
    try {
      payload = await readJsonResponse<{ items?: unknown[] }>(response);
    } catch {
      return { classification: 'UNKNOWN', deployments: [], httpStatus: response.status };
    }
    // AA-05: a 200 response that is not a Kubernetes List (missing/non-array
    // `items`) says nothing about whether the rollback was applied. Treating it
    // as an empty list produced NOT_APPLIED, i.e. converted an unmeasured result
    // into a committed one. Fail closed to UNKNOWN.
    if (!Array.isArray(payload.items)) {
      return { classification: 'UNKNOWN', deployments: [], httpStatus: response.status };
    }
    const deployments = payload.items
      .map(deploymentSummary)
      .filter((entry): entry is KubernetesDeploymentSummary => entry !== null);
    const matches = deployments.filter(
      (deployment) => deployment.annotations[markerAnnotation] === marker,
    );
    if (matches.length === 0) {
      return { classification: 'NOT_APPLIED', deployments, httpStatus: response.status };
    }
    if (matches.length !== 1) {
      return { classification: 'UNKNOWN', deployments, httpStatus: response.status };
    }
    const matched = matches[0]!;
    const expected = targetAnnotations(markerAnnotation);
    if (
      matched.name !== context.name ||
      matched.namespace !== context.namespace ||
      matched.annotations[expected.revision] !== expectedRevision ||
      !matched.templateHash ||
      matched.annotations[expected.templateHash] !== matched.templateHash ||
      !matched.rolloutComplete
    ) {
      return { classification: 'UNKNOWN', deployments, httpStatus: response.status, matched };
    }
    return {
      classification: 'APPLIED',
      deployments,
      httpStatus: response.status,
      matched,
    };
  }

  async function write(
    input: Pick<AdapterExecuteInput, 'tenantId' | 'destination' | 'signal'>,
    markerAnnotation: string,
    marker: string,
    deployment: KubernetesDeploymentSummary,
    targetRevision: string,
    reason: string,
    target: KubernetesRollbackTarget,
  ): Promise<number> {
    const context = await requestContext(input.tenantId, input.destination);
    const deploymentUrl = new URL(
      `${context.collectionUrl.pathname}/${encodeURIComponent(context.name)}`,
      context.collectionUrl,
    );
    const expected = targetAnnotations(markerAnnotation);
    try {
      const patchResponse = await fetchImpl(deploymentUrl, {
        method: 'PATCH',
        headers: headers(context.token, 'application/merge-patch+json'),
        body: JSON.stringify({
          metadata: {
            annotations: {
              [markerAnnotation]: marker,
              [expected.revision]: targetRevision,
              [expected.templateHash]: target.templateHash,
              ...(markerAnnotation === ACTION_MARKER_ANNOTATION
                ? { [ACTION_ORIGINAL_REVISION_ANNOTATION]: deployment.revision }
                : {}),
            },
          },
        }),
        signal: input.signal,
      });
      if (!patchResponse.ok) {
        throw executionError(
          `Kubernetes marker patch failed with HTTP ${patchResponse.status}`,
          'KUBERNETES_MARKER_PATCH_FAILED',
          patchResponse.status === 401 || patchResponse.status === 403
            ? 'NOT_COMMITTED'
            : 'UNKNOWN',
          { httpStatus: patchResponse.status },
        );
      }
      let markedDeployment: KubernetesDeploymentSummary | null;
      try {
        markedDeployment = deploymentSummary(await readJsonResponse<unknown>(patchResponse));
      } catch {
        markedDeployment = null;
      }
      if (!markedDeployment?.resourceVersion) {
        throw executionError(
          'Kubernetes marker patch response lacks resourceVersion',
          'KUBERNETES_MARKER_RESPONSE_INVALID',
          'UNKNOWN',
        );
      }

      const rollbackResponse = await fetchImpl(deploymentUrl, {
        method: 'PATCH',
        headers: headers(context.token, 'application/strategic-merge-patch+json'),
        body: JSON.stringify({
          metadata: {
            resourceVersion: markedDeployment.resourceVersion,
            annotations: { [ROLLBACK_REASON_ANNOTATION]: reason },
          },
          spec: { template: target.template },
        }),
        signal: input.signal,
      });
      if (!rollbackResponse.ok) {
        throw executionError(
          `Kubernetes rollback failed with HTTP ${rollbackResponse.status}`,
          'KUBERNETES_ROLLBACK_FAILED',
          'UNKNOWN',
          { httpStatus: rollbackResponse.status },
        );
      }
      let rolledBack: KubernetesDeploymentSummary | null;
      try {
        rolledBack = deploymentSummary(await readJsonResponse<unknown>(rollbackResponse));
      } catch {
        rolledBack = null;
      }
      if (!rolledBack?.rolloutComplete || rolledBack.templateHash !== target.templateHash) {
        throw executionError(
          'Kubernetes rollback was accepted but rollout completion is not yet visible',
          'KUBERNETES_ROLLOUT_PENDING',
          'UNKNOWN',
          { httpStatus: rollbackResponse.status },
        );
      }
      return rollbackResponse.status;
    } catch (error) {
      if (error instanceof AdapterExecutionError) throw error;
      throw executionError(
        'Kubernetes rollback completion is unknown',
        'KUBERNETES_ROLLBACK_UNKNOWN',
        'UNKNOWN',
      );
    }
  }

  return {
    descriptor: KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,

    async execute(input: AdapterExecuteInput): Promise<Record<string, unknown>> {
      const { targetRevision, reason } = requiredExecuteArgs(input.args);
      const context = parseKubernetesDeploymentDestination(input.destination);
      const marker = commanderActionMarker(input.tenantId, input.idempotencyKey);
      const observed = await observe(input, ACTION_MARKER_ANNOTATION, marker, targetRevision);
      if (observed.classification === 'APPLIED') {
        const originalRevision = observed.matched?.annotations[ACTION_ORIGINAL_REVISION_ANNOTATION];
        if (!originalRevision) {
          throw executionError(
            'Matching action marker lacks original revision evidence',
            'KUBERNETES_ACTION_EVIDENCE_CONFLICT',
            'UNKNOWN',
          );
        }
        return evidence(
          context.name,
          context.namespace,
          'APPLIED',
          observed.httpStatus ?? 200,
          originalRevision,
        );
      }
      if (observed.classification === 'UNKNOWN') {
        throw executionError(
          'Kubernetes rollback observation is ambiguous',
          'KUBERNETES_ACTION_OBSERVATION_UNKNOWN',
          'UNKNOWN',
        );
      }
      const deployment = observed.deployments.find(
        (candidate) => candidate.name === context.name && candidate.namespace === context.namespace,
      );
      if (!deployment?.revision) {
        throw executionError(
          'Kubernetes deployment or observed revision was not found',
          'KUBERNETES_DEPLOYMENT_NOT_FOUND',
          'NOT_COMMITTED',
          { httpStatus: observed.httpStatus },
        );
      }
      const target = await resolveRollbackTarget(input, deployment, targetRevision);
      const httpStatus = await write(
        input,
        ACTION_MARKER_ANNOTATION,
        marker,
        deployment,
        targetRevision,
        reason,
        target,
      );
      return evidence(context.name, context.namespace, 'APPLIED', httpStatus, deployment.revision);
    },

    async queryOutcome(input: AdapterQueryInput): Promise<EffectRemoteOutcome> {
      const args =
        input.request.args && typeof input.request.args === 'object'
          ? (input.request.args as Record<string, unknown>)
          : {};
      const targetRevision = requiredRevision(
        input.request.targetRevision ?? args.targetRevision,
        'targetRevision',
      );
      const context = parseKubernetesDeploymentDestination(input.destination);
      const observed = await observe(
        input,
        ACTION_MARKER_ANNOTATION,
        commanderActionMarker(input.tenantId, input.idempotencyKey),
        targetRevision,
      );
      const originalRevision = observed.matched?.annotations[ACTION_ORIGINAL_REVISION_ANNOTATION];
      if (observed.classification === 'APPLIED' && !originalRevision) {
        return {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        };
      }
      return toRemoteOutcome(observed, context.name, context.namespace, originalRevision);
    },

    async compensate(input: AdapterCompensateInput): Promise<Record<string, unknown>> {
      if (!input.originalEffectId) {
        throw executionError(
          'Missing original effect id for compensation',
          'KUBERNETES_COMPENSATE_MISSING_EFFECT',
          'NOT_COMMITTED',
        );
      }
      const originalRevision = requiredRevision(
        input.forwardResponse.revision,
        'Missing original revision; forwardResponse.revision',
      );
      const allowed = new Set(KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR.compensationPatchKeys);
      const keys = Object.keys(input.compensationPatch);
      if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
        throw executionError(
          'compensationPatch contains denied or missing keys',
          'KUBERNETES_COMPENSATE_PATCH_DENIED',
          'NOT_COMMITTED',
        );
      }
      const targetRevision = requiredRevision(
        input.compensationPatch.targetRevision,
        'compensationPatch.targetRevision',
      );
      if (targetRevision !== originalRevision) {
        throw executionError(
          'compensationPatch targetRevision must equal the original revision',
          'KUBERNETES_COMPENSATE_TARGET_MUTATION',
          'NOT_COMMITTED',
        );
      }
      const reason = requiredReason(input.compensationPatch.reason);
      const context = parseKubernetesDeploymentDestination(input.destination);
      const marker = compensationIdempotencyKey(
        input.originalEffectId,
        KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR.adapterVersion,
      );
      const observed = await observe(input, COMPENSATION_MARKER_ANNOTATION, marker, targetRevision);
      if (observed.classification === 'APPLIED') {
        return evidence(
          context.name,
          context.namespace,
          'APPLIED',
          observed.httpStatus ?? 200,
          targetRevision,
        );
      }
      if (observed.classification === 'UNKNOWN') {
        throw executionError(
          'Kubernetes compensation observation is ambiguous',
          'KUBERNETES_COMPENSATE_OBSERVATION_UNKNOWN',
          'UNKNOWN',
        );
      }
      const deployment = observed.deployments.find(
        (candidate) => candidate.name === context.name && candidate.namespace === context.namespace,
      );
      if (!deployment?.revision) {
        throw executionError(
          'Kubernetes deployment was not found for compensation',
          'KUBERNETES_COMPENSATE_DEPLOYMENT_NOT_FOUND',
          'NOT_COMMITTED',
        );
      }
      const target = await resolveRollbackTarget(input, deployment, targetRevision);
      const httpStatus = await write(
        input,
        COMPENSATION_MARKER_ANNOTATION,
        marker,
        deployment,
        targetRevision,
        reason,
        target,
      );
      return evidence(context.name, context.namespace, 'APPLIED', httpStatus, targetRevision);
    },

    async queryCompensationOutcome(
      input: AdapterQueryInput & { compensationResponse?: Record<string, unknown> },
    ): Promise<EffectRemoteOutcome> {
      const forwardResponse =
        input.request.forwardResponse && typeof input.request.forwardResponse === 'object'
          ? (input.request.forwardResponse as Record<string, unknown>)
          : {};
      const compensationPatch =
        input.request.compensationPatch && typeof input.request.compensationPatch === 'object'
          ? (input.request.compensationPatch as Record<string, unknown>)
          : {};
      const targetRevision = requiredRevision(
        compensationPatch.targetRevision ?? forwardResponse.revision,
        'compensation targetRevision',
      );
      const originalEffectId = String(input.request.originalEffectId ?? '');
      if (!originalEffectId)
        return {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        };
      const context = parseKubernetesDeploymentDestination(input.destination);
      const marker = compensationIdempotencyKey(
        originalEffectId,
        KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR.adapterVersion,
      );
      const observed = await observe(input, COMPENSATION_MARKER_ANNOTATION, marker, targetRevision);
      if (observed.classification !== 'APPLIED')
        return {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        };
      return toRemoteOutcome(observed, context.name, context.namespace, targetRevision);
    },
  };
}
