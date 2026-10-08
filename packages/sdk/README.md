# @praetor/sdk

TypeScript SDK for Commander. It ships **two** clients with different
requirements — pick the one that matches how you run Commander.

| Client | Transport | Needs `@praetor/core` | Use it for |
| --- | --- | --- | --- |
| `CommanderGatewayClient` | HTTP to the Gateway `/v1` API | No | The current server path. Recommended for integrations. |
| `CommanderClient` | In-process (dynamic import) | Yes (peer dependency) | Embedding the orchestration runtime in your own Node process. Alpha. |

Both are exported from the package root:

```typescript
import { CommanderGatewayClient, CommanderClient } from '@praetor/sdk';
```

> Alpha: use this package for evaluated integrations only. It is not a claim
> that Commander or the Gateway is production-ready.

## Requirements

- Node.js 20 or newer
- A running Commander Gateway
- A scoped `COMMANDER_API_KEY`

## Install

```bash
npm install @praetor/sdk
```

## Gateway client

```typescript
import { CommanderGatewayClient } from '@praetor/sdk';

const client = new CommanderGatewayClient({
  baseUrl: process.env.COMMANDER_API_URL!,
  apiKey: process.env.COMMANDER_API_KEY!,
});

const result = await client.submitRun({
  goal: 'Review the proposed change',
  policySnapshotId: 'review-policy-v1',
  idempotencyKey: crypto.randomUUID(),
});

console.log(result.run.id, result.accepted);
```

Consequential actions use the `/v1/actions` methods on
`CommanderGatewayClient`. Simulate first, bind approvals to the returned
digest and policy snapshot, and verify the evidence receipt before treating an
action as complete.

## In-process client

`CommanderClient` embeds the runtime in your process. It dynamically imports
`@praetor/core`, so `@praetor/core` must be installed alongside this
package. It is **alpha** and is **not** a read-only path: it may initialize
local state under `.commander_state/` and invoke configured tools.

```typescript
import { CommanderClient } from '@praetor/sdk';

const client = new CommanderClient({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
});

await client.connect();
const result = await client.run('Summarise this repository');
await client.disconnect();
```

Other members: `plan(task)`, `createAgent` / `submitTask` / `awaitTask` for
multi-agent work, `writeMemory` / `queryMemory` / `getMemoryStats`,
`onEvent(handler)` for streaming, and `getStatus()` / `getReliabilityStats()`.

See the repository's `PRIVACY.md` and enterprise quickstart before sending
sensitive data or enabling target-system writes.
