import { test, before, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getGlobalTenantProvider,
  resetGlobalTenantProvider,
  SimpleTenantProvider,
  NullTenantProvider,
} from '@praetor/core/runtime';
import { loadTenantProvider, getConfiguredTenantIds } from '../src/tenantProviderLoader';

let originalTenantConfigPath: string | undefined;
let tmpDir: string | undefined;

before(() => {
  originalTenantConfigPath = process.env.TENANT_CONFIG_PATH;
});

afterEach(() => {
  resetGlobalTenantProvider();
  process.env.TENANT_CONFIG_PATH = originalTenantConfigPath;
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function makeTempDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commander-tenant-'));
  return tmpDir;
}

function writeConfig(dir: string, config: object): string {
  const configPath = path.join(dir, 'tenants.json');
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return configPath;
}

test('loads config from explicit path', () => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, {
    tenants: [
      {
        tenantId: 'acme-corp',
        tokenBudget: 100000,
        maxConcurrency: 5,
        maxRunsPerMinute: 60,
        enabled: true,
      },
    ],
  });

  loadTenantProvider(configPath);

  const provider = getGlobalTenantProvider();
  assert.ok(provider instanceof SimpleTenantProvider);
  assert.deepEqual(getConfiguredTenantIds(), ['acme-corp']);
  const config = provider.getTenantConfig('acme-corp');
  assert.equal(config?.tenantId, 'acme-corp');
  assert.equal(config?.tokenBudget, 100000);
  assert.equal(config?.maxConcurrency, 5);
  assert.equal(config?.maxRunsPerMinute, 60);
  assert.equal(config?.enabled, true);
});

test('falls back to NullTenantProvider when config file does not exist', () => {
  const dir = makeTempDir();
  const missingPath = path.join(dir, 'missing-tenants.json');

  loadTenantProvider(missingPath);

  const provider = getGlobalTenantProvider();
  assert.ok(provider instanceof NullTenantProvider);
  assert.deepEqual(getConfiguredTenantIds(), []);
  assert.equal(provider.getTenantConfig('any'), undefined);
});

test('skips disabled tenants', () => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, {
    tenants: [
      { tenantId: 'enabled-tenant', tokenBudget: 1000, enabled: true },
      { tenantId: 'disabled-tenant', tokenBudget: 2000, enabled: false },
    ],
  });

  loadTenantProvider(configPath);

  const provider = getGlobalTenantProvider();
  assert.ok(provider instanceof SimpleTenantProvider);
  assert.deepEqual(getConfiguredTenantIds(), ['enabled-tenant']);
  assert.equal(provider.getTenantConfig('enabled-tenant')?.enabled, true);
  assert.equal(provider.getTenantConfig('disabled-tenant'), undefined);
});

test('enabled defaults to true when omitted', () => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, {
    tenants: [{ tenantId: 'default-enabled', tokenBudget: 1000 }],
  });

  loadTenantProvider(configPath);

  const provider = getGlobalTenantProvider();
  assert.ok(provider instanceof SimpleTenantProvider);
  assert.deepEqual(getConfiguredTenantIds(), ['default-enabled']);
  assert.equal(provider.getTenantConfig('default-enabled')?.enabled, true);
});

test('throws on invalid tenant id', () => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, {
    tenants: [{ tenantId: 'invalid tenant!', tokenBudget: 1000 }],
  });

  assert.throws(() => loadTenantProvider(configPath), /Invalid tenant id/);
});

test('throws when optional numeric fields are not positive', () => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, {
    tenants: [{ tenantId: 'bad-numbers', tokenBudget: 0, maxConcurrency: -1 }],
  });

  assert.throws(() => loadTenantProvider(configPath), /must be a positive number when provided/);
});

test('respects TENANT_CONFIG_PATH environment variable', () => {
  const dir = makeTempDir();
  const configPath = writeConfig(dir, {
    tenants: [{ tenantId: 'env-tenant', tokenBudget: 5000, enabled: true }],
  });

  process.env.TENANT_CONFIG_PATH = configPath;
  loadTenantProvider();

  const provider = getGlobalTenantProvider();
  assert.ok(provider instanceof SimpleTenantProvider);
  assert.deepEqual(getConfiguredTenantIds(), ['env-tenant']);
  assert.equal(provider.getTenantConfig('env-tenant')?.tokenBudget, 5000);
});

test('explicit config path takes precedence over TENANT_CONFIG_PATH', () => {
  const dir = makeTempDir();
  const explicitPath = path.join(dir, 'explicit-tenants.json');
  const envPath = path.join(dir, 'env-tenants.json');
  fs.writeFileSync(
    explicitPath,
    JSON.stringify({ tenants: [{ tenantId: 'explicit-tenant', tokenBudget: 1000 }] }),
    'utf-8',
  );
  fs.writeFileSync(
    envPath,
    JSON.stringify({ tenants: [{ tenantId: 'env-tenant', tokenBudget: 2000 }] }),
    'utf-8',
  );

  process.env.TENANT_CONFIG_PATH = envPath;
  loadTenantProvider(explicitPath);

  const provider = getGlobalTenantProvider();
  assert.deepEqual(getConfiguredTenantIds(), ['explicit-tenant']);
  assert.equal(provider.getTenantConfig('explicit-tenant')?.tokenBudget, 1000);
  assert.equal(provider.getTenantConfig('env-tenant'), undefined);
});
