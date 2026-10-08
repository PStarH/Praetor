#!/usr/bin/env npx tsx
/**
 * Basic Commander Example
 *
 * Runs a single-agent task: ask Commander a question and get an answer.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx examples/basic.ts
 */
import { executeTask } from '@praetor/core';

async function main() {
  const task = 'Explain what Commander is in one paragraph.';

  console.log('Task:', task);
  console.log('---');

  const result = await executeTask({
    task,
    options: {
      stream: false,
      effort: 'simple',
    },
  });

  console.log('Result:', result.output);
  console.log('---');
  console.log('Status:', result.status);
  console.log('Tokens used:', result.usage?.totalTokens ?? 'N/A');
}

main().catch(console.error);
