# @praetor/worker-plane

The worker plane is the only location that executes a leased step. It is
separate from the Gateway and communicates with the shared execution kernel
through the `KernelWorkerPort` contract.

## Security and scheduling invariants

- A worker must authenticate before registration; no permissive default
  authenticator is supplied.
- Registration has a monotonically increasing generation. A superseded process
  cannot heartbeat or drain its replacement.
- Worker capability and tenant authorization constrain kernel claims.
- Tenant concurrency is enforced by the kernel's shared PostgreSQL usage row,
  not a process-local semaphore.
- Step completion/failure remains lease- and fencing-checked by the kernel.
- An executor receives an `AbortSignal`; a failed step heartbeat aborts it.
- Tool/connector steps marked `hasExternalEffects` must carry an Effect Broker
  capability token, request idempotency key, effect id, and live fenced lease.
  Without a broker they fail closed and never invoke the registered handler.

`PostgresWorkerRegistry` and `PostgresKernelRepository` need the same shared
Postgres cluster. The next cutover step is an environment-specific bootstrap
that supplies a real workload-identity verifier and approved executor module.

## Process entrypoint

`commander-worker` (or `node dist/main.js`) is deliberately fail-closed. Set
`COMMANDER_WORKER_BOOTSTRAP` to a module exporting:

```ts
export async function createWorkerService(): Promise<WorkerService> {
  // Construct PostgresKernelRepository, PostgresWorkerRegistry,
  // WorkerAuthenticator, WorkerDefinition/identity, and StepExecutor.
}
```

The bootstrap module is the deployment-specific trust boundary: it must obtain
short-lived workload identity and may only register approved executor types.
