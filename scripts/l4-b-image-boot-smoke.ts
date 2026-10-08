#!/usr/bin/env tsx
/**
 * L4-B P6 — worker image in-container contracts / schemas boot probe.
 *
 *   pnpm cell:image-boot-smoke [--image-tag TAG] [--skip-build] [--help]
 *
 * Must use `docker run --entrypoint node` (no bind-mount of contracts or host node_modules).
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function assertSafeImageTag(imageTag: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(imageTag)) {
    throw new Error(`Invalid image tag: ${imageTag}`);
  }
  return imageTag;
}

const DEFAULT_DOCKERFILE = 'packages/worker-plane/Dockerfile';
const DEFAULT_IMAGE_TAG = 'l4-b-image-boot-smoke-local';
const CONTAINER_WORKDIR = '/app/packages/worker-plane';
const CONTAINER_CONTRACTS_ROOT = '/app/packages/contracts';

const HELP = `L4-B image boot smoke — in-image @praetor/contracts + schemas probe (P6)

Usage:
  pnpm cell:image-boot-smoke [--image-tag TAG] [--skip-build] [--help]

Options:
  --image-tag TAG   Docker image tag (default: ${DEFAULT_IMAGE_TAG})
  --skip-build      Skip docker build (reuse existing tag, e.g. commander-worker-ci)
  --help            Show this message

Artifact: artifacts/l4-b-image-boot-smoke-<ts>.json
`;

export interface InImageProbePayload {
  snapshotSchemaCount: number;
  resourcesCount: number;
  schemasDirEntryCount: number;
  distIndexExists: boolean;
}

export interface ImageBootSmokeArtifact {
  passed: boolean;
  imageTag: string;
  snapshotSchemaCount: number;
  elapsedMs: number;
  gitSha: string;
  probe: 'in-image';
  usedBindMount: false;
  artifactPath: string;
  probePayload?: InImageProbePayload;
  error?: string;
}

/** ESM probe executed inside the worker image via \`docker run --entrypoint node\`. */
export function buildInImageProbeSource(): string {
  // Absolute file URL — image may lack workspace package resolution from worker-plane cwd.
  return `import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const contractsRoot = '${CONTAINER_CONTRACTS_ROOT}';
const distIndex = contractsRoot + '/dist/index.js';
const require = createRequire(pathToFileURL(distIndex).href);
const { snapshotContracts } = require(distIndex);
const schemasDir = contractsRoot + '/schemas';
const snap = snapshotContracts();
const snapshotSchemaCount = Array.isArray(snap.schemaNames)
  ? snap.schemaNames.length
  : Array.isArray(snap.resources)
    ? snap.resources.length
    : Object.keys(snap.contracts ?? {}).length;
const resourcesCount = Array.isArray(snap.resources)
  ? snap.resources.length
  : snapshotSchemaCount;
const schemasDirEntryCount = fs.existsSync(schemasDir)
  ? fs.readdirSync(schemasDir).filter((name) => !name.startsWith('.')).length
  : 0;
const distIndexExists = fs.existsSync(distIndex);
const payload = {
  snapshotSchemaCount,
  resourcesCount,
  schemasDirEntryCount,
  distIndexExists,
};
const ok =
  distIndexExists &&
  schemasDirEntryCount > 0 &&
  snapshotSchemaCount > 0 &&
  resourcesCount > 0;
console.log(JSON.stringify(payload));
process.exit(ok ? 0 : 1);
`;
}

export function parseInImageProbeStdout(stdout: string): InImageProbePayload {
  const line = stdout
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) {
    throw new Error('empty probe stdout');
  }
  return JSON.parse(line) as InImageProbePayload;
}

/** Fail-closed validation for in-image probe JSON (also used by negative node:test). */
export function assertInImageProbePayload(payload: InImageProbePayload): void {
  if (!payload.distIndexExists) {
    throw new Error('contracts dist/index.js missing in image');
  }
  if (payload.schemasDirEntryCount <= 0) {
    throw new Error('contracts schemas directory missing or empty in image');
  }
  if (payload.snapshotSchemaCount <= 0) {
    throw new Error('snapshotContracts().schemaNames is empty');
  }
  if (payload.resourcesCount <= 0) {
    throw new Error('snapshotContracts().resources is empty');
  }
}

export function probePayloadExitCode(payload: InImageProbePayload): number {
  try {
    assertInImageProbePayload(payload);
    return 0;
  } catch {
    return 1;
  }
}

export function parseImageBootSmokeArtifact(json: string): ImageBootSmokeArtifact {
  const parsed = JSON.parse(json) as ImageBootSmokeArtifact;
  return parsed;
}

export function artifactPassedSemantics(artifact: ImageBootSmokeArtifact): boolean {
  return (
    artifact.passed === true &&
    artifact.probe === 'in-image' &&
    artifact.usedBindMount === false &&
    artifact.snapshotSchemaCount > 0
  );
}

function resolveGitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function dockerBuild(imageTag: string): void {
  const tag = assertSafeImageTag(imageTag);
  execFileSync('docker', ['build', '-f', DEFAULT_DOCKERFILE, '-t', tag, '.'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

function dockerRunInImageProbe(imageTag: string): InImageProbePayload {
  const tag = assertSafeImageTag(imageTag);
  const source = buildInImageProbeSource();
  try {
    const stdout = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--workdir',
        CONTAINER_WORKDIR,
        '--entrypoint',
        'node',
        tag,
        '--input-type=module',
      ],
      {
        cwd: process.cwd(),
        input: source,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return parseInImageProbeStdout(stdout);
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string };
    const merged = `${execErr.stdout ?? ''}\n${execErr.stderr ?? ''}`;
    try {
      return parseInImageProbeStdout(merged);
    } catch {
      throw err;
    }
  }
}

function dockerRmi(imageTag: string): void {
  try {
    execFileSync('docker', ['rmi', assertSafeImageTag(imageTag)], { stdio: 'pipe' });
  } catch {
    /* best effort */
  }
}
export async function runImageBootSmoke(options: {
  imageTag?: string;
  skipBuild?: boolean;
}): Promise<ImageBootSmokeArtifact> {
  const started = Date.now();
  const imageTag = options.imageTag ?? DEFAULT_IMAGE_TAG;
  const builtByScript = !options.skipBuild;
  let passed = false;
  let probePayload: InImageProbePayload | undefined;
  let error: string | undefined;
  let snapshotSchemaCount = 0;

  try {
    if (builtByScript) {
      dockerBuild(imageTag);
    }
    probePayload = dockerRunInImageProbe(imageTag);
    assertInImageProbePayload(probePayload);
    snapshotSchemaCount = probePayload.snapshotSchemaCount;
    passed = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if (probePayload) {
      snapshotSchemaCount = probePayload.snapshotSchemaCount;
    }
    passed = false;
  } finally {
    if (builtByScript) {
      dockerRmi(imageTag);
    }
  }

  const outDir = join(process.cwd(), 'artifacts');
  await mkdir(outDir, { recursive: true });
  const artifactPath = join(outDir, `l4-b-image-boot-smoke-${Date.now()}.json`);
  const artifact: ImageBootSmokeArtifact = {
    passed,
    imageTag,
    snapshotSchemaCount,
    elapsedMs: Date.now() - started,
    gitSha: resolveGitSha(),
    probe: 'in-image',
    usedBindMount: false,
    artifactPath,
    probePayload,
    error,
  };
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2));

  return artifact;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  let imageTag = DEFAULT_IMAGE_TAG;
  let skipBuild = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--image-tag' && args[i + 1]) {
      imageTag = args[++i];
    } else if (arg === '--skip-build') {
      skipBuild = true;
    }
  }

  const result = await runImageBootSmoke({ imageTag, skipBuild });
  console.log(
    `Image boot smoke ${result.passed ? 'PASS' : 'FAIL'} probe=${result.probe} → ${result.artifactPath}`,
  );
  if (result.error) console.error(result.error);
  if (!result.passed) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
