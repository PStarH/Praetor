import {
  servicenowCorrelationId,
  SERVICENOW_INCIDENT_CREATE_DESCRIPTOR,
} from '@praetor/contracts';
import { AdapterExecutionError } from '@praetor/effect-broker';
import type { EffectRemoteOutcome } from '@praetor/effect-broker';
import {
  assertOkResponse,
  adapterFetch,
  readJsonResponse,
  requireArrayResponse,
  requireObjectResponse,
  type FetchFn,
} from '../http.js';
import type {
  ActionAdapter,
  AdapterCompensateInput,
  AdapterCredentialProvider,
  AdapterExecuteInput,
  AdapterQueryInput,
} from '../types.js';
import { parseServiceNowDestination } from '../types.js';

interface ServiceNowIncident {
  sys_id: string;
  number: string;
  state: string;
  correlation_id: string;
}

function requireIncident(value: unknown, label: string): ServiceNowIncident {
  const record = requireObjectResponse<Record<string, unknown>>(value, label);
  if (
    typeof record.sys_id !== 'string' ||
    typeof record.number !== 'string' ||
    typeof record.state !== 'string'
  ) {
    throw new AdapterExecutionError(`${label} returned an incomplete incident body`, {
      code: 'ADAPTER_RESPONSE_BODY_INVALID',
      commitState: 'UNKNOWN',
      retryMode: 'QUERY_FIRST',
    });
  }
  return record as unknown as ServiceNowIncident;
}

export interface ServiceNowIncidentCreateAdapterOptions {
  credentials: AdapterCredentialProvider;
  fetch?: FetchFn;
}

export function createServiceNowIncidentCreateAdapter(
  options: ServiceNowIncidentCreateAdapterOptions,
): ActionAdapter {
  const rawFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const fetchImpl = (url: RequestInfo | URL, init?: RequestInit) =>
    adapterFetch(rawFetch, url, init);

  function baseUrl(instance: string): string {
    return `https://${instance}.service-now.com`;
  }

  function authHeader(username: string, password: string): string {
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  async function queryBySysId(
    input: AdapterQueryInput,
    sysId: string,
  ): Promise<EffectRemoteOutcome> {
    const { instance } = parseServiceNowDestination(input.destination);
    const creds = await options.credentials.getServiceNowCredentials(
      input.tenantId,
      input.destination,
    );
    const response = await fetchImpl(`${baseUrl(instance)}/api/now/table/incident/${sysId}`, {
      headers: {
        Authorization: authHeader(creds.username, creds.password),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: input.signal,
    });
    if (response.status === 404) {
      return {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      };
    }
    await assertOkResponse(response, 'ServiceNow get incident');
    const payload = requireObjectResponse<{ result: unknown }>(
      await readJsonResponse(response),
      'ServiceNow get incident',
    );
    const incident = requireIncident(payload.result, 'ServiceNow get incident');
    return {
      status: 'APPLIED',
      response: {
        sysId: incident.sys_id,
        number: incident.number,
        state: incident.state,
      },
    };
  }

  async function queryByCorrelation(
    input: AdapterQueryInput,
    correlationId: string,
  ): Promise<{ incidents: ServiceNowIncident[]; outcome: EffectRemoteOutcome | null }> {
    const { instance } = parseServiceNowDestination(input.destination);
    const creds = await options.credentials.getServiceNowCredentials(
      input.tenantId,
      input.destination,
    );
    const params = new URLSearchParams({
      sysparm_query: `correlation_id=${correlationId}`,
      sysparm_limit: '10',
    });
    const response = await fetchImpl(`${baseUrl(instance)}/api/now/table/incident?${params}`, {
      headers: {
        Authorization: authHeader(creds.username, creds.password),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: input.signal,
    });
    await assertOkResponse(response, 'ServiceNow query incident');
    const payload = requireObjectResponse<{ result?: unknown }>(
      await readJsonResponse(response),
      'ServiceNow query incident',
    );
    const incidents = requireArrayResponse(payload.result ?? [], 'ServiceNow query incident').map(
      (entry) => requireIncident(entry, 'ServiceNow query incident'),
    );
    if (incidents.length === 0) {
      return {
        incidents,
        outcome: {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        },
      };
    }
    if (incidents.length > 1) {
      return {
        incidents,
        outcome: {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        },
      };
    }
    const incident = incidents[0]!;
    return {
      incidents,
      outcome: {
        status: 'APPLIED',
        response: {
          sysId: incident.sys_id,
          number: incident.number,
          state: incident.state,
        },
      },
    };
  }

  return {
    descriptor: SERVICENOW_INCIDENT_CREATE_DESCRIPTOR,

    async execute(input: AdapterExecuteInput): Promise<Record<string, unknown>> {
      const correlationId = servicenowCorrelationId(input.tenantId, input.idempotencyKey);
      const existing = await queryByCorrelation(
        {
          tenantId: input.tenantId,
          effectId: input.effectId,
          idempotencyKey: input.idempotencyKey,
          destination: input.destination,
          request: {},
        },
        correlationId,
      );
      if (existing.incidents.length === 1) {
        const incident = existing.incidents[0]!;
        return { sysId: incident.sys_id, number: incident.number, state: incident.state };
      }
      if (existing.incidents.length > 1) {
        throw new AdapterExecutionError('Multiple incidents matched correlation id', {
          code: 'SERVICENOW_MULTI_MARKER',
          commitState: 'UNKNOWN',
          retryMode: 'QUERY_FIRST',
          details: { matchCount: existing.incidents.length },
        });
      }

      const { instance } = parseServiceNowDestination(input.destination);
      const creds = await options.credentials.getServiceNowCredentials(
        input.tenantId,
        input.destination,
      );
      const shortDescription = String(input.args.short_description ?? 'Commander incident');
      const description = String(input.args.description ?? '');
      const response = await fetchImpl(`${baseUrl(instance)}/api/now/table/incident`, {
        method: 'POST',
        headers: {
          Authorization: authHeader(creds.username, creds.password),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          short_description: shortDescription,
          description,
          correlation_id: correlationId,
        }),
        signal: input.signal,
      });
      await assertOkResponse(response, 'ServiceNow create incident');
      const payload = requireObjectResponse<{ result: unknown }>(
        await readJsonResponse(response),
        'ServiceNow create incident',
      );
      const incident = requireIncident(payload.result, 'ServiceNow create incident');
      return { sysId: incident.sys_id, number: incident.number, state: incident.state };
    },

    async queryOutcome(input: AdapterQueryInput): Promise<EffectRemoteOutcome> {
      const correlationId = servicenowCorrelationId(input.tenantId, input.idempotencyKey);
      const result = await queryByCorrelation(input, correlationId);
      return (
        result.outcome ?? {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        }
      );
    },

    async compensate(input: AdapterCompensateInput): Promise<Record<string, unknown>> {
      const sysId = String(input.forwardResponse.sysId ?? '');
      if (!sysId) {
        throw new AdapterExecutionError('Missing sysId for compensation', {
          code: 'SERVICENOW_COMPENSATE_MISSING_SYS_ID',
          commitState: 'NOT_COMMITTED',
          retryMode: 'NEVER',
        });
      }
      const allowed = new Set(SERVICENOW_INCIDENT_CREATE_DESCRIPTOR.compensationPatchKeys ?? []);
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(input.compensationPatch)) {
        if (!allowed.has(key)) continue;
        patch[key] = value;
      }
      if (Object.keys(patch).length === 0) {
        throw new AdapterExecutionError('compensationPatch has no allowed keys', {
          code: 'SERVICENOW_COMPENSATE_PATCH_DENIED',
          commitState: 'NOT_COMMITTED',
          retryMode: 'NEVER',
        });
      }

      const { instance } = parseServiceNowDestination(input.destination);
      const creds = await options.credentials.getServiceNowCredentials(
        input.tenantId,
        input.destination,
      );
      const response = await fetchImpl(`${baseUrl(instance)}/api/now/table/incident/${sysId}`, {
        method: 'PATCH',
        headers: {
          Authorization: authHeader(creds.username, creds.password),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
        signal: input.signal,
      });
      await assertOkResponse(response, 'ServiceNow compensate incident');
      const payload = requireObjectResponse<{ result: unknown }>(
        await readJsonResponse(response),
        'ServiceNow compensate incident',
      );
      const incident = requireIncident(payload.result, 'ServiceNow compensate incident');
      return { sysId: incident.sys_id, state: incident.state };
    },

    async queryCompensationOutcome(
      input: AdapterQueryInput & { compensationResponse?: Record<string, unknown> },
    ): Promise<EffectRemoteOutcome> {
      // The kernel's governed compensation request nests the forward receipt at
      // request.forwardResponse and the registry passes that request through
      // unchanged; compensationResponse is only an optional direct-call extra.
      // Reading only the top level made every reconciliation return UNKNOWN.
      const forward = input.request.forwardResponse;
      const forwardSysId =
        forward !== null && typeof forward === 'object' && !Array.isArray(forward)
          ? (forward as Record<string, unknown>).sysId
          : undefined;
      const sysId = String(
        input.compensationResponse?.sysId ??
          forwardSysId ??
          input.request.sysId ??
          input.request.forwardSysId ??
          '',
      );
      if (!sysId) {
        return {
          status: 'UNKNOWN',
          error: {
            code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
            message: 'Remote outcome is not yet provable',
          },
        };
      }
      const outcome = await queryBySysId(input, sysId);
      if (outcome.status !== 'APPLIED') {
        return outcome;
      }
      const targetState = String(input.request.expectedState ?? '7');
      if (outcome.response?.state === targetState) {
        return {
          status: 'APPLIED',
          response: { sysId: outcome.response.sysId, state: outcome.response.state },
        };
      }
      return {
        status: 'UNKNOWN',
        error: {
          code: 'RECONCILE_OUTCOME_NOT_YET_VISIBLE',
          message: 'Remote outcome is not yet provable',
        },
      };
    },
  };
}
