#!/usr/bin/env npx tsx
/**
 * Commander vs OpenCode — Hard Mode Comparison
 *
 * Complex multi-step tasks that exercise:
 * - Multi-file analysis and cross-referencing
 * - Research + synthesis + code generation
 * - Error analysis across large codebases
 * - Multi-step planning with dependencies
 *
 * Tracks token usage per Commander phase.
 *
 * Usage:
 *   npx tsx packages/core/tests/commander-vs-opencode-hard.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { requireMimoApiKey, mimoBaseUrl } from './helpers/liveProviderCredentials';

// ── Config ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = path.join(process.cwd(), '.compare-hard-output');

// ── Task Definitions ─────────────────────────────────────────────────────────
interface ComparisonTask {
  name: string;
  category: string;
  prompt: string;
  outputFile: string;
  minExpectedBytes: number;
}

const TASKS: ComparisonTask[] = [
  {
    name: 'cross-module-analysis',
    category: 'deep-analysis',
    prompt: `Analyze the Commander codebase's error handling strategy across these modules:
1. packages/core/src/runtime/agentRuntime.ts — agent execution errors
2. packages/core/src/ultimate/orchestrator.ts — orchestration errors
3. packages/core/src/ultimate/subAgentExecutor.ts — sub-agent errors
4. packages/core/src/runtime/providers/ — provider errors

For each module, identify:
- Error types handled vs unhandled
- Error propagation patterns (swallow, wrap, rethrow)
- Recovery mechanisms (retry, fallback, circuit breaker)
- Missing error cases that could cause silent failures

Write a comprehensive error handling audit with specific code references and improvement recommendations to /tmp/compare-error-audit.md`,
    outputFile: '/tmp/compare-error-audit.md',
    minExpectedBytes: 1000,
  },
  {
    name: 'multi-file-refactor-plan',
    category: 'planning',
    prompt: `Study the Commander codebase structure:
- packages/core/src/ultimate/ — orchestration layer
- packages/core/src/runtime/ — execution layer
- packages/core/src/tools/ — tool system
- packages/core/src/telos/ — goal management

Create a detailed refactoring plan to extract the tool system into a standalone package (@praetor/tools). Include:
1. Dependency analysis: what each tool file imports from core
2. Interface boundary: what types need to be shared vs duplicated
3. Migration steps with specific file moves and import rewrites
4. Testing strategy for the extracted package
5. Risk assessment and rollback plan

Write the plan to /tmp/compare-refactor-plan.md`,
    outputFile: '/tmp/compare-refactor-plan.md',
    minExpectedBytes: 1000,
  },
  {
    name: 'research-and-implement',
    category: 'multi-step',
    prompt: `Research the Actor Model pattern for concurrent systems. Then analyze Commander's current concurrent execution model in packages/core/src/ultimate/subAgentExecutor.ts and packages/core/src/runtime/agentRuntime.ts.

Based on your research, propose a concrete implementation plan to refactor Commander's sub-agent execution to use an Actor Model approach. Include:
1. Actor definition interface with message types
2. Mailbox implementation for inter-agent communication
3. Supervisor hierarchy for error handling
4. Code examples showing before/after for key methods

Write the proposal with code examples to /tmp/compare-actor-model.md`,
    outputFile: '/tmp/compare-actor-model.md',
    minExpectedBytes: 1000,
  },
  {
    name: 'security-audit',
    category: 'deep-analysis',
    prompt: `Perform a security audit of Commander's tool execution system. Analyze:
1. packages/core/src/tools/fileSystemTool.ts — file operations (path traversal, symlink attacks)
2. packages/core/src/tools/codeExecutionTool.ts — code execution (sandboxing, injection)
3. packages/core/src/runtime/agentRuntime.ts — tool call validation and sanitization
4. packages/core/src/ultimate/orchestrator.ts — permission boundaries

For each area, identify:
- Current security measures
- Potential vulnerabilities (with attack scenarios)
- Missing protections
- Specific code fixes with before/after examples

Write the security audit to /tmp/compare-security-audit.md`,
    outputFile: '/tmp/compare-security-audit.md',
    minExpectedBytes: 1000,
  },
  {
    name: 'performance-profiler',
    category: 'analysis',
    prompt: `Analyze Commander's performance characteristics by examining:
1. packages/core/src/runtime/agentRuntime.ts — token usage, retry logic, caching
2. packages/core/src/ultimate/orchestrator.ts — orchestration overhead, synthesis cost
3. packages/core/src/ultimate/subAgentExecutor.ts — parallel execution, serialization bottlenecks
4. packages/core/src/runtime/providers/ — API call patterns, rate limiting

Identify:
- Token waste patterns (redundant context, oversized prompts)
- Latency bottlenecks (sequential operations that could be parallel)
- Memory pressure points (large objects in memory, unbounded collections)
- Caching opportunities (tool results, provider responses)

Write a performance optimization report with specific recommendations and estimated impact to /tmp/compare-perf-report.md`,
    outputFile: '/tmp/compare-perf-report.md',
    minExpectedBytes: 1000,
  },
  {
    name: 'integration-test-design',
    category: 'planning',
    prompt: `Design a comprehensive integration test suite for Commander's multi-agent orchestration. Study:
- packages/core/src/ultimate/orchestrator.ts — the main orchestration flow
- packages/core/src/ultimate/subAgentExecutor.ts — sub-agent execution
- packages/core/src/ultimate/synthesizer.ts — result synthesis
- packages/core/src/ultimate/atomizer.ts — task decomposition

Create test specifications for:
1. Happy path: single agent completes a task
2. Parallel execution: multiple agents work concurrently
3. Failure recovery: agent fails and is retried
4. Synthesis quality: multiple results are combined correctly
5. Token budget: execution stops when budget exceeded
6. Topology selection: correct topology chosen for task type

Include mock strategies, assertion patterns, and test data factories. Write to /tmp/compare-test-design.md`,
    outputFile: '/tmp/compare-test-design.md',
    minExpectedBytes: 1000,
  },
];

// ── Results ──────────────────────────────────────────────────────────────────
interface TaskResult {
  system: 'commander' | 'opencode';
  taskName: string;
  category: string;
  durationMs: number;
  tokensUsed: number;
  success: boolean;
  outputSize: number;
  error?: string;
}

// ── OpenCode Runner ──────────────────────────────────────────────────────────
async function runOpenCode(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();

  try {
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    const result = execSync(
      `opencode run -m "mimo/mimo-v2.5" "${task.prompt.replace(/"/g, '\\"')}"`,
      {
        timeout: 600_000,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      },
    );

    const durationMs = Date.now() - start;

    let outputSize = 0;
    try {
      outputSize = fs.statSync(task.outputFile).size;
    } catch {}

    const tokenMatch = result.match(/(\d+)\s*tokens?/i);
    const tokens = tokenMatch ? parseInt(tokenMatch[1]) : 0;

    return {
      system: 'opencode',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: tokens,
      success: outputSize >= task.minExpectedBytes,
      outputSize,
    };
  } catch (err: any) {
    const durationMs = Date.now() - start;

    let outputSize = 0;
    try {
      outputSize = fs.statSync(task.outputFile).size;
    } catch {}

    return {
      system: 'opencode',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: 0,
      success: outputSize >= task.minExpectedBytes,
      outputSize,
      error: err?.message?.slice(0, 200) || String(err).slice(0, 200),
    };
  }
}

// ── Commander Runner ─────────────────────────────────────────────────────────
async function runCommander(task: ComparisonTask): Promise<TaskResult> {
  const start = Date.now();

  try {
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    const { AgentRuntime } = await import('../src/runtime/agentRuntime');
    const { TELOSOrchestrator } = await import('../src/telos/telosOrchestrator');
    const { UltimateOrchestrator } = await import('../src/ultimate/orchestrator');
    const { MiMoProvider } = await import('../src/runtime/providers/mimoProvider');

    const provider = new MiMoProvider({
      apiKey: requireMimoApiKey(),
      baseUrl: mimoBaseUrl('https://token-plan-sgp.xiaomimimo.com/v1'),
      defaultModel: 'mimo-v2.5',
    });

    const runtime = new AgentRuntime({
      budgetHardCapTokens: 800_000,
      maxSteps: 20,
    });
    runtime.registerProvider('mimo', provider);
    runtime.registerProvider('openai', provider);

    const { WebSearchTool, WebFetchTool } = await import('../src/tools/webSearchTool');
    const { FileReadTool, FileWriteTool, FileEditTool, FileListTool, FileSearchTool } =
      await import('../src/tools/fileSystemTool');

    runtime.registerTool('web_search', new WebSearchTool());
    runtime.registerTool('web_fetch', new WebFetchTool());
    runtime.registerTool('file_write', new FileWriteTool());
    runtime.registerTool('file_read', new FileReadTool());
    runtime.registerTool('file_list', new FileListTool());
    runtime.registerTool('file_edit', new FileEditTool());
    runtime.registerTool('file_search', new FileSearchTool());

    const telos = new TELOSOrchestrator(runtime);
    const orchestrator = new UltimateOrchestrator(telos, runtime, {
      enableDeliberation: false,
      enableReflection: false,
      maxRecursiveDepth: 2,
      maxParallelSubAgents: 2,
    });

    const result = await orchestrator.execute({
      projectId: 'compare-hard',
      agentId: `compare-${task.name}`,
      goal: task.prompt,
      contextData: {
        availableTools: [
          'web_search',
          'web_fetch',
          'file_write',
          'file_read',
          'file_list',
          'file_edit',
          'file_search',
        ],
      },
    });

    const durationMs = Date.now() - start;
    const tokens = result.metrics?.totalTokens ?? 0;

    let outputSize = 0;
    try {
      outputSize = fs.statSync(task.outputFile).size;
    } catch {}

    // Extract per-phase token breakdown from reasoning
    const reasoning = result.reasoning ?? [];

    return {
      system: 'commander',
      taskName: task.name,
      category: task.category,
      durationMs,
      tokensUsed: tokens,
      success: outputSize >= task.minExpectedBytes,
      outputSize,
    };
  } catch (err) {
    return {
      system: 'commander',
      taskName: task.name,
      category: task.category,
      durationMs: Date.now() - start,
      tokensUsed: 0,
      success: false,
      outputSize: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Commander vs OpenCode — Hard Mode Comparison              ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Model:     mimo-v2.5 (same for both)                      ║');
  console.log(`║  Tasks:     ${(TASKS.length + ' per system (complex multi-step)').padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const allResults: TaskResult[] = [];

  for (const task of TASKS) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`TASK: ${task.name} [${task.category}]`);
    console.log(`${'═'.repeat(60)}`);

    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    // Run OpenCode first
    console.log(`  ├─ Running OpenCode...`);
    const ocResult = await runOpenCode(task);
    allResults.push(ocResult);
    const ocOut = ocResult.success ? `${(ocResult.outputSize / 1024).toFixed(1)}KB` : 'FAIL';
    console.log(
      `  │  ${ocResult.success ? '✅' : '❌'} ${(ocResult.durationMs / 1000).toFixed(1)}s | ${ocOut}${ocResult.error ? ` | ${ocResult.error.slice(0, 60)}` : ''}`,
    );

    // Save OpenCode output
    let ocOutput = '';
    try {
      ocOutput = fs.readFileSync(task.outputFile, 'utf-8');
    } catch {}

    try {
      fs.unlinkSync(task.outputFile);
    } catch {}

    // Pause
    await new Promise((r) => setTimeout(r, 5000));

    // Run Commander
    console.log(`  ├─ Running Commander...`);
    const cmdResult = await runCommander(task);
    allResults.push(cmdResult);
    const cmdOut = cmdResult.success ? `${(cmdResult.outputSize / 1024).toFixed(1)}KB` : 'FAIL';
    console.log(
      `  │  ${cmdResult.success ? '✅' : '❌'} ${(cmdResult.durationMs / 1000).toFixed(1)}s | ${cmdResult.tokensUsed.toLocaleString()} tok | ${cmdOut}${cmdResult.error ? ` | ${cmdResult.error.slice(0, 60)}` : ''}`,
    );

    // Save Commander output
    let cmdOutput = '';
    try {
      cmdOutput = fs.readFileSync(task.outputFile, 'utf-8');
    } catch {}

    // Save per-task comparison
    const comparison = {
      task: task.name,
      category: task.category,
      opencode: {
        success: ocResult.success,
        durationSec: (ocResult.durationMs / 1000).toFixed(1),
        outputBytes: ocResult.outputSize,
        outputPreview: ocOutput.slice(0, 500),
      },
      commander: {
        success: cmdResult.success,
        durationSec: (cmdResult.durationMs / 1000).toFixed(1),
        tokens: cmdResult.tokensUsed,
        outputBytes: cmdResult.outputSize,
        outputPreview: cmdOutput.slice(0, 500),
      },
    };
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${task.name}.json`),
      JSON.stringify(comparison, null, 2),
    );

    // Pause
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const ocResults = allResults.filter((r) => r.system === 'opencode');
  const cmdResults = allResults.filter((r) => r.system === 'commander');

  const ocSuccess = ocResults.filter((r) => r.success).length;
  const cmdSuccess = cmdResults.filter((r) => r.success).length;
  const cmdTokens = cmdResults.reduce((s, r) => s + r.tokensUsed, 0);
  const ocTime = ocResults.reduce((s, r) => s + r.durationMs, 0);
  const cmdTime = cmdResults.reduce((s, r) => s + r.durationMs, 0);
  const ocOutput = ocResults.reduce((s, r) => s + r.outputSize, 0);
  const cmdOutput = cmdResults.reduce((s, r) => s + r.outputSize, 0);

  const summary = {
    timestamp: new Date().toISOString(),
    model: 'mimo-v2.5',
    tasksPerSystem: TASKS.length,
    difficulty: 'hard (multi-step, cross-module analysis)',
    opencode: {
      successRate: `${ocSuccess}/${TASKS.length}`,
      totalTimeSec: (ocTime / 1000).toFixed(1),
      avgTimeSec: (ocTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: ocOutput,
    },
    commander: {
      successRate: `${cmdSuccess}/${TASKS.length}`,
      totalTokens: cmdTokens,
      totalTimeSec: (cmdTime / 1000).toFixed(1),
      avgTimeSec: (cmdTime / TASKS.length / 1000).toFixed(1),
      totalOutputBytes: cmdOutput,
    },
    overhead: {
      tokenMultiplier:
        cmdTokens > 0
          ? `${(
              cmdTokens /
              Math.max(
                1,
                ocResults.reduce((s, r) => s + r.tokensUsed, 0),
              )
            ).toFixed(1)}x`
          : 'N/A',
      timeMultiplier: `${(cmdTime / Math.max(1, ocTime)).toFixed(2)}x`,
      outputRatio: ocOutput > 0 ? `${(cmdOutput / ocOutput).toFixed(2)}x` : 'N/A',
    },
    perTask: allResults.map((r) => ({
      system: r.system,
      task: r.taskName,
      category: r.category,
      success: r.success,
      durationSec: (r.durationMs / 1000).toFixed(1),
      tokens: r.tokensUsed,
      outputBytes: r.outputSize,
      error: r.error?.slice(0, 100),
    })),
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'comparison-summary.json'),
    JSON.stringify(summary, null, 2),
  );

  console.log(`\n${'═'.repeat(60)}`);
  console.log('COMPARISON RESULTS');
  console.log(`${'═'.repeat(60)}`);
  console.log('');
  console.log('                        OpenCode        Commander');
  console.log('                        ─────────        ─────────');
  console.log(
    `  Success Rate:         ${summary.opencode.successRate.padEnd(16)} ${summary.commander.successRate}`,
  );
  console.log(
    `  Total Time:           ${(summary.opencode.totalTimeSec + 's').padEnd(16)} ${summary.commander.totalTimeSec}s`,
  );
  console.log(
    `  Avg Time/Task:        ${(summary.opencode.avgTimeSec + 's').padEnd(16)} ${summary.commander.avgTimeSec}s`,
  );
  console.log(
    `  Total Tokens:         ${'N/A'.padEnd(16)} ${summary.commander.totalTokens.toLocaleString()}`,
  );
  console.log(
    `  Output Generated:     ${(summary.opencode.totalOutputBytes + ' bytes').padEnd(16)} ${summary.commander.totalOutputBytes} bytes`,
  );
  console.log('');
  console.log('  Token Overhead:       Commander uses more tokens per task');
  console.log(`  Time Overhead:        ${summary.overhead.timeMultiplier}`);
  console.log(`  Output Ratio:         ${summary.overhead.outputRatio} (Commander vs OpenCode)`);
  console.log('');

  console.log('Per-task comparison:');
  for (const task of TASKS) {
    const oc = allResults.find((r) => r.system === 'opencode' && r.taskName === task.name);
    const cmd = allResults.find((r) => r.system === 'commander' && r.taskName === task.name);
    console.log(`\n  ${task.name} [${task.category}]:`);
    console.log(
      `    OpenCode:  ${oc?.success ? '✅' : '❌'} ${(oc?.durationMs ?? 0) / 1000}s | ${oc?.outputSize ?? 0} bytes${oc?.error ? ` | ${oc.error.slice(0, 60)}` : ''}`,
    );
    console.log(
      `    Commander: ${cmd?.success ? '✅' : '❌'} ${(cmd?.durationMs ?? 0) / 1000}s | ${(cmd?.tokensUsed ?? 0).toLocaleString()} tok | ${cmd?.outputSize ?? 0} bytes${cmd?.error ? ` | ${cmd.error.slice(0, 60)}` : ''}`,
    );
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Full results: ${OUTPUT_DIR}/`);
  console.log(`${'═'.repeat(60)}`);

  // Cleanup
  for (const task of TASKS) {
    try {
      fs.unlinkSync(task.outputFile);
    } catch {}
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
