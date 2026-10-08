import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanEffectIo } from './effect-io-guard.js';
import { FIXED_ACTION_ADAPTER_MANIFESTS } from '../packages/contracts/src/actionAdapters.js';

function sha256(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function writeConfig(
  root: string,
  input: { exceptions?: unknown[]; allowlist?: unknown[]; baselineCount?: number } = {},
): void {
  const exceptions = input.exceptions ?? [];
  writeFileSync(
    join(root, 'config/effect-io-exceptions.json'),
    JSON.stringify({ baselineCount: input.baselineCount ?? exceptions.length, exceptions }),
  );
  writeFileSync(
    join(root, 'config/effect-io-allowlist.json'),
    JSON.stringify({ paths: input.allowlist ?? [] }),
  );
}

describe('effect-io-guard', () => {
  it('baseline exceptions count matches config', () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), 'config/effect-io-exceptions.json'), 'utf-8'),
    );
    assert.equal(config.exceptions.length, config.baselineCount);
  });

  it('registered adapter manifests have effectType', () => {
    for (const m of FIXED_ACTION_ADAPTER_MANIFESTS) {
      assert.ok(m.effectType, `${m.adapterId} effectType`);
    }
  });

  it('passes on current baseline', () => {
    const errors = scanEffectIo();
    assert.deepEqual(errors, [], errors.join('\n'));
  });

  it('owns networkProxy as exact sandbox security infrastructure', () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), 'config/effect-io-allowlist.json'), 'utf-8'),
    ) as { paths: Array<Record<string, unknown>> };
    const path = 'packages/core/src/sandbox/networkProxy.ts';
    const entry = config.paths.find((candidate) => candidate.path === path);
    assert.ok(entry, `${path} must have an exact allowlist entry`);
    assert.equal(entry.owner, '@praetor/core/sandbox-security');
    assert.match(String(entry.reason), /sandbox security infrastructure/i);
    assert.deepEqual(entry.patterns, ['net']);
    assert.equal(entry.sourceSha256, sha256(readFileSync(join(process.cwd(), path), 'utf-8')));
  });

  it('flags new fetch bypass outside baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-audit-'));
    try {
      for (const dir of ['config', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'config/effect-io-exceptions.json'),
        JSON.stringify({ baselineCount: 0, exceptions: [] }),
      );
      writeFileSync(join(root, 'config/effect-io-allowlist.json'), JSON.stringify({ paths: [] }));
      writeFileSync(
        join(root, 'packages/kernel/src/bypass.ts'),
        'export async function probe() { await fetch("https://example.com"); }\n',
      );
      const errors = scanEffectIo(root);
      assert.ok(errors.some((e) => e.includes('New external I/O bypass')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects I/O loaded through the ESM require helpers, not just bare require', () => {
    // Regression: 13 of 14 packages are "type": "module", so the codebase loads
    // built-ins through nodeRequire/optionalRequire instead of the bare
    // `require`. A case-sensitive `require\s*\(` never matches `nodeRequire(`,
    // so migrating to the helper silently hid real subprocess/HTTP I/O from this
    // guard (the exception went stale and the I/O stopped being reported).
    const root = mkdtempSync(join(tmpdir(), 'effect-io-esm-require-'));
    try {
      for (const dir of ['config', 'packages/kernel/src', 'packages/core/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'config/effect-io-exceptions.json'),
        JSON.stringify({ baselineCount: 0, exceptions: [] }),
      );
      writeFileSync(join(root, 'config/effect-io-allowlist.json'), JSON.stringify({ paths: [] }));

      writeFileSync(
        join(root, 'packages/core/src/helper-subprocess.ts'),
        'export function run() {\n  const { spawn } = nodeRequire("child_process");\n  return spawn("ls");\n}\n',
      );
      writeFileSync(
        join(root, 'packages/kernel/src/helper-https.ts'),
        'export function call() {\n  const https = optionalRequire("node:https");\n  return https.request("https://example.com");\n}\n',
      );

      const errors = scanEffectIo(root);
      assert.ok(
        errors.some((e) => e.includes('helper-subprocess.ts (child_process)')),
        `nodeRequire("child_process") must be detected as external I/O, got: ${JSON.stringify(errors)}`,
      );
      assert.ok(
        errors.some((e) => e.includes('helper-https.ts (node:https)')),
        `optionalRequire("node:https") must be detected as external I/O, got: ${JSON.stringify(errors)}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes outbound sockets from pure net helpers and inbound servers', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-direction-'));
    try {
      for (const dir of ['config', 'apps/api/src', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'config/effect-io-exceptions.json'),
        JSON.stringify({ baselineCount: 0, exceptions: [] }),
      );
      writeFileSync(join(root, 'config/effect-io-allowlist.json'), JSON.stringify({ paths: [] }));
      writeFileSync(
        join(root, 'apps/api/src/inbound.ts'),
        'import { createServer } from "node:https";\nexport const server = createServer();\n',
      );
      writeFileSync(
        join(root, 'packages/kernel/src/identity.ts'),
        'import { isIP } from "node:net";\nexport const valid = isIP("127.0.0.1");\n',
      );
      assert.deepEqual(scanEffectIo(root), []);

      writeFileSync(
        join(root, 'packages/kernel/src/outbound.ts'),
        'import { request } from "node:https";\nexport const call = () => request("https://example.com");\n',
      );
      assert.ok(scanEffectIo(root).some((error) => error.includes('outbound.ts (node:https)')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects namespace, aliased, require, and dynamic HTTP clients', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-http-forms-'));
    try {
      for (const dir of ['config', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeConfig(root);
      const sources = {
        namespace: 'import * as secure from "node:https"; secure.request("https://x");\n',
        aliased: 'import { request as send } from "node:https"; send("https://x");\n',
        required: 'const secure = require("https"); secure.get("https://x");\n',
        dynamic: 'const secure = await import("node:https"); secure.request("https://x");\n',
      };
      for (const [name, source] of Object.entries(sources)) {
        writeFileSync(join(root, `packages/kernel/src/${name}.ts`), source);
      }
      const errors = scanEffectIo(root);
      for (const name of Object.keys(sources)) {
        assert.ok(
          errors.some((error) => error.includes(`${name}.ts (node:https)`)),
          errors.join('\n'),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects namespace and require net socket connections', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-net-forms-'));
    try {
      for (const dir of ['config', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeConfig(root);
      const sources = {
        namespaceConnect:
          'import * as network from "node:net";\nexport const open = () => network.connect(443, "example.com");\n',
        requireCreateConnection:
          'const network = require("net");\nexport const open = () => network.createConnection(443, "example.com");\n',
        socketConnect:
          'import * as network from "net";\nexport const open = () => new network.Socket().connect(443, "example.com");\n',
      };
      for (const [name, source] of Object.entries(sources)) {
        writeFileSync(join(root, `packages/kernel/src/${name}.ts`), source);
      }
      const errors = scanEffectIo(root);
      for (const name of Object.keys(sources)) {
        assert.ok(
          errors.some((error) => error.includes(`${name}.ts (net)`)),
          errors.join('\n'),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects execFile, execFileSync, and fork subprocess execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-child-process-forms-'));
    try {
      for (const dir of ['config', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeConfig(root);
      const sources = {
        execFile:
          'import { execFile } from "node:child_process";\nexport const run = () => execFile("git", ["status"]);\n',
        execFileSync:
          'const child = require("child_process");\nexport const run = () => child.execFileSync("git", ["status"]);\n',
        fork: 'import * as child from "node:child_process";\nexport const run = () => child.fork("worker.js");\n',
        aliasedExecFile:
          'import { execFile as runFile } from "node:child_process";\nexport const run = () => runFile("git", ["status"]);\n',
      };
      for (const [name, source] of Object.entries(sources)) {
        writeFileSync(join(root, `packages/kernel/src/${name}.ts`), source);
      }
      const errors = scanEffectIo(root);
      for (const name of Object.keys(sources)) {
        assert.ok(
          errors.some((error) => error.includes(`${name}.ts (child_process)`)),
          errors.join('\n'),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('trusts only exact registered action-adapter directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-adapter-boundary-'));
    try {
      for (const dir of [
        'config',
        'packages/action-adapters/src/github',
        'packages/action-adapters/src',
      ]) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeConfig(root);
      const source = 'export const call = () => fetch("https://example.com");\n';
      writeFileSync(join(root, 'packages/action-adapters/src/github/client.ts'), source);
      writeFileSync(join(root, 'packages/action-adapters/src/githubBypass.ts'), source);
      const errors = scanEffectIo(root);
      assert.equal(
        errors.some((error) => error.includes('github/client.ts')),
        false,
      );
      assert.ok(
        errors.some((error) => error.includes('githubBypass.ts (fetch)')),
        errors.join('\n'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('grants proof transport ownership only to the three exact kernel clients', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-proof-client-'));
    try {
      for (const dir of ['config', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      const httpsSource =
        'import { request } from "node:https";\nexport const prove = () => request("https://proof.invalid");\n';
      const httpSource =
        'import { request } from "node:http";\nexport const prove = () => request({ socketPath: "/proof.sock" });\n';
      writeFileSync(
        join(root, 'config/effect-io-exceptions.json'),
        JSON.stringify({ baselineCount: 0, exceptions: [] }),
      );
      writeFileSync(
        join(root, 'config/effect-io-allowlist.json'),
        JSON.stringify({
          paths: [
            {
              id: 'readiness-proof-client',
              path: 'packages/kernel/src/task1ReadinessChallengeClient.ts',
              sourceSha256: sha256(httpsSource),
              owner: '@praetor/kernel',
              reason: 'TLS-pinned challenged readiness proof client',
              expiresAt: '2099-12-31',
              patterns: ['node:https'],
            },
            {
              id: 'compose-proof-client',
              path: 'packages/kernel/src/task1ComposeProofRuntime.ts',
              sourceSha256: sha256(httpSource),
              owner: '@praetor/kernel',
              reason: 'Authenticated local Compose proof relay client',
              expiresAt: '2099-12-31',
              patterns: ['node:http'],
            },
            {
              id: 'kubernetes-proof-client',
              path: 'packages/kernel/src/task1KubernetesProofRuntime.ts',
              sourceSha256: sha256(httpsSource),
              owner: '@praetor/kernel',
              reason: 'Projected-token Kubernetes proof API client',
              expiresAt: '2099-12-31',
              patterns: ['node:https'],
            },
          ],
        }),
      );
      writeFileSync(
        join(root, 'packages/kernel/src/task1ReadinessChallengeClient.ts'),
        httpsSource,
      );
      writeFileSync(join(root, 'packages/kernel/src/task1ComposeProofRuntime.ts'), httpSource);
      writeFileSync(join(root, 'packages/kernel/src/task1KubernetesProofRuntime.ts'), httpsSource);
      writeFileSync(join(root, 'packages/kernel/src/challengeClientBypass.ts'), httpsSource);
      writeFileSync(join(root, 'packages/kernel/src/composeRelayBypass.ts'), httpSource);
      const errors = scanEffectIo(root);
      assert.equal(
        errors.some((error) => error.includes('task1ReadinessChallengeClient.ts')),
        false,
      );
      assert.equal(
        errors.some((error) => error.includes('task1ComposeProofRuntime.ts')),
        false,
      );
      assert.equal(
        errors.some((error) => error.includes('task1KubernetesProofRuntime.ts')),
        false,
      );
      assert.equal(
        errors.some((error) => error.includes('challengeClientBypass.ts (node:https)')),
        true,
      );
      assert.equal(
        errors.some((error) => error.includes('composeRelayBypass.ts (node:http)')),
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds allowlist approval to source hash, owner, reason, and expiry', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-allowlist-binding-'));
    try {
      for (const dir of ['config', 'packages/kernel/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      const path = 'packages/kernel/src/proofClient.ts';
      const source = 'export const prove = () => fetch("https://proof.invalid");\n';
      writeFileSync(join(root, path), source);
      const approved = {
        id: 'proof-client',
        path,
        sourceSha256: sha256(source),
        owner: '@praetor/kernel',
        reason: 'Challenged proof transport with no effect execution',
        expiresAt: '2099-12-31',
        patterns: ['fetch('],
      };
      writeConfig(root, { allowlist: [approved] });
      assert.deepEqual(scanEffectIo(root), []);

      for (const invalid of [
        { ...approved, sourceSha256: '0'.repeat(64) },
        { ...approved, owner: '' },
        { ...approved, reason: '' },
        { ...approved, expiresAt: '2020-01-01' },
      ]) {
        writeConfig(root, { allowlist: [invalid] });
        assert.ok(scanEffectIo(root).length > 0, JSON.stringify(invalid));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when an exception references a deleted source file', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-stale-exception-'));
    try {
      mkdirSync(join(root, 'config'), { recursive: true });
      writeConfig(root, {
        exceptions: [
          {
            id: 'deleted-bypass',
            path: 'packages/core/src/deleted.ts',
            owner: '@praetor/core',
            reason: 'Legacy subprocess authority pending removal',
            replacement: 'packages/action-adapters/src/process',
            expiresAt: '2099-12-31',
            patterns: ['child_process'],
          },
        ],
      });
      assert.ok(
        scanEffectIo(root).some((error) =>
          error.includes("Stale effect-io exception 'deleted-bypass'"),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when an exception source no longer contains its approved I/O', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-unnecessary-exception-'));
    try {
      for (const dir of ['config', 'packages/core/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      const path = 'packages/core/src/legacy.ts';
      writeFileSync(join(root, path), 'export const local = () => 42;\n');
      writeConfig(root, {
        exceptions: [
          {
            id: 'removed-fetch',
            path,
            owner: '@praetor/core',
            reason: 'Legacy HTTP authority pending removal',
            replacement: 'packages/action-adapters/src/http',
            expiresAt: '2099-12-31',
            patterns: ['fetch('],
          },
        ],
      });
      assert.ok(
        scanEffectIo(root).some((error) =>
          error.includes("Stale effect-io exception 'removed-fetch'"),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags expired exceptions', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-expired-exception-'));
    try {
      for (const dir of ['config', 'packages/core/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'packages/core/src/expired.ts'),
        'export const probe = () => fetch("https://x");\n',
      );
      writeConfig(root, {
        exceptions: [
          {
            id: 'expired',
            path: 'packages/core/src/expired.ts',
            owner: '@praetor/core',
            reason: 'Legacy HTTP authority pending removal',
            replacement: 'packages/action-adapters/src/http',
            expiresAt: '2020-01-01',
            patterns: ['fetch('],
          },
        ],
      });
      const errors = scanEffectIo(root);
      assert.ok(errors.some((e) => e.includes('Expired')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let a single exception pattern cover a second IO type in the same file', () => {
    const root = mkdtempSync(join(tmpdir(), 'effect-io-multi-'));
    try {
      for (const dir of ['config', 'packages/core/src']) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      writeFileSync(
        join(root, 'config/effect-io-exceptions.json'),
        JSON.stringify({
          baselineCount: 1,
          exceptions: [
            {
              id: 'tmp-fetch-only',
              path: 'packages/core/src/multi.ts',
              expiresAt: '2099-01-01',
              patterns: ['fetch('],
            },
          ],
        }),
      );
      writeFileSync(join(root, 'config/effect-io-allowlist.json'), JSON.stringify({ paths: [] }));
      writeFileSync(
        join(root, 'packages/core/src/multi.ts'),
        'import { spawn } from "child_process";\nexport async function probe() { await fetch("https://x"); spawn("true"); }\n',
      );
      const errors = scanEffectIo(root);
      assert.ok(
        errors.some((e) => e.includes('New external I/O bypass') && e.includes('child_process')),
        errors.join('\n'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
