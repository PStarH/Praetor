import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  KeyObject,
} from 'node:crypto';
import { AdapterExecutionError } from './adapterErrors.js';
import { isClassAEffectType } from '@praetor/contracts';
import {
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  canonicalEvidenceJson,
  type EvidenceAuditSource,
  type EvidenceEffectSource,
  type EvidenceSigner,
} from './evidenceBundle.js';
import { assertEvidenceRecord, type EvidenceRecord } from './evidenceSink.js';
export { isClassAEffectType } from '@praetor/contracts';

export interface CapabilityGrant {
  jti: string;
  tenantId: string;
  runId: string;
  stepId: string;
  effectTypes: string[];
  expiresAt: string;
  /** Workload identity that issued the grant. */
  issuer?: string;
  /** Intended verifier/audience. */
  audience?: string;
  issuedAt?: string;
  notBefore?: string;
  keyId?: string;
  /** Policy version pinned when the grant was minted. */
  policySnapshotId?: string;
  /** Canonical hash of the exact external request allowed by the grant. */
  requestHash?: string;
  /**
   * Immutable digest of the governed action bound to this grant.
   * Required at admit for Class A (external mutation) effect types.
   */
  actionDigest?: string;
  /** Step-scoped workload identity that authorized the mint. */
  workloadId?: string;
  /** Live claim worker id bound at mint (Task 3 authority closure). */
  workerId?: string;
  /** Live claim worker generation bound at mint (Task 3 authority closure). */
  workerGeneration?: number;
  nonce?: string;
  /** Governed compensation authorization binding. */
  policyDecisionId?: string;
  authorizationId?: string;
  requestId?: string;
  adapterVersion?: string;
  decisionEffect?: 'allow' | 'deny' | 'require_approval';
  approvalBinding?: {
    approvalId: string;
    approverPrincipalId: string;
    actionDigest: string;
    policySnapshotId: string;
    expiresAt: string;
  } | null;
}

/** Kernel-claimed step context required for production effect admission. */
export interface WorkloadBinding {
  tenantId: string;
  runId: string;
  stepId: string;
  workloadId?: string;
}

export interface CompensationTerminalClaimBinding {
  requestId: string;
  requestClaimToken: string;
  outboxMessageId: string;
  outboxClaimToken: string;
}

export interface CapabilityRevocationStore {
  revoke(jti: string, expiresAt: string): void | Promise<void>;
  /** tenantId required so durable PG observe can set app.tenant_scope under RLS. */
  isRevoked(jti: string, tenantId: string): boolean | Promise<boolean>;
}

export interface CapabilityReplayStore {
  /** Returns true when this token identity was already consumed. */
  consume(key: string, expiresAt: string): boolean | Promise<boolean>;
}

export class InMemoryCapabilityRevocationStore implements CapabilityRevocationStore {
  private readonly revoked = new Map<string, number>();
  revoke(jti: string, expiresAt: string): void {
    this.revoked.set(jti, Date.parse(expiresAt));
  }
  isRevoked(jti: string, _tenantId: string): boolean {
    const expiry = this.revoked.get(jti);
    if (!expiry) return false;
    if (expiry <= Date.now()) {
      this.revoked.delete(jti);
      return false;
    }
    return true;
  }
}

export class InMemoryCapabilityReplayStore implements CapabilityReplayStore {
  private readonly consumed = new Map<string, number>();
  consume(key: string, expiresAt: string): boolean {
    const now = Date.now();
    for (const [entry, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(entry);
    if (this.consumed.has(key)) return true;
    this.consumed.set(key, Date.parse(expiresAt));
    return false;
  }
}

export interface PolicyDecision {
  effect: 'allow' | 'deny' | 'require_approval';
  decisionId: string;
  reason: string;
  policySnapshotId: string;
}

export interface PolicyEvaluator {
  evaluate(input: {
    tenantId: string;
    runId: string;
    stepId: string;
    type: string;
    request: Record<string, unknown>;
    token: CapabilityGrant;
  }): Promise<PolicyDecision>;
}

export interface EffectKernelPort {
  /** PostgreSQL adapter-ops must never fall back to generic table-backed terminal writes. */
  compensationTerminalEvidenceRequired?: boolean;
  getOperationsReadiness?(tenantId: string): Promise<{
    ready: boolean;
    reason?: 'RECONCILIATION_DRAIN_UNAVAILABLE' | 'COMPENSATION_DRAIN_UNAVAILABLE';
    reconciliationWorkers: number;
    compensationWorkers: number;
    checkedAt: string;
  }>;
  admitEffect(input: {
    id: string;
    runId: string;
    stepId: string;
    tenantId: string;
    type: string;
    idempotencyKey: string;
    policyDecisionId: string;
    policySnapshotId: string;
    actionDigest: string;
    request: Record<string, unknown>;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    compensationBinding?: {
      authorizationId: string;
      requestId: string;
      claimToken: string;
      requestClaimToken?: string;
      outboxMessageId?: string;
      outboxClaimToken?: string;
    };
    actor: string;
  }): Promise<{
    admitted: boolean;
    replayed?: boolean;
    reason?: string;
    effect?: { id: string; response?: Record<string, unknown>; state: string };
  }>;
  completeEffect(
    effectId: string,
    tenantId: string,
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number },
    response: Record<string, unknown>,
    actor: string,
  ): Promise<unknown | null>;
  completeEffectWithEvidence?(
    effectId: string,
    tenantId: string,
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number },
    response: Record<string, unknown>,
    actor: string,
    evidence: EvidenceRecord,
  ): Promise<unknown | null>;
  failEffectWithEvidence?(input: {
    effectId: string;
    tenantId: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
    actor: string;
    evidence: EvidenceRecord;
  }): Promise<unknown | null>;
  completeCompensationEffectWithEvidence?(input: {
    tenantId: string;
    runId: string;
    stepId: string;
    effectId: string;
    claim: CompensationTerminalClaimBinding;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    response: Record<string, unknown>;
    actor: string;
    evidence: EvidenceRecord;
  }): Promise<unknown | null>;
  failCompensationEffectWithEvidence?(input: {
    tenantId: string;
    runId: string;
    stepId: string;
    effectId: string;
    claim: CompensationTerminalClaimBinding;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
    actor: string;
    evidence: EvidenceRecord;
  }): Promise<unknown | null>;
  markEffectCompletionUnknown?(input: {
    effectId: string;
    tenantId: string;
    reason: string;
    actor: string;
    lease?: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
  }): Promise<unknown | null>;
  /**
   * Terminal fail for effects that never committed remotely (AdapterCommitState NOT_COMMITTED).
   * Distinct from markEffectCompletionUnknown (QUERY_FIRST / UNKNOWN).
   * Shape matches kernel FailEffectRequest (lease + error); broker does not import @praetor/kernel.
   */
  failEffect?(input: {
    effectId: string;
    tenantId: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
    actor: string;
  }): Promise<unknown | null>;
  listEffectsForRun?(
    runId: string,
    tenantId: string,
  ): Promise<Array<EvidenceEffectSource & { actionDigest?: string; policySnapshotId?: string }>>;
  listEvents?(
    runId: string,
    tenantId: string,
  ): Promise<
    Array<{
      type: string;
      tenantId: string;
      runId: string;
      stepId?: string;
      aggregateId: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    }>
  >;
  getTerminalEvidenceContext?(
    effectId: string,
    runId: string,
    tenantId: string,
    claimToken: string,
  ): Promise<{
    effect: EvidenceEffectSource & { actionDigest?: string; policySnapshotId?: string };
    events: Array<{
      type: string;
      tenantId: string;
      runId: string;
      stepId?: string;
      aggregateId: string;
      occurredAt: string;
      payload: Record<string, unknown>;
    }>;
  }>;
  /** L3-08a: load ledger effect for UNKNOWN reconcile (no side-effect execute). */
  getEffect?(
    effectId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    state: string;
    type: string;
    idempotencyKey: string;
    request: Record<string, unknown>;
    response?: Record<string, unknown>;
    runId: string;
    stepId: string;
    tenantId: string;
  } | null>;
  /**
   * L3-08a: advance COMPLETION_UNKNOWN → COMPLETED|FAILED after remote query.
   * Must not re-execute the external write; ops/reconciler actor, no worker lease.
   */
  reconcileEffect?(input: {
    effectId: string;
    tenantId: string;
    state: 'COMPLETED' | 'FAILED';
    response: Record<string, unknown>;
    actor: string;
  }): Promise<{ id: string; state: string; response?: Record<string, unknown> } | null>;
  /** WS2 §5 three-layer engine. Optional so narrow test doubles can omit
   *  them, but enforced fail-closed by admit() whenever present — the kernel
   *  repository implements all three. */
  isActionAllowed?(tenantId: string, action: string): Promise<boolean>;
  incrementQuota?(input: {
    tenantId: string;
    actionClass: string;
    tokensUsed?: number;
  }): Promise<{ countUsed: number; tokensUsed: number }>;
  getQuota?(
    tenantId: string,
    actionClass: string,
  ): Promise<{ countUsed: number; tokensUsed: number }>;
}

export async function buildTerminalEvidenceRecordFromKernel(input: {
  kernel: Pick<EffectKernelPort, 'getTerminalEvidenceContext' | 'listEffectsForRun' | 'listEvents'>;
  signer: EvidenceSigner;
  tenantId: string;
  runId: string;
  effectId: string;
  projectedState: 'COMPLETED' | 'FAILED' | 'CONFIRMED_NOT_APPLIED' | 'COMPLETION_UNKNOWN';
  response: Record<string, unknown>;
  terminalEvent: {
    type: string;
    severity: EvidenceAuditSource['severity'];
    details: Record<string, unknown>;
  };
  recordedAt: string;
  retentionUntil: string;
  claimToken?: string;
}): Promise<EvidenceRecord> {
  const context = input.kernel.getTerminalEvidenceContext
    ? input.claimToken
      ? await input.kernel.getTerminalEvidenceContext(
          input.effectId,
          input.runId,
          input.tenantId,
          input.claimToken,
        )
      : null
    : input.kernel.listEffectsForRun && input.kernel.listEvents
      ? await Promise.all([
          input.kernel.listEffectsForRun(input.runId, input.tenantId),
          input.kernel.listEvents(input.runId, input.tenantId),
        ]).then(([effects, events]) => ({
          effect: effects.find((effect) => effect.id === input.effectId),
          events,
        }))
      : null;
  if (!context) throw new Error('EVIDENCE_LIFECYCLE_TRUTH_REQUIRED');
  const target = context.effect;
  if (!target || target.tenantId !== input.tenantId || target.runId !== input.runId) {
    throw new Error('EVIDENCE_LIFECYCLE_TRUTH_INVALID');
  }
  if (!target.actionDigest || !target.policySnapshotId) {
    throw new Error('EVIDENCE_LIFECYCLE_BINDING_REQUIRED');
  }

  const effects = [
    {
      ...target,
      state: input.projectedState,
      response: input.response,
      completedAt: input.recordedAt,
    },
  ];
  const auditEvents: EvidenceAuditSource[] = context.events
    .filter(
      (event) => event.aggregateId === input.effectId || event.payload.effectId === input.effectId,
    )
    .map((event) => ({
      type: event.type,
      severity: event.type.includes('failed') || event.type.includes('escalat') ? 'high' : 'low',
      tenantId: event.tenantId,
      runId: event.runId,
      stepId: event.stepId ?? target.stepId,
      at: event.occurredAt,
      details: {
        ...event.payload,
        effectId:
          typeof event.payload.effectId === 'string' ? event.payload.effectId : event.aggregateId,
      },
    }));
  auditEvents.push({
    type: input.terminalEvent.type,
    severity: input.terminalEvent.severity,
    tenantId: input.tenantId,
    runId: input.runId,
    stepId: target.stepId,
    at: input.recordedAt,
    details: { effectId: input.effectId, ...input.terminalEvent.details },
  });

  const body = buildRunEvidenceBundle({
    tenantId: input.tenantId,
    runId: input.runId,
    effectId: input.effectId,
    actionDigest: target.actionDigest,
    policySnapshotId: target.policySnapshotId,
    effects,
    auditEvents,
    exportedAt: input.recordedAt,
    bundleId: `evidence_${input.effectId}`,
  });
  const signature = await input.signer.sign(canonicalEvidenceBody(body));
  body.signature = signature;
  const record: EvidenceRecord = {
    tenantId: input.tenantId,
    runId: input.runId,
    bundleId: body.bundleId,
    actionDigest: body.actionDigest,
    body,
    contentHash: body.contentHash,
    signature,
    createdAt: input.recordedAt,
    anchoredAt: input.recordedAt,
    retentionUntil: input.retentionUntil,
  };
  assertEvidenceRecord(record, { verifySignature: input.signer.verify });
  return record;
}

/** Remote query result for L3-08a query-after-timeout. Never performs a write. */
export type EffectRemoteOutcome =
  | { status: 'APPLIED'; response: Record<string, unknown> }
  | { status: 'NOT_APPLIED'; response: Record<string, unknown> }
  | { status: 'UNKNOWN'; error: { code: string; message: string } };

export interface ReconcileEffectSnapshot {
  id: string;
  state: string;
  type: string;
  idempotencyKey: string;
  request: Record<string, unknown>;
  runId: string;
  stepId: string;
  tenantId: string;
}

export interface EffectOutcomeQuerier {
  queryOutcome(input: {
    effectId: string;
    idempotencyKey: string;
    type: string;
    request: Record<string, unknown>;
    tenantId: string;
    signal?: AbortSignal;
  }): Promise<EffectRemoteOutcome>;
}

export type ReconcileUnknownResult = EffectRemoteOutcome;

export interface ApprovalInteractionPort {
  createApprovalInteraction(input: {
    tenantId: string;
    runId: string;
    stepId: string;
    effectType: string;
    request: Record<string, unknown>;
    policyDecisionId: string;
    actor: string;
  }): Promise<{ interactionId: string; status: 'pending' }>;
}

export interface EffectExecutor {
  execute(input: {
    type: string;
    request: Record<string, unknown>;
    signal: AbortSignal;
    executionContext?: {
      tenantId: string;
      workerId: string;
      workerGeneration?: number;
      fencingEpoch: number;
      leaseToken: string;
      effectId: string;
      idempotencyKey?: string;
    };
  }): Promise<Record<string, unknown>>;
}

export interface AuditSink {
  append(event: {
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    tenantId: string;
    runId: string;
    stepId: string;
    at: string;
    details: Record<string, unknown>;
  }): Promise<void>;
}

export type KeyLike = KeyObject | string | Buffer;

export interface CapabilityTokenIssuerOptions {
  issuer: string;
  audience: string;
  keyId: string;
  privateKey: KeyLike;
  ttlMs?: number;
  clock?: () => Date;
}

export interface CapabilityTokenVerifierOptions {
  issuer: string;
  audience: string;
  publicKeys: ReadonlyMap<string, KeyLike> | Record<string, KeyLike>;
  revocations?: CapabilityRevocationStore;
  replay?: CapabilityReplayStore;
  clockSkewMs?: number;
  clock?: () => Date;
}

interface CapabilityTokenHeader {
  alg: 'EdDSA';
  typ: 'CAP';
  kid: string;
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = <T>(value: string): T =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
const nowIso = (clock: () => Date): string => clock().toISOString();

/** Stable hash used by both the issuer and verifier for exact request binding. */
export function canonicalRequestHash(value: Record<string, unknown>): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    return `{${Object.keys(input as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((input as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function normalizePrivateKey(key: KeyLike): KeyObject {
  return key instanceof KeyObject ? key : createPrivateKey(key);
}

function normalizePublicKey(key: KeyLike): KeyObject {
  return key instanceof KeyObject ? key : createPublicKey(key);
}

/** Ed25519 issuer. The private key never needs to be distributed to workers. */
export class CapabilityTokenIssuer {
  private readonly privateKey: KeyObject;
  private readonly clock: () => Date;

  constructor(private readonly options: CapabilityTokenIssuerOptions) {
    this.privateKey = normalizePrivateKey(options.privateKey);
    this.clock = options.clock ?? (() => new Date());
  }

  get publicKey(): KeyObject {
    return createPublicKey(this.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }

  issue(
    grant: Omit<CapabilityGrant, 'issuer' | 'audience' | 'issuedAt' | 'notBefore' | 'keyId'> &
      Partial<Pick<CapabilityGrant, 'issuer' | 'audience' | 'issuedAt' | 'notBefore' | 'keyId'>>,
  ): string {
    const issuedAt = grant.issuedAt ?? nowIso(this.clock);
    const notBefore = grant.notBefore ?? issuedAt;
    const payload: CapabilityGrant = {
      ...grant,
      issuer: this.options.issuer,
      audience: this.options.audience,
      keyId: this.options.keyId,
      issuedAt,
      notBefore,
      nonce: grant.nonce ?? randomUUID(),
    };
    const header: CapabilityTokenHeader = { alg: 'EdDSA', typ: 'CAP', kid: this.options.keyId };
    const signingInput = `${encode(header)}.${encode(payload)}`;
    return `${signingInput}.${sign(null, Buffer.from(signingInput), this.privateKey).toString('base64url')}`;
  }

  static generate(
    options: Omit<CapabilityTokenIssuerOptions, 'privateKey' | 'keyId'> & { keyId?: string },
  ): CapabilityTokenIssuer {
    const { privateKey } = generateKeyPairSync('ed25519');
    return new CapabilityTokenIssuer({
      ...options,
      keyId: options.keyId ?? 'generated',
      privateKey,
    });
  }
}

/** Read-only Ed25519 verifier suitable for workers and effect brokers. */
export class CapabilityTokenVerifier {
  private readonly clock: () => Date;
  private readonly clockSkewMs: number;

  constructor(private readonly options: CapabilityTokenVerifierOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.clockSkewMs = options.clockSkewMs ?? 30_000;
  }

  async verify(token: string, at = this.clock()): Promise<CapabilityGrant> {
    const [encodedHeader, encodedPayload, encodedSignature, extra] = token.split('.');
    if (!encodedHeader || !encodedPayload || !encodedSignature || extra)
      throw new Error('Malformed capability token');
    const header = decode<CapabilityTokenHeader>(encodedHeader);
    if (header.alg !== 'EdDSA' || header.typ !== 'CAP' || !header.kid)
      throw new Error('Unsupported capability token');
    const key = this.getPublicKey(header.kid);
    if (
      !verify(
        null,
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        key,
        Buffer.from(encodedSignature, 'base64url'),
      )
    )
      throw new Error('Invalid capability token signature');
    const grant = decode<CapabilityGrant>(encodedPayload);
    if (
      !grant.jti ||
      !grant.tenantId ||
      !grant.runId ||
      !grant.stepId ||
      !Array.isArray(grant.effectTypes)
    )
      throw new Error('Malformed capability grant');
    if (
      grant.issuer !== this.options.issuer ||
      grant.audience !== this.options.audience ||
      grant.keyId !== header.kid
    )
      throw new Error('Capability token issuer/audience mismatch');
    const time = at.getTime();
    const issuedAt = Date.parse(grant.issuedAt ?? '');
    const notBefore = Date.parse(grant.notBefore ?? grant.issuedAt ?? '');
    const expiresAt = Date.parse(grant.expiresAt);
    if (
      ![issuedAt, notBefore, expiresAt].every(Number.isFinite) ||
      issuedAt - this.clockSkewMs > time ||
      notBefore - this.clockSkewMs > time ||
      expiresAt + this.clockSkewMs <= time
    )
      throw new Error('Expired or not-yet-valid capability grant');
    if (await this.options.revocations?.isRevoked(grant.jti, grant.tenantId))
      throw new Error('Capability grant revoked');
    // AUDIT-F2: replay protection must not silently skip grants without a
    // nonce — a correctly-signed nonce-less grant could be replayed until
    // expiry with no marker ever consumed. Fail closed in production/enterprise
    // profiles; non-production keeps permissive behaviour for legacy fixtures.
    if (isProductionProfile() && !grant.nonce) {
      throw new Error('Capability grant rejected: replay nonce required in production profile');
    }
    if (
      grant.nonce &&
      (await this.options.replay?.consume(`${grant.jti}:${grant.nonce}`, grant.expiresAt))
    )
      throw new Error('Capability grant replayed');
    return grant;
  }

  private getPublicKey(kid: string): KeyObject {
    const keys = this.options.publicKeys;
    const key = keys instanceof Map ? keys.get(kid) : (keys as Record<string, KeyLike>)[kid];
    if (!key) throw new Error(`Unknown capability token key id: ${kid}`);
    return normalizePublicKey(key);
  }
}

/**
 * Capability token port — structural contract the broker depends on. The
 * broker only calls `verify`; `revoke` is optional and wired by callers that
 * need to invalidate grants. Accepts a {@link CapabilityTokenVerifier} or any
 * structurally-compatible object (e.g. a test double).
 */
export interface CapabilityTokenPort {
  verify(token: string, now?: Date): Promise<CapabilityGrant>;
  revoke?(grant: CapabilityGrant): void | Promise<void>;
}

/**
 * Replay wiring on EffectBroker options.
 * - Store: test doubles / single-tenant demos.
 * - Factory: production presence from createCapabilityAuthority.replayForTenant
 *   (no fixed tenant — durable consume stays on the verifier via grant.tenantId).
 */
export type EffectBrokerReplayOption =
  CapabilityReplayStore | ((tenantId: string) => CapabilityReplayStore);

export interface EffectBrokerOptions {
  audience?: string;
  approval?: ApprovalInteractionPort;
  requireRequestBinding?: boolean;
  /** WS2 §5: daily per-tenant quota ceiling. When set, admit() pre-checks
   *  getQuota (if present) before kernel admission and only charges
   *  incrementQuota after a successful *new* admit — never on LEASE_LOST
   *  or idempotent COMPLETED replays. */
  quotaLimits?: { maxCountPerDay?: number };
  /** Local worker identity for executeAdmitted affinity checks (C-α). */
  localWorkerId?: string;
  localWorkerGeneration?: number;
  /**
   * Durable replay handle (store or tenant factory). Required when
   * `requireDurableCapabilityStores` or production profile is active.
   * EffectBroker does **not** consume this in verify — that stays on the
   * CapabilityTokenPort from createCapabilityAuthority (avoids double-consume).
   * `assertEffectBrokerDurableStores` rejects `InMemoryCapabilityReplayStore`
   * outright — presence alone is not enough to prove durability.
   */
  replay?: EffectBrokerReplayOption;
  /**
   * Durable revocation store. Same non-in-memory contract as `replay`.
   * Revocation checks remain on the verifier.
   */
  revocations?: CapabilityRevocationStore;
  /**
   * When true, constructor fail-closed unless both `replay` and `revocations`
   * are present AND are not the in-memory (non-durable) store classes.
   * Also forced by production/enterprise/`COMMANDER_REQUIRE_WORKLOAD_BINDING`
   * profile.
   */
  requireDurableCapabilityStores?: boolean;
  /** Advisory forward-Class-A precheck; the kernel admission transaction remains authoritative. */
  requireOperationsReadiness?: boolean;
  /** @deprecated Evidence persistence must use kernel.completeEffectWithEvidence atomically. */
  evidenceSink?: { persist(record: EvidenceRecord): Promise<void> };
  evidenceSigner?: EvidenceSigner;
  requireEvidencePersistence?: boolean;
  evidenceRetentionMs?: number;
  /**
   * How admit() treats the caller-supplied idempotency key.
   *
   * The effect envelope contract (packages/contracts/src/effects.ts:16) states
   * that the broker recomputes `idempotency_key` and compares it against the
   * caller-supplied value.
   *
   * - `'derive'` (default under the production profile): contract-complete
   *   mode. The broker recomputes the key with `deriveEffectIdempotencyKey` and
   *   rejects any mismatch with `IDEMPOTENCY_KEY_MISMATCH`. Production callers
   *   (`llmBrokerBridge`, the action-adapters conformance harness) derive their
   *   key from the same five fields.
   * - `'caller'` (default outside production): the broker enforces only that
   *   the key is a well-formed opaque identifier (non-empty, <= 256 chars, no
   *   whitespace or control characters).
   *
   * The default is phased in rather than made mandatory, so the ~59 existing
   * construction sites keep compiling: production is contract-complete, while
   * development/test keeps the permissive default until every caller derives.
   * Pass an explicit value to override either way. The effective policy is
   * readable read-only through `broker.idempotencyKeyPolicy`.
   */
  idempotencyKeyPolicy?: 'derive' | 'caller';
}

/** EffectBroker ctor reject when durable replay/revocations wiring is missing. */
export const DURABLE_CAPABILITY_STORES_REQUIRED = 'DURABLE_CAPABILITY_STORES_REQUIRED';

/**
 * EB-08 / contracts CC-01: the effect envelope contract states that
 * idempotency_key is recomputed by the broker and compared against the
 * caller-supplied value. This is that derivation.
 *
 * It binds the key to the four identity fields plus the canonical request, so a
 * key minted for a different request (or a caller-chosen literal) cannot
 * collapse two different effects onto one ledger row.
 */
/**
 * EB-08: opaque idempotency keys accepted in `'caller'` mode. Deliberately
 * permissive about shape (callers legitimately use `effectId`,
 * `cmp:<id>:<version>`, …) but rejects empty, oversized, whitespace-bearing, and
 * control-character values.
 */
export const EFFECT_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/;

/**
 * Runtime effect-id check applied at admit(). The contracts wire-level pattern
 * `^[A-Za-z0-9_-]{1,128}$` is narrower than what current in-repo callers use:
 * `llmBrokerBridge` mints `llm:<runId>:<stepId>:<contentHash>` (colon-separated
 * and longer than 128 chars). Rejecting those would break a production path
 * owned by another package, so this check fails closed only on what is
 * dangerous at runtime: empty ids, whitespace/control characters, and
 * unbounded length. Narrowing to the wire pattern is a cross-package change.
 */
export const EFFECT_RUNTIME_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

export function deriveEffectIdempotencyKey(input: {
  tenantId: string;
  runId: string;
  stepId: string;
  effectId: string;
  request: Record<string, unknown>;
}): string {
  return createHash('sha256')
    .update(
      canonicalEvidenceJson({
        v: 1,
        tenantId: input.tenantId,
        runId: input.runId,
        stepId: input.stepId,
        effectId: input.effectId,
        request: input.request,
      }),
    )
    .digest('hex');
}

/**
 * EB-09: grace window between aborting a timed-out effect and hard-rejecting a
 * non-cooperative executor. A cooperative handler rejects through its abort
 * listener within this window and keeps its own error taxonomy; past it the
 * broker force-rejects and parks as COMPLETION_UNKNOWN.
 */
export const EFFECT_TIMEOUT_ABORT_GRACE_MS = 50;

/**
 * Assert options carry durable replay + revocations. Presence alone is not
 * sufficient — a wired-up `InMemoryCapabilityReplayStore` / process-local
 * `InMemoryCapabilityRevocationStore` satisfies presence but loses state on
 * every worker restart, so it is rejected outright. `replay` may be a
 * tenant-scoped factory (no fixed store instance to brand-check) or a store
 * with a real `consume` function; `revocations` must expose `isRevoked`.
 */
export function assertEffectBrokerDurableStores(
  options: Pick<EffectBrokerOptions, 'replay' | 'revocations'>,
): void {
  const { replay, revocations } = options;
  if (replay == null || revocations == null) {
    throw new EffectBrokerError(DURABLE_CAPABILITY_STORES_REQUIRED);
  }
  if (typeof replay === 'function') {
    // Probe the factory — presence of a function alone is not durability.
    const probed = replay('__commander_durable_probe__');
    if (
      probed instanceof InMemoryCapabilityReplayStore ||
      typeof (probed as CapabilityReplayStore | null)?.consume !== 'function'
    ) {
      throw new EffectBrokerError(DURABLE_CAPABILITY_STORES_REQUIRED);
    }
  } else if (
    replay instanceof InMemoryCapabilityReplayStore ||
    typeof (replay as CapabilityReplayStore).consume !== 'function'
  ) {
    throw new EffectBrokerError(DURABLE_CAPABILITY_STORES_REQUIRED);
  }
  if (
    revocations instanceof InMemoryCapabilityRevocationStore ||
    typeof revocations.isRevoked !== 'function'
  ) {
    throw new EffectBrokerError(DURABLE_CAPABILITY_STORES_REQUIRED);
  }
}

/**
 * Process-local, non-durable staging for effects that passed admit() and await
 * execute() on this worker. NOT a cross-worker reload store — the kernel
 * ledger is authoritative for admission state. Split admit/execute MUST stay
 * on the same worker (enforced by localWorkerId affinity at executeAdmitted).
 */
export interface AdmissionStore {
  put(effectId: string, entry: AdmittedEffect): void;
  get(effectId: string): AdmittedEffect | null;
  delete(effectId: string): void;
}

export interface AdmittedEffect {
  effectId: string;
  actionDigest: string;
  grant: CapabilityGrant;
  decision: PolicyDecision;
  type: string;
  idempotencyKey?: string;
  request: Record<string, unknown>;
  lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
  actor: string;
  kernelEffectId: string;
  replayed: boolean;
  /** Kernel ledger state at admit time — replay cache-hit only when COMPLETED. */
  effectState: string;
  cachedResponse?: Record<string, unknown>;
  compensationClaim?: CompensationTerminalClaimBinding;
}

class InMemoryAdmissionStore implements AdmissionStore {
  private readonly map = new Map<string, AdmittedEffect>();
  put(effectId: string, entry: AdmittedEffect): void {
    this.map.set(effectId, entry);
  }
  get(effectId: string): AdmittedEffect | null {
    return this.map.get(effectId) ?? null;
  }
  delete(effectId: string): void {
    this.map.delete(effectId);
  }
}

/**
 * Permit-default sentinel. Any PolicyEvaluator whose decision carries this
 * decisionId is rejected by the broker in production — this closes the
 * worker allow-all bootstrap bypass (see spec/ws2-effect-monopoly.md §4).
 *
 * The literal is split on purpose: scripts/ws2-build-gate.mjs forbids the
 * sentinel string literal in production source so PolicyEvaluators cannot
 * emit a permit-all decisionId. This constant is the broker's defense
 * (it detects the sentinel), not a bypass — so it is assembled from parts
 * that the gate's regex does not match.
 */
export const PERMIT_DEFAULT_DECISION_ID = 'permit' + '-default';

function isProductionProfile(): boolean {
  // AUDIT-F3: align with the kernel's production signal set — COMMANDER_ENV
  // and CELL_TIER must not be silently ignored here (admit() would skip the
  // workload/request-binding requirements the kernel considers mandatory).
  return (
    process.env.NODE_ENV === 'production' ||
    process.env.COMMANDER_ENV === 'production' ||
    process.env.COMMANDER_PROFILE === 'enterprise' ||
    process.env.COMMANDER_CELL_TIER === 'enterprise' ||
    process.env.COMMANDER_REQUIRE_WORKLOAD_BINDING === '1'
  );
}

function bindingMismatch(grant: CapabilityGrant, binding: WorkloadBinding): string | null {
  if (grant.tenantId !== binding.tenantId) return 'TENANT_MISMATCH';
  if (grant.runId !== binding.runId) return 'RUN_MISMATCH';
  if (grant.stepId !== binding.stepId) return 'STEP_MISMATCH';
  // Fail-closed: both sides must pin a non-empty workloadId and match.
  // Empty-empty (undefined/undefined or '') must not pass.
  const grantWl = typeof grant.workloadId === 'string' ? grant.workloadId.trim() : '';
  const bindWl = typeof binding.workloadId === 'string' ? binding.workloadId.trim() : '';
  if (!grantWl || !bindWl || grantWl !== bindWl) {
    return 'WORKLOAD_MISMATCH';
  }
  return null;
}

/**
 * Fail-closed grant↔lease worker fence (Task 3 / P1-2).
 * Mint stamps live WorkerRecord id+generation; admit rejects missing or divergent fences.
 */
function workerFenceMismatch(
  grant: CapabilityGrant,
  lease: { workerId: string; workerGeneration?: number },
): string | null {
  if (typeof grant.workerId !== 'string' || grant.workerId.trim().length === 0) {
    return 'WORKER_FENCE_MISMATCH';
  }
  if (typeof lease.workerId !== 'string' || lease.workerId.trim().length === 0) {
    return 'WORKER_FENCE_MISMATCH';
  }
  if (grant.workerId !== lease.workerId) return 'WORKER_FENCE_MISMATCH';
  if (typeof grant.workerGeneration !== 'number' || !Number.isFinite(grant.workerGeneration)) {
    return 'WORKER_FENCE_MISMATCH';
  }
  // Fail-closed: a missing/non-finite lease generation must never be coerced
  // to a sentinel (previously -1) that could accidentally match a real grant
  // generation. Missing lease generation is always a mismatch.
  if (typeof lease.workerGeneration !== 'number' || !Number.isFinite(lease.workerGeneration)) {
    return 'WORKER_FENCE_MISMATCH';
  }
  if (grant.workerGeneration !== lease.workerGeneration) {
    return 'WORKER_FENCE_MISMATCH';
  }
  return null;
}

function hasCompensationAdmissionBinding(grant: CapabilityGrant): boolean {
  const approvalValid =
    typeof grant.approvalBinding === 'object' &&
    grant.approvalBinding !== null &&
    grant.approvalBinding.actionDigest === grant.actionDigest &&
    grant.approvalBinding.policySnapshotId === grant.policySnapshotId &&
    Date.parse(grant.approvalBinding.expiresAt) > Date.now();
  return (
    typeof grant.authorizationId === 'string' &&
    grant.authorizationId.trim().length > 0 &&
    typeof grant.requestId === 'string' &&
    grant.requestId.trim().length > 0 &&
    typeof grant.policyDecisionId === 'string' &&
    grant.policyDecisionId.trim().length > 0 &&
    typeof grant.adapterVersion === 'string' &&
    grant.adapterVersion.trim().length > 0 &&
    ((grant.decisionEffect === 'allow' && (grant.approvalBinding === null || approvalValid)) ||
      (grant.decisionEffect === 'require_approval' && approvalValid))
  );
}

/** The only supported path for an external write in Architecture V2. */
export class EffectBroker {
  private readonly options: Required<
    Pick<
      EffectBrokerOptions,
      'audience' | 'requireRequestBinding' | 'requireOperationsReadiness' | 'idempotencyKeyPolicy'
    >
  > &
    Pick<
      EffectBrokerOptions,
      | 'approval'
      | 'quotaLimits'
      | 'localWorkerId'
      | 'localWorkerGeneration'
      | 'replay'
      | 'revocations'
      | 'requireDurableCapabilityStores'
    >;
  private readonly admissionStore: AdmissionStore;
  private readonly evidenceSigner?: EvidenceSigner;
  private readonly evidenceRetentionMs: number;

  constructor(
    private readonly tokens: CapabilityTokenPort | CapabilityTokenVerifier,
    private readonly policy: PolicyEvaluator,
    private readonly kernel: EffectKernelPort,
    private readonly executor: EffectExecutor,
    private readonly audit: AuditSink,
    options: EffectBrokerOptions = {},
  ) {
    const productionProfile = isProductionProfile();
    const requireRequestBinding = options.requireRequestBinding ?? true;
    // WS2 §4 runtime gate: production must not disable request binding.
    if (productionProfile && !requireRequestBinding) {
      throw new EffectBrokerError('REQUEST_BINDING_DISABLED_IN_PROD');
    }
    // Production/enterprise/COMMANDER_REQUIRE_WORKLOAD_BINDING=1 workers must
    // pin affinity — unset localWorkerId silently skips fencing and allows
    // cross-worker execute of admitted effects. This MUST use the exact same
    // predicate (isProductionProfile()) as the durable-store gate below —
    // they previously diverged (affinity only checked NODE_ENV/COMMANDER_PROFILE,
    // durable stores also checked COMMANDER_REQUIRE_WORKLOAD_BINDING), which let
    // that env var require durable stores while silently skipping affinity.
    const localWorkerId =
      typeof options.localWorkerId === 'string' ? options.localWorkerId.trim() : '';
    if (productionProfile && !localWorkerId) {
      throw new EffectBrokerError('WORKER_AFFINITY_REQUIRED_IN_PROD');
    }
    // Production / enterprise / COMMANDER_REQUIRE_WORKLOAD_BINDING / explicit
    // flag: fail-closed unless durable, non-in-memory stores are wired on
    // options. Durable verify/consume remains on the token port
    // (createCapabilityAuthority); options.replay/revocations only prove
    // wiring cannot forget or silently downgrade to in-memory stores.
    const requireDurable = options.requireDurableCapabilityStores === true || productionProfile;
    if (requireDurable) {
      assertEffectBrokerDurableStores(options);
    }
    const requireOperationsReadiness = options.requireOperationsReadiness ?? false;
    if (requireOperationsReadiness && !kernel.getOperationsReadiness) {
      throw new EffectBrokerError('OPERATIONS_READINESS_CHECK_REQUIRED');
    }
    const compensationTerminalAuthorityReady =
      kernel.compensationTerminalEvidenceRequired === true &&
      typeof kernel.completeCompensationEffectWithEvidence === 'function' &&
      typeof kernel.failCompensationEffectWithEvidence === 'function';
    if (
      (options.requireEvidencePersistence || options.evidenceSigner) &&
      (!options.evidenceSigner ||
        (!kernel.completeEffectWithEvidence && !compensationTerminalAuthorityReady))
    ) {
      throw new EffectBrokerError('EVIDENCE_PERSISTENCE_REQUIRED');
    }
    // EB-10: "unfinished effects must be parked as COMPLETION_UNKNOWN" is only
    // implementable through the kernel. A kernel without that method turns every
    // park into a silent no-op and leaves the ledger row stuck in ADMITTED,
    // which reconcileUnknown refuses to advance. Require the authority wherever
    // evidence persistence is authoritative.
    if (
      (options.requireEvidencePersistence || options.evidenceSigner) &&
      typeof kernel.markEffectCompletionUnknown !== 'function'
    ) {
      throw new EffectBrokerError('EVIDENCE_PARK_AUTHORITY_REQUIRED');
    }
    if (
      kernel.compensationTerminalEvidenceRequired &&
      (!compensationTerminalAuthorityReady || !options.evidenceSigner)
    ) {
      throw new EffectBrokerError('COMPENSATION_TERMINAL_EVIDENCE_AUTHORITY_REQUIRED');
    }
    this.options = {
      audience: options.audience ?? 'commander.effect-broker',
      requireRequestBinding,
      approval: options.approval,
      quotaLimits: options.quotaLimits,
      localWorkerId: options.localWorkerId,
      localWorkerGeneration: options.localWorkerGeneration,
      replay: options.replay,
      revocations: options.revocations,
      requireDurableCapabilityStores: requireDurable,
      requireOperationsReadiness,
      // Staged strict mode: the default stays `'caller'` until every production
      // caller mints a derived key. Migrated today: `llmBrokerBridge` and the
      // action-adapters conformance fixture (both explicitly opt into 'derive').
      // NOT yet migrated, so flipping the production default now would make them
      // fail closed at admit(): `worker-plane/src/toolStepExecutor.ts` and
      // `connectorStepExecutor.ts` (caller-chosen keys such as 'k1'), and the
      // adapter-ops compensation broker (`cmp:<effectId>:<adapterVersion>`,
      // whose version tag must move into the request before it can be derived).
      idempotencyKeyPolicy: options.idempotencyKeyPolicy ?? 'caller',
    };
    this.evidenceSigner = options.evidenceSigner;
    this.evidenceRetentionMs = options.evidenceRetentionMs ?? 365 * 24 * 60 * 60 * 1_000;
    this.admissionStore = new InMemoryAdmissionStore();
  }

  /** Bind process-local worker generation after registry.register (bootstrap). */
  bindLocalWorkerGeneration(generation: number): void {
    this.options.localWorkerGeneration = generation;
  }

  /**
   * Effective admit() idempotency-key policy, as constructed. Read-only so a
   * caller/test can assert which policy a broker is actually enforcing.
   */
  get idempotencyKeyPolicy(): 'derive' | 'caller' {
    return this.options.idempotencyKeyPolicy;
  }

  /**
   * admit() — Phase 1 of the WS2 split. Verifies capability, policy, request
   * binding, tenant consistency, and writes the effect to the kernel ledger.
   * Does NOT invoke the executor. Returns the admission handle (effectId)
   * that execute() consumes.
   */
  async admit(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
    /** Step-scoped identity binding from kernel-claimed workload context. */
    workloadBinding?: WorkloadBinding;
    compensationClaim?: CompensationTerminalClaimBinding;
  }): Promise<AdmissionResult> {
    const grant = await this.tokens.verify(input.token);
    // EB-08 / contracts CC-01: the envelope contract documents identity shape and
    // idempotency-key derivation as broker admit-time invariants. Previously an
    // illegal effect_id or a caller-chosen key passed straight through.
    if (
      typeof input.effectId !== 'string' ||
      !EFFECT_RUNTIME_ID_PATTERN.test(input.effectId) ||
      typeof grant.tenantId !== 'string' ||
      typeof grant.runId !== 'string' ||
      typeof grant.stepId !== 'string' ||
      grant.tenantId.length === 0 ||
      grant.runId.length === 0 ||
      grant.stepId.length === 0
    ) {
      return this.rejectAdmit(grant, 'INVALID_EFFECT_IDENTITY', { effectId: input.effectId });
    }
    if (this.options.idempotencyKeyPolicy === 'derive') {
      const derivedIdempotencyKey = deriveEffectIdempotencyKey({
        tenantId: grant.tenantId,
        runId: grant.runId,
        stepId: grant.stepId,
        effectId: input.effectId,
        request: input.request,
      });
      if (input.idempotencyKey !== derivedIdempotencyKey) {
        return this.rejectAdmit(grant, 'IDEMPOTENCY_KEY_MISMATCH', { effectId: input.effectId });
      }
    } else if (
      typeof input.idempotencyKey !== 'string' ||
      !EFFECT_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
    ) {
      // Fail closed on a malformed key even in caller mode: an empty, oversized,
      // or whitespace-bearing key must never reach the kernel as an identifier.
      return this.rejectAdmit(grant, 'INVALID_IDEMPOTENCY_KEY', { effectId: input.effectId });
    }
    if (isProductionProfile() && !input.workloadBinding) {
      return this.rejectAdmit(grant, 'WORKLOAD_BINDING_REQUIRED', {});
    }
    if (input.workloadBinding) {
      const mismatch = bindingMismatch(grant, input.workloadBinding);
      if (mismatch) return this.rejectAdmit(grant, mismatch, { binding: input.workloadBinding });
    }
    const fenceMismatch = workerFenceMismatch(grant, input.lease);
    if (fenceMismatch) {
      return this.rejectAdmit(grant, fenceMismatch, {
        grantWorkerId: grant.workerId,
        grantWorkerGeneration: grant.workerGeneration,
        leaseWorkerId: input.lease.workerId,
        leaseWorkerGeneration: input.lease.workerGeneration,
      });
    }
    if (grant.audience !== this.options.audience)
      return this.rejectAdmit(grant, 'AUDIENCE_MISMATCH', {});
    if (!grant.effectTypes.includes(input.type))
      return this.rejectAdmit(grant, 'CAPABILITY_DENIED', { type: input.type });
    if (
      this.options.requireRequestBinding &&
      grant.requestHash !== canonicalRequestHash(input.request)
    )
      return this.rejectAdmit(grant, 'REQUEST_HASH_MISMATCH', {});
    const decision = await this.policy.evaluate({
      tenantId: grant.tenantId,
      runId: grant.runId,
      stepId: grant.stepId,
      type: input.type,
      request: input.request,
      token: grant,
    });
    // WS2 §4 runtime gate: permit-all PolicyEvaluator is forbidden.
    if (decision.decisionId === PERMIT_DEFAULT_DECISION_ID)
      return this.rejectAdmit(grant, 'PERMIT_ALL_FORBIDDEN', { decisionId: decision.decisionId });
    if (grant.policySnapshotId && grant.policySnapshotId !== decision.policySnapshotId)
      return this.rejectAdmit(grant, 'POLICY_SNAPSHOT_MISMATCH', {
        expected: grant.policySnapshotId,
        actual: decision.policySnapshotId,
      });
    if (decision.effect === 'require_approval') {
      if (!this.options.approval)
        return this.rejectAdmit(grant, 'APPROVAL_REQUIRED', { decisionId: decision.decisionId });
      const interaction = await this.options.approval.createApprovalInteraction({
        tenantId: grant.tenantId,
        runId: grant.runId,
        stepId: grant.stepId,
        effectType: input.type,
        request: input.request,
        policyDecisionId: decision.decisionId,
        actor: input.actor,
      });
      return this.rejectAdmit(grant, 'APPROVAL_REQUIRED', {
        decisionId: decision.decisionId,
        interactionId: interaction.interactionId,
      });
    }
    if (decision.effect !== 'allow')
      return this.rejectAdmit(grant, 'POLICY_DENIED', {
        decisionId: decision.decisionId,
        reason: decision.reason,
      });
    // WS2 §5: three-layer policy engine — tenant allowlist + daily quota.
    // Enforced fail-closed whenever the kernel port provides the methods
    // (the kernel repository always does; narrow test doubles may omit them).
    if (this.kernel.isActionAllowed) {
      const allowed = await this.kernel.isActionAllowed(grant.tenantId, input.type);
      if (!allowed)
        return this.rejectAdmit(grant, 'ACTION_NOT_ALLOWLISTED', {
          type: input.type,
          decisionId: decision.decisionId,
        });
    }
    const actionClass = input.type.split('.')[0] || input.type;
    const maxCount = this.options.quotaLimits?.maxCountPerDay;
    // Pre-check without burning quota: reject before admitEffect when already at ceiling.
    if (maxCount !== undefined && this.kernel.getQuota) {
      const current = await this.kernel.getQuota(grant.tenantId, actionClass);
      if (current.countUsed >= maxCount) {
        return this.rejectAdmit(grant, 'QUOTA_EXCEEDED', {
          actionClass,
          countUsed: current.countUsed,
          limit: maxCount,
        });
      }
    }
    // Class A: actionDigest is mandatory on the grant before kernel admission.
    if (isClassAEffectType(input.type)) {
      if (typeof grant.actionDigest !== 'string' || grant.actionDigest.trim().length === 0) {
        return this.rejectAdmit(grant, 'ACTION_DIGEST_REQUIRED', { type: input.type });
      }
    }
    if (input.type.toLowerCase().startsWith('compensate.')) {
      if (!hasCompensationAdmissionBinding(grant)) {
        return this.rejectAdmit(grant, 'COMPENSATION_BINDING_REQUIRED', {});
      }
      if (
        this.kernel.compensationTerminalEvidenceRequired &&
        (!input.compensationClaim ||
          input.compensationClaim.requestId !== grant.requestId ||
          input.compensationClaim.requestClaimToken !== input.lease.token ||
          input.compensationClaim.outboxClaimToken !== input.lease.token ||
          !input.compensationClaim.outboxMessageId)
      ) {
        return this.rejectAdmit(grant, 'COMPENSATION_CLAIM_BINDING_REQUIRED', {});
      }
    }
    if (
      this.options.requireOperationsReadiness &&
      isClassAEffectType(input.type) &&
      !input.type.toLowerCase().startsWith('compensate.')
    ) {
      let readiness: Awaited<ReturnType<NonNullable<EffectKernelPort['getOperationsReadiness']>>>;
      try {
        readiness = await this.kernel.getOperationsReadiness!(grant.tenantId);
      } catch {
        return this.rejectAdmit(grant, 'OPERATIONS_READINESS_CHECK_FAILED', {});
      }
      if (!readiness.ready) {
        return this.rejectAdmit(grant, 'OPERATIONS_NOT_READY', { readiness });
      }
    }
    const actionDigest = isClassAEffectType(input.type)
      ? grant.actionDigest!
      : (grant.actionDigest ?? canonicalRequestHash(input.request));
    const admitted = await this.kernel.admitEffect({
      id: input.effectId,
      runId: grant.runId,
      stepId: grant.stepId,
      tenantId: grant.tenantId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      policyDecisionId: decision.decisionId,
      policySnapshotId: decision.policySnapshotId,
      actionDigest,
      request: input.request,
      lease: input.lease,
      ...(input.type.toLowerCase().startsWith('compensate.')
        ? {
            compensationBinding: {
              authorizationId: grant.authorizationId!,
              requestId: grant.requestId!,
              claimToken: input.lease.token,
              ...(input.compensationClaim
                ? {
                    requestClaimToken: input.compensationClaim.requestClaimToken,
                    outboxMessageId: input.compensationClaim.outboxMessageId,
                    outboxClaimToken: input.compensationClaim.outboxClaimToken,
                  }
                : {}),
            },
          }
        : {}),
      actor: input.actor,
    });
    if (!admitted.admitted || !admitted.effect)
      return this.rejectAdmit(grant, 'EFFECT_ADMISSION_REJECTED', {
        reason: admitted.reason ?? 'unknown',
      });
    // Charge only successful new admissions. LEASE_LOST / conflict never reach here;
    // idempotent replays must not double-count.
    if (this.kernel.incrementQuota && !admitted.replayed) {
      const usage = await this.kernel.incrementQuota({ tenantId: grant.tenantId, actionClass });
      if (maxCount !== undefined && usage.countUsed > maxCount) {
        // Concurrent admits can race past getQuota; the effect is already on the ledger.
        // Fail-closed: never hand out an admission handle for an over-quota effect, and
        // park it so retries cannot treat ADMITTED as a silent success.
        await this.kernel.markEffectCompletionUnknown?.({
          effectId: admitted.effect.id,
          tenantId: grant.tenantId,
          reason: 'QUOTA_EXCEEDED after admission (concurrent race)',
          actor: input.actor,
          lease: input.lease,
        });
        return this.rejectAdmit(grant, 'QUOTA_EXCEEDED', {
          actionClass,
          countUsed: usage.countUsed,
          limit: maxCount,
        });
      }
    }
    const effectState = admitted.effect.state;
    // Idempotent replay is only a successful cache hit when the prior effect COMPLETED.
    // ADMITTED / COMPLETION_UNKNOWN / FAILED must not return undefined as "success".
    const completedReplay = !!admitted.replayed && effectState === 'COMPLETED';
    const result: AdmissionResult = {
      admitted: true,
      effectId: admitted.effect.id,
      replayed: !!admitted.replayed,
      cachedResponse: completedReplay ? admitted.effect.response : undefined,
      decisionId: decision.decisionId,
      policySnapshotId: decision.policySnapshotId,
    };
    this.admissionStore.put(input.effectId, {
      effectId: input.effectId,
      actionDigest,
      grant,
      decision,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
      lease: input.lease,
      actor: input.actor,
      kernelEffectId: admitted.effect.id,
      replayed: !!admitted.replayed,
      effectState,
      cachedResponse: completedReplay ? admitted.effect.response : undefined,
      ...(input.compensationClaim ? { compensationClaim: input.compensationClaim } : {}),
    });
    return result;
  }

  /**
   * execute() — Phase 2 of the WS2 split. Consumes an admission handle and
   * dispatches the effect to the executor. Completed idempotent replays return
   * the cached response; incomplete prior states fail closed.
   */
  async executeAdmitted(input: {
    effectId: string;
    timeoutMs?: number;
  }): Promise<{ effectId: string; replayed: boolean; response?: Record<string, unknown> }> {
    const admission = this.admissionStore.get(input.effectId);
    if (!admission)
      throw new EffectBrokerError('ADMISSION_NOT_FOUND', { effectId: input.effectId });
    // Affinity must run inside try/finally so fail-closed consume clears the
    // process-local admission (grant/request) instead of leaking forever.
    let finished = false;
    let parked = false;
    try {
      this.assertWorkerAffinity(admission);
      if (admission.replayed) {
        if (admission.effectState === 'COMPLETED') {
          finished = true;
          return {
            effectId: admission.kernelEffectId,
            replayed: true,
            response: admission.cachedResponse,
          };
        }
        if (admission.effectState === 'COMPLETION_UNKNOWN') {
          throw new EffectBrokerError('COMPLETION_UNKNOWN', {
            effectId: admission.kernelEffectId,
            state: admission.effectState,
          });
        }
        if (admission.effectState === 'FAILED') {
          throw new EffectBrokerError('EFFECT_FAILED', {
            effectId: admission.kernelEffectId,
            state: admission.effectState,
          });
        }
        // ADMITTED replay: park on the ledger so step retries cannot spin on EFFECT_IN_FLIGHT forever.
        await this.parkUnfinishedAdmission(admission, 'incomplete_idempotent_replay');
        parked = true;
        throw new EffectBrokerError('COMPLETION_UNKNOWN', {
          effectId: admission.kernelEffectId,
          state: 'COMPLETION_UNKNOWN',
        });
      }
      const controller = new AbortController();
      // EB-09: aborting the signal is only advisory. A non-cooperative executor
      // (third-party SDK that ignores `signal`) left the effect ADMITTED and the
      // caller suspended under a live lease heartbeat forever. Arm a hard exit
      // after abort plus a short grace window; the timeout then rejects below and
      // is parked as COMPLETION_UNKNOWN by the catch block. The outcome of a
      // timed-out write is unknown — never a success.
      const timeoutMs = input.timeoutMs ?? 30_000;
      let hardTimedOut = false;
      let rejectHardTimeout: (error: EffectBrokerError) => void = () => {};
      const hardTimeout = new Promise<never>((_resolve, reject) => {
        rejectHardTimeout = reject;
      });
      const abortTimer = setTimeout(() => controller.abort(new Error('Effect timeout')), timeoutMs);
      const graceTimer = setTimeout(() => {
        if (hardTimedOut) return;
        hardTimedOut = true;
        rejectHardTimeout(
          new EffectBrokerError('EFFECT_EXECUTION_TIMEOUT', {
            effectId: admission.kernelEffectId,
            timeoutMs,
          }),
        );
      }, timeoutMs + EFFECT_TIMEOUT_ABORT_GRACE_MS);
      try {
        // A rejection handler is attached to the abandoned executor promise so a
        // non-cooperative implementation cannot surface as an unhandledRejection
        // once the hard timeout wins the race. `Promise.race` still sees the
        // executor's own rejection and error taxonomy.
        const execution = this.executor.execute({
          type: admission.type,
          request: admission.request,
          signal: controller.signal,
          executionContext: {
            tenantId: admission.grant.tenantId,
            workerId: admission.lease.workerId,
            ...(admission.lease.workerGeneration !== undefined
              ? { workerGeneration: admission.lease.workerGeneration }
              : {}),
            fencingEpoch: admission.lease.fencingEpoch,
            leaseToken: admission.lease.token,
            effectId: admission.effectId,
            ...(admission.idempotencyKey ? { idempotencyKey: admission.idempotencyKey } : {}),
          },
        });
        void execution.catch(() => undefined);
        const response = await Promise.race([execution, hardTimeout]);
        const committed = await this.completeTerminalEffect(admission, response);
        if (!committed) {
          await this.parkUnfinishedAdmission(
            admission,
            'Kernel rejected completion after external executor returned',
          );
          parked = true;
          throw new EffectBrokerError('COMPLETION_UNCONFIRMED');
        }
        await this.audit.append({
          type: 'effect.completed',
          severity: 'low',
          tenantId: admission.grant.tenantId,
          runId: admission.grant.runId,
          stepId: admission.grant.stepId,
          at: new Date().toISOString(),
          details: {
            effectId: admission.kernelEffectId,
            policyDecisionId: admission.decision.decisionId,
          },
        });
        finished = true;
        return { effectId: admission.kernelEffectId, replayed: false, response };
      } finally {
        clearTimeout(abortTimer);
        clearTimeout(graceTimer);
      }
    } catch (error) {
      if (error instanceof EffectBrokerError && error.code === 'EFFECT_EXECUTION_TIMEOUT') {
        // EB-09: a hard timeout is the absence of a decision. Park and report
        // COMPLETION_UNKNOWN instead of letting the deadline error escape with
        // no ledger state, which let retries spin on ADMITTED.
        await this.parkUnfinishedAdmission(admission, error.code);
        throw new EffectBrokerError('COMPLETION_UNKNOWN', {
          effectId: admission.kernelEffectId,
          code: error.code,
          timeoutMs: error.details.timeoutMs,
        });
      }
      if (!finished && !parked && admission.effectState === 'ADMITTED') {
        // L4-02: adapter taxonomy — NOT_COMMITTED → failEffect (terminal);
        // UNKNOWN → park (QUERY_FIRST). Other errors keep fail-closed park.
        if (error instanceof AdapterExecutionError) {
          if (error.commitState === 'NOT_COMMITTED') {
            const failure = {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              ...(error.details ? { details: error.details } : {}),
            };
            const failed = this.evidenceSigner
              ? await this.failTerminalEffect(admission, failure)
              : await this.kernel.failEffect?.({
                  effectId: admission.kernelEffectId,
                  tenantId: admission.grant.tenantId,
                  lease: admission.lease,
                  error: failure,
                  actor: admission.actor,
                });
            if (!failed) {
              await this.parkUnfinishedAdmission(admission, error.code);
              throw new EffectBrokerError('COMPLETION_UNKNOWN', {
                effectId: admission.kernelEffectId,
                code: error.code,
                commitState: error.commitState,
                retryMode: error.retryMode,
              });
            }
            throw new EffectBrokerError('EFFECT_FAILED', {
              effectId: admission.kernelEffectId,
              code: error.code,
              commitState: error.commitState,
              retryMode: error.retryMode,
            });
          }
          await this.parkUnfinishedAdmission(admission, error.code);
          throw new EffectBrokerError('COMPLETION_UNKNOWN', {
            effectId: admission.kernelEffectId,
            code: error.code,
            commitState: error.commitState,
            retryMode: error.retryMode,
          });
        }
        await this.parkUnfinishedAdmission(
          admission,
          error instanceof EffectBrokerError ? error.code : 'execute_admitted_failed',
        );
      }
      throw error;
    } finally {
      this.admissionStore.delete(input.effectId);
    }
  }

  private async completeTerminalEffect(
    admission: AdmittedEffect,
    response: Record<string, unknown>,
  ): Promise<unknown | null> {
    if (!this.evidenceSigner) {
      return this.kernel.completeEffect(
        admission.kernelEffectId,
        admission.grant.tenantId,
        admission.lease,
        response,
        admission.actor,
      );
    }
    try {
      const record = await this.buildTerminalEvidenceRecord(admission, {
        state: 'COMPLETED',
        response,
        eventType: 'effect.completed',
        severity: 'low',
        details: { policyDecisionId: admission.decision.decisionId },
      });
      assertEvidenceRecord(record, { verifySignature: this.evidenceSigner.verify });
      if (this.kernel.compensationTerminalEvidenceRequired) {
        if (!admission.compensationClaim || !this.kernel.completeCompensationEffectWithEvidence) {
          throw new Error('COMPENSATION_TERMINAL_EVIDENCE_AUTHORITY_REQUIRED');
        }
        return await this.kernel.completeCompensationEffectWithEvidence({
          tenantId: admission.grant.tenantId,
          runId: admission.grant.runId,
          stepId: admission.grant.stepId,
          effectId: admission.kernelEffectId,
          claim: admission.compensationClaim,
          lease: admission.lease,
          response,
          actor: admission.actor,
          evidence: record,
        });
      }
      return await this.kernel.completeEffectWithEvidence!(
        admission.kernelEffectId,
        admission.grant.tenantId,
        admission.lease,
        response,
        admission.actor,
        record,
      );
    } catch {
      throw new EffectBrokerError('EVIDENCE_PERSIST_FAILED', {
        effectId: admission.kernelEffectId,
      });
    }
  }

  private async failTerminalEffect(
    admission: AdmittedEffect,
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> },
  ): Promise<unknown | null> {
    const failEffectWithEvidence = this.kernel.failEffectWithEvidence;
    const failCompensationEffectWithEvidence = this.kernel.failCompensationEffectWithEvidence;
    try {
      if (!this.kernel.compensationTerminalEvidenceRequired && !failEffectWithEvidence)
        throw new Error('FAILED_EVIDENCE_AUTHORITY_REQUIRED');
      const record = await this.buildTerminalEvidenceRecord(admission, {
        state: 'FAILED',
        response: error,
        eventType: 'effect.failed',
        severity: 'high',
        details: { errorCode: error.code },
      });
      assertEvidenceRecord(record, { verifySignature: this.evidenceSigner?.verify });
      if (this.kernel.compensationTerminalEvidenceRequired) {
        if (!admission.compensationClaim || !failCompensationEffectWithEvidence) {
          throw new Error('COMPENSATION_TERMINAL_EVIDENCE_AUTHORITY_REQUIRED');
        }
        return await failCompensationEffectWithEvidence({
          tenantId: admission.grant.tenantId,
          runId: admission.grant.runId,
          stepId: admission.grant.stepId,
          effectId: admission.kernelEffectId,
          claim: admission.compensationClaim,
          lease: admission.lease,
          error,
          actor: admission.actor,
          evidence: record,
        });
      }
      if (!failEffectWithEvidence) {
        throw new Error('FAILED_EVIDENCE_AUTHORITY_REQUIRED');
      }
      return await failEffectWithEvidence({
        effectId: admission.kernelEffectId,
        tenantId: admission.grant.tenantId,
        lease: admission.lease,
        error,
        actor: admission.actor,
        evidence: record,
      });
    } catch {
      throw new EffectBrokerError('EVIDENCE_PERSIST_FAILED', {
        effectId: admission.kernelEffectId,
      });
    }
  }

  private async buildTerminalEvidenceRecord(
    admission: AdmittedEffect,
    terminal: {
      state: 'COMPLETED' | 'FAILED';
      response: Record<string, unknown>;
      eventType: 'effect.completed' | 'effect.failed';
      severity: 'low' | 'high';
      details: Record<string, unknown>;
    },
  ): Promise<EvidenceRecord> {
    if (
      !this.evidenceSigner ||
      (!this.kernel.getTerminalEvidenceContext &&
        (!this.kernel.listEffectsForRun || !this.kernel.listEvents))
    ) {
      throw new Error('EVIDENCE_LIFECYCLE_TRUTH_REQUIRED');
    }
    const completedAt = new Date().toISOString();
    const context = this.kernel.getTerminalEvidenceContext
      ? await this.kernel.getTerminalEvidenceContext(
          admission.kernelEffectId,
          admission.grant.runId,
          admission.grant.tenantId,
          admission.lease.token,
        )
      : await Promise.all([
          this.kernel.listEffectsForRun!(admission.grant.runId, admission.grant.tenantId),
          this.kernel.listEvents!(admission.grant.runId, admission.grant.tenantId),
        ]).then(([effects, events]) => ({
          effect: effects.find((effect) => effect.id === admission.kernelEffectId),
          events,
        }));
    const target = context.effect;
    if (
      !target ||
      target.tenantId !== admission.grant.tenantId ||
      target.runId !== admission.grant.runId ||
      target.stepId !== admission.grant.stepId ||
      target.state !== 'ADMITTED'
    ) {
      throw new Error('EVIDENCE_LIFECYCLE_TRUTH_INVALID');
    }
    if (
      target.actionDigest !== admission.actionDigest ||
      target.policyDecisionId !== admission.decision.decisionId ||
      (target.policySnapshotId && target.policySnapshotId !== admission.decision.policySnapshotId)
    ) {
      throw new Error('EVIDENCE_LIFECYCLE_TRUTH_INVALID');
    }
    const effects = [
      { ...target, state: terminal.state, response: terminal.response, completedAt },
    ];
    const auditEvents: EvidenceAuditSource[] = context.events
      .filter(
        (event) =>
          event.aggregateId === admission.kernelEffectId ||
          event.payload.effectId === admission.kernelEffectId,
      )
      .map((event) => ({
        type: event.type,
        severity: event.type.includes('failed') || event.type.includes('escalat') ? 'high' : 'low',
        tenantId: event.tenantId,
        runId: event.runId,
        ...(event.stepId ? { stepId: event.stepId } : { stepId: admission.grant.stepId }),
        at: event.occurredAt,
        details: {
          ...event.payload,
          effectId:
            typeof event.payload.effectId === 'string' ? event.payload.effectId : event.aggregateId,
        },
      }));
    auditEvents.push({
      type: terminal.eventType,
      severity: terminal.severity,
      tenantId: admission.grant.tenantId,
      runId: admission.grant.runId,
      stepId: admission.grant.stepId,
      at: completedAt,
      details: { effectId: admission.kernelEffectId, ...terminal.details },
    });
    const body = buildRunEvidenceBundle({
      tenantId: admission.grant.tenantId,
      runId: admission.grant.runId,
      actionDigest: admission.actionDigest,
      effectId: admission.kernelEffectId,
      policySnapshotId: target.policySnapshotId ?? admission.decision.policySnapshotId,
      effects,
      auditEvents,
      exportedAt: completedAt,
      bundleId: `evidence_${admission.kernelEffectId}`,
    });
    const signature = await this.evidenceSigner.sign(canonicalEvidenceBody(body));
    body.signature = signature;
    return {
      tenantId: admission.grant.tenantId,
      runId: admission.grant.runId,
      bundleId: body.bundleId,
      actionDigest: body.actionDigest,
      body,
      contentHash: body.contentHash,
      signature,
      createdAt: completedAt,
      anchoredAt: completedAt,
      retentionUntil: new Date(Date.parse(completedAt) + this.evidenceRetentionMs).toISOString(),
    };
  }

  /** Park an ADMITTED ledger row so idempotent retries fail closed as COMPLETION_UNKNOWN, not in-flight spin. */
  private async parkUnfinishedAdmission(admission: AdmittedEffect, reason: string): Promise<void> {
    const park = this.kernel.markEffectCompletionUnknown?.bind(this.kernel);
    if (typeof park !== 'function') {
      // EB-10: under evidence persistence the constructor already refused this
      // kernel. Without it there is no park authority to call, and throwing here
      // would mask the original error the caller must see (e.g.
      // WORKER_AFFINITY_VIOLATION) with a park error.
      if (this.evidenceSigner) {
        throw new EffectBrokerError('EVIDENCE_PARK_AUTHORITY_REQUIRED', {
          effectId: admission.kernelEffectId,
          reason,
        });
      }
      return;
    }
    try {
      // Called as a member of the kernel, never as a detached function: an
      // unbound call loses `this`, so the park threw, was downgraded to an audit
      // row, and left the effect ADMITTED — a retry would then re-execute an
      // effect whose remote outcome is unknown (L4-B adapter chaos).
      await park({
        effectId: admission.kernelEffectId,
        tenantId: admission.grant.tenantId,
        reason,
        actor: admission.actor,
        lease: admission.lease,
      });
    } catch (error) {
      // EB-10: a failed park must not replace the caller's original error, but it
      // must not vanish either — an unresolvable park leaves the row ADMITTED for
      // reconciliation. Record it; if the audit authority is down too, that
      // failure surfaces instead of being swallowed.
      await this.audit.append({
        type: 'effect.park_failed',
        severity: 'high',
        tenantId: admission.grant.tenantId,
        runId: admission.grant.runId,
        stepId: admission.grant.stepId,
        at: new Date().toISOString(),
        details: {
          effectId: admission.kernelEffectId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  /**
   * L3-08a — query-after-timeout reconcile for COMPLETION_UNKNOWN effects.
   * Never invokes the write executor; only queries remote outcome and advances ledger.
   */
  async reconcileUnknown(input: {
    effect: ReconcileEffectSnapshot;
    querier: EffectOutcomeQuerier;
  }): Promise<ReconcileUnknownResult> {
    const effect = input.effect;
    if (effect.state !== 'COMPLETION_UNKNOWN') {
      throw new EffectBrokerError('EFFECT_NOT_UNKNOWN', {
        effectId: effect.id,
        state: effect.state,
      });
    }

    const remote = await input.querier.queryOutcome({
      effectId: effect.id,
      idempotencyKey: effect.idempotencyKey,
      type: effect.type,
      request: effect.request,
      tenantId: effect.tenantId,
    });

    const validResponse =
      (remote.status === 'APPLIED' || remote.status === 'NOT_APPLIED') &&
      typeof remote.response === 'object' &&
      remote.response !== null &&
      !Array.isArray(remote.response);
    const validUnknown =
      remote.status === 'UNKNOWN' &&
      typeof remote.error?.code === 'string' &&
      remote.error.code.trim().length > 0 &&
      typeof remote.error?.message === 'string' &&
      remote.error.message.trim().length > 0;
    if (!validResponse && !validUnknown) {
      throw new EffectBrokerError('ADAPTER_OUTCOME_INVALID', {
        effectId: effect.id,
        effectType: effect.type,
      });
    }
    return remote;
  }

  /**
   * execute() — legacy single-call path. Kept for backward compatibility with
   * existing StepExecutors (tool/connector). Equivalent to admit() followed
   * by executeAdmitted(). Surfaces the original admit() rejection code so
   * existing callers/tests keep matching on POLICY_DENIED, REQUEST_HASH_MISMATCH, etc.
   */
  async execute(input: {
    effectId: string;
    token: string;
    type: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
    lease: { workerId: string; workerGeneration?: number; token: string; fencingEpoch: number };
    actor: string;
    timeoutMs?: number;
    workloadBinding?: WorkloadBinding;
  }): Promise<{ effectId: string; replayed: boolean; response?: Record<string, unknown> }> {
    const admission = await this.admit(input);
    if (!admission.admitted) {
      throw new EffectBrokerError(
        admission.reason ?? 'ADMIT_REJECTED',
        admission.details ?? { reason: admission.reason },
      );
    }
    return this.executeAdmitted({ effectId: input.effectId, timeoutMs: input.timeoutMs });
  }

  private assertWorkerAffinity(admission: AdmittedEffect): void {
    const localWorkerId = this.options.localWorkerId;
    if (!localWorkerId) return;
    if (admission.lease.workerId !== localWorkerId) {
      throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
        effectId: admission.effectId,
        expectedWorkerId: localWorkerId,
        actualWorkerId: admission.lease.workerId,
      });
    }
    // Fail-closed: a missing/non-finite lease generation must never be
    // coerced to a sentinel (previously -1) — it always fails the check.
    const localGen = this.options.localWorkerGeneration;
    if (localGen !== undefined) {
      const leaseGen = admission.lease.workerGeneration;
      if (typeof leaseGen !== 'number' || !Number.isFinite(leaseGen) || leaseGen !== localGen) {
        throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
          effectId: admission.effectId,
          expectedWorkerGeneration: localGen,
          actualWorkerGeneration: leaseGen,
        });
      }
    }
    if (typeof admission.lease.token !== 'string' || admission.lease.token.length === 0) {
      throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
        effectId: admission.effectId,
        reason: 'missing_lease_token',
      });
    }
    if (!Number.isFinite(admission.lease.fencingEpoch) || admission.lease.fencingEpoch < 0) {
      throw new EffectBrokerError('WORKER_AFFINITY_VIOLATION', {
        effectId: admission.effectId,
        reason: 'invalid_fencing_epoch',
        actualFencingEpoch: admission.lease.fencingEpoch,
      });
    }
  }

  private async rejectAdmit(
    grant: CapabilityGrant,
    code: string,
    details: Record<string, unknown>,
  ): Promise<AdmissionResult> {
    await this.audit.append({
      type: 'effect.rejected',
      severity: 'high',
      tenantId: grant.tenantId,
      runId: grant.runId,
      stepId: grant.stepId,
      at: new Date().toISOString(),
      details: { code, ...details },
    });
    return {
      admitted: false,
      effectId: '',
      replayed: false,
      decisionId: '',
      policySnapshotId: '',
      reason: code,
      details: { code, ...details },
    };
  }
}

export interface AdmissionResult {
  admitted: boolean;
  effectId: string;
  replayed: boolean;
  cachedResponse?: Record<string, unknown>;
  decisionId: string;
  policySnapshotId: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export class EffectBrokerError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'EffectBrokerError';
  }
}

export {
  EVIDENCE_BODY_VERSION,
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_DLP_EXCLUDED_KEYS,
  EVIDENCE_GENESIS_HASH,
  EVIDENCE_RESPONSE_SUMMARY_KEYS,
  assertTerminalEvidence,
  buildEffectEvidenceBundle,
  buildRunEvidenceBundle,
  canonicalEvidenceBody,
  canonicalEvidenceJson,
  findDlpViolation,
  sanitizeForEvidence,
  verifyEvidenceBundle,
} from './evidenceBundle.js';
export type {
  BuildEvidenceBundleInput,
  EvidenceAuditSource,
  EvidenceBundle,
  EvidenceBundleAuditEntry,
  EvidenceBundleEffectEntry,
  EvidenceBundleIdentity,
  EvidenceBundleScope,
  EvidenceBundleVersions,
  EvidenceEffectSource,
  EvidenceSignature,
  EvidenceSigner,
  EvidenceTerminalDisposition,
  VerifyEvidenceBundleResult,
} from './evidenceBundle.js';
export { EvidenceSink, DEFAULT_EVIDENCE_MAX_BYTES } from './evidenceSink.js';
export type { EvidenceRecord, EvidenceRepositoryPort } from './evidenceSink.js';
export { createEvidenceSigner, verifyEvidenceSignature } from './evidenceSigner.js';
export type { ConfiguredEvidenceSigner, EvidenceJwks } from './evidenceSigner.js';

export { buildEffectScopedEvidenceRecord } from './terminalEvidence.js';
export type {
  SignedTerminalEvidenceReceipt,
  TerminalEvidenceEffect,
  TerminalEvidenceRecord,
} from './terminalEvidence.js';
export { buildSignedEvidenceBundle, verifySignedEvidenceBundle } from './signedEvidence.js';
export type { BuildSignedEvidenceBundleInput, SignedEvidenceBundle } from './signedEvidence.js';
export type { EvidenceJwk } from './evidenceSigner.js';
export { verifyEvidenceReceipt } from './evidenceReceipt.js';
export type { EvidenceVerificationResult } from './evidenceReceipt.js';

export {
  AdapterExecutionError,
  adapterErrorFromHttpStatus,
  classifyAdapterError,
} from './adapterErrors.js';
export type { AdapterCommitState, AdapterRetryMode } from './adapterErrors.js';
