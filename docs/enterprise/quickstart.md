# Enterprise Pilot Quickstart

For governed external actions, start with the [GitHub pilot](../pilot/github/README.md)
(same-repository PR creation with approval and response-loss recovery).
For historical observation evaluation without external writes, see [Shadow Pilot Phase A](../pilot/shadow/README.md).
The live-write procedure below is a gated engineering reference for Kubernetes rollback;
live Kubernetes rollback remains frozen. Shared multi-tenant hosting remains alpha.

## Future live-write acceptance target

Before this workflow can be offered, release-specific evidence must demonstrate
that one Kubernetes `Deployment` rollback can be proposed
by an external Agent Runtime, approved by a named operator, recovered after a
process failure, reconciled without a second write, and closed with an
independently verifiable receipt.

The Web workflow editor is a preview tool. `POST /api/workflows/:id/execute`
returns an ordered pipeline; it does not perform an external write. Consequential
work must use the Action Gateway (`/v1/actions`) or its MCP surface.

## Prerequisites

- Node 22, pnpm 9, Docker, `kind`, `kubectl`, `curl`, and PostgreSQL client tools.
- A dedicated sandbox Kubernetes namespace and a named approver/escalation owner.
- A Commander API key scoped to the pilot tenant.
- A provider key supplied only at runtime. Never commit it or put it in an
  acceptance artifact.

The exact Postgres roles, TLS requirements, evidence keys, and Kind image are in
[`ci-handoff-cd.md`](../runbooks/ci-handoff-cd.md). A missing prerequisite is a
failed preflight, not permission to substitute a fake external system.

## 1. Start the dedicated stack

Use the repository's V2 compose topology for technical acceptance. The following
creates ephemeral local-only authority and signing keys, then sets the API
credentials the compose file requires. Do not use this key-generation path for
production; load the same variables from a secret manager instead.

```bash
export COMMANDER_MASTER_KEY="$(openssl rand -hex 32)"
export JWT_SECRET="$(openssl rand -hex 32)"
export COMMANDER_API_KEY="$(openssl rand -hex 32)"
export COMMANDER_CAPABILITY_TOKEN_KEY="$(openssl rand -hex 32)"
export COMMANDER_INTEGRITY_KEY="$(openssl rand -hex 32)"
export COMMANDER_AUDIT_CHAIN_KEY="$(openssl rand -hex 32)"
export COMMANDER_TENANT_ID="pilot-tenant"
export COMMANDER_WORKER_TENANTS="$COMMANDER_TENANT_ID"
export COMMANDER_KUBERNETES_PROOF_NAMESPACE="${COMMANDER_KUBERNETES_PROOF_NAMESPACE:-commander-rollback-proof}"
export COMMANDER_CAPABILITY_KEY_ID="pilot-capability-$(date -u +%Y%m%d%H%M%S)"
export COMMANDER_EVIDENCE_SIGNING_KEY_ID="pilot-evidence-$(date -u +%Y%m%d%H%M%S)"
export API_KEYS="${COMMANDER_API_KEY}:pilot:read;write;admin;actions:approve"
export TENANT_API_KEYS="${COMMANDER_TENANT_ID}:${COMMANDER_API_KEY}"
export ADMIN_PASSWORD="$(openssl rand -hex 16)"

PILOT_KEY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/commander-pilot-keys.XXXXXX")"
node --input-type=module - "$PILOT_KEY_DIR" <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
mkdirSync(directory, { recursive: true, mode: 0o700 });

function material(prefix, keyId) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  writeFileSync(join(directory, `${prefix}-private.pem`), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(join(directory, `${prefix}-jwks.json`), JSON.stringify({ keys: [{ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: keyId }] }), { mode: 0o600 });
}

material('capability', process.env.COMMANDER_CAPABILITY_KEY_ID);
material('evidence', process.env.COMMANDER_EVIDENCE_SIGNING_KEY_ID);
NODE

export COMMANDER_CAPABILITY_PRIVATE_KEY_PEM="$(< "$PILOT_KEY_DIR/capability-private.pem")"
export COMMANDER_CAPABILITY_JWKS_JSON="$(< "$PILOT_KEY_DIR/capability-jwks.json")"
export COMMANDER_EVIDENCE_SIGNING_PRIVATE_KEY_PEM="$(< "$PILOT_KEY_DIR/evidence-private.pem")"
export COMMANDER_EVIDENCE_JWKS_JSON="$(< "$PILOT_KEY_DIR/evidence-jwks.json")"

docker compose -f deploy/docker/v2-compose.yml config >/dev/null
docker compose -f deploy/docker/v2-compose.yml up -d
```

> **How inbound API keys actually work.** `API_KEYS` / `TENANT_API_KEYS` are
> required by `deploy/docker/v2-compose.yml`, which refuses to start without
> them — but since the PostgreSQL auth migration they no longer bind an inbound
> key. `apps/api/src/authMiddleware.ts` authenticates **only** against the
> `commander_auth_api_keys` table, and `apps/api/test/authMiddlewareImport.test.ts`
> forbids any reference to those two env vars in that file. `COMMANDER_API_KEY`
> is the outbound Action Gateway credential. To get an inbound key for the
> pilot, sign in as the initial admin account seeded from `ADMIN_PASSWORD`, then
> create a tenant-scoped key through the control-plane API and use that as the
> Gateway credential.

Wait for `/health` and `/ready` on the configured Gateway endpoint. Keep the
Gateway, kernel-ops, worker, and adapter-ops identities separate. Keep
`PILOT_KEY_DIR` until the receipt has been verified; remove it after teardown.

## 2. Connect the external runtime

The MCP client receives only the public Commander MCP server. Configure the
client with the installed `commander-mcp-server` binary and the Gateway identity:

```json
{
  "mcpServers": {
    "commander": {
      "command": "commander-mcp-server",
      "env": {
        "COMMANDER_PROFILE": "enterprise",
        "COMMANDER_ACTION_GATEWAY_URL": "https://commander.example",
        "COMMANDER_API_KEY": "${COMMANDER_API_KEY}",
        "COMMANDER_TENANT_ID": "${COMMANDER_TENANT_ID}"
      }
    }
  }
}
```

The Agent Runtime must discover and invoke `commander_action_*` tools over MCP.
It must not import Commander packages or call kernel/adapter functions directly.

## 3. Run the action workflow

Use the sequence below for the Kubernetes template:

1. `commander_action_simulate` checks the destination, policy, and expected
   effect without writing.
2. `commander_action_propose` records the immutable action digest.
3. A named approver calls `commander_action_approve` with the simulation id,
   policy snapshot id, and action digest.
4. The worker executes one rollback. If the process dies after the remote commit,
   restart it and call `commander_action_reconcile`.
5. Confirm reconciliation reports the external outcome and zero writes during
   reconciliation.
6. Call `commander_action_evidence`, save only its sanitized `receipt` object as
   `receipt.json`, and verify it in a separate process:

   ```bash
   pnpm exec tsx scripts/verify-evidence.ts receipt.json \
     --jwks "$PILOT_KEY_DIR/evidence-jwks.json"
   ```

   The verifier must print `{"ok":true}`. Never save the provider response,
   request payload, or private key alongside the receipt.

The deterministic external Agent Runtime acceptance is the no-key CI reference.
The live provider smoke is an opt-in compatibility check and is not a CI gate.

## 4. Stop and remove

Before teardown, export the receipt hash and the sanitized verification result.
Disable the tenant kill switch only after the action is terminal, then remove the
dedicated stack and sandbox namespace using the deployment runbook:

```bash
docker compose -f deploy/docker/v2-compose.yml down -v --remove-orphans
kubectl delete namespace "${COMMANDER_KUBERNETES_PROOF_NAMESPACE:?}" --ignore-not-found
rm -rf "$PILOT_KEY_DIR"
```

Keep only the sanitized evidence bundle; remove provider keys, raw payloads, and
temporary credentials.

## Acceptance rule

An independent reader who did not build the workflow must complete the install,
proposal, approval, recovery, receipt verification, kill-switch check, and
teardown from this page and the linked support runbook. Every confusion is a G7
blocker until the documentation or product path is corrected.
