import { reportSilentFailure } from '../../silentFailureReporter';
import { TELOSOrchestrator } from '../../telos/telosOrchestrator';
import { UltimateOrchestrator } from '../../ultimate/orchestrator';
import { assessGovernanceRiskLevel } from '../../ultimate/riskAssessor';
import { SSEStream } from '../../runtime/sseStream';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { getGlobalTenantProvider } from '../../runtime/tenantProvider';
import { deliberate } from '../../ultimate/deliberation';
import { classifyEffortLevel } from '../../ultimate/effortScaler';
import { normalizeTopology, type OrchestrationTopology } from '../../ultimate/types';
import { getGlobalLogger } from '../../logging';
import { createCompanyEngine } from '../../ultimate/companyEngine';
import { detectProvider, type ProviderType } from '../../config/commanderConfig';
import { GoalOrchestrator } from '../../goal/goalOrchestrator';
import type { GoalConfig } from '../../goal/types';
import {
  createRuntime,
  loadTools,
  $,
  section,
  kv,
  bullet,
  cmdHeader,
  startSpinner,
  fatalError,
} from './_shared';
import { t } from '../i18n';
import { runShowcase } from '../../showcase/showcaseRunner';
import { getMetaLearner } from '../../selfEvolution/metaLearner';
import { getDirname, getRequire } from '../../esmCompat';

const nodeRequire = getRequire(import.meta.url);
const __dirname = getDirname(import.meta.url);

// Routing-flag plumbing (audit P0-2 / P1-1 surface). Declared at top-of-file so it
// hoists before the first reference (cmdRun / cmdRunInternal / cmdWatchInternal).
interface RoutingFlags {
  model?: string;
  provider?: ProviderType;
  tier?: 'speed' | 'balanced' | 'power';
  topology?:
    // Canonical (Anthropic-aligned 5) — preferred.
    | 'SINGLE'
    | 'CHAIN'
    | 'DISPATCH'
    | 'ORCHESTRATOR'
    | 'REVIEW'
    // Legacy aliases accepted during the deprecation window. CLI ingest
    // will `console.warn` once per process per legacy name and the
    // internal routing will normalize to canonical on emit.
    // (D3.2 enum consolidation.)
    | 'SEQUENTIAL'
    | 'PARALLEL'
    | 'HIERARCHICAL'
    | 'HYBRID'
    | 'DEBATE'
    | 'ENSEMBLE'
    | 'EVALUATOR_OPTIMIZER'
    | 'HANDOFF'
    | 'CONSENSUS';
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'max';
  cascade?: boolean;
  qualityThreshold?: number;
}

function parseRoutingFlags(flags: Record<string, string>): RoutingFlags {
  const allowedTiers = ['speed', 'balanced', 'power'] as const;
  const allowedEfforts = ['minimal', 'low', 'medium', 'high', 'max'] as const;
  // acceptance list — canonical 5 + legacy 9 (full backwards-compat for 2
  // minor versions). Canonical names do NOT emit a deprecation warning.
  const allowedTopologies = [
    // Canonical (Anthropic-aligned 5).
    'SINGLE',
    'CHAIN',
    'DISPATCH',
    'ORCHESTRATOR',
    'REVIEW',
    // Legacy aliases (warn-once on emit; hard-removed in 2 minor versions).
    'SEQUENTIAL',
    'PARALLEL',
    'HIERARCHICAL',
    'HYBRID',
    'DEBATE',
    'ENSEMBLE',
    'EVALUATOR_OPTIMIZER',
    'HANDOFF',
    'CONSENSUS',
  ] as const;
  let tier: RoutingFlags['tier'];
  const tierRaw = flags.tier?.toLowerCase();
  if (tierRaw !== undefined) {
    if (!(allowedTiers as readonly string[]).includes(tierRaw)) {
      const closest = didYouMean(tierRaw, allowedTiers);
      const hint = closest
        ? t('error_messages.did_you_mean', { flag: 'tier', value: closest })
        : '';
      fatalError(
        t('error_messages.invalid_tier', {
          value: tierRaw,
          allowed: allowedTiers.join(', '),
          hint,
        }),
      );
    }
    tier = tierRaw as RoutingFlags['tier'];
  }
  let effort: RoutingFlags['effort'];
  const effortRaw = flags.effort?.toLowerCase();
  if (effortRaw !== undefined) {
    if (!(allowedEfforts as readonly string[]).includes(effortRaw)) {
      const closest = didYouMean(effortRaw, allowedEfforts);
      const hint = closest
        ? t('error_messages.did_you_mean', { flag: 'effort', value: closest })
        : '';
      fatalError(
        t('error_messages.invalid_effort', {
          value: effortRaw,
          allowed: allowedEfforts.join(', '),
          hint,
        }),
      );
    }
    effort = effortRaw as RoutingFlags['effort'];
  }
  let topology: RoutingFlags['topology'];
  const topologyRaw = flags.topology?.toUpperCase();
  if (topologyRaw !== undefined) {
    if (!(allowedTopologies as readonly string[]).includes(topologyRaw)) {
      const closest = didYouMean(topologyRaw, allowedTopologies);
      const hint = closest
        ? t('error_messages.did_you_mean', { flag: 'topology', value: closest })
        : '';
      fatalError(
        t('error_messages.invalid_topology', {
          value: topologyRaw,
          allowed: allowedTopologies.join(', '),
          hint,
        }),
      );
    }
    topology = topologyRaw as RoutingFlags['topology'];
    // D3.2 migration window: invoke the once-per-process deprecation
    // warning for legacy-name CLI ingest so users see the migration
    // signal in their actual run output (not just docs). `normalizeTopology`
    // returns canonical unchanged; for legacy names it emits
    // `console.warn` exactly once per process per deprecated name and
    // returns the canonical replacement. Per the user's "only change
    // strings" directive, the typed `topology` field on RoutingFlags is
    // retained unchanged so callers can still inspect both forms;
    // telemetry emission at the next boundary will normalize.
    normalizeTopology(topology as OrchestrationTopology);
  }
  let qualityThreshold: number | undefined;
  if (flags['quality-threshold'] !== undefined) {
    const parsed = Number(flags['quality-threshold']);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      fatalError(
        t('error_messages.invalid_quality_threshold', {
          value: flags['quality-threshold'],
        }),
        t('error_messages.quality_threshold_hint'),
      );
    }
    qualityThreshold = parsed;
  }
  return {
    model: flags.model,
    provider: flags.provider?.toLowerCase() as ProviderType | undefined,
    tier,
    topology,
    effort,
    // Cascade is `undefined` when --cascade is absent so that the
    // agentRuntime's late-stage override does NOT clobber the constructor
    // default (smartRouterActive = true). Only an explicit --cascade flips
    // it to true. (Audit P0-2 follow-up — fixes the regression where
    // boolean-default disabled the smart router for every CLI invocation.)
    cascade: 'cascade' in flags ? true : undefined,
    qualityThreshold,
  };
}

// Single source of truth for --tier → model-tier mapping. Both cmdRunInternal
// and cmdWatchInternal's contextData lift prefix preferredModelTier with
// TIER_MAP[flags.tier] so the smart router and effort→tier cascade agree.
// Exported would be better, but core.ts is CLI-only so inline is fine.
// (Audit P0-2 follow-up.)
const TIER_MAP: Record<
  NonNullable<RoutingFlags['tier']>,
  'eco' | 'standard' | 'power' | 'consensus'
> = {
  speed: 'eco',
  balanced: 'standard',
  power: 'power',
};

// ── Tiny edit-distance helpers (UX audit P0-1 follow-up) ───────────────────
// Used by parseRoutingFlags to render "Did you mean --tier=balanced?"-style
// suggestions instead of ejecting the user with a dead-end. Standard
// Wagner-Fischer dynamic programming, in-place swap, no deps. Returned
// suggestion is the closest allowed value whose edit-distance is ≤ 2 and
// less than half the input length — both gates prevent nonsense matches
// like "Did you mean --tier=power?" for "?".
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function didYouMean(input: string, allowed: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  let best: { candidate: string; distance: number } | undefined;
  for (const candidate of allowed) {
    const d = levenshtein(lower, candidate.toLowerCase());
    if (!best || d < best.distance) best = { candidate, distance: d };
  }
  // Single-gate threshold: cap at min(2, ceil(length*0.4)). The previous
  // two-gate (`distance ≤ 2 AND distance < length/2`) silently dropped the
  // genuine typo case "spd" → "speed" (distance 2, length 3, 2<1.5=false).
  // Reviewer catch (UX audit P0-1 follow-up).
  if (best && best.distance <= Math.min(2, Math.ceil(lower.length * 0.4))) {
    return best.candidate;
  }
  return undefined;
}

/**
 * Unified run command — replaces plan, watch, and goal.
 *
 * Flags:
 *   --dry-run        Show plan without executing (replaces `plan`)
 *   --stream         Real-time SSE progress (replaces `watch`)
 *   --mode=goal      Multi-agent goal loop (replaces `goal`)
 *   --mode=fast      Fast execution mode
 *   --mode=balanced  Balanced mode (default)
 *   --mode=thorough  Thorough mode
 *   --provider=X     Force provider
 *   --budget=N       Token budget
 *   --max-rounds=N   Max rounds (goal mode only)
 */
export async function cmdRun(task: string, flags: Record<string, string> = {}) {
  // Reject empty or whitespace-only tasks
  if (!task || !task.trim()) {
    console.error(
      `\n  ${$.red}${$.bold}${t('error.fatal')}${$.reset} ${t('error_messages.run.no_task')}\n\n  ${t('error_messages.run.no_task.usage')} ${$.cyan}${t('run.usage.template', { task: '<task>' })}${$.reset}\n  ${t('error_messages.run.no_task.example')} ${$.cyan}${t('run.example.analyze')}${$.reset}\n`,
    );
    process.exit(1);
  }
  task = task.trim();

  // ── Special: showcase ─────────────────────────────────────────────
  if (task.toLowerCase() === 'showcase') {
    return cmdShowcase();
  }

  // ── --tui: terminal dashboard (runs alongside execution) ──────────
  if ('tui' in flags) {
    // Fork TUI into a child process so the main execution continues.
    // The child subscribes to the message bus via IPC or shared state.
    const { fork } = nodeRequire('child_process');
    const tuiPath = nodeRequire('path').join(__dirname, '..', '..', 'tui', 'tuiProcess.js');
    // Try to spawn the TUI process — fall back to a warning if the module isn't built
    try {
      const child = fork(tuiPath, [], {
        stdio: 'inherit',
        env: { ...process.env, COMMANDER_TUI_PARENT_PID: String(process.pid) },
      });
      child.unref(); // Don't let the child prevent process exit
      console.log(`  ${$.dim}${t('run.tui.dashboard_started', { pid: child.pid })}${$.reset}`);
    } catch (err) {
      reportSilentFailure(err, 'core:276');
      console.log(`  ${$.yellow}⚠ ${t('run.tui.could_not_start')}${$.reset}`);
    }
  }

  const dryRun = 'dry-run' in flags;
  const stream = 'stream' in flags;
  const mode = flags.mode || 'balanced';
  const providerFlag = flags.provider?.toLowerCase();
  const budget = flags.budget ? parseInt(flags.budget, 10) : undefined;
  const maxRounds = flags['max-rounds'] ? parseInt(flags['max-rounds'], 10) : undefined;

  // --dry-run: show plan only (replaces `plan` command)
  if (dryRun) {
    return cmdPlanInternal(task);
  }

  // --mode=goal: multi-agent goal loop (replaces `goal` command)
  if (mode === 'goal') {
    return cmdGoalInternal(task, {
      mode: mode as GoalConfig['mode'],
      budgetTokens: budget,
      maxRounds,
      provider: providerFlag,
    });
  }

  // --stream: real-time SSE progress (replaces `watch` command)
  if (stream) {
    return cmdWatchInternal(task, parseRoutingFlags(flags));
  }

  // Default: full pipeline execution
  return cmdRunInternal(task, parseRoutingFlags(flags));
}

// ============================================================================
// Showcase: 3-agent DEBATE topology code audit
// ============================================================================

async function cmdShowcase() {
  const provider = detectProvider();
  const runtime = createRuntime();
  if (!runtime || !provider) {
    fatalError(t('error.no.apikey'), t('error.fix.apikey'));
  }

  // ── Header ────────────────────────────────────────────────────────
  console.log(
    `\n  ${$.bold}${$.blue}╭──────────────────────────────────────────────────────────╮${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}│${$.reset}  ${$.bold}${t('showcase.title')}${$.reset}              ${$.bold}${$.blue}│${$.reset}`,
  );
  console.log(
    `  ${$.bold}${$.blue}╰──────────────────────────────────────────────────────────╯${$.reset}\n`,
  );

  section(t('showcase.topology_header'));
  console.log(
    `  ${$.cyan}🔴 ${t('showcase.team.red')}${$.reset} ${$.dim}${t('showcase.team.red_role')}${$.reset}`,
  );
  console.log(
    `  ${$.cyan}🔵 ${t('showcase.team.blue')}${$.reset} ${$.dim}${t('showcase.team.blue_role')}${$.reset}`,
  );
  console.log(
    `  ${$.cyan}🟡 ${t('showcase.team.judge')}${$.reset} ${$.dim}${t('showcase.team.judge_role')}${$.reset}`,
  );

  kv(t('showcase.field.provider'), `${provider.type} · ${provider.defaultModel}`, $.cyan);
  console.log();

  // ── Phase 1: Execution ─────────────────────────────────────────────
  let result;
  try {
    console.log(`  ${$.dim}🔴 ${t('showcase.team.red')} ${t('showcase.team.red_role')}${$.reset}`);
    console.log(
      `  ${$.dim}🔵 ${t('showcase.team.blue')} ${t('showcase.team.blue_role')}${$.reset}`,
    );
    console.log(
      `  ${$.dim}🟡 ${t('showcase.team.judge')} ${t('showcase.team.judge_role')}${$.reset}\n`,
    );
    const agentDone = startSpinner(t('showcase.subtitle'));
    result = await runShowcase(runtime);
    agentDone();
  } catch (err) {
    console.error(
      `\n  ${$.red}${$.bold}${t('error.fatal')}${$.reset} ${t('showcase.error.showcase_failed', { message: (err as Error).message })}`,
    );
    console.error(`  ${$.dim}${t('showcase.error.check_api_key')}${$.reset}`);
    console.error(`  ${$.dim}${t('showcase.error.run_init')}${$.reset}\n`);
    return;
  }

  if (result.metrics.filesScanned === 0) {
    console.log(`\n  ${$.yellow}${t('showcase.files_scanned_zero').split('.')[0]}.${$.reset}`);
    console.log(`  ${$.dim}${$.cyan}commander run showcase${$.reset} ${$.dim}↩${$.reset}\n`);
    return;
  }

  // ── Results ───────────────────────────────────────────────────────
  section(t('showcase.execution_complete'));
  kv(t('showcase.field.files_scanned'), `${result.metrics.filesScanned}`, $.cyan);
  kv(
    t('showcase.field.red_team'),
    result.redTeamRaw.length > 0
      ? `${$.green}${t('history.phase.completed')}${$.reset} (${result.metrics.redTeamTokens.toLocaleString()} tok)`
      : `${$.red}${t('history.phase.failed')}${$.reset}`,
    result.redTeamRaw.length > 0 ? $.green : $.red,
  );
  kv(
    t('showcase.field.blue_team'),
    result.blueTeamRaw.length > 0
      ? `${$.green}${t('history.phase.completed')}${$.reset} (${result.metrics.blueTeamTokens.toLocaleString()} tok)`
      : `${$.red}${t('history.phase.failed')}${$.reset}`,
    result.blueTeamRaw.length > 0 ? $.green : $.red,
  );
  kv(
    t('showcase.field.judge'),
    result.judgeRaw.length > 0
      ? `${$.green}${t('history.phase.completed')}${$.reset} (${result.metrics.judgeTokens.toLocaleString()} tok)`
      : `${$.red}${t('history.phase.failed')}${$.reset}`,
    result.judgeRaw.length > 0 ? $.green : $.red,
  );
  kv(t('showcase.field.total_tokens'), `${result.metrics.totalTokens.toLocaleString()}`, $.yellow);
  kv(t('showcase.field.duration'), `${(result.metrics.durationMs / 1000).toFixed(1)}s`, $.yellow);

  // ── Scores ────────────────────────────────────────────────────────
  section(t('showcase.scores_header'));
  const scoreColor = (s: number) => (s >= 90 ? $.green : s >= 70 ? $.yellow : $.red);
  const grade = (s: number): string =>
    s >= 90
      ? t('showcase.grade.S')
      : s >= 80
        ? t('showcase.grade.A')
        : s >= 70
          ? t('showcase.grade.B')
          : s >= 60
            ? t('showcase.grade.C')
            : t('showcase.grade.D');

  console.log(
    `  🔒 ${$.bold}${t('showcase.score.security')}${$.reset}      ${scoreColor(result.metrics.securityScore)}${result.metrics.securityScore}/100${$.reset} ${$.dim}(${grade(result.metrics.securityScore)})${$.reset}`,
  );
  console.log(
    `  📝 ${$.bold}${t('showcase.score.code_quality')}${$.reset}   ${scoreColor(result.metrics.qualityScore)}${result.metrics.qualityScore}/100${$.reset} ${$.dim}(${grade(result.metrics.qualityScore)})${$.reset}`,
  );
  console.log(
    `  🏗️ ${$.bold}${t('showcase.score.architecture')}${$.reset}  ${scoreColor(result.metrics.architectureScore)}${result.metrics.architectureScore}/100${$.reset} ${$.dim}(${grade(result.metrics.architectureScore)})${$.reset}`,
  );
  console.log(`  ${$.dim}${'─'.repeat(30)}${$.reset}`);
  console.log(
    `  ${$.bold}${t('showcase.score.overall')}${$.reset}       ${scoreColor(result.metrics.overallScore)}${result.metrics.overallScore}/100${$.reset} ${$.dim}(${grade(result.metrics.overallScore)})${$.reset}\n`,
  );

  // ── Findings summary ─────────────────────────────────────────────
  const { critical, high } = result.findings;
  if (critical.length > 0) {
    section(`${t('showcase.critical_header')} (${critical.length})`);
    for (const f of critical.slice(0, 3)) {
      console.log(`  ${$.red}•${$.reset} ${f.slice(0, 120)}`);
    }
    if (critical.length > 3)
      console.log(`  ${$.dim}  ${t('showcase.more', { count: critical.length - 3 })}${$.reset}`);
  }
  if (high.length > 0) {
    section(`${t('showcase.high_header')} (${high.length})`);
    for (const f of high.slice(0, 3)) {
      console.log(`  ${$.yellow}•${$.reset} ${f.slice(0, 120)}`);
    }
    if (high.length > 3)
      console.log(`  ${$.dim}  ${t('showcase.more', { count: high.length - 3 })}${$.reset}`);
  }

  // ── Full report ───────────────────────────────────────────────────
  section(t('showcase.full_report'));
  console.log(result.report);
  console.log();
}

// ============================================================================
// Internal implementations
// ============================================================================

async function cmdPlanInternal(task: string) {
  cmdHeader(task);
  const done = startSpinner(t('plan.spinner'));
  const plan = deliberate(task);
  const effort = classifyEffortLevel(task);
  done();

  section(t('plan.section'));
  bullet(
    t('plan.task_label', { type: plan.taskType, effort, topology: plan.recommendedTopology }),
    $.cyan,
  );
  console.log();
  kv(t('plan.agents'), `${plan.estimatedAgentCount}`, $.yellow);
  kv(t('plan.steps'), `${plan.estimatedSteps}`, $.yellow);
  kv(
    t('plan.confidence'),
    `${(plan.confidence * 100).toFixed(0)}%`,
    plan.confidence > 0.7 ? $.green : $.yellow,
  );
  kv(
    t('plan.external_info_yes') + ' / ' + t('plan.external_info_no'),
    plan.requiresExternalInfo ? t('plan.external_info_yes') : t('plan.external_info_no'),
    plan.requiresExternalInfo ? $.yellow : $.dim,
  );
  kv(
    t('plan.tokens'),
    t('plan.tokens_breakdown', {
      total: plan.estimatedTokens.toLocaleString(),
      thinking: plan.tokenBudget.thinking.toLocaleString(),
      execution: plan.tokenBudget.execution.toLocaleString(),
    }),
  );
  kv(
    'Duration',
    t('plan.duration', {
      seconds: (plan.estimatedDurationMs / 1000).toFixed(1),
      perAgent: (plan.timeBudgetPerAgentMs / 1000).toFixed(1),
    }),
  );
  kv(
    'Task nature',
    plan.taskNature === 'IO_BOUND'
      ? t('plan.task_nature.IO')
      : plan.taskNature === 'COMPUTE_BOUND'
        ? t('plan.task_nature.COMPUTE')
        : plan.taskNature,
    plan.taskNature === 'IO_BOUND'
      ? $.cyan
      : plan.taskNature === 'COMPUTE_BOUND'
        ? $.yellow
        : $.dim,
  );
  kv(
    'Speculation',
    plan.suitableForSpeculation ? t('plan.speculation_yes') : t('plan.speculation_no'),
    plan.suitableForSpeculation ? $.green : $.dim,
  );

  if (plan.capabilitiesNeeded.length > 0) {
    section(t('plan.needs_section'));
    for (const cap of plan.capabilitiesNeeded) {
      bullet(cap);
    }
  }
}

async function cmdRunInternal(task: string, routingFlags: RoutingFlags = {}) {
  const provider = detectProvider(routingFlags.provider);
  const runtime = createRuntime(routingFlags.provider, routingFlags.model);
  if (!runtime || !provider) {
    fatalError(t('error.no.apikey'), t('plan.fail.no_runtime'));
  }

  cmdHeader(task);
  const rt: AgentRuntime = runtime;
  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  // ── Live CLI override wiring (no runtime restart required) ───────────────
  // --cascade toggles SmartModelRouter participation live.
  // --quality-threshold mutates the orchestrator's quality-gate config in
  //   place so the very next execute() call sees the updated thresholds.
  // Both setters mutate the existing instance instead of re-constructing.
  // --quality-threshold is the only knob that requires orchestrator-side
  // mutation (orchestrator owns the gate config and re-reads it during
  // execute()). The remaining CLI flags (--cascade, --model, --tier)
  // flow through contextData and are lifted by agentRuntime.ts's
  // late-stage override block onto ctx.preferredModel /
  // ctx.preferredModelTier / smartRouterActive BEFORE the routing
  // decision runs. (Audit P0-2 follow-up.)
  if (routingFlags.qualityThreshold !== undefined) {
    orch.setQualityGateThreshold('all', routingFlags.qualityThreshold);
  }

  let lastPhase = '';
  const startTime = Date.now();

  // Inject preferredModel / preferredModelTier / cascadeEnabled into
  // contextData so agentRuntime.ts's late-stage override block lifts them
  // onto ctx.preferredModel / ctx.preferredModelTier / smartRouterActive
  // before the routing decision runs.
  const availableTools = loadTools();
  const routingContextData: Record<string, unknown> = {
    availableTools,
    // ET-02: risk level is a measurement fed into the governance chain, not a
    // constant. Hardcoding 'LOW' disabled the approval/escalation gates.
    governanceProfile: { riskLevel: assessGovernanceRiskLevel(task, availableTools) },
  };
  if (routingFlags.model !== undefined) routingContextData.preferredModel = routingFlags.model;
  if (routingFlags.tier !== undefined) {
    const tierMap: Record<string, 'eco' | 'standard' | 'power' | 'consensus'> = {
      speed: 'eco',
      balanced: 'standard',
      power: 'power',
    };
    routingContextData.preferredModelTier = tierMap[routingFlags.tier];
  }
  if (routingFlags.cascade === true) routingContextData.cascadeEnabled = true;

  const result = await orch.execute({
    projectId: 'cli',
    agentId: 'commander-cli',
    tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
    goal: task,
    contextData: routingContextData,
    onProgress: (phase, detail) => {
      if (phase === 'COMPLETE') return;
      if (phase !== lastPhase) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const icons: Record<string, string> = {
          INIT: '📋',
          DELIBERATION: '🧠',
          EFFORT_SCALING: '📊',
          TOPOLOGY_ROUTING: '🔀',
          DECOMPOSITION: '📦',
          TEAM_FORMATION: '👥',
          EXECUTION: '⚡',
          SYNTHESIS: '🔗',
        };
        const phaseKey: Record<string, string> = {
          INIT: 'run.phase.init',
          DELIBERATION: 'run.phase.deliberation',
          EFFORT_SCALING: 'run.phase.effort_scaling',
          TOPOLOGY_ROUTING: 'run.phase.topology_routing',
          DECOMPOSITION: 'run.phase.decomposition',
          TEAM_FORMATION: 'run.phase.team_formation',
          EXECUTION: 'run.phase.execution',
          SYNTHESIS: 'run.phase.synthesis',
        };
        console.log(
          `  ${$.dim}[${elapsed}s]${$.reset} ${icons[phase] || ' '} ${$.bold}${t(phaseKey[phase] ?? 'help.title')}${$.reset} ${$.dim}${detail.slice(0, 70)}${$.reset}`,
        );
        lastPhase = phase;
      }
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();

  section(t('run.section.results'));
  const icon = result.status === 'SUCCESS' ? '✅' : result.status === 'PARTIAL' ? '⚠️' : '❌';
  const statusColor =
    result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red;
  console.log(
    `  ${icon} ${statusColor}${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s · ${result.metrics.totalTokens.toLocaleString()} tok · $${result.metrics.totalCostUsd.toFixed(4)}${$.reset}`,
  );

  if (result.status !== 'SUCCESS' && result.errors.length > 0) {
    console.log();
    for (const err of result.errors) {
      console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
    }
  }

  if (result.synthesis) {
    const preview = result.synthesis
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 8)
      .join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.synthesis.split('\n').filter((l) => l.trim()).length;
    if (totalLines > 8) console.log(`  ${$.dim}... (${totalLines - 8} more lines)${$.reset}`);
  }

  // ── Human feedback ──────────────────────────────────────────────
  await promptHumanFeedback(result.status === 'SUCCESS', task);

  console.log();

  // One-shot CLI run: dispose the runtime so background services (retention
  // janitor, OTel exporter timers, webhook dispatcher, supervisor) do not keep
  // the event loop alive after the result has been printed. The crash-safety
  // shutdown path has no force-exit, so also schedule an explicit exit once
  // pending stdout writes have had a chance to flush.
  rt.dispose();
  process.exitCode = result.status === 'SUCCESS' ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 50).unref();
}

async function cmdWatchInternal(task: string, routingFlags: RoutingFlags = {}) {
  const runtime = createRuntime(routingFlags.provider, routingFlags.model);
  if (!runtime) {
    fatalError(t('error.no.apikey'), t('plan.fail.no_runtime'));
  }
  const rt: AgentRuntime = runtime;

  const telos = new TELOSOrchestrator(rt);
  const orch = new UltimateOrchestrator(telos, rt);

  // Apply --quality-threshold live (orchestrator owns the gate config).
  // --cascade, --model, --tier flow through contextData below and are
  // lifted by agentRuntime.ts's late-stage override. (Audit P0-2 follow-up.)
  if (routingFlags.qualityThreshold !== undefined) {
    orch.setQualityGateThreshold('all', routingFlags.qualityThreshold);
  }

  cmdHeader(task);

  // Track metrics for live display
  let totalTokens = 0;
  let agentCount = 0;
  let toolCalls = 0;
  let eventCount = 0;
  const agents = new Map<string, { status: string; tokens: number }>();

  const sse = new SSEStream();
  sse.onEvent((event) => {
    try {
      const data = JSON.parse(event.replace(/^data: /, '').trim());
      eventCount++;
      const ts = new Date(data.timestamp || Date.now()).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      // Topic-specific rendering
      const topic = data.topic || 'unknown';
      const payload = data.payload || {};

      switch (topic) {
        case 'agent.started': {
          agentCount++;
          const agentId = payload.agentId || `agent-${agentCount}`;
          agents.set(agentId, { status: 'running', tokens: 0 });
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.green}▶${$.reset} ${$.bold}${agentId}${$.reset} ${$.dim}${t('run.sse.agent_started')}${$.reset}`,
          );
          break;
        }
        case 'agent.completed': {
          const agentId = payload.agentId || 'agent';
          const agent = agents.get(agentId);
          if (agent) agent.status = 'done';
          const tokens = payload.tokens || 0;
          if (tokens > 0) totalTokens += tokens;
          const completedLabel =
            tokens > 0
              ? t('run.sse.agent_completed_tokens', { tokens: tokens.toLocaleString() })
              : t('run.sse.agent_completed');
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.green}✓${$.reset} ${$.bold}${agentId}${$.reset} ${$.dim}${completedLabel}${$.reset}`,
          );
          break;
        }
        case 'agent.failed': {
          const agentId = payload.agentId || 'agent';
          const agent = agents.get(agentId);
          if (agent) agent.status = 'failed';
          const err = payload.error || 'unknown error';
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.red}✗${$.reset} ${$.bold}${agentId}${$.reset} ${$.red}${err.slice(0, 60)}${$.reset}`,
          );
          break;
        }
        case 'tool.executed': {
          toolCalls++;
          const toolName = payload.tool || 'tool';
          const duration = payload.durationMs ? `${(payload.durationMs / 1000).toFixed(1)}s` : '';
          const status =
            payload.success === false
              ? `${$.red}${t('run.sse.tool_failed')}${$.reset}`
              : `${$.cyan}→${$.reset}`;
          console.log(
            `  ${$.dim}${ts}${$.reset} ${status} ${$.dim}${toolName}${$.reset} ${$.gray}${duration}${$.reset}`,
          );
          break;
        }
        case 'agent.message': {
          const agentId = payload.agentId || 'agent';
          const msg = typeof payload.message === 'string' ? payload.message.slice(0, 80) : '';
          if (msg) {
            console.log(
              `  ${$.dim}${ts}${$.reset} ${$.cyan}💬${$.reset} ${$.dim}${t('run.sse.message_prefix', { agent: agentId })}${$.reset} ${msg}`,
            );
          }
          break;
        }
        case 'system.alert': {
          const level = payload.level || 'warn';
          const msg = payload.message || JSON.stringify(payload).slice(0, 80);
          const icon =
            level === 'error'
              ? `${$.red}${t('run.sse.alert_error')}${$.reset}`
              : `${$.yellow}${t('run.sse.alert_warn')}${$.reset}`;
          console.log(`  ${$.dim}${ts}${$.reset} ${icon} ${msg}`);
          break;
        }
        case 'token.usage': {
          const tokens = payload.totalTokens || payload.tokens || 0;
          if (tokens > 0) totalTokens += tokens;
          break;
        }
        default: {
          // Generic event — only show in verbose mode
          const payloadStr =
            typeof payload === 'object'
              ? JSON.stringify(payload).slice(0, 60)
              : String(payload).slice(0, 60);
          console.log(
            `  ${$.dim}${ts}${$.reset} ${$.gray}·${$.reset} ${$.dim}${topic}${$.reset} ${$.gray}${payloadStr}${$.reset}`,
          );
          break;
        }
      }
    } catch (err) {
      getGlobalLogger().debug('CLI', 'Failed to parse SSE event', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  console.log();

  const startTime = Date.now();
  let result: Awaited<ReturnType<typeof orch.execute>>;
  try {
    // Build routing context the same way cmdRunInternal does so that
    // agentRuntime's late-stage override can lift --cascade / --model /
    // --tier from contextData onto ctx.preferredModel / preferredModelTier
    // / smartRouterActive before the routing decision runs. The module-
    // scope TIER_MAP is the single source of truth. (Audit P0-2 follow-up.)
    const watchTools = loadTools();
    const watchContextData: Record<string, unknown> = {
      availableTools: watchTools,
      governanceProfile: { riskLevel: assessGovernanceRiskLevel(task, watchTools) },
    };
    if (routingFlags.model !== undefined) {
      watchContextData.preferredModel = routingFlags.model;
    }
    if (routingFlags.tier !== undefined) {
      watchContextData.preferredModelTier = TIER_MAP[routingFlags.tier];
    }
    if (routingFlags.cascade === true) {
      watchContextData.cascadeEnabled = true;
    }

    result = await orch.execute({
      projectId: 'cli',
      agentId: 'commander-cli',
      tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
      goal: task,
      contextData: watchContextData,
    });
  } finally {
    sse.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Final summary with live metrics
  section(t('watch.execution_summary'));
  const statusIcon =
    result.status === 'SUCCESS'
      ? `${$.green}✓${$.reset}`
      : result.status === 'PARTIAL'
        ? `${$.yellow}⚠${$.reset}`
        : `${$.red}✗${$.reset}`;
  console.log(`  ${statusIcon} ${$.bold}${result.status}${$.reset}  ${$.dim}${elapsed}s${$.reset}`);
  console.log();
  kv(t('watch.field.agents'), `${agentCount}`, $.cyan);
  kv(t('watch.field.tool_calls'), `${toolCalls}`, $.cyan);
  kv(t('watch.field.events'), `${eventCount}`, $.dim);
  kv(
    t('watch.field.tokens'),
    `${(totalTokens || result.metrics.totalTokens).toLocaleString()}`,
    $.yellow,
  );
  kv(t('watch.field.cost'), `$${(result.metrics.totalCostUsd || 0).toFixed(4)}`, $.dim);

  if (result.status !== 'SUCCESS' && result.errors.length > 0) {
    console.log();
    for (const err of result.errors) {
      console.log(`  ${$.red}✗${$.reset} ${err.message.slice(0, 120)}`);
    }
  }

  if (result.synthesis) {
    const preview = result.synthesis
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 6)
      .join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.synthesis.split('\n').filter((l) => l.trim()).length;
    if (totalLines > 6) console.log(`  ${$.dim}... (${totalLines - 6} more lines)${$.reset}`);
  }
  console.log();
}

// ============================================================================
// Human-in-the-Loop Feedback
// ============================================================================

async function promptHumanFeedback(_success: boolean, _task: string): Promise<void> {
  // Only prompt in interactive TTY mode
  if (!process.stdin.isTTY || process.env.CI || process.env.COMMANDER_NON_INTERACTIVE) return;

  console.log(
    `  ${$.dim}${t('run.feedback.prompt')}${$.reset} ${$.green}${t('run.feedback.good_option')}${$.reset} ${$.red}${t('run.feedback.bad_option')}${$.reset} ${$.dim}${t('run.feedback.skip_option')}${$.reset}`,
  );

  try {
    const answer = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(''), 15000); // Auto-skip after 15s
      const onData = (data: Buffer) => {
        clearTimeout(timer);
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) process.stdin.pause();
        resolve(data.toString().trim().toLowerCase());
      };
      process.stdin.resume();
      process.stdin.on('data', onData);
    });

    if (!answer) return; // Skip / timeout

    const ratedGood =
      answer.includes('👍') ||
      answer.includes('good') ||
      answer === 'y' ||
      answer === 'yes' ||
      answer === '1';
    const ratedBad =
      answer.includes('👎') ||
      answer.includes('wrong') ||
      answer.includes('bad') ||
      answer === 'n' ||
      answer === 'no' ||
      answer === '2';

    if (ratedGood || ratedBad) {
      try {
        const ml = getMetaLearner();
        // Human feedback carries 2x weight compared to automatic signals
        const exp = {
          runId: `human_feedback_${Date.now()}`,
          agentId: 'human-feedback',
          taskType: 'general',
          strategyUsed: 'UNKNOWN',
          success: ratedGood,
          durationMs: 0,
          tokenCost: 0,
          lessons: ratedGood ? ['Human rated this as helpful'] : ['Human rated this as incorrect'],
          errorPattern: ratedBad ? 'human_negative_feedback' : undefined,
          timestamp: new Date().toISOString(),
          modelUsed: 'human',
          id: `hf_${Date.now()}`,
          toolsUsed: [],
          topology: undefined,
        } as import('../../runtime/types').ExecutionExperience;
        ml.recordExperience(exp);
      } catch (err) {
        reportSilentFailure(err, 'core:923');
        /* best-effort */
      }
      const result = ratedGood
        ? `${$.green}${t('run.feedback.thanks_good')}${$.reset}`
        : `${$.red}${t('run.feedback.thanks_bad')}${$.reset}`;
      console.log(`  ${result}`);
    }
  } catch (err) {
    reportSilentFailure(err, 'core:932');
    // Timeout or read error — silently skip
  }
}

async function cmdGoalInternal(task: string, config: Partial<GoalConfig> & { provider?: string }) {
  const forcedProvider = config.provider?.toLowerCase() as ProviderType | undefined;
  const provider = detectProvider(forcedProvider);
  const runtime = createRuntime(forcedProvider);
  if (!runtime || !provider) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
  }

  cmdHeader(task);

  // Support --provider flag to force a specific provider
  let llmProvider: import('../../runtime/types').LLMProvider | undefined;

  if (forcedProvider) {
    llmProvider = runtime.getProvider(forcedProvider);
    if (!llmProvider) {
      console.error(
        `\n  ${$.red}${$.bold}ERROR${$.reset} Provider "${forcedProvider}" not available. Check your API key.\n`,
      );
      process.exit(1);
    }
  } else {
    llmProvider =
      runtime.getFirstAvailableProvider(provider.type) ??
      runtime.getProvider(provider.type) ??
      runtime.getProvider('openai') ??
      runtime.getProvider('anthropic') ??
      runtime.getProvider('openrouter') ??
      runtime.getProvider('mimo') ??
      runtime.getProvider('deepseek') ??
      runtime.getProvider('glm') ??
      runtime.getProvider('xiaomi') ??
      runtime.getProvider('google');
  }

  if (!llmProvider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No LLM provider available.\n`);
    process.exit(1);
  }

  const goalConfig: Partial<GoalConfig> = {};
  if (config.mode) goalConfig.mode = config.mode;
  if (config.budgetTokens) goalConfig.budgetTokens = config.budgetTokens;
  if (config.maxRounds) goalConfig.maxRounds = config.maxRounds;

  const orch = new GoalOrchestrator(llmProvider, goalConfig);

  console.log(
    `  ${$.dim}Provider:${$.reset} ${$.cyan}${forcedProvider ?? 'auto'}${$.reset}  ${$.dim}Mode:${$.reset} ${$.cyan}${goalConfig.mode ?? 'balanced'}${$.reset}  ${$.dim}Budget:${$.reset} ${$.cyan}${(goalConfig.budgetTokens ?? 100000).toLocaleString()} tok${$.reset}  ${$.dim}Max rounds:${$.reset} ${$.cyan}${goalConfig.maxRounds ?? 10}${$.reset}\n`,
  );

  const done = startSpinner('Goal loop running...');
  const startTime = Date.now();
  const result = await orch.execute(task);
  done();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('GOAL RESULT');
  const statusIcon =
    result.status === 'completed' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
  const statusColor =
    result.status === 'completed' ? $.green : result.status === 'partial' ? $.yellow : $.red;
  console.log(
    `  ${statusIcon} ${statusColor}${$.bold}${result.status.toUpperCase()}${$.reset}  ${$.dim}${elapsed}s · ${result.totalRounds} rounds · ${result.totalTokensUsed.toLocaleString()} tok${$.reset}\n`,
  );

  console.log(`  ${$.bold}Rounds:${$.reset} ${result.totalRounds}`);
  console.log(`  ${$.bold}Tokens:${$.reset} ${result.totalTokensUsed.toLocaleString()}`);
  console.log(`  ${$.bold}Duration:${$.reset} ${elapsed}s`);
  console.log();

  const lastRound = result.ledger[result.ledger.length - 1];
  if (lastRound) {
    console.log(
      `  ${$.bold}Stop reason:${$.reset} ${$.yellow}${lastRound.decisionReason}${$.reset}`,
    );
    if (lastRound.findingsTotal > 0) {
      console.log(
        `  ${$.bold}Remaining findings:${$.reset} ${$.red}${lastRound.findingsTotal}${$.reset}`,
      );
    }
    console.log(
      `  ${$.bold}Improvement trend:${$.reset} ${lastRound.improvementRate > 0.05 ? $.green + 'improving' : $.dim + 'plateaued'}${$.reset}`,
    );
  }

  if (result.summary) {
    const preview = result.summary
      .split('\n')
      .filter((l: string) => l.trim())
      .slice(0, 8)
      .join('\n  ');
    console.log(`\n  ${preview}`);
    const totalLines = result.summary.split('\n').filter((l: string) => l.trim()).length;
    if (totalLines > 8) console.log(`  ${$.dim}... (${totalLines - 8} more lines)${$.reset}`);
  }
  console.log();
}

export async function cmdCompany(
  task: string,
  options?: { mode?: string; budget?: number; userId?: string },
) {
  const runtime = createRuntime();
  if (!runtime) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
  }

  cmdHeader(task);
  section('COMPANY MODE');

  const telos = new TELOSOrchestrator(runtime);
  const orchestrator = new UltimateOrchestrator(telos, runtime);

  const engine = createCompanyEngine(orchestrator, {
    projectId: 'commander-cli',
    tenantId: getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
    userId: options?.userId,
    enableCapabilityMatching: true,
    enableQualityGating: true,
    enableMemory: true,
    tokenBudget: options?.budget ?? 100000,
  });

  kv('Mode', options?.mode ?? 'auto', $.cyan);
  kv('Budget', `${(options?.budget ?? 100000).toLocaleString()} tokens`, $.yellow);
  kv('Capability Matching', 'ON', $.green);
  kv('Quality Gating', 'ON', $.green);
  kv('Memory', 'ON', $.green);
  console.log();

  const done = startSpinner('Executing with Company Engine...');

  try {
    const result = await engine.execute({
      goal: task,
      agentId: 'commander-cli',
      onProgress: (_phase: string, _detail: string) => {},
    });

    done();

    section('EXECUTION');
    kv(
      'Status',
      result.status,
      result.status === 'SUCCESS' ? $.green : result.status === 'PARTIAL' ? $.yellow : $.red,
    );
    kv('Mode', result.executionMode, $.cyan);
    kv('Agents', result.agentsUsed.map((a: { agentId: string }) => a.agentId).join(', '), $.dim);
    kv('Tokens', `${(result.metrics?.totalTokens ?? 0).toLocaleString()}`, $.yellow);
    kv('Duration', `${((result.metrics?.totalDurationMs ?? 0) / 1000).toFixed(1)}s`, $.yellow);
    kv(
      'Quality',
      `${(result.qualityDecision.rollingQuality * 100).toFixed(0)}%`,
      result.qualityDecision.rollingQuality > 0.7 ? $.green : $.yellow,
    );
    kv('Strategy', result.matchResult.strategy, $.dim);
    kv('Savings', `~${result.estimatedSavings}%`, $.green);
    console.log();

    section('QUALITY');
    kv(
      'Action',
      result.qualityDecision.action,
      result.qualityDecision.action === 'escalate'
        ? $.yellow
        : result.qualityDecision.action === 'de-escalate'
          ? $.green
          : $.dim,
    );
    kv('Reason', result.qualityDecision.reason, $.dim);
    kv('Confidence', `${(result.qualityDecision.confidence * 100).toFixed(0)}%`, $.dim);
    console.log();

    if (result.summary) {
      section('SUMMARY');
      console.log(`  ${result.summary}`);
      console.log();
    }

    const stats = engine.getStats();
    section('ENGINE STATS');
    kv('Total Executions', `${stats.totalExecutions}`, $.dim);
    kv('Avg Quality', `${(stats.averageQuality * 100).toFixed(0)}%`, $.dim);
    kv('Avg Tokens', `${stats.averageTokens.toLocaleString()}`, $.dim);
    kv('Pool Size', `${stats.poolSize}`, $.dim);

    return result;
  } catch (err) {
    done();
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} ${(err as Error).message}\n`);
    throw err;
  }
}
