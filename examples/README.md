# Commander Examples

Runnable examples to help you get started with Commander.

## Prerequisites

```bash
git clone https://github.com/PStarH/Praetor.git
cd Praetor
pnpm install
# Set at least one API key
export OPENAI_API_KEY=sk-...
```

## Examples

| Example               | Description                                                          | Run                                       |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `basic.ts`            | Single-agent task — ask Commander a question                        | `npx tsx examples/basic.ts`               |
| `streaming.ts`        | Streaming mode — inspect agent events in real-time                   | `npx tsx examples/streaming.ts`           |
| `multi-agent.ts`      | Debate topology — two agents debate a topic                         | `npx tsx examples/multi-agent.ts`         |
| `approval-flow.ts`    | Tool approval flow — high-risk tool calls trigger human approval    | `npx tsx examples/approval-flow.ts`      |
| `dlq-replay.ts`       | Dead-letter queue — record a failed task then replay it             | `npx tsx examples/dlq-replay.ts`          |
| `interrupt-resume.ts` | Interrupt & resume — checkpoint, pause, then resume with new intent  | `npx tsx examples/interrupt-resume.ts`    |
| `saga-compensation.ts`| Saga compensation — multi-step transaction with automatic rollback  | `npx tsx examples/saga-compensation.ts`   |

## Running

```bash
# Basic single-agent task
npx tsx examples/basic.ts

# With streaming output
npx tsx examples/streaming.ts

# Multi-agent debate
npx tsx examples/multi-agent.ts

# Tool approval flow (interactive)
npx tsx examples/approval-flow.ts

# Dead-letter queue replay
npx tsx examples/dlq-replay.ts

# Interrupt & resume
npx tsx examples/interrupt-resume.ts

# Saga compensation transaction
npx tsx examples/saga-compensation.ts
```

Each example will use whatever API key you have set (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.). Commander auto-detects your provider.
