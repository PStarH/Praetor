import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Task 1 deployment closure', () => {
  it('declares the contracts dependency in effect-broker metadata and lockfile', () => {
    const pkg = JSON.parse(read('packages/effect-broker/package.json')) as {
      dependencies?: Record<string, string>;
    };
    assert.equal(pkg.dependencies?.['@praetor/contracts'], 'workspace:*');
    assert.match(
      read('pnpm-lock.yaml'),
      /packages\/effect-broker:[\s\S]*?dependencies:[\s\S]*?'@(commander|praetor)\/contracts':[\s\S]*?link:\.\.\/contracts/,
    );
  });

  it('keeps root, v2, and benchmark compose variants on five separate runtime DSNs', () => {
    for (const file of [
      'docker-compose.yml',
      'docker-compose.v2.yml',
      'deploy/docker/v2-compose.yml',
    ]) {
      const yaml = read(file);
      assert.match(yaml, /adapter-ops:/, `${file}: adapter-ops service missing`);
      assert.match(yaml, /commander_adapter_ops/, `${file}: fifth adapter-ops DSN missing`);
      assert.match(yaml, /COMMANDER_ADAPTER_OPS_INSTANCE_ID/, `${file}: instance id missing`);
      assert.match(
        yaml,
        /COMMANDER_ADAPTER_OPS_CLAIM_SECRET_DIR/,
        `${file}: claim secret dir missing`,
      );
      assert.match(yaml, /adapter-ops-claim-secrets/, `${file}: claim secret volume missing`);
      assert.match(yaml, /COMMANDER_CELL_TENANT_ID/, `${file}: explicit cell tenant missing`);
      assert.match(
        yaml,
        /COMMANDER_ADAPTER_EGRESS_ALLOWLIST/,
        `${file}: secure egress allowlist missing`,
      );
    }
  });

  it('makes the Compose claim-secret mountpoint writable by the non-root runtime user', () => {
    const dockerfile = read('packages/adapter-ops/Dockerfile.ops');
    assert.match(
      dockerfile,
      /mkdir -p \/var\/run\/commander\/adapter-ops[\s\S]*chown -R commander:commander \/var\/run\/commander\/adapter-ops[\s\S]*USER commander/,
    );
  });

  it('builds the PostgreSQL runtime before its core package consumer', () => {
    const dockerfile = read('apps/api/Dockerfile');
    const postgresRuntimeBuild = dockerfile.indexOf('RUN cd packages/postgres-runtime');
    const coreBuild = dockerfile.indexOf('RUN cd packages/core');
    assert.notEqual(postgresRuntimeBuild, -1, 'postgres-runtime build step missing');
    assert.notEqual(coreBuild, -1, 'core build step missing');
    assert.ok(postgresRuntimeBuild < coreBuild, 'postgres-runtime must be built before core');
  });

  it('makes COMMANDER_SOURCE_REVISION optional for ordinary API builds but validates supplied revisions', () => {
    const dockerfile = read('apps/api/Dockerfile');
    assert.match(dockerfile, /ARG COMMANDER_SOURCE_REVISION/);
    assert.match(dockerfile, /if \[ -n "\$COMMANDER_SOURCE_REVISION" \]; then/);
    assert.match(dockerfile, /case "\$COMMANDER_SOURCE_REVISION" in/);
    assert.match(dockerfile, /\[ "\$\{#COMMANDER_SOURCE_REVISION\}" -eq 40 \]/);
    assert.match(dockerfile, /\*\[!0-9a-f\]\*/);
    assert.doesNotMatch(dockerfile, /RUN test -n "\$COMMANDER_SOURCE_REVISION"/);
    for (const file of [
      'docker-compose.yml',
      'docker-compose.v2.yml',
      '.github/workflows/cd.yml',
      'scripts/deploy.sh',
      'scripts/deploy-vm.sh',
    ]) {
      assert.doesNotMatch(
        read(file),
        /COMMANDER_SOURCE_REVISION/,
        file + ': build arg should remain caller-optional',
      );
    }
  });

  it('packages every checksum-pinned kernel manifest used by the production image', () => {
    const dockerfile = read('apps/api/Dockerfile');
    const lifecycle = read('packages/kernel/src/task1LifecycleInitialize.ts');
    assert.match(
      dockerfile,
      /COPY --from=build \/app\/packages\/kernel\/src\/\*\.json \.\/packages\/kernel\/src\//,
    );
    for (const manifest of [
      'task1HistoricalBaselineManifestSource.v1.json',
      'task1HardenedBaselineManifestSource.v1.json',
      'task1LifecyclePostconditionManifest.v1.json',
    ]) {
      assert.match(lifecycle, new RegExp(`'\\.\\./src/${manifest.replaceAll('.', '\\.')}'`));
    }
  });

  it('excludes incremental compiler state from clean image builds', () => {
    assert.match(read('.dockerignore'), /^\*\*\/\*\.tsbuildinfo$/m);
  });

  it('keeps Helm values, schema, and comments aligned with six identities', () => {
    const values = read('deploy/helm/commander/values.yaml');
    const enterpriseValues = read('deploy/helm/commander/values-enterprise.yaml');
    const schema = read('deploy/helm/commander/values.schema.json');
    assert.match(values, /Six distinct DSN secret keys/i);
    assert.doesNotMatch(values, /fixed daemon worker ids|Multi-replica needs POD_NAME/i);
    assert.match(schema, /"adapterOpsSecretKey"/);
    assert.match(schema, /"tenantAuthoritySecretKey"/);
    assert.match(schema, /"claimSecretDir"/);
    assert.match(schema, /"replicas"/);
    assert.match(
      read('deploy/helm/commander/templates/_helpers.tpl'),
      /enterprise tier requires adapterOps\.egress\.allowlist/i,
    );
    assert.match(enterpriseValues, /adapterOps:[\s\S]*?replicas:\s*2\b/);
    assert.match(enterpriseValues, /allowlist:\s*\n\s*-\s*api\.github\.com/i);
  });

  it('bootstraps the adapter-ops LOGIN before migrations on populated-volume upgrades', () => {
    const migrate = read('packages/kernel/src/migrate.ts');
    assert.match(migrate, /ensureAdapterOpsLogin/);
    assert.match(migrate, /COMMANDER_ADAPTER_OPS_DATABASE_URL/);
    for (const file of [
      'docker-compose.yml',
      'docker-compose.cell.yml',
      'deploy/docker/v2-compose.yml',
    ]) {
      assert.match(
        read(file),
        /COMMANDER_ADAPTER_OPS_PASSWORD/,
        `${file}: migration path missing adapter-ops password`,
      );
    }
    const migrationJob = read('deploy/helm/commander/templates/migration-job.yaml');
    assert.match(migrationJob, /"ADAPTER_OPS" \(include "commander\.databaseAdapterOpsSecretKey"/);
    assert.match(migrationJob, /name: COMMANDER_\{\{ \$name \}\}_DATABASE_URL/);
    assert.equal(
      (migrationJob.match(/name: COMMANDER_\{\{ \$name \}\}_DATABASE_URL/g) ?? []).length,
      1,
      'the adapter-ops DSN must be emitted once by the role range, not duplicated',
    );
    assert.match(migrationJob, /commander\.databaseAdapterOpsSecretKey/);
    assert.doesNotMatch(
      migrationJob,
      /key:\s*adapter-ops-password/,
      'external database secrets promise DSNs, not a raw password key',
    );
  });

  it('keeps Task 1 static and live PostgreSQL gates in maintained commands', () => {
    const rootPackage = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const kernelPackage = JSON.parse(read('packages/kernel/package.json')) as {
      scripts: Record<string, string>;
    };
    const contractsPackage = JSON.parse(read('packages/contracts/package.json')) as {
      scripts: Record<string, string>;
    };

    assert.match(kernelPackage.scripts.test, /task1Authority\.test\.ts/);
    assert.match(contractsPackage.scripts.test, /effectClassification\.test\.ts/);
    assert.match(kernelPackage.scripts['test:task1:postgres'] ?? '', /COMMANDER_TASK1_PG_URL/);
    assert.match(kernelPackage.scripts['test:task1:postgres'] ?? '', /process\.exit\(1\)/);
    assert.match(
      kernelPackage.scripts['test:task1:postgres'] ?? '',
      /task1\.migration-live\.test\.ts/,
    );
    assert.match(
      kernelPackage.scripts['test:task1:postgres'] ?? '',
      /task1\.postgres-live\.test\.ts/,
    );
    assert.match(rootPackage.scripts['test:task1:unit'] ?? '', /task1-deploy-closure\.test\.ts/);
    assert.match(
      rootPackage.scripts['test:task1:unit'] ?? '',
      /task1ComposeProofRuntime\.test\.ts/,
    );
    assert.match(rootPackage.scripts['test:task1:unit'] ?? '', /helm-tenant-cutover\.test\.ts/);
    assert.match(rootPackage.scripts['test:task1:unit'] ?? '', /helm-release-projection\.test\.ts/);
    assert.match(
      rootPackage.scripts['test:task1:unit'] ?? '',
      /helm-recover-tenant-authority\.test\.ts/,
    );
    assert.match(rootPackage.scripts['test:task1'] ?? '', /test:task1:prerequisites/);
    assert.match(rootPackage.scripts['test:task1'] ?? '', /test:helm:lifecycle:static/);
    assert.match(rootPackage.scripts['test:task1'] ?? '', /test:task1:postgres/);
    assert.match(rootPackage.scripts['test:deploy-gates'], /test:task1/);
  });
});
