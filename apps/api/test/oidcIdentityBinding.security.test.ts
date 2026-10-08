import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AuthPluginResult } from '@praetor/core';

const originalCwd = process.cwd();
const originalEnv = {
  JWT_SECRET: process.env.JWT_SECRET,
  OIDC_ISSUER: process.env.OIDC_ISSUER,
  OIDC_CLIENT_ID: process.env.OIDC_CLIENT_ID,
  OIDC_ENABLED: process.env.OIDC_ENABLED,
  OIDC_DEFAULT_TENANT_ID: process.env.OIDC_DEFAULT_TENANT_ID,
  OIDC_TENANT_CLAIM: process.env.OIDC_TENANT_CLAIM,
  COMMANDER_DEFAULT_TENANT_ID: process.env.COMMANDER_DEFAULT_TENANT_ID,
};
const tmpDir = path.join(os.tmpdir(), `commander-oidc-binding-${crypto.randomUUID()}`);

fs.mkdirSync(path.join(tmpDir, '.commander'), { recursive: true });
process.chdir(tmpDir);
process.env.JWT_SECRET = 'oidc-binding-test-secret-at-least-32-chars';
process.env.OIDC_ISSUER = 'https://idp.example.test';
process.env.OIDC_CLIENT_ID = 'commander-test-client';
process.env.OIDC_ENABLED = 'true';
process.env.COMMANDER_DEFAULT_TENANT_ID = 'deployment-default';

const { createOIDCAuthRouter } = await import('../src/oidcAuthEndpoints');
const { createUserAuthRouter } = await import('../src/userAuthEndpoints');
const {
  _resetUserStoreForTests,
  createUser,
  findUserByEmail,
  findUserByOidcIdentity,
  setUserRepository,
} = await import('../src/userStore');
const { _resetRefreshTokenStoreForTests, setRefreshTokenRepository } =
  await import('../src/refreshTokenStore');
const { verifyToken } = await import('../src/jwtMiddleware');
const { SimpleTenantProvider, setGlobalTenantProvider, resetGlobalTenantProvider } =
  await import('@praetor/core/runtime');
const { TestRefreshTokenRepository, TestUserRepository } = await import('./authRepositories');

const localPassword = ['local', 'password'].join('-');

let result: AuthPluginResult;
let server: ReturnType<ReturnType<typeof express>['listen']>;
let baseUrl: string;

function oidcResult(overrides: Partial<AuthPluginResult> = {}): AuthPluginResult {
  return {
    userId: 'subject-alice',
    username: 'alice@example.test',
    role: 'operator',
    tenantId: 'tenant-a',
    claims: {
      iss: 'https://idp.example.test',
      sub: 'subject-alice',
      email: 'alice@example.test',
      email_verified: true,
      tenant_id: 'tenant-a',
    },
    ...overrides,
  };
}

async function exchange(idToken = 'validated-id-token') {
  return fetch(`${baseUrl}/api/auth/oidc/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    createOIDCAuthRouter({
      authenticate: async () => result,
    }),
  );
  app.use(createUserAuthRouter());
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  resetGlobalTenantProvider();
  delete process.env.OIDC_DEFAULT_TENANT_ID;
  delete process.env.OIDC_TENANT_CLAIM;
  process.env.COMMANDER_DEFAULT_TENANT_ID = 'deployment-default';
  setUserRepository(new TestUserRepository());
  setRefreshTokenRepository(new TestRefreshTokenRepository());
  result = oidcResult();
});

after(async () => {
  resetGlobalTenantProvider();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  _resetUserStoreForTests();
  _resetRefreshTokenStoreForTests();
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('OIDC exchange identity and tenant binding', () => {
  it('rejects a valid multi-tenant token with no tenant claim before minting tokens', async () => {
    setGlobalTenantProvider(new SimpleTenantProvider());
    result = oidcResult({
      tenantId: undefined,
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
      },
    });

    const response = await exchange();
    assert.equal(response.status, 401);
    const body = (await response.json()) as { token?: string; refreshToken?: string };
    assert.equal(body.token, undefined);
    assert.equal(body.refreshToken, undefined);
    assert.equal(
      await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'),
      undefined,
    );
  });

  it('accepts a valid explicit tenant claim in multi-tenant mode', async () => {
    setGlobalTenantProvider(new SimpleTenantProvider());

    const response = await exchange();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string };
    assert.equal(verifyToken(body.token)?.tenant_id, 'tenant-a');
  });

  it('accepts a tenant from an operator-configured claim name', async () => {
    setGlobalTenantProvider(new SimpleTenantProvider());
    process.env.OIDC_TENANT_CLAIM = 'organization_id';
    result = oidcResult({
      tenantId: 'implicit-idp-hostname',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
        organization_id: 'tenant-configured',
      },
    });

    const response = await exchange();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string };
    assert.equal(verifyToken(body.token)?.tenant_id, 'tenant-configured');
  });

  it('requires an explicit configured default for a claim-less single-tenant token', async () => {
    delete process.env.COMMANDER_DEFAULT_TENANT_ID;
    result = oidcResult({
      tenantId: 'implicit-idp-hostname',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
      },
    });

    const rejected = await exchange();
    assert.equal(rejected.status, 401);
    assert.equal(
      await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'),
      undefined,
    );

    process.env.OIDC_DEFAULT_TENANT_ID = 'single-tenant-default';
    const accepted = await exchange();
    assert.equal(accepted.status, 200);
    const body = (await accepted.json()) as { token: string };
    assert.equal(verifyToken(body.token)?.tenant_id, 'single-tenant-default');
  });

  it('provisions a new user bound to issuer+subject and mints the validated tenant', async () => {
    const response = await exchange();
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string; user: { id: string } };
    const token = verifyToken(body.token);

    assert.equal(token?.tenant_id, 'tenant-a');
    assert.equal(
      (await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'))?.id,
      body.user.id,
    );
  });

  it('returns the same linked account when the IdP email changes', async () => {
    const first = await exchange();
    const firstBody = (await first.json()) as { user: { id: string } };

    result = oidcResult({
      username: 'alice-renamed@example.test',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice-renamed@example.test',
        email_verified: true,
      },
    });
    const second = await exchange();
    const secondBody = (await second.json()) as { user: { id: string } };

    assert.equal(second.status, 200);
    assert.equal(secondBody.user.id, firstBody.user.id);
  });

  it('links a legitimate existing local account only when the email is verified', async () => {
    const created = await createUser({
      username: 'alice',
      email: 'alice@example.test',
      password: localPassword,
      role: 'viewer',
    });
    assert.ok(!('error' in created));

    const response = await exchange();
    assert.equal(response.status, 200);
    assert.equal(
      (await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'))?.id,
      created.user.id,
    );
  });

  it('rejects an unverified colliding email without changing the local account', async () => {
    const created = await createUser({
      username: 'victim',
      email: 'alice@example.test',
      password: localPassword,
      role: 'admin',
    });
    assert.ok(!('error' in created));
    result = oidcResult({
      role: 'viewer',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'attacker-subject',
        email: 'alice@example.test',
        email_verified: false,
      },
      userId: 'attacker-subject',
    });

    const response = await exchange();
    assert.equal(response.status, 409);
    assert.equal((await findUserByEmail('alice@example.test'))?.role, 'admin');
    assert.equal(
      await findUserByOidcIdentity('https://idp.example.test', 'attacker-subject'),
      undefined,
    );
  });

  it('rejects a second subject attempting to claim an already-bound email', async () => {
    assert.equal((await exchange()).status, 200);
    result = oidcResult({
      userId: 'subject-attacker',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-attacker',
        email: 'alice@example.test',
        email_verified: true,
      },
    });

    assert.equal((await exchange()).status, 409);
    assert.equal(
      await findUserByOidcIdentity('https://idp.example.test', 'subject-attacker'),
      undefined,
    );
  });

  it('rejects an invalid tenant claim instead of minting a fallback tenant', async () => {
    result = oidcResult({
      tenantId: '../tenant-b',
      claims: {
        iss: 'https://idp.example.test',
        sub: 'subject-alice',
        email: 'alice@example.test',
        email_verified: true,
        tenant_id: '../tenant-b',
      },
    });

    const response = await exchange();
    assert.equal(response.status, 401);
    assert.equal(
      await findUserByOidcIdentity('https://idp.example.test', 'subject-alice'),
      undefined,
    );
  });

  it('preserves the OIDC tenant when rotating the refresh token', async () => {
    const response = await exchange();
    const body = (await response.json()) as { refreshToken: string };
    const rotatedResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: body.refreshToken }),
    });
    const rotated = (await rotatedResponse.json()) as { token: string; refreshToken: string };

    assert.equal(rotatedResponse.status, 200);
    assert.equal(verifyToken(rotated.token)?.tenant_id, 'tenant-a');
    assert.equal(verifyToken(rotated.refreshToken)?.tenant_id, 'tenant-a');
  });
});
