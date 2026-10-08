/** HTTP client for the Architecture V2 Gateway. It never imports the local runtime. */
import { createPublicKey, verify } from 'node:crypto';
import type {
  ActionApprovalInput,
  ActionCompensationApprovalInput,
  ActionCompensationApprovalResult,
  ActionCompensationInput,
  ActionCompensationResult,
  ActionEvidenceBundle,
  ActionEvidenceJwks,
  ActionEvidenceVerification,
  GatewayErrorDetail,
  GovernedAction,
  KillSwitch,
  KillSwitchScope,
  KillSwitchUpdateInput,
  ProposeActionInput,
  ProposeActionResult,
  RequestReconcileResult,
  SimulateActionResult,
} from './resources';

export interface GatewayRun {
  id: string;
  status: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  intentHash: string;
  workGraphHash: string;
  workGraphVersion: string;
  policySnapshotId: string;
}
export interface GatewayClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
}

function invalidEvidence(code: string, message: string): ActionEvidenceVerification {
  return { valid: false, error: { code, message } };
}

function decodeBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('Non-canonical base64url');
  return decoded;
}

/** Verify a compact Ed25519 JWS receipt using only the supplied JWKS. */
export function verifyActionEvidence(
  receipt: string,
  jwks: ActionEvidenceJwks,
): ActionEvidenceVerification {
  try {
    const parts = receipt.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      return invalidEvidence('EVIDENCE_RECEIPT_INVALID', 'Evidence receipt is not a compact JWS.');
    }
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = JSON.parse(decodeBase64Url(encodedHeader).toString('utf8')) as {
      alg?: unknown;
      kid?: unknown;
    };
    if (header.alg !== 'EdDSA' || typeof header.kid !== 'string') {
      return invalidEvidence(
        'EVIDENCE_RECEIPT_INVALID',
        'Evidence receipt requires EdDSA and a key id.',
      );
    }
    const key = jwks.keys.find(
      (candidate) =>
        candidate.kid === header.kid &&
        candidate.kty === 'OKP' &&
        candidate.crv === 'Ed25519' &&
        (!candidate.alg || candidate.alg === 'EdDSA') &&
        (!candidate.use || candidate.use === 'sig'),
    );
    if (!key) {
      return invalidEvidence('EVIDENCE_KEY_NOT_FOUND', 'No matching Ed25519 signing key exists.');
    }
    const publicKey = createPublicKey({
      key: { kty: key.kty, crv: key.crv, x: key.x },
      format: 'jwk',
    });
    const valid = verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      decodeBase64Url(encodedSignature),
    );
    if (!valid) {
      return invalidEvidence(
        'EVIDENCE_SIGNATURE_INVALID',
        'Evidence receipt signature is invalid.',
      );
    }
    const payload = JSON.parse(decodeBase64Url(encodedPayload).toString('utf8')) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return invalidEvidence(
        'EVIDENCE_PAYLOAD_INVALID',
        'Evidence receipt payload must be an object.',
      );
    }
    return { valid: true, payload: payload as Record<string, unknown> };
  } catch {
    return invalidEvidence('EVIDENCE_RECEIPT_INVALID', 'Evidence receipt could not be decoded.');
  }
}

export class CommanderGatewayClient {
  private readonly request: typeof globalThis.fetch;
  constructor(private readonly options: GatewayClientOptions) {
    this.request = options.fetch ?? globalThis.fetch;
    if (!this.request) throw new Error('A fetch implementation is required');
  }
  async submitRun(input: {
    goal: string;
    policySnapshotId: string;
    steps?: Array<{
      id?: string;
      kind: string;
      input?: Record<string, unknown>;
      dependencies?: string[];
      priority?: number;
      maxAttempts?: number;
    }>;
    metadata?: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<{ run: GatewayRun; idempotentReplay: boolean; accepted: boolean }> {
    const response = await this.call('/v1/runs', {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(input),
    });
    const body = await this.body(response);
    return {
      run: body.run,
      idempotentReplay: body.idempotentReplay,
      accepted: response.status === 202,
    };
  }
  async getRun(runId: string): Promise<GatewayRun> {
    const response = await this.call(`/v1/runs/${encodeURIComponent(runId)}`);
    return (await this.body(response)).run;
  }
  async listRunEvents(runId: string): Promise<Array<Record<string, unknown>>> {
    const response = await this.call(`/v1/runs/${encodeURIComponent(runId)}/events`);
    return (await this.body(response)).events;
  }
  async simulateAction(input: ProposeActionInput): Promise<SimulateActionResult> {
    const response = await this.call('/v1/actions/simulate', {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(input),
    });
    return this.body(response);
  }
  async proposeAction(input: ProposeActionInput): Promise<ProposeActionResult> {
    const response = await this.call('/v1/actions', {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify(input),
    });
    const body = await this.body(response);
    return {
      action: body.action,
      idempotentReplay: body.idempotentReplay,
      accepted: response.status === 202,
    };
  }
  async getAction(runId: string): Promise<GovernedAction> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}`);
    return (await this.body(response)).action;
  }
  async approveAction(
    runId: string,
    input: ActionApprovalInput,
    idempotencyKey: string,
  ): Promise<GovernedAction> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/approve`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
    return (await this.body(response)).action;
  }
  async requestActionCompensation(
    runId: string,
    input: ActionCompensationInput,
    idempotencyKey: string,
  ): Promise<ActionCompensationResult> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/compensations`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
    return this.body(response);
  }
  async approveActionCompensation(
    runId: string,
    authorizationId: string,
    input: ActionCompensationApprovalInput,
    idempotencyKey: string,
  ): Promise<ActionCompensationApprovalResult> {
    const response = await this.call(
      `/v1/actions/${encodeURIComponent(runId)}/compensations/${encodeURIComponent(authorizationId)}/approve`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
    return this.body(response);
  }
  async rejectAction(
    runId: string,
    input: { reason?: string },
    idempotencyKey: string,
  ): Promise<GovernedAction> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/reject`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
    return (await this.body(response)).action;
  }
  async reconcileAction(runId: string, idempotencyKey: string): Promise<RequestReconcileResult> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/reconcile`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
    });
    return this.body(response);
  }
  async getActionEvidence(runId: string): Promise<ActionEvidenceBundle> {
    const response = await this.call(`/v1/actions/${encodeURIComponent(runId)}/evidence`);
    return this.body(response);
  }
  verifyActionEvidence(receipt: string, jwks: ActionEvidenceJwks): ActionEvidenceVerification {
    return verifyActionEvidence(receipt, jwks);
  }
  async listKillSwitches(): Promise<KillSwitch[]> {
    const response = await this.call('/v1/actions/kill-switches');
    return (await this.body<{ killSwitches: KillSwitch[] }>(response)).killSwitches;
  }
  async putKillSwitch(
    scope: KillSwitchScope,
    value: string,
    input: KillSwitchUpdateInput,
    idempotencyKey: string,
  ): Promise<KillSwitch> {
    const response = await this.call(
      `/v1/actions/kill-switches/${encodeURIComponent(scope)}/${encodeURIComponent(value)}`,
      {
        method: 'PUT',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
    return (await this.body<{ killSwitch: KillSwitch }>(response)).killSwitch;
  }
  async removeKillSwitch(
    scope: KillSwitchScope,
    value: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.call(
      `/v1/actions/kill-switches/${encodeURIComponent(scope)}/${encodeURIComponent(value)}`,
      { method: 'DELETE', headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }
  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (init.body) headers.set('content-type', 'application/json');
    if (this.options.apiKey) headers.set('x-api-key', this.options.apiKey);
    const response = await this.request(`${this.options.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new CommanderGatewayError(response.status, body);
    }
    return response;
  }
  private async body<T = any>(response: Response): Promise<T> {
    return response.json() as Promise<T>;
  }
}
export class CommanderGatewayError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    let detail: GatewayErrorDetail | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: GatewayErrorDetail };
      if (parsed.error && typeof parsed.error.code === 'string') detail = parsed.error;
    } catch {
      // Preserve the raw response body when the gateway did not return JSON.
    }
    super(detail?.message ?? `Gateway request failed (${status})`);
    this.name = 'CommanderGatewayError';
    this.code = detail?.code ?? 'GATEWAY_REQUEST_FAILED';
    this.details = detail?.details;
  }
}

export const PraetorGatewayClient = CommanderGatewayClient;
export const PraetorGatewayError = CommanderGatewayError;

