# Public documentation

Product and operator docs that ship with the repository.

> **Status:** Commander is alpha and not production-ready. Deployment checklists
> describe configuration steps; they are not a production-readiness guarantee.
> See [the privacy boundary](../PRIVACY.md) before using provider-backed tasks.

| Doc | Purpose |
|-----|---------|
| [getting-started.md](./getting-started.md) | Quick start |
| [pilot/github/README.md](./pilot/github/README.md) | GitHub pilot: action approval and response-loss recovery |
| [pilot/shadow/README.md](./pilot/shadow/README.md) | Current enterprise historical evaluation; no external writes |
| [enterprise/quickstart.md](./enterprise/quickstart.md) | Gated live-write acceptance reference; rollback frozen |
| [enterprise/workflow-template-kubernetes-rollback.md](./enterprise/workflow-template-kubernetes-rollback.md) | Future live-write workflow mapping; rollback frozen |
| [enterprise/support-runbook.md](./enterprise/support-runbook.md) | Pilot operations and incident handling |
| [deploy.md](./deploy.md) | Deployment |
| [v2-migration-guide.md](./v2-migration-guide.md) | Architecture V2 migration |
| [slo.md](./slo.md) | SLO definitions |
| [content/why-retrying-ai-agent-external-actions-is-unsafe.md](./content/why-retrying-ai-agent-external-actions-is-unsafe.md) | Engineering failure model: why retrying external actions is unsafe |
| [architecture/](./architecture/) | Canonical architecture ADRs |
| [runbooks/](./runbooks/) | Ops runbooks |
| [security/](./security/) | Public security process docs |
| [../PRIVACY.md](../PRIVACY.md) | Data flows, storage, retention, and deletion |

Internal audits, agent plans, and diligence notes are **not** in this tree.
They live only on developer machines under `.internal/` (gitignored).
