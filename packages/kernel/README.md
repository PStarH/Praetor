# @praetor/kernel

The Commander execution kernel is the sole authority for durable run and step
lifecycle state. It is deliberately separate from HTTP, CLI, LLM providers,
tools, plugins, and planning.

## Production requirements

- A shared PostgreSQL-compatible transactional store is mandatory.
- Large artifacts/checkpoints belong in object storage; store references and
  digests in the kernel, not large payloads in database rows.
- The caller supplies a `SqlPool` (for example `pg.Pool`) and calls
  `initialize()` during an explicit migration/startup phase.
- There is no memory, SQLite, JSON, or filesystem fallback in this package.

```ts
import { Pool } from 'pg';
import { PostgresKernelRepository } from '@praetor/kernel';

const kernel = new PostgresKernelRepository(new Pool({ connectionString: process.env.DATABASE_URL }));
await kernel.initialize();
```

## Invariants

1. A step is claimed through `FOR UPDATE SKIP LOCKED` and receives a fresh
   lease token plus monotonically increasing fencing epoch.
2. Heartbeat, completion, failure, and effect admission require the exact live
   lease and expected entity version.
3. Run/step state transitions, kernel events, and outbox rows are committed in
   one database transaction.
4. Outbox delivery is at-least-once. External effects must use the unique
   tenant-scoped idempotency key and canonical request hash recorded in
   `commander_effects`; reusing a key for a different request is a conflict.
5. Effect completion requires the still-live step lease and fencing epoch.
6. This package does not execute an effect; an Effect Broker/worker must use
   `admitEffect()` before execution and `completeEffect()` after it succeeds.

## Migration ownership

`runKernelMigrations(pool)` is the production initialization path. It acquires
an advisory lock, applies checksummed migrations exactly once, and installs the
tenant RLS policies. The database role used by the kernel must not be a
superuser/table owner; trusted scheduler/recovery transactions use the
`app.tenant_scope='*'` setting, while tenant-scoped requests set a comma
separated scope before querying. Do not point existing SQLite ATR files at
this repository.
