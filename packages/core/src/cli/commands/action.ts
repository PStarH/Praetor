/**
 * commander action — Governed Action Gateway operations (L4-04).
 *
 * Usage:
 *   commander action kill list
 *   commander action kill enable <scope> <value> [--reason=...]
 *   commander action kill disable <scope> <value> [--reason=...]
 */
import { parseFlags } from '../util';
import {
  ACTION_KILL_SWITCH_SCOPES_V1,
  validateResource,
  type ContractSchemaName,
} from '@praetor/contracts';

export interface ActionApiConfig {
  baseUrl: string;
  apiKey: string;
}

class ActionCliValidationError extends Error {}

function validationError(message: string): never {
  throw new ActionCliValidationError(message);
}

function requiredValue(value: string | undefined, usage: string): string {
  if (!value?.trim()) validationError(usage);
  return value;
}

function parseData(value: string | undefined, usage: string): Record<string, unknown> {
  const raw = requiredValue(value, usage);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) validationError(usage);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ActionCliValidationError) throw error;
    validationError(`${usage} (--data must be a JSON object)`);
  }
}

function parseContractData(
  schemaName: ContractSchemaName,
  value: string | undefined,
  usage: string,
): Record<string, unknown> {
  const parsed = parseData(value, usage);
  const result = validateResource(schemaName, parsed);
  if (!result.ok) validationError(`${usage} (${result.errors.join('; ')})`);
  return parsed;
}

function writeIdempotencyKey(flags: Record<string, string>, usage: string): string {
  return requiredValue(flags['idempotency-key'], `${usage} --idempotency-key=<key>`);
}

export function resolveActionApiConfig(env: NodeJS.ProcessEnv = process.env): ActionApiConfig {
  const baseUrl = (env.COMMANDER_API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
  const apiKey = env.COMMANDER_API_KEY?.trim() ?? '';
  if (!apiKey) {
    throw new Error('COMMANDER_API_KEY is required for commander action commands.');
  }
  return { baseUrl, apiKey };
}

export async function actionApiFetch(
  path: string,
  init: RequestInit,
  config: ActionApiConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  headers.set('authorization', `Bearer ${config.apiKey}`);
  return fetchImpl(`${config.baseUrl}${path}`, { ...init, headers });
}

async function killList(
  config: ActionApiConfig,
  fetchImpl: typeof fetch,
  json: boolean,
): Promise<void> {
  const response = await actionApiFetch(
    '/v1/actions/kill-switches',
    { method: 'GET' },
    config,
    fetchImpl,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kill switch list failed (${response.status}): ${body}`);
  }
  const payload = (await response.json()) as { killSwitches: Array<Record<string, unknown>> };
  if (json) {
    printPayload(payload, true);
    return;
  }
  if (payload.killSwitches.length === 0) {
    console.log('No kill switches configured.');
    return;
  }
  for (const entry of payload.killSwitches) {
    console.log(
      `${entry.scope}\t${entry.value}\t${entry.enabled ? 'enabled' : 'disabled'}\t${entry.reason ?? ''}`,
    );
  }
}

async function killSet(
  config: ActionApiConfig,
  fetchImpl: typeof fetch,
  scope: string,
  value: string,
  enabled: boolean,
  idempotencyKey: string,
  json: boolean,
  reason?: string,
): Promise<void> {
  const response = await actionApiFetch(
    `/v1/actions/kill-switches/${encodeURIComponent(scope)}/${encodeURIComponent(value)}`,
    {
      method: 'PUT',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ enabled, ...(reason ? { reason } : {}) }),
    },
    config,
    fetchImpl,
  );
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Kill switch update failed (${response.status}): ${body}`);
  }
  const payload = (await response.json()) as { killSwitch: Record<string, unknown> };
  if (json) {
    printPayload(payload, true);
    return;
  }
  console.log(
    `Kill switch ${payload.killSwitch.scope}/${payload.killSwitch.value} is now ${
      payload.killSwitch.enabled ? 'enabled' : 'disabled'
    }.`,
  );
}

async function gatewayRequest(
  path: string,
  init: RequestInit,
  config: ActionApiConfig,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await actionApiFetch(path, init, config, fetchImpl);
  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const code =
      payload && typeof payload === 'object' && 'error' in payload
        ? (payload as { error?: { code?: string } }).error?.code
        : undefined;
    throw new Error(`Action gateway failed (${response.status}${code ? ` ${code}` : ''})`);
  }
  return payload;
}

function printPayload(payload: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

export async function cmdAction(
  args: string[],
  flags: Record<string, string> = {},
  deps: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    exit?: (code: number) => never;
  } = {},
): Promise<void> {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const parsed = parseFlags(args);
  const subcommand = parsed.positional[0];
  const rest = parsed.positional.slice(1);
  const mergedFlags = { ...parsed.flags, ...flags };

  try {
    const config = resolveActionApiConfig(deps.env);
    const json = mergedFlags.json === 'true';

    if (subcommand === 'kill') {
      const action = requiredValue(rest[0], 'Usage: commander action kill list|enable|disable');
      if (action === 'list') {
        await killList(config, fetchImpl, json);
        return;
      }
      if (action === 'enable' || action === 'disable') {
        const scope = requiredValue(
          rest[1],
          `Usage: commander action kill ${action} <scope> <value> [--reason=...]`,
        );
        const value = requiredValue(
          rest[2],
          `Usage: commander action kill ${action} <scope> <value> [--reason=...]`,
        );
        if (!ACTION_KILL_SWITCH_SCOPES_V1.includes(scope as never)) {
          validationError(`Unknown kill switch scope: ${scope}`);
        }
        const idempotencyKey = writeIdempotencyKey(
          mergedFlags,
          `Usage: commander action kill ${action} <scope> <value>`,
        );
        await killSet(
          config,
          fetchImpl,
          scope,
          value,
          action === 'enable',
          idempotencyKey,
          json,
          mergedFlags.reason,
        );
        return;
      }
      validationError('Usage: commander action kill list|enable|disable');
    }

    let path: string;
    let init: RequestInit;
    switch (subcommand) {
      case 'simulate':
      case 'propose': {
        const body = parseContractData(
          'actionProposeRequest',
          mergedFlags.data,
          `Usage: commander action ${subcommand} --data='<json>' [--json]`,
        );
        const idempotencyKey = requiredValue(
          typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined,
          'Action input requires idempotencyKey',
        );
        path = subcommand === 'simulate' ? '/v1/actions/simulate' : '/v1/actions';
        init = {
          method: 'POST',
          headers: { 'idempotency-key': idempotencyKey },
          body: JSON.stringify(body),
        };
        break;
      }
      case 'compensation': {
        const operation = requiredValue(
          rest[0],
          "Usage: commander action compensation request|approve <runId> [authorizationId] --data='<json>'",
        );
        const runId = requiredValue(
          rest[1],
          "Usage: commander action compensation request|approve <runId> [authorizationId] --data='<json>'",
        );
        const idempotencyKey = writeIdempotencyKey(
          mergedFlags,
          `Usage: commander action compensation ${operation} ${runId}`,
        );
        if (operation === 'request') {
          const body = parseContractData(
            'actionCompensationRequest',
            mergedFlags.data,
            "Usage: commander action compensation request <runId> --data='<json>'",
          );
          path = `/v1/actions/${encodeURIComponent(runId)}/compensations`;
          init = {
            method: 'POST',
            headers: { 'idempotency-key': idempotencyKey },
            body: JSON.stringify(body),
          };
          break;
        }
        if (operation === 'approve') {
          const authorizationId = requiredValue(
            rest[2],
            "Usage: commander action compensation approve <runId> <authorizationId> --data='<json>'",
          );
          const body = parseContractData(
            'actionCompensationApprovalRequest',
            mergedFlags.data,
            "Usage: commander action compensation approve <runId> <authorizationId> --data='<json>'",
          );
          path = `/v1/actions/${encodeURIComponent(runId)}/compensations/${encodeURIComponent(authorizationId)}/approve`;
          init = {
            method: 'POST',
            headers: { 'idempotency-key': idempotencyKey },
            body: JSON.stringify(body),
          };
          break;
        }
        validationError(
          "Usage: commander action compensation request|approve <runId> [authorizationId] --data='<json>'",
        );
      }
      case 'get': {
        const runId = requiredValue(rest[0], 'Usage: commander action get <runId> [--json]');
        path = `/v1/actions/${encodeURIComponent(runId)}`;
        init = { method: 'GET' };
        break;
      }
      case 'approve': {
        const runId = requiredValue(
          rest[0],
          "Usage: commander action approve <runId> --data='<json>'",
        );
        const body = parseContractData(
          'actionApprovalRequest',
          mergedFlags.data,
          "Usage: commander action approve <runId> --data='<json>'",
        );
        path = `/v1/actions/${encodeURIComponent(runId)}/approve`;
        init = {
          method: 'POST',
          headers: {
            'idempotency-key': writeIdempotencyKey(
              mergedFlags,
              'Usage: commander action approve <runId>',
            ),
          },
          body: JSON.stringify(body),
        };
        break;
      }
      case 'reject': {
        const runId = requiredValue(
          rest[0],
          'Usage: commander action reject <runId> [--reason=...]',
        );
        path = `/v1/actions/${encodeURIComponent(runId)}/reject`;
        init = {
          method: 'POST',
          headers: {
            'idempotency-key': writeIdempotencyKey(
              mergedFlags,
              'Usage: commander action reject <runId>',
            ),
          },
          body: JSON.stringify(mergedFlags.reason ? { reason: mergedFlags.reason } : {}),
        };
        break;
      }
      case 'reconcile': {
        const runId = requiredValue(rest[0], 'Usage: commander action reconcile <runId> [--json]');
        path = `/v1/actions/${encodeURIComponent(runId)}/reconcile`;
        init = {
          method: 'POST',
          headers: {
            'idempotency-key': writeIdempotencyKey(
              mergedFlags,
              'Usage: commander action reconcile <runId>',
            ),
          },
          body: JSON.stringify({}),
        };
        break;
      }
      case 'evidence': {
        if (rest[0] !== 'verify') {
          validationError('Usage: commander action evidence verify <runId> [--json]');
        }
        const runId = requiredValue(
          rest[1],
          'Usage: commander action evidence verify <runId> [--json]',
        );
        path = `/v1/actions/${encodeURIComponent(runId)}/evidence`;
        init = { method: 'GET' };
        break;
      }
      default:
        validationError(
          'Usage: commander action simulate|propose|get|approve|reject|compensation|reconcile|evidence|kill',
        );
    }

    const payload = await gatewayRequest(path, init, config, fetchImpl);
    if (
      subcommand === 'evidence' &&
      payload &&
      typeof payload === 'object' &&
      'verification' in payload &&
      (payload as { verification?: { ok?: boolean } }).verification?.ok === false
    ) {
      throw new Error('Action evidence verification failed');
    }
    printPayload(payload, json);
  } catch (error) {
    console.error((error as Error).message);
    exit(error instanceof ActionCliValidationError ? 2 : 1);
  }
}
