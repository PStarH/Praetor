# ADR 001: Resource Model

## Status

Approved

## Context

Commander has accumulated multiple overlapping models: legacy `Run` in `@praetor/core`, gateway-specific DTOs in `apps/api`, and SDK-specific types in `packages/sdk`. This duplication causes inconsistent state names, broken contract tests, and leaking internal types through public SDKs.

## Decision

Adopt a single, versioned public resource model owned by `packages/contracts`.

### Canonical Resources

- `Organization`
- `Project`
- `Environment`
- `Principal`
- `Run`
- `WorkGraph`
- `Step`
- `Interaction`
- `Effect`
- `Artifact`
- `PolicyBundle`
- `AgentDefinition`
- `ToolDefinition`
- `ConnectorDefinition`
- `Worker`

### Rules

1. All public resources use string timestamps (ISO 8601), not `Date` objects.
2. Resource IDs are opaque strings; consumers must not parse their structure.
3. Public types never import from `@praetor/core` or any provider package.
4. Every public resource carries `tenantId` for authorization scope.

## Consequences

- Gateway, kernel, worker, and SDK share one source of truth.
- Breaking changes require a new contracts major/minor version.
- Internal implementation details are no longer exposed to SDK consumers.
