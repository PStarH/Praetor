# Workflow Template: Kubernetes Deployment Rollback

This is a gated live-write design reference, not the current customer pilot.
Kubernetes rollback execution remains frozen. For governed external actions, start with the
[GitHub pilot](../pilot/github/README.md). For historical evaluation without external writes, see
[Shadow Pilot Phase A](../pilot/shadow/README.md).
The future live-write scope is deliberately narrow:
one tenant, one allowlisted cluster/namespace, one Deployment, mandatory human
approval, and a reversible rollback target.

## Mapping from an existing SRE workflow

| Existing SRE step | Commander boundary | User-visible evidence |
| --- | --- | --- |
| Alert says the release is unhealthy | External Agent Runtime proposes an action | action digest + tenant scope |
| Operator checks the target revision | `commander_action_simulate` | policy decision + destination |
| Change manager approves | `commander_action_approve` | approval id + policy snapshot |
| Kubernetes API performs rollback | registered `connector.kubernetes.deployment.rollback` adapter | effect id + remote observation |
| Client times out or worker restarts | `commander_action_reconcile` | query-first outcome, no reconciliation write |
| Incident closes | `commander_action_evidence` | signed receipt hash + independent verification |
| Rollback must be undone | separate compensation request and approval | compensation receipt |

## Action envelope

The external runtime proposes this shape through MCP. The tenant is taken from
authenticated context; it is not supplied by model output:

```json
{
  "source": "sre-agent",
  "package": "customer.release-automation",
  "model": "configured-at-runtime",
  "tool": "kubernetes.deployment.rollback",
  "destination": "k8s://cluster-a/platform/deployments/payments-api",
  "effectType": "connector.kubernetes.deployment.rollback",
  "args": {
    "targetRevision": "42",
    "reason": "rollback approved by release owner"
  },
  "idempotencyKey": "payments-api-rollback-20260808-0001"
}
```

The destination must match the registered cluster and namespace. The adapter
credential provider rejects an unregistered cluster, namespace, or tenant.

## Approval policy

The action is not complete when the model proposes it. The approver must inspect
the simulation, target revision, destination, and reason. A denied or expired
approval cannot reach the adapter. A kill switch denies admission before any
external write.

## Failure contract

- A transport timeout is not permission to retry the write.
- `COMPLETION_UNKNOWN` requires an outcome query before retry.
- `APPLIED` completes the existing effect without invoking the write adapter again.
- An unprovable outcome remains visible and escalates; it is never silently
  converted into success.
- Compensation is a separate authorized action with its own digest and receipt.

## Required evidence fields

The sanitized pilot record contains timestamps, action/effect identifiers, state
transitions, write counters, reconciliation outcome, compensation disposition,
receipt hashes, and verifier results. It must not contain prompts, raw arguments,
provider responses, credentials, tokens, database URLs, or customer payloads.
