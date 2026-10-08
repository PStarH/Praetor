#!/usr/bin/env tsx
/**
 * Deployment & environment integrity verification.
 *
 * Static gate that proves the documented install/deploy paths are internally
 * consistent with the current code. It deliberately does NOT require Docker,
 * Helm, kubectl, or a live cluster, so it can run in CI on every pull request.
 *
 * Checks:
 *   1. Compose build sources   — every `build.dockerfile` exists AND is git-tracked
 *                                (the repo-root Dockerfile is gitignored, so any
 *                                compose service pointing at it cannot build from
 *                                a fresh clone), and every `build.target` exists.
 *   2. Dockerfile closure      — every `pnpm install --filter X` has X's manifest
 *                                copied into the image, and every workspace
 *                                dependency of the built packages is also filtered.
 *                                Catches MODULE_NOT_FOUND / unresolvable workspace
 *                                link failures at image build or container start.
 *   3. Env contract            — variables Compose requires via `${VAR:?...}` are
 *                                present in .env.example, so `cp .env.example .env`
 *                                yields a usable file.
 *   4. Helm chart              — `.Values.*` references resolve, `include` helpers
 *                                are defined, and value overlays add no unknown keys.
 *   5. Health surface          — documented API health routes are actually mounted.
 *   6. Documented scripts      — npm scripts referenced by docs/deploy.md exist.
 *   7. Compose bootability     — every `docker compose ... up` the guide presents
 *                                either wires the api service a DATABASE_URL or
 *                                documents the mandatory-auth failure, since the
 *                                API's auth authorities are PostgreSQL-only.
 *
 * Exit code 0 on success, 1 when any check fails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

interface Finding {
  check: string;
  detail: string;
}

const ROOT = process.cwd();
const findings: Finding[] = [];
const notes: string[] = [];

const fail = (check: string, detail: string) => findings.push({ check, detail });
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => existsSync(path.join(ROOT, p));

function isGitTracked(relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', relPath], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A gitignored path is absent from a fresh clone even though it exists locally,
 * so a bind mount or build source pointing at one cannot work for a new user.
 */
function isGitIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', relPath], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Compose files that form the documented deployment surface. */
function composeFiles(): string[] {
  const found: string[] = [];
  const dirs = ['.', 'deploy/docker', 'deploy/observability'];
  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.yml') || f.endsWith('.yaml')) {
        found.push(path.join(dir, f).replace(/^\.\//, ''));
      }
    }
  }
  return found.sort();
}

/** Resolve workspace package name -> package directory. */
function workspaceNameToDir(): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of ['packages', 'apps']) {
    const groupDir = path.join(ROOT, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const manifest = path.join(group, entry, 'package.json');
      if (!exists(manifest)) continue;
      try {
        const pkg = JSON.parse(read(manifest)) as { name?: string };
        if (pkg.name) map.set(pkg.name, path.join(group, entry));
      } catch {
        /* ignore malformed manifests */
      }
    }
  }
  return map;
}

function loadYaml(file: string): unknown {
  return yaml.load(read(file));
}

// ── Check 1: Compose build sources and targets ───────────────────────────────
function checkComposeBuildSources(): void {
  for (const file of composeFiles()) {
    let doc: {
      services?: Record<
        string,
        { build?: { context?: string; dockerfile?: string; target?: string } }
      >;
    };
    try {
      doc = loadYaml(file) as typeof doc;
    } catch {
      continue; // not a compose document (e.g. prometheus config)
    }
    const services = doc?.services;
    if (!services || typeof services !== 'object') continue;

    for (const [name, svc] of Object.entries(services)) {
      const build = svc?.build;
      if (!build) continue;
      const context = build.context ?? '.';
      const dockerfile = build.dockerfile ?? 'Dockerfile';
      // Compose resolves `context` relative to the compose file's directory and
      // `dockerfile` relative to `context`. Normalise to a repo-root-relative path.
      const rel = path.relative(ROOT, path.resolve(ROOT, path.dirname(file), context, dockerfile));

      if (!exists(rel)) {
        fail('compose-build-source', `${file}: service "${name}" builds ${rel} — file missing`);
        continue;
      }
      if (!isGitTracked(rel)) {
        fail(
          'compose-build-source',
          `${file}: service "${name}" builds ${rel} — not tracked by git, so a fresh clone cannot build it`,
        );
      }
      if (build.target) {
        const df = read(rel);
        const hasTarget = new RegExp(`^\\s*FROM\\s+\\S+\\s+AS\\s+${build.target}\\s*$`, 'im').test(
          df,
        );
        if (!hasTarget) {
          fail(
            'compose-build-target',
            `${file}: service "${name}" targets "${build.target}" — no such stage in ${rel}`,
          );
        }
      }
    }
  }
}

// ── Check 2: Dockerfile workspace closure ────────────────────────────────────
function checkDockerfileClosure(): void {
  const nameToDir = workspaceNameToDir();
  const dirToName = new Map([...nameToDir].map(([n, d]) => [d, n]));

  const dockerfiles = [
    'apps/api/Dockerfile',
    'apps/web/Dockerfile',
    'packages/kernel/Dockerfile.ops',
    'packages/worker-plane/Dockerfile',
    'packages/adapter-ops/Dockerfile.ops',
  ].filter(exists);

  const workspaceDepsOf = (dir: string): string[] => {
    const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as Record<
      string,
      Record<string, string>
    >;
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    return Object.entries(all)
      .filter(([, v]) => typeof v === 'string' && v.startsWith('workspace:'))
      .map(([k]) => k);
  };

  for (const df of dockerfiles) {
    const text = read(df);

    // 2e. an image that copies the kernel's emitted dist must also carry the
    // kernel JSON manifests. The kernel reads them at RUNTIME from its `src`
    // directory (not `dist`), so a dist-only copy yields
    // "ENOENT ... packages/kernel/src/authorityClassifierManifest.v1.json" and a
    // crash-looping worker/adapter-ops. apps/api had this right while
    // worker-plane and adapter-ops did not, and nothing checked it.
    if (
      /COPY\s+\S*\s*\/app\/packages\/kernel\/dist\s/.test(text) &&
      !/COPY\s+\S*\s*\/app\/packages\/kernel\/src\/\*\.json\s/.test(text)
    ) {
      fail(
        'dockerfile-kernel-manifest',
        `${df}: copies packages/kernel/dist but not packages/kernel/src/*.json — the kernel loads those manifests from src at runtime`,
      );
    }

    // Scoped package names contain a slash (e.g. @praetor/contracts).
    const filters = [...text.matchAll(/--filter\s+(@?[A-Za-z0-9_./-]+)/g)].map((m) => m[1]);
    const copiedManifests = new Set(
      [...text.matchAll(/COPY\s+\S*package\.json\s+\.?\/?(.+?)\s*$/gm)]
        .map((m) => m[1].replace(/^\.\//, '').replace(/\/package\.json$/, ''))
        .map((p) => p.replace(/^\.?\//, '')),
    );

    // 2a. every install filter has its manifest copied into the build context
    for (const filter of filters) {
      const dir = nameToDir.get(filter);
      if (!dir) {
        fail(
          'dockerfile-filter-unknown',
          `${df}: --filter ${filter} does not match a workspace package`,
        );
        continue;
      }
      if (!copiedManifests.has(dir) && !copiedManifests.has(`./${dir}`)) {
        fail(
          'dockerfile-manifest-missing',
          `${df}: --filter ${filter} but ${dir}/package.json is never COPYed — pnpm cannot resolve the workspace link`,
        );
      }
    }

    // 2b. every workspace dependency of an installed package is also installed
    const installed = new Set(filters);
    for (const filter of filters) {
      const dir = nameToDir.get(filter);
      if (!dir) continue;
      for (const dep of workspaceDepsOf(dir)) {
        if (!installed.has(dep)) {
          fail(
            'dockerfile-workspace-closure',
            `${df}: ${filter} depends on workspace package ${dep}, but ${dep} is not in the pnpm install filters`,
          );
        }
      }
    }

    // 2c. source trees copied for building should include their manifests
    for (const rawDir of copiedManifests) {
      const dir = rawDir.replace(/^\.\//, '');
      const name = dirToName.get(dir);
      if (!name || !installed.has(name)) continue;
      // Look for a whole-tree COPY, e.g. "COPY packages/kernel ./packages/kernel".
      const treeCopied = text
        .split('\n')
        .some((line) => line.trim().startsWith('COPY ') && line.split(/\s+/)[1] === dir);
      if (!treeCopied) {
        notes.push(
          `${df}: manifest for ${dir} copied but the full source tree may not be (verify manually)`,
        );
      }
    }

    // 2d. workspace packages must be BUILT in dependency order.
    //
    // tsc resolves a sibling workspace package through its emitted `dist`
    // declarations, so a `RUN cd packages/X && tsc --noEmit` that runs before
    // `X`'s workspace dependency has emitted fails with
    // TS2307 "Cannot find module '@praetor/<dep>'". Only the `--filter` set and
    // the manifests were checked before, so packages/worker-plane/Dockerfile
    // built packages/core before packages/postgres-runtime and every image build
    // died — while this gate stayed green.
    //
    // Anchored at column 0 with `cd` directly under RUN so a later `RUN cd` inside
    // a heredoc or a shell loop cannot be mistaken for the build order.
    const buildOrder = [...text.matchAll(/^RUN cd (\S+?)\s*&&/gm)].map((m) => m[1]);
    const positionOf = new Map(buildOrder.map((dir, index) => [dir, index]));
    for (const [dir, index] of positionOf) {
      const pkg = dirToName.get(dir);
      if (!pkg) continue;
      const pkgJsonPath = path.join(dir, 'package.json');
      if (!exists(pkgJsonPath)) continue;
      for (const dep of workspaceDepsOf(dir)) {
        const depDir = nameToDir.get(dep);
        if (!depDir) continue;
        const depIndex = positionOf.get(depDir);
        if (depIndex === undefined || depIndex > index) {
          fail(
            'dockerfile-build-order',
            `${df}: builds ${dir} (position ${index + 1}) before its workspace dependency ${dep} (${depDir}${depIndex === undefined ? ', never built' : `, position ${depIndex + 1}`}) — tsc cannot resolve ${dep} from dist`,
          );
        }
      }
    }
  }
}

// ── Check 2: Compose bind-mount sources ──────────────────────────────────────
/**
 * Every relative bind mount must exist and must not be gitignored. A gitignored
 * mount source (e.g. a directory matched by a broad ignore rule) exists on the
 * author's machine but is missing from a fresh clone, so the profile fails with
 * "bind source path does not exist" for every new user.
 */
function checkComposeBindMounts(): void {
  for (const file of composeFiles()) {
    let doc: { services?: Record<string, { volumes?: unknown[] }> };
    try {
      doc = loadYaml(file) as typeof doc;
    } catch {
      continue;
    }
    const services = doc?.services;
    if (!services || typeof services !== 'object') continue;

    for (const [name, svc] of Object.entries(services)) {
      for (const mount of svc?.volumes ?? []) {
        // Long syntax: { type: bind, source: ./x, target: ... }
        let source: string | undefined;
        if (mount && typeof mount === 'object' && !Array.isArray(mount)) {
          const entry = mount as { type?: string; source?: string };
          if (entry.type === 'bind') source = entry.source;
        } else if (typeof mount === 'string') {
          source = mount.split(':')[0];
        }
        if (!source) continue;
        if (!source.startsWith('./') && !source.startsWith('../')) continue;

        const rel = path.relative(ROOT, path.resolve(ROOT, path.dirname(file), source));
        if (!exists(rel)) {
          fail(
            'compose-bind-source',
            `${file}: service "${name}" mounts ${rel} — source path does not exist`,
          );
          continue;
        }
        if (isGitIgnored(rel)) {
          fail(
            'compose-bind-source',
            `${file}: service "${name}" mounts ${rel} — path is gitignored, so it is absent from a fresh clone`,
          );
        }
      }
    }
  }
}

// ── Check 3: environment variable contract ───────────────────────────────────
function checkEnvContract(): void {
  const envExample = read('.env.example');
  const documented = new Set<string>();
  for (const line of envExample.split('\n')) {
    // Only an uncommented assignment counts as documented. Accepting a commented
    // `# VAR=` line would let a required variable pass the gate while
    // `cp .env.example .env` still produces an unusable file.
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/.exec(line);
    if (m) documented.add(m[1]);
  }

  // Scope: the single-box path a user reaches via `cp .env.example .env`.
  // docker-compose.prod*.yml and deploy/docker/* are operator/bench surfaces whose
  // values (image digests, host TLS paths, externally managed DSNs) are supplied by
  // runbooks and secret managers and must NOT be seeded into .env.example.
  //
  // `docker-compose.kernel-tls.yml` is listed explicitly: the v2/cell profiles
  // reference it as a third `-f` file (not via `include:`), so it is part of the
  // documented path and its required variables must be documented too.
  const inScope = [
    'docker-compose.yml',
    'docker-compose.v2.yml',
    'docker-compose.cell.yml',
    'docker-compose.kernel-tls.yml',
  ];
  const required = new Map<string, string>();
  const visited = new Set<string>();
  const queue = [...inScope];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file) || !exists(file)) continue;
    visited.add(file);
    const text = read(file);
    for (const m of text.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)) {
      if (!required.has(m[1])) required.set(m[1], file);
    }
    // Compose `include:` is rejected by `docker compose up` for these profiles
    // ("services.<name> conflicts with imported resource") even though `config`
    // accepts it, so keep it out of the kernel-on fragments entirely.
    if (/^include:/m.test(text)) {
      fail(
        'compose-include',
        `${file} uses compose \`include:\`, which \`docker compose up\` rejects with "services.<name> conflicts with imported resource" — pass the fragment as an explicit third -f file instead`,
      );
    }
    // Defensive: follow includes anyway if one is ever reintroduced.
    for (const m of text.matchAll(/^ {2}-\s+(\S+\.ya?ml)\s*$/gm)) {
      const included = path
        .relative(ROOT, path.resolve(ROOT, path.dirname(file), m[1].replace(/^\.\//, '')))
        .split(path.sep)
        .join('/');
      if (!visited.has(included)) queue.push(included);
    }
  }

  for (const [v, file] of required) {
    if (!documented.has(v)) {
      fail(
        'env-contract',
        `${file} requires ${v} via \${${v}:?...} but .env.example never documents it — \`cp .env.example .env\` produces an unusable file`,
      );
    }
  }
}

// ── Check 4: Helm chart integrity ────────────────────────────────────────────
function checkHelmChart(): void {
  const chartDir = 'deploy/helm/commander';
  if (!exists(chartDir)) return;
  const templatesDir = path.join(chartDir, 'templates');

  const valuesFile = path.join(chartDir, 'values.yaml');
  let values: Record<string, unknown>;
  try {
    values = yaml.load(read(valuesFile)) as Record<string, unknown>;
  } catch {
    fail('helm-values', `${valuesFile} is not valid YAML`);
    return;
  }

  const resolve = (keys: string[]): boolean => {
    let cur: unknown = values;
    for (const k of keys) {
      if (cur == null || typeof cur !== 'object' || !(k in (cur as Record<string, unknown>)))
        return false;
      cur = (cur as Record<string, unknown>)[k];
    }
    return true;
  };

  const templateFiles = readdirSync(path.join(ROOT, templatesDir)).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.tpl'),
  );

  // 4a. .Values.* references resolve against values.yaml
  for (const f of templateFiles) {
    const text = read(path.join(templatesDir, f));
    for (const m of text.matchAll(/\.Values\.([A-Za-z0-9_.]+)/g)) {
      if (!resolve(m[1].split('.'))) {
        fail(
          'helm-values-ref',
          `${chartDir}/templates/${f}: .Values.${m[1]} is not defined in values.yaml`,
        );
      }
    }
  }

  // 4b. every included helper is defined somewhere in the chart
  const defined = new Set<string>();
  for (const f of templateFiles) {
    const text = read(path.join(templatesDir, f));
    for (const m of text.matchAll(/\{\{-\s*define\s+"([^"]+)"/g)) defined.add(m[1]);
  }
  for (const f of templateFiles) {
    const text = read(path.join(templatesDir, f));
    for (const m of text.matchAll(/include\s+"([^"]+)"/g)) {
      if (!defined.has(m[1])) {
        fail('helm-helper', `${chartDir}/templates/${f}: include "${m[1]}" has no matching define`);
      }
    }
  }

  // 4c. value overlays must not invent keys
  const flatKeys = (o: unknown, prefix = ''): string[] => {
    if (o == null || typeof o !== 'object' || Array.isArray(o)) return prefix ? [prefix] : [];
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      flatKeys(v, prefix ? `${prefix}.${k}` : k),
    );
  };
  const baseKeys = new Set(flatKeys(values));
  for (const overlay of ['values-demo.yaml', 'values-enterprise.yaml']) {
    const p = path.join(chartDir, overlay);
    if (!exists(p)) continue;
    let ov: unknown;
    try {
      ov = yaml.load(read(p));
    } catch {
      fail('helm-overlay', `${p} is not valid YAML`);
      continue;
    }
    for (const k of flatKeys(ov)) {
      if (!baseKeys.has(k)) fail('helm-overlay', `${p}: key "${k}" does not exist in values.yaml`);
    }
  }

  // 4d. values.schema.json is parseable and its required keys exist
  const schemaPath = path.join(chartDir, 'values.schema.json');
  if (exists(schemaPath)) {
    try {
      const schema = JSON.parse(read(schemaPath)) as { required?: string[] };
      for (const req of schema.required ?? []) {
        if (!(req in values))
          fail('helm-schema', `${schemaPath} requires "${req}" which is absent from values.yaml`);
      }
    } catch {
      fail('helm-schema', `${schemaPath} is not valid JSON`);
    }
  }
}

// ── Check 5: documented health routes are mounted ────────────────────────────
function checkHealthRoutes(): void {
  const entry = 'apps/api/src/index.ts';
  if (!exists(entry)) return;
  const text = read(entry);
  const required = [
    '/health',
    '/ready',
    '/health/detailed',
    '/v1/health',
    '/metrics',
    '/system/status',
  ];
  for (const route of required) {
    if (!text.includes(`app.get('${route}'`)) {
      fail('health-route', `${entry}: documented route ${route} is not mounted`);
    }
  }
  // Documented as intentionally absent.
  for (const absent of ['/readyz', '/livez']) {
    if (text.includes(`app.get('${absent}'`)) {
      fail('health-route', `${entry}: ${absent} is mounted but docs state it must not exist`);
    }
  }
}

// ── Check 6: npm scripts referenced by the deployment guide ──────────────────
function checkDocumentedScripts(): void {
  if (!exists('docs/deploy.md') || !exists('package.json')) return;
  const deployDoc = read('docs/deploy.md');
  const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};

  // Backticked entries in the "required integration-owner package script entries"
  // list of docs/deploy.md.
  const referenced = new Set<string>();
  for (const m of deployDoc.matchAll(/`(helm:[a-z0-9:-]+|test:helm:lifecycle:[a-z]+)`/g)) {
    referenced.add(m[1]);
  }
  for (const script of referenced) {
    if (!(script in scripts)) {
      fail(
        'documented-script',
        `docs/deploy.md requires npm script "${script}" but package.json does not define it`,
      );
    }
  }
}

// ── Check 7: documented compose paths can satisfy the mandatory auth DSN ─────
/**
 * The API's five authentication authorities are PostgreSQL-only with no
 * fallback (`apps/api/src/authDb.ts` throws `AUTH_DATABASE_URL_REQUIRED`), so a
 * compose invocation that starts `api` without a DSN cannot boot. That was a
 * real defect: `docs/deploy.md` advertised a bare `docker compose up` as a
 * working local-first stack while the base file injects no DSN, so the
 * container exited during startup and no CI job ever noticed.
 *
 * This check parses every `docker compose ... up` invocation in the guide,
 * merges the compose files it loads, and requires that either
 *   (a) the merged `api` service receives a DATABASE_URL, or
 *   (b) the guide documents the `AUTH_DATABASE_URL_REQUIRED` failure for it.
 */
function mergeYaml(base: unknown, over: unknown): unknown {
  const isMap = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isMap(base) || !isMap(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isMap(v) && isMap(out[k]) ? mergeYaml(out[k], v) : v;
  }
  return out;
}

function checkDocumentedComposeBootability(): void {
  if (!exists('docs/deploy.md')) return;
  const authDb = exists('apps/api/src/authDb.ts') ? read('apps/api/src/authDb.ts') : '';
  if (!authDb.includes('AUTH_DATABASE_URL_REQUIRED')) return; // requirement gone; check obsolete

  const guide = read('docs/deploy.md');

  for (const block of guide.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const cmd = line.replace(/^\s*#.*/, '').trim();
      if (!/^docker compose\b/.test(cmd)) continue;
      // Only `up` starts a deployment; `down`/`build`/`config` are not paths.
      if (!/\bup\b/.test(cmd)) continue;

      const files = [...cmd.matchAll(/-f\s+(\S+)/g)].map((m) => m[1]);
      if (files.length === 0) files.push('docker-compose.yml');

      let merged: unknown;
      for (const f of files) {
        if (!exists(f)) {
          fail('compose-bootability', `docs/deploy.md runs \`${cmd}\` but ${f} does not exist`);
          merged = undefined;
          break;
        }
        merged = merged ? mergeYaml(merged, loadYaml(f)) : loadYaml(f);
      }
      if (merged === undefined) continue;

      const api = (merged as { services?: Record<string, { environment?: unknown }> }).services
        ?.api;
      if (!api) continue;

      const env = api.environment;
      const keys = Array.isArray(env)
        ? env.map((e) => String(e).split('=')[0])
        : Object.keys((env as Record<string, unknown>) ?? {});

      if (!keys.includes('DATABASE_URL')) {
        if (!guide.includes('AUTH_DATABASE_URL_REQUIRED')) {
          fail(
            'compose-bootability',
            `docs/deploy.md presents \`${cmd}\` as a deployment, but the merged api service gets no ` +
              `DATABASE_URL and the API fails closed with AUTH_DATABASE_URL_REQUIRED. Either wire a ` +
              `DSN (as v2/cell do) or document the failure.`,
          );
        }
      }
    }
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────
const checks: Array<[string, () => void]> = [
  ['compose build sources & targets', checkComposeBuildSources],
  ['compose bind-mount sources', checkComposeBindMounts],
  ['Dockerfile workspace closure', checkDockerfileClosure],
  ['environment variable contract', checkEnvContract],
  ['Helm chart integrity', checkHelmChart],
  ['documented health routes', checkHealthRoutes],
  ['documented npm scripts', checkDocumentedScripts],
  ['documented compose bootability', checkDocumentedComposeBootability],
];

let crashed = 0;
for (const [label, fn] of checks) {
  const before = findings.length;
  try {
    fn();
  } catch (err) {
    crashed++;
    fail(label, `check threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  const delta = findings.length - before;
  process.stdout.write(`${delta === 0 ? 'ok  ' : 'FAIL'}  ${label}${delta ? ` (${delta})` : ''}\n`);
}

if (notes.length) {
  process.stdout.write('\nnotes:\n');
  for (const n of notes) process.stdout.write(`  - ${n}\n`);
}

if (findings.length) {
  process.stderr.write(`\ndeployment integrity: ${findings.length} finding(s)\n\n`);
  for (const f of findings) process.stderr.write(`  [${f.check}] ${f.detail}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `\ndeployment integrity: OK (${checks.length} checks${crashed ? `, ${crashed} crashed` : ''})\n`,
  );
}
