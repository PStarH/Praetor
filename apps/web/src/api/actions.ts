import type {
  ActionApprovalRequestV1,
  ActionCompensationApprovalRequestV1,
  ActionCompensationApprovalResponseV1,
  ActionCompensationRequestResponseV1,
  ActionCompensationRequestV1,
  ActionEvidenceV1,
  ActionKillSwitchScopeV1,
  ActionKillSwitchV1,
  ActionProposeRequestV1,
  ActionProposeResponseV1,
  ActionReconcileAcceptedV1,
  ActionSimulationResponseV1,
  ActionSimulationV1,
  ActionStateV1,
  GovernedActionV1,
} from '@praetor/contracts';
import { resolveApiBase } from '../lib/apiOrigin';

/**
 * API base URL for the running bundle. The production image builds with an
 * empty `VITE_API_BASE_URL` and is served same-origin by nginx, so an empty
 * value resolves to the page's own origin rather than the development default
 * — see src/lib/apiOrigin.ts.
 */
const DEFAULT_API_BASE = resolveApiBase(import.meta.env?.VITE_API_BASE_URL, globalThis.location);

function storedAuthToken(): string | null {
  try {
    return localStorage.getItem('commander.auth.token');
  } catch {
    return null;
  }
}

export type ActionState = ActionStateV1;
export type {
  ActionCompensationApprovalRequestV1,
  ActionCompensationApprovalResponseV1,
  ActionCompensationRequestResponseV1,
  ActionCompensationRequestV1,
  ActionEvidenceV1,
  ActionKillSwitchScopeV1,
  ActionKillSwitchV1,
  ActionProposeRequestV1,
  ActionReconcileAcceptedV1,
  ActionSimulationV1,
  GovernedActionV1,
};

export interface ActionKillSwitchInput {
  scope: ActionKillSwitchScopeV1;
  value: string;
  enabled: boolean;
  reason?: string;
}

export class ActionGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ActionGatewayError';
  }
}

export interface ActionGatewayClientOptions {
  baseUrl?: string;
  token?: string | null;
  tenantId?: string;
  fetchImpl?: typeof fetch;
}

export class ActionGatewayClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ActionGatewayClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    const token = this.options.token ?? storedAuthToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (this.options.tenantId) headers.set('x-tenant-id', this.options.tenantId);
    if (init.body) headers.set('content-type', 'application/json');
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const payload = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    if (!response.ok) {
      throw new ActionGatewayError(
        response.status,
        payload.error?.code ?? 'ACTION_GATEWAY_ERROR',
        payload.error?.message ?? `Action Gateway request failed (${response.status})`,
      );
    }
    return payload as T;
  }

  simulateAction(input: ActionProposeRequestV1): Promise<ActionSimulationResponseV1> {
    return this.request('/v1/actions/simulate', {
      method: 'POST',
      headers: { 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  proposeAction(input: ActionProposeRequestV1): Promise<ActionProposeResponseV1> {
    return this.request('/v1/actions', {
      method: 'POST',
      headers: { 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  async getAction(runId: string): Promise<GovernedActionV1> {
    const result = await this.request<{ action: GovernedActionV1 }>(
      `/v1/actions/${encodeURIComponent(runId)}`,
    );
    return result.action;
  }

  async approveAction(
    runId: string,
    binding: ActionApprovalRequestV1,
    idempotencyKey: string,
  ): Promise<GovernedActionV1> {
    const result = await this.request<{ action: GovernedActionV1 }>(
      `/v1/actions/${encodeURIComponent(runId)}/approve`,
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(binding),
      },
    );
    return result.action;
  }

  requestCompensation(
    runId: string,
    input: ActionCompensationRequestV1,
    idempotencyKey: string,
  ): Promise<ActionCompensationRequestResponseV1> {
    return this.request(`/v1/actions/${encodeURIComponent(runId)}/compensations`, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  approveCompensation(
    runId: string,
    authorizationId: string,
    input: ActionCompensationApprovalRequestV1,
    idempotencyKey: string,
  ): Promise<ActionCompensationApprovalResponseV1> {
    return this.request(
      `/v1/actions/${encodeURIComponent(runId)}/compensations/${encodeURIComponent(authorizationId)}/approve`,
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
  }

  async rejectAction(
    runId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<GovernedActionV1> {
    const result = await this.request<{ action: GovernedActionV1 }>(
      `/v1/actions/${encodeURIComponent(runId)}/reject`,
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ reason }),
      },
    );
    return result.action;
  }

  reconcileAction(runId: string, idempotencyKey: string): Promise<ActionReconcileAcceptedV1> {
    return this.request(`/v1/actions/${encodeURIComponent(runId)}/reconcile`, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({}),
    });
  }

  getActionEvidence(runId: string): Promise<ActionEvidenceV1> {
    return this.request(`/v1/actions/${encodeURIComponent(runId)}/evidence`);
  }

  async listKillSwitches(): Promise<ActionKillSwitchV1[]> {
    const result = await this.request<{ killSwitches: ActionKillSwitchV1[] }>(
      '/v1/actions/kill-switches',
    );
    return result.killSwitches;
  }

  async setKillSwitch(
    input: ActionKillSwitchInput,
    idempotencyKey: string,
  ): Promise<ActionKillSwitchV1> {
    const result = await this.request<{ killSwitch: ActionKillSwitchV1 }>(
      `/v1/actions/kill-switches/${encodeURIComponent(input.scope)}/${encodeURIComponent(input.value)}`,
      {
        method: 'PUT',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          enabled: input.enabled,
          ...(input.reason ? { reason: input.reason } : {}),
        }),
      },
    );
    return result.killSwitch;
  }
}
