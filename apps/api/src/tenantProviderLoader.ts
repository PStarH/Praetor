import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  setGlobalTenantProvider,
  SimpleTenantProvider,
  NullTenantProvider,
  type TenantConfig,
} from '@praetor/core/runtime';

/** Tenant ID format: alphanumeric, hyphen, underscore, dot, colon. Must not be empty. */
const TENANT_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

interface TenantConfigFile {
  tenants?: unknown[];
}

let configuredTenantIds: string[] = [];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validateTenant(raw: unknown, index: number): TenantConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`Tenant at index ${index} must be an object`);
  }

  const tenantId = raw.tenantId;
  if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
    throw new Error(
      `Invalid tenant id at index ${index}: must be 1-128 chars matching ${TENANT_ID_RE.source}`,
    );
  }

  const optionalPositiveNumberFields = [
    'maxConcurrency',
    'maxRunsPerMinute',
    'tokenBudget',
    'maxStorageBytes',
  ] as const;
  for (const field of optionalPositiveNumberFields) {
    const value = raw[field];
    if (value !== undefined && !isPositiveNumber(value)) {
      throw new Error(
        `Invalid ${field} for tenant "${tenantId}": must be a positive number when provided`,
      );
    }
  }

  const isolation = raw.isolation;
  if (isolation !== undefined && !['pool', 'bridge', 'silo'].includes(isolation as string)) {
    throw new Error(
      `Invalid isolation for tenant "${tenantId}": must be one of pool, bridge, silo`,
    );
  }

  const enabled = raw.enabled !== false;

  return {
    tenantId,
    tokenBudget: typeof raw.tokenBudget === 'number' ? raw.tokenBudget : 0,
    maxConcurrency: typeof raw.maxConcurrency === 'number' ? raw.maxConcurrency : 0,
    maxRunsPerMinute: typeof raw.maxRunsPerMinute === 'number' ? raw.maxRunsPerMinute : 0,
    enabled,
    isolation: isolation as TenantConfig['isolation'],
    workspacePath: typeof raw.workspacePath === 'string' ? raw.workspacePath : undefined,
    storagePath: typeof raw.storagePath === 'string' ? raw.storagePath : undefined,
    maxStorageBytes: typeof raw.maxStorageBytes === 'number' ? raw.maxStorageBytes : undefined,
    metadata: isPlainObject(raw.metadata)
      ? Object.fromEntries(Object.entries(raw.metadata).map(([k, v]) => [k, String(v ?? '')]))
      : undefined,
  };
}

/**
 * Load tenant configuration from an explicit JSON file and initialize the
 * global TenantProvider. Multi-tenant mode is opt-in via the `configPath`
 * argument or the TENANT_CONFIG_PATH environment variable. When neither is
 * provided, the API boots in single-tenant mode using NullTenantProvider.
 */
export function loadTenantProvider(configPath?: string): void {
  const targetPath = configPath ?? process.env.TENANT_CONFIG_PATH;

  if (!targetPath || !fs.existsSync(targetPath)) {
    setGlobalTenantProvider(new NullTenantProvider());
    configuredTenantIds = [];
    return;
  }

  let parsed: TenantConfigFile;
  try {
    const raw = fs.readFileSync(targetPath, 'utf-8');
    parsed = JSON.parse(raw) as TenantConfigFile;
  } catch (err) {
    throw new Error(
      `Failed to parse tenant config at ${targetPath}: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  const rawTenants = Array.isArray(parsed.tenants) ? parsed.tenants : [];
  const tenants: TenantConfig[] = [];
  for (let i = 0; i < rawTenants.length; i++) {
    const validated = validateTenant(rawTenants[i], i);
    if (validated.enabled) {
      tenants.push(validated);
    }
  }

  configuredTenantIds = tenants.map((t) => t.tenantId);
  setGlobalTenantProvider(new SimpleTenantProvider(tenants));
}

/** Return the tenant IDs that were loaded by the most recent call to loadTenantProvider. */
export function getConfiguredTenantIds(): string[] {
  return configuredTenantIds.slice();
}
