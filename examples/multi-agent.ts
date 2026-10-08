#!/usr/bin/env npx tsx
/**
 * Multi-Agent Debate Commander Example
 *
 * Two agents debate a topic using Commander's DEBATE topology.
 * Commander automatically picks the optimal topology — no config needed.
 *
 * Usage:
 *   export OPENAI_API_KEY=sk-...
 *   npx tsx examples/multi-agent.ts
 */
import { executeTask } from '@praetor/core';

async function main() {
  // Commander's deliberation engine will classify this as a DEBATE task
  // and automatically spin up multiple agents.
  const task = `Debate: "Should all AI-generated code be reviewed by a human before deployment?"
  
  Arguments for: AI code needs human oversight for safety and correctness.
  Arguments against: AI code is often more thoroughly tested than human code.
  
  Provide a balanced conclusion.`;

  console.log('Task:', task);
  console.log('---');
  console.log('Running multi-agent debate...\n');

  const result = await executeTask({
    task,
    options: {
      stream: true,
      effort: 'moderate',
      onStream: (chunk) => {
        if (chunk.type === 'thought') {
          process.stdout.write(`\x1b[2m${chunk.content}\x1b[0m\n`);
        } else if (chunk.type === 'output') {
          process.stdout.write(chunk.content);
        }
      },
    },
  });

  console.log('\n---');
  console.log('Status:', result.status);
  console.log('Topology used:', result.topology);
}

main().catch(console.error);
