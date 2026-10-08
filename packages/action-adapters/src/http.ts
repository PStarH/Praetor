import { AdapterExecutionError, adapterErrorFromHttpStatus } from '@praetor/effect-broker';

export type FetchFn = typeof fetch;

export async function adapterFetch(
  fetchImpl: FetchFn,
  url: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetchImpl(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    throw adapterErrorFromHttpStatus(
      response.status,
      `HTTP redirect not followed (${response.status})`,
    );
  }
  return response;
}

// A 2xx whose body is missing or unparseable says nothing about what the remote
// applied, so it is classified UNKNOWN/QUERY_FIRST instead of escaping the
// adapter taxonomy as a bare TypeError/SyntaxError.
function bodyError(message: string, status?: number): AdapterExecutionError {
  return new AdapterExecutionError(message, {
    code: 'ADAPTER_RESPONSE_BODY_INVALID',
    commitState: 'UNKNOWN',
    retryMode: 'QUERY_FIRST',
    ...(status === undefined ? {} : { details: { httpStatus: status } }),
  });
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw bodyError('Adapter response body could not be read', response.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw bodyError('Adapter response body was not valid JSON', response.status);
  }
}

export function requireObjectResponse<T extends object>(value: unknown, label: string): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw bodyError(`${label} did not return a JSON object`);
  }
  return value as T;
}

export function requireArrayResponse(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw bodyError(`${label} did not return a JSON array`);
  }
  return value;
}

export async function assertOkResponse(response: Response, label: string): Promise<void> {
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw adapterErrorFromHttpStatus(
    response.status,
    `${label} failed with HTTP ${response.status}: ${text.slice(0, 200)}`,
  );
}
