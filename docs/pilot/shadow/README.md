# Commander Shadow Pilot: Phase A

This pack supports a customer-cloud, historical evaluation of one workflow:
`kubernetes.deployment.rollback`. It compares a declared historical sample with
Commander's pinned policy result. It does not place Commander in the request
path and it does not execute, queue, authorize, or recover a rollback.

Phase A uses the customer-operated PostgreSQL evidence store. Results describe
only the declared historical sample and do not describe unsampled activity or
rollback outcomes.

The charter assigns named owners for the policy, sample, retention, deletion,
export, usefulness review, mismatch adjudication, and stop conditions.

## Clean-room prerequisites

Use Node.js 22, pnpm 9, the three release tarballs listed below, a customer
PostgreSQL 16 database with the trusted `pgcrypto` extension available, and `psql`. The release owner supplies the tarballs from
the same revision, plus its full Git SHA. Place them in an empty directory and
install with local overrides so workspace packages do not require a registry:

```sh
corepack enable
pnpm init
npm pkg set 'pnpm.overrides.@praetor/contracts=file:./commander-contracts-0.2.0.tgz'
npm pkg set 'pnpm.overrides.@praetor/postgres-runtime=file:./commander-postgres-runtime-0.2.0.tgz'
pnpm add ./commander-shadow-plane-0.1.0.tgz ./commander-postgres-runtime-0.2.0.tgz pg@8.22.0
```

A database administrator creates one installer, three non-login capability roles,
and three tenant-scoped login roles. The example names bind `tenant-1`; use a
separate set of login roles for every additional tenant in the same schema.
Substitute secrets through the customer's secret manager rather than placing
them in shell history. The database named `shadow_database` must already exist.

```sql
\prompt 'installer password: ' installer_password
\prompt 'ingestion password: ' ingestion_password
\prompt 'reader password: ' reader_password
\prompt 'retention password: ' retention_password
CREATE ROLE commander_shadow_installer LOGIN PASSWORD :'installer_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commander_shadow_ingestion NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commander_shadow_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commander_shadow_retention NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commander_shadow_tenant_1_ingestion LOGIN PASSWORD :'ingestion_password' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE commander_shadow_ingestion;
CREATE ROLE commander_shadow_tenant_1_reader LOGIN PASSWORD :'reader_password' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE commander_shadow_reader;
CREATE ROLE commander_shadow_tenant_1_retention LOGIN PASSWORD :'retention_password' NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS IN ROLE commander_shadow_retention;
GRANT CREATE ON DATABASE shadow_database TO commander_shadow_installer;
-- CONNECT is granted explicitly and is NOT optional. A hardened database revokes
-- CONNECT from PUBLIC, and without this grant every pilot role fails at connect
-- with `permission denied for database "shadow_database"` (detail: "User does not
-- have CONNECT privilege") before any schema statement runs. This repository's own
-- development database is configured that way, which is how the gap was found.
GRANT CONNECT ON DATABASE shadow_database TO
  commander_shadow_installer,
  commander_shadow_tenant_1_ingestion,
  commander_shadow_tenant_1_reader,
  commander_shadow_tenant_1_retention;
```

Export the shipped schema without modifying it, then apply it once with the
installer DSN. `SHADOW_SCHEMA_SQL` is the package's supported schema artifact.
Schema version 3 requires a fresh dedicated database where `pgcrypto` is not
already installed. The installer creates it in the locked `commander_shadow`
schema; installation fails rather than reusing an extension from another schema.
There is no migration or unauthenticated legacy write API.

```sh
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { SHADOW_SCHEMA_SQL } from '@praetor/shadow-plane';
writeFileSync('shadow-schema.sql', SHADOW_SCHEMA_SQL, { mode: 0o600 });
JS
psql "$SHADOW_INSTALLER_URL" -v ON_ERROR_STOP=1 -f shadow-schema.sql
psql "$SHADOW_INSTALLER_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO commander_shadow.tenant_role_bindings (role_name, tenant_id)
VALUES
  ('commander_shadow_tenant_1_ingestion', 'tenant-1'),
  ('commander_shadow_tenant_1_reader', 'tenant-1'),
  ('commander_shadow_tenant_1_retention', 'tenant-1');
SQL
```

The binding table is installer-owned. Forced row-level security requires both
the login-role binding and the transaction-local tenant selected by the CLI;
missing or mismatched bindings fail closed. Runtime roles have no direct access
to the binding table.

Provision a separate random 32-byte HMAC key for each ingestion login through
the customer's secret manager, independently of its database password and the
manifest/report signing keys. Deliver the lowercase 64-character hex value only
to the ingestion CLI as `COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX` and to
the installer for the following parameterized provisioning command. Do not
grant runtime roles access to the key table or installer credentials.

```sh
node --input-type=module <<'JS'
import { Pool } from 'pg';
import { buildVerifiedPostgresPoolConfig } from '@praetor/postgres-runtime';
const hex = process.env.COMMANDER_SHADOW_INGESTION_ATTESTATION_KEY_HEX;
if (!/^[0-9a-f]{64}$/.test(hex ?? '')) throw new Error('Invalid ingestion key');
const pool = new Pool(buildVerifiedPostgresPoolConfig({ connectionString: process.env.SHADOW_INSTALLER_URL }));
try {
  await pool.query(
    'INSERT INTO commander_shadow.ingestion_attestation_keys (role_name, key_bytes) VALUES ($1, $2)',
    ['commander_shadow_tenant_1_ingestion', Buffer.from(hex, 'hex')],
  );
} finally {
  await pool.end();
}
JS
```

Use the verified installer TLS configuration described below for this command.
Protect the key from SQL statement/parameter logging and process-environment
collection. Reader and retention processes do not need this key. An ingestion
database password alone cannot attest manifests, evaluations, or rejected/failed
attempts. Proofs bind the exact login, tenant, operation, and all effective write
parameters. Rotate the database key and application secret together while
ingestion is stopped; this invalidates old proofs. Database administrators and
holders of both secrets remain trusted authorities.

## TLS and configuration

Use the three tenant-scoped logins in distinct verified `sslmode=verify-full`
DSNs named `SHADOW_INGESTION_URL`, `SHADOW_READER_URL`, and
`SHADOW_RETENTION_URL`. Save the database CA chain in a mode-0600 file. Pin the
expected server SPKI from a separately authenticated certificate:

```sh
export COMMANDER_DATABASE_TLS_CA_FILE=/secure/path/database-ca.pem
export COMMANDER_DATABASE_TLS_EXPECTED_SERVER_SPKI_SHA256="$(openssl x509 -in /secure/path/server.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)"
```

Provision separate Ed25519 manifest and report keys through the customer's key
manager. For a file-based evaluation, generate them in an existing protected
directory with `umask 077` and `openssl genpkey -algorithm ED25519 -out KEY_FILE`.
Use those two distinct files at the paths below. Set the source revision to the
full SHA supplied with the release, and obtain the installer and runtime DSNs
from the database administrator. Their format is
`postgres://LOGIN:PERCENT_ENCODED_PASSWORD@DNS_NAME:5432/shadow_database?sslmode=verify-full`.
For the `psql` setup commands, set `PGSSLROOTCERT` to the same verified CA file;
`psql` performs hostname and CA validation but does not consume the Node SPKI setting.

Every database-backed command loads the common tenant, TLS, trust, retention,
and cleanup configuration below. Only `report export` requires the report
private key and source revision. Withdrawal and retention do not require export
credentials, so the deletion owner can act independently. The
manifest trust value is an exact JSON array of Ed25519 trust records. Keep an
identical independently distributed copy in `manifest-trust.json` for offline
report verification.

```sh
export COMMANDER_SHADOW_TENANT_ID=tenant-1
export COMMANDER_SHADOW_RETENTION_DAYS=14
export COMMANDER_SHADOW_CLEANUP_FRESHNESS_MINUTES=90
export COMMANDER_SHADOW_SOURCE_REVISION=0123456789abcdef0123456789abcdef01234567
export SHADOW_MANIFEST_PRIVATE_KEY_FILE=/secure/path/manifest-key.pk8.pem
export COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON="$(node --input-type=module <<'JS'
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
const publicKeyPem = createPublicKey(createPrivateKey(
  readFileSync(process.env.SHADOW_MANIFEST_PRIVATE_KEY_FILE),
)).export({ format: 'pem', type: 'spki' }).toString();
process.stdout.write(JSON.stringify([{
  algorithm: 'Ed25519', keyId: 'manifest-key-1', status: 'active', publicKeyPem,
}]));
JS
)"
export COMMANDER_SHADOW_REPORT_SIGNING_KEY_ID=report-key-1
export SHADOW_REPORT_PRIVATE_KEY_FILE=/secure/path/report-key.pk8.pem
export COMMANDER_SHADOW_REPORT_SIGNING_PRIVATE_KEY_PEM="$(cat "$SHADOW_REPORT_PRIVATE_KEY_FILE")"
printf '%s\n' "$COMMANDER_SHADOW_TRUSTED_MANIFEST_KEYS_JSON" > manifest-trust.json
chmod 600 manifest-trust.json
node --input-type=module <<'JS'
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const publicKeyPem = createPublicKey(createPrivateKey(
  readFileSync(process.env.SHADOW_REPORT_PRIVATE_KEY_FILE),
)).export({ format: 'pem', type: 'spki' }).toString();
writeFileSync('report-trust.json', `${JSON.stringify({
  schema: 'commander.shadow-report-trust/v1',
  algorithm: 'Ed25519', keyId: 'report-key-1', status: 'active', publicKeyPem,
})}\n`, { mode: 0o600 });
JS
```

`COMMANDER_SHADOW_DATABASE_URL` is set per command to the least-privileged DSN.
The report verifier is offline and does not read these database settings.

## Policy pin and signed manifest

Retrieve the exact policy identity and digest from the installed package and
record both in the approved charter:

```sh
node --input-type=module <<'JS'
import { actionGatewayPolicySnapshot } from '@praetor/shadow-plane';
process.stdout.write(`${JSON.stringify(actionGatewayPolicySnapshot(), null, 2)}\n`);
JS
```

Prepare `observations.ndjson` using only the fields in
[the approved data boundary](data-boundary.md). Generate the manifest from those
exact canonical records. `SHADOW_CLOSES_AT` must be a future canonical UTC
timestamp and the manifest private key must correspond to `manifest-key-1`.

Use [example-observations.ndjson](example-observations.ndjson) for an installation
rehearsal only. Its two synthetic records exercise `require_approval` and
`insufficient_evidence`; they are not customer evidence. Keep rehearsal and
customer campaigns separate. For the customer run, the approved producer exports
the declared historical sample and retains the pseudonym mapping locally.

```sh
export SHADOW_CLOSES_AT="$(node -e 'process.stdout.write(new Date(Date.now() + 15 * 60_000).toISOString())')"
node --input-type=module <<'JS'
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  actionGatewayPolicySnapshot,
  canonicalBytes,
  observationDigest,
  parseShadowObservation,
} from '@praetor/shadow-plane';

const observations = readFileSync('observations.ndjson', 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => parseShadowObservation(JSON.parse(line)));
if (observations.length === 0) throw new Error('at least one observation is required');
const first = observations[0];
if (!observations.every((value, index) =>
  value.index === index &&
  value.campaignId === first.campaignId &&
  value.tenantId === first.tenantId &&
  value.producerId === first.producerId &&
  value.batchId === first.batchId)) throw new Error('observation bindings are inconsistent');
const policy = actionGatewayPolicySnapshot();
const unsigned = {
  schema: 'commander.shadow-manifest/v1',
  campaignId: first.campaignId,
  tenantId: first.tenantId,
  producerId: first.producerId,
  policyId: policy.policyId,
  policyDigest: policy.descriptorDigest,
  batchId: first.batchId,
  closesAt: process.env.SHADOW_CLOSES_AT,
  records: observations.map((value) => ({
    index: value.index,
    observationId: value.observationId,
    digest: observationDigest(value),
  })),
  keyId: 'manifest-key-1',
};
const privateKey = createPrivateKey(readFileSync(process.env.SHADOW_MANIFEST_PRIVATE_KEY_FILE));
const signature = sign(null, canonicalBytes(unsigned), privateKey).toString('base64url');
writeFileSync('manifest.json', `${JSON.stringify({ ...unsigned, signature })}\n`, { mode: 0o600 });
JS
```

## Historical evaluation commands

Initialize cleanup readiness, register and import the sample, and close the
batch only after its signed `closesAt` deadline. Replace identifiers with the
values in the signed manifest.
The example deadline is 15 minutes after manifest creation; choose the actual
admission window before signing. Run `batch close` only after that deadline.
The customer-operated scheduler must run `retention run` more often than the
configured 90-minute freshness bound; run it again before closing/exporting if
the initial cleanup is stale. Commander does not start a scheduler or listener.

```sh
COMMANDER_SHADOW_DATABASE_URL="$SHADOW_RETENTION_URL" pnpm exec commander-shadow retention run
COMMANDER_SHADOW_DATABASE_URL="$SHADOW_INGESTION_URL" pnpm exec commander-shadow manifest register --file manifest.json
COMMANDER_SHADOW_DATABASE_URL="$SHADOW_INGESTION_URL" pnpm exec commander-shadow import --file observations.ndjson
COMMANDER_SHADOW_DATABASE_URL="$SHADOW_INGESTION_URL" pnpm exec commander-shadow batch close --campaign campaign-2026q4 --batch batch-001
COMMANDER_SHADOW_DATABASE_URL="$SHADOW_READER_URL" pnpm exec commander-shadow report export --campaign campaign-2026q4 --output report.json
pnpm exec commander-shadow report verify --bundle report.json --public-key report-trust.json --manifest-keys manifest-trust.json
COMMANDER_SHADOW_DATABASE_URL="$SHADOW_RETENTION_URL" pnpm exec commander-shadow campaign withdraw --campaign campaign-2026q4 --confirm campaign-2026q4
COMMANDER_SHADOW_DATABASE_URL="$SHADOW_INGESTION_URL" pnpm exec commander-shadow status
```

The command forms are:

- `manifest register --file`
- `import --file`
- `batch close --campaign --batch`
- `report export --campaign --output`
- `report verify --bundle --public-key --manifest-keys`
- `campaign withdraw --campaign --confirm`
- `retention run`
- `status`

`report-trust.json` has exact fields `schema`, `algorithm`, `keyId`, `status`,
and `publicKeyPem`; its schema is `commander.shadow-report-trust/v1`. Manifest
trust records have exact fields `algorithm`, `keyId`, `status`, and
`publicKeyPem`. Both trust sets come through the customer's agreed key-management
process separately from the report. `status` checks database, role, schema, and
cleanup readiness only; it does not count campaigns.

Read the remaining materials in order: [Invitation](invitation.md),
[Pilot charter](pilot-charter.md), [Approved data boundary](data-boundary.md),
[Historical evaluation](historical-evaluation.md), [Security
architecture](security-architecture.md), and [Retention, withdrawal, and
teardown](retention-withdrawal-teardown.md).

Legal/DPA review is an external review owned by the customer and its counsel;
this repository does not supply a DPA or legal advice.
