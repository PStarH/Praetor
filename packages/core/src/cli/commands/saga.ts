import { reportSilentFailure } from '../../silentFailureReporter';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CheckpointManager,
  ApprovalManager,
  FileSagaStore,
  FileApprovalStore,
  InMemorySagaStore,
  InMemoryApprovalStore,
  InProcessWorkerPool,
  CompensationScheduler,
  defaultCompensationRetryPolicy,
  runSaga,
  ExecutionGraph,
  listSagaExamples,
  getSagaExample,
} from '../../saga/index.js';
import type { SagaContext } from '../../saga/index.js';

const DATA_DIR_ENV = 'COMMANDER_SAGA_DATA';
const DEFAULT_DATA_DIR = join(process.cwd(), '.commander', 'sagas');

function sagaDataDir(): string {
  return process.env[DATA_DIR_ENV] ?? DEFAULT_DATA_DIR;
}

function ensureDataDir(): string {
  const dir = sagaDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function listRuns(): Array<{ runId: string; state: string; updatedAt: string }> {
  const dir = sagaDataDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((runId) => {
      const snapshotPath = join(dir, runId.name, 'snapshot.json');
      if (!existsSync(snapshotPath)) {
        return { runId: runId.name, state: 'UNKNOWN', updatedAt: '' };
      }
      try {
        const snap = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
        return {
          runId: runId.name,
          state: snap.state ?? 'UNKNOWN',
          updatedAt: snap.updatedAt ?? '',
        };
      } catch (err) {
        reportSilentFailure(err, 'saga:51');
        return { runId: runId.name, state: 'CORRUPT', updatedAt: '' };
      }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
function green(s: string): string {
  return `\x1b[32m${s}\x1b[0m`;
}
function red(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}
function yellow(s: string): string {
  return `\x1b[33m${s}\x1b[0m`;
}
function cyan(s: string): string {
  return `\x1b[36m${s}\x1b[0m`;
}
function bold(s: string): string {
  return `\x1b[1m${s}\x1b[0m`;
}

function header(title: string) {
  console.log(`\n  ${bold(cyan('Saga'))}  ${title}\n`);
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--') && arg.includes('=')) {
      const [k, v] = arg.slice(2).split('=', 2);
      flags[k] = v;
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2)] = 'true';
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function parseInputJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid --input JSON: ${msg}`);
  }
}

function buildRuntime(useFiles: boolean) {
  if (useFiles) {
    const baseDir = ensureDataDir();
    const store = new FileSagaStore({ baseDir });
    const approvalStore = new FileApprovalStore({ baseDir });
    return {
      checkpoint: new CheckpointManager(store),
      approval: new ApprovalManager({ store: approvalStore }),
      compensation: new CompensationScheduler({ retryPolicy: defaultCompensationRetryPolicy() }),
      workerPool: new InProcessWorkerPool(8),
      baseDir,
    };
  }
  return {
    checkpoint: new CheckpointManager(new InMemorySagaStore()),
    approval: new ApprovalManager({ store: new InMemoryApprovalStore() }),
    compensation: new CompensationScheduler({ retryPolicy: defaultCompensationRetryPolicy() }),
    workerPool: new InProcessWorkerPool(8),
    baseDir: '(in-memory)',
  };
}

function buildContext(
  runId: string,
  input: Record<string, unknown>,
  timeoutMs: number,
): SagaContext {
  return {
    runId,
    input,
    results: new Map(),
    attempts: new Map(),
    metadata: {},
    signal: AbortSignal.timeout(timeoutMs),
  };
}

function formatResult(result: Awaited<ReturnType<typeof runSaga>>): void {
  const statusColor = result.status === 'committed' ? green : red;
  const icon = result.status === 'committed' ? '✓' : '✗';
  console.log(
    `\n  ${statusColor(icon)} ${bold(result.status.toUpperCase())}  ${dim(`(${result.durationMs}ms)`)}`,
  );
  if (result.error) console.log(`  ${dim('error:')} ${result.error}`);
  if (Object.keys(result.results).length > 0) {
    console.log(`  ${dim('results:')}`);
    for (const [k, v] of Object.entries(result.results)) {
      const value = typeof v === 'object' ? JSON.stringify(v) : String(v);
      console.log(`    ${cyan(k)}: ${value}`);
    }
  }
  console.log(`  ${dim('summary:')} ${result.summary}\n`);
}

async function cmdSagaRun(args: string[]) {
  const { positional, flags } = parseFlags(args);
  if (positional.length === 0) {
    console.error(`  ${red('error:')} missing saga name`);
    console.log(
      `  ${dim('Run')} ${bold('commander saga examples')} ${dim('to see available sagas')}`,
    );
    process.exit(1);
  }

  const name = positional[0]!;
  const example = getSagaExample(name);
  if (!example) {
    console.error(`  ${red('error:')} unknown saga "${name}"`);
    console.log(
      `  ${dim('Run')} ${bold('commander saga examples')} ${dim('to see available sagas')}`,
    );
    process.exit(1);
  }

  const input = parseInputJson(flags.input);
  const useFiles = flags['in-memory'] !== 'true';
  const timeoutMs = parseInt(flags.timeout ?? '60000', 10);
  const runId = flags['run-id'] ?? `${name}-${Date.now()}`;

  header(example.name);
  console.log(`  ${dim('description:')} ${example.description}`);
  console.log(`  ${dim('runId:      ')} ${runId}`);
  console.log(`  ${dim('storage:    ')} ${useFiles ? sagaDataDir() : '(in-memory)'}`);
  console.log(`  ${dim('timeout:    ')} ${timeoutMs}ms`);

  const graph = example.build();
  const eg = new ExecutionGraph(graph);
  const order = eg.nodes.map((n) => ('name' in n && n.name ? n.name : n.id));
  console.log(`  ${dim('nodes:      ')} ${eg.size} (${order.join(' \u2192 ')})`);

  const runtime = buildRuntime(useFiles);
  const ctx = buildContext(runId, input, timeoutMs);

  console.log('');
  const result = await runSaga(graph, ctx, runtime.checkpoint, runtime.approval, runtime);
  formatResult(result);

  if (useFiles && result.status === 'aborted') {
    console.log(`  ${dim('Recover the run with:')} ${bold(`commander saga resume ${runId}`)}`);
  }
}

async function cmdSagaList(args: string[]) {
  const { flags } = parseFlags(args);
  const inMemoryOnly = flags['in-memory'] === 'true';
  const runs = inMemoryOnly ? [] : listRuns();
  header(`${runs.length} run${runs.length === 1 ? '' : 's'}`);
  if (runs.length === 0) {
    console.log(
      `  ${dim('No runs found. Run one with:')} ${bold('commander saga run order-fulfillment')}\n`,
    );
    return;
  }
  console.log(`  ${pad(bold('RUN ID'), 32)}  ${pad(bold('STATE'), 14)}  ${bold('UPDATED')}`);
  console.log(`  ${dim('-'.repeat(70))}`);
  for (const r of runs) {
    const stateColor = r.state === 'COMMITTED' ? green : r.state === 'ABORTED' ? red : yellow;
    console.log(`  ${pad(r.runId, 32)}  ${pad(stateColor(r.state), 22)}  ${dim(r.updatedAt)}`);
  }
  console.log();
}

async function cmdSagaStatus(args: string[]) {
  const { positional } = parseFlags(args);
  if (positional.length === 0) {
    console.error(`  ${red('error:')} missing runId`);
    process.exit(1);
  }
  const runId = positional[0]!;
  const dir = sagaDataDir();
  const snapshotPath = join(dir, runId, 'snapshot.json');

  if (!existsSync(snapshotPath)) {
    console.error(`  ${red('error:')} run "${runId}" not found`);
    process.exit(1);
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as {
    runId: string;
    state: string;
    intentHash: string;
    fencingEpoch: number;
    nodeStates: Record<string, string>;
    createdAt: string;
    updatedAt: string;
    error?: string;
  };

  header(`Status: ${runId}`);
  console.log(`  ${dim('state:        ')} ${snapshot.state}`);
  console.log(`  ${dim('fencingEpoch: ')} ${snapshot.fencingEpoch}`);
  console.log(`  ${dim('createdAt:    ')} ${snapshot.createdAt}`);
  console.log(`  ${dim('updatedAt:    ')} ${snapshot.updatedAt}`);
  if (snapshot.error) console.log(`  ${dim('error:        ')} ${red(snapshot.error)}`);
  console.log(`\n  ${dim('Nodes:')}`);
  for (const [id, state] of Object.entries(snapshot.nodeStates)) {
    const stateColor = state === 'completed' ? green : state === 'failed' ? red : dim;
    console.log(`    ${pad(id, 28)}  ${stateColor(state)}`);
  }
  console.log();
}

async function cmdSagaResume(args: string[]) {
  const { positional, flags } = parseFlags(args);
  if (positional.length === 0) {
    console.error(`  ${red('error:')} missing runId`);
    process.exit(1);
  }
  const runId = positional[0]!;
  const dir = sagaDataDir();
  const snapshotPath = join(dir, runId, 'snapshot.json');

  if (!existsSync(snapshotPath)) {
    console.error(`  ${red('error:')} run "${runId}" not found`);
    process.exit(1);
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  if (snapshot.state === 'COMMITTED' || snapshot.state === 'ABORTED') {
    console.log(
      `  ${yellow('note:')} run "${runId}" is already ${snapshot.state}; nothing to resume`,
    );
    return;
  }

  console.log(
    `  ${dim('Resuming run')} ${cyan(runId)} ${dim('— rebuilding saga from snapshot...')}`,
  );

  const ctx = buildContext(runId, snapshot.input ?? {}, parseInt(flags.timeout ?? '60000', 10));
  const runtime = buildRuntime(true);
  const recovered = await runtime.checkpoint.recover(runId);
  if (!recovered) {
    console.error(`  ${red('error:')} could not recover ${runId}`);
    process.exit(1);
  }
  console.log(`  ${dim('snapshot:')}      ${recovered.snapshot.state}`);
  console.log(`  ${dim('events total:')}  ${recovered.allEvents.length}`);
  console.log(`  ${dim('events since:')}  ${recovered.eventsAfterSnapshot.length}\n`);

  // Rebuild execution graph from snapshot metadata
  // The graph definition is stored in the example registry — re-resolve it.
  // For orphaned sagas (no matching example), replay events is still possible.
  const nodes = Object.keys(recovered.snapshot.nodeStates ?? {});
  if (nodes.length === 0) {
    console.log(`  ${yellow('warning:')} no node states found in snapshot; nothing to resume\n`);
    return;
  }

  // Determine which nodes already completed and which still need to run
  const completedNodes = nodes.filter((n) => recovered.snapshot.nodeStates[n] === 'completed');
  const pendingNodes = nodes.filter((n) => recovered.snapshot.nodeStates[n] !== 'completed');

  if (pendingNodes.length === 0) {
    console.log(`  ${green('✓')} All nodes already completed — run was successful\n`);
    return;
  }

  console.log(`  ${dim('completed:')}  ${green(`${completedNodes.length}/${nodes.length}`)}`);
  console.log(`  ${dim('pending:')}     ${yellow(`${pendingNodes.length}/${nodes.length}`)}`);
  console.log(`  ${dim('nodes:')}       ${pendingNodes.join(', ')}\n`);

  // Load the saga example for this run type
  // The runId may contain the saga name as prefix (e.g., "order-fulfillment-1717523456")
  const sagaName = runId.includes('-') ? runId.split('-').slice(0, -1).join('-') : runId;
  let sagaDefinition: ReturnType<typeof getSagaExample> | undefined;

  try {
    const { getSagaExample: getEx } = await import('../../saga/index.js');
    sagaDefinition = getEx(sagaName);
    // Try shorter name: first segment only
    if (!sagaDefinition && runId.includes('-')) {
      sagaDefinition = getEx(runId.split('-')[0]!);
    }
  } catch (err) {
    reportSilentFailure(err, 'saga:351');
    /* saga definition not found — will run without graph */
  }

  if (sagaDefinition) {
    // Full resume: rebuild graph and re-run, skipping completed nodes
    const graph = sagaDefinition.build();
    const { ExecutionGraph: ExGraph, runSaga: runEx } = await import('../../saga/index.js');
    const eg = new ExGraph(graph);
    const order = eg.nodes.map((n) => ('name' in n && n.name ? n.name : n.id));
    console.log(`  ${dim('graph:')}       ${order.join(' → ')}`);
    console.log();

    // Re-run saga — the coordinator skips already completed nodes
    const result = await runEx(graph, ctx, runtime.checkpoint, runtime.approval, runtime);
    console.log(`\n  ${bold('Resume result:')}`);
    formatResult(result);
  } else {
    console.log(`  ${yellow('warning:')} saga definition "${sagaName}" not found.`);
    console.log(`  ${dim('The snapshot is available for manual inspection at:')}`);
    console.log(`  ${dim(snapshotPath)}\n`);
  }
}

async function cmdSagaApprove(args: string[]) {
  await cmdSagaDecide(args, 'approve');
}

async function cmdSagaReject(args: string[]) {
  await cmdSagaDecide(args, 'reject');
}

async function cmdSagaDecide(args: string[], decision: 'approve' | 'reject') {
  const { positional, flags } = parseFlags(args);
  if (positional.length < 2) {
    console.error(
      `  ${red('error:')} usage: commander saga ${decision} <runId> <nodeId> [--by=<user>]`,
    );
    process.exit(1);
  }
  const [runId, nodeId] = [positional[0]!, positional[1]!];
  const by = flags.by ?? process.env.USER ?? process.env.USERNAME ?? 'cli-user';

  const baseDir = ensureDataDir();
  const approval = new ApprovalManager({ store: new FileApprovalStore({ baseDir }) });

  await approval.decide(runId, nodeId, {
    decision,
    decidedBy: by,
    decidedAt: new Date().toISOString(),
  });

  console.log(
    `  ${green('\u2713')} ${bold(decision.toUpperCase())} ${dim('by')} ${cyan(by)} ${dim('\u2192')} ${cyan(`${runId}/${nodeId}`)}\n`,
  );
}

async function cmdSagaExamples(_args: string[]) {
  const examples = listSagaExamples();
  header(`${examples.length} built-in examples`);
  for (const ex of examples) {
    const graph = ex.build();
    const eg = new ExecutionGraph(graph);
    console.log(`  ${bold(cyan(ex.name))}`);
    console.log(`    ${dim(ex.description)}`);
    console.log(`    ${dim('nodes:')} ${eg.size}`);
    console.log(
      `    ${dim('run:    ')} ${bold(`commander saga run ${ex.name} --input='{"orderId":"o_42","amount":100}'`)}`,
    );
    console.log();
  }
}

export async function cmdSaga(args: string[]) {
  const sub = args[0] ?? 'help';
  const rest = args.slice(1);

  switch (sub) {
    case 'run':
      await cmdSagaRun(rest);
      break;
    case 'list':
    case 'ls':
      await cmdSagaList(rest);
      break;
    case 'status':
      await cmdSagaStatus(rest);
      break;
    case 'resume':
      await cmdSagaResume(rest);
      break;
    case 'approve':
      await cmdSagaApprove(rest);
      break;
    case 'reject':
      await cmdSagaReject(rest);
      break;
    case 'examples':
      await cmdSagaExamples(rest);
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(`
  ${bold('commander saga')} ${dim('\u2014 manage saga runs')}

  ${bold('Subcommands:')}
    ${cyan('run <name>')}        Run a built-in example saga
    ${cyan('list')}              List all runs (committed, aborted, in-progress)
    ${cyan('status <runId>')}    Show a run's snapshot
    ${cyan('resume <runId>')}    Inspect a resumable run
    ${cyan('approve <runId> <nodeId>')}    Approve a pending approval
    ${cyan('reject <runId> <nodeId>')}     Reject a pending approval
    ${cyan('examples')}          List built-in example sagas

  ${bold('Run flags:')}
    --input=<json>        Saga input (JSON)
    --run-id=<id>         Custom run ID (default: <name>-<timestamp>)
    --timeout=<ms>        Total timeout (default: 60000)
    --in-memory           Use in-memory stores (no disk persistence)

  ${dim('Examples:')}
    commander saga examples
    commander saga run order-fulfillment --input='{"orderId":"o_42","amount":100}'
    commander saga run refund-approval --input='{"refundId":"r_1","amount":600}'
    commander saga list
    commander saga status order-fulfillment-1717523456
    commander saga approve r_1 finance-team-approval --by=alice
`);
      if (sub !== 'help' && sub !== '--help' && sub !== '-h') {
        process.exit(1);
      }
  }
}
