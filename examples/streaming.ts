#!/usr/bin/env npx tsx
/**
 * Streaming Commander Example
 *
 * Runs a task with real-time SSE streaming to watch the agent think.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx examples/streaming.ts
 */
import { executeTask } from '@praetor/core';

async function main() {
  const task = 'List 5 best practices for writing secure API endpoints.';

  console.log('Task:', task);
  console.log('---');
  console.log('Agent thoughts will stream below:\n');

  const result = await executeTask({
    task,
    options: {
      stream: true,
      effort: 'simple',
      onStream: (chunk) => {
        if (chunk.type === 'thought') {
          process.stdout.write(`\x1b[2m${chunk.content}\x1b[0m\n`);
        } else if (chunk.type === 'tool_call') {
          process.stdout.write(`\x1b[34m[Tool: ${chunk.toolName}]\x1b[0m\n`);
        } else if (chunk.type === 'output') {
          process.stdout.write(chunk.content);
        }
      },
    },
  });

  console.log('\n---');
  console.log('Status:', result.status);
}

main().catch(console.error);
