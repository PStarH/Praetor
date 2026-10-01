#!/usr/bin/env node
/**
 * Commander CLI — Multi-Agent Orchestration System
 *
 * Usage:
 *   commander run <task> [flags]        Execute with full pipeline
 *   commander review [options]          Code review (P0-P3 findings)
 *   commander fix [--test]              Auto-fix lint/type errors
 *   commander company <task>            Company mode execution (local·exp)
 *   commander swarm <task> [flags]      Recursive swarm (local·exp)
 *   commander drive <task> [flags]      Autonomous drive loop (local·exp)
 *   commander init [flags]              Zero-config scan + fallback chain
 *   commander quickstart                Interactive setup guide
 *   commander doctor [--offline]        System diagnostics
 *   commander --version                 Show version
 *   commander help                      Show this help
 */
// NOTE: this import MUST stay first. ESM evaluates the static import list in
// source order, so this side-effect module loads the walk-up `.env` before any
// command/config module below is evaluated — several of them read `process.env`
// at module scope. Reordering it silently reintroduces the startup bug.
import './cli/bootstrapEnv';
import { reportSilentFailure } from './silentFailureReporter';
import { $, parseFlags, setTheme } from './cli/util';

// Initialize theme from env var before any output
if (process.env.COMMANDER_THEME) {
  setTheme(process.env.COMMANDER_THEME);
}
import {
  cmdRun,
  cmdCompany,
  cmdSwarm,
  cmdDrive,
  cmdStatus,
  cmdConfig,
  cmdDoctor,
  cmdGui,
  cmdSkill,
  cmdMode,
  cmdReview,
  cmdHistory,
  cmdHelp,
  cmdCompletion,
  cmdFeedback,
  cmdSaga,
  cmdCost,
  cmdResume,
  cmdCompensation,
  cmdInit,
  cmdQuickstart,
  cmdIntelligence,
  cmdExperience,
  cmdDebugIntent,
  cmdBudget,
  cmdCheckpoint,
  cmdGoalJudge,
  cmdPlugin,
  cmdUp,
  cmdJobs,
  cmdNotify,
  cmdSchedule,
  cmdWebhook,
  cmdSecurity,
  cmdWorkflow,
  cmdDiagnose,
  cmdAction,
} from './cli/commands';
import { cmdFix } from './cli/commands/convenience';
import { cmdSandbox } from './cli/commands/sandbox';
import { getDirname, getRequire } from './esmCompat';

const nodeRequire = getRequire(import.meta.url);
const __dirname = getDirname(import.meta.url);

// ============================================================================
// Per-command help text
// ============================================================================

// ============================================================================
// Command profiles (SKU honesty, WS8)
// ============================================================================
// Every CLI command belongs to a profile. Today the CLI never routes to the
// Enterprise Gateway (that path is `POST /v1/runs`); so the active profile is
// always `local`. `local·exp` marks experimental one-run-model verbs. No command
// may be labelled `enterprise` unless its handler actually calls `/v1`.
type CliProfile = 'local' | 'local·exp';

const COMMAND_PROFILES: Record<string, CliProfile> = {
  company: 'local·exp',
  swarm: 'local·exp',
  drive: 'local·exp',
  goal: 'local·exp',
};

function profileOf(cmd: string): CliProfile {
  return COMMAND_PROFILES[cmd] ?? 'local';
}

// The CLI is a Local CLI SKU tool. Gateway routing is via `POST /v1/runs`, not
// any CLI command. Returns `local` until a CLI command wires a `/v1` path.
function resolveActiveProfile(): CliProfile {
  return 'local';
}

const COMMAND_HELP: Record<string, string> = {
  run: `  ${$.bold}commander run <task> [flags]${$.reset}\n\n  Execute a task with the full multi-agent pipeline.\n\n  ${$.bold}Flags:${$.reset}\n    --dry-run              Show plan without executing\n    --stream               Real-time SSE progress streaming\n    --tui                  Terminal dashboard with live topology view\n    --mode=<mode>          Execution mode: balanced (default), fast, thorough, goal\n    --provider=<name>      Force provider (openai, anthropic, deepseek, etc.)\n    --budget=<tokens>      Token budget (default: 100000)\n    --max-rounds=<n>       Max rounds (goal mode only, default: 10)\n\n  ${$.dim}Examples:${$.reset}\n    commander run "Fix all TypeScript errors in src/"\n    commander run "Analyze auth module" --dry-run\n    commander run "Refactor auth" --stream\n    commander run showcase\n`,
  review: `  ${$.bold}commander review [flags]${$.reset}\n\n  Review code changes with AI-powered analysis.\n\n  ${$.bold}Flags:${$.reset}\n    --commit [sha]     Review a specific commit (or latest)\n    --branch           Review entire branch vs main\n    --base <ref>       Compare against a specific ref\n    --real             Require a real provider; never use heuristic fallback\n    --provider=<name>  Provider to use with --real\n    --json             Output as JSON\n    --guidelines <r>   Custom rules (pipe-separated)\n\n  ${$.dim}Example:${$.reset}\n    commander review --commit HEAD --real --provider=openai\n    commander review --branch --json\n`,
  fix: `  ${$.bold}commander fix [flags]${$.reset}\n\n  Auto-fix lint, formatting, and type errors.\n\n  ${$.bold}Flags:${$.reset}\n    --test              Also run tests after fixing\n\n  ${$.dim}Example:${$.reset}\n    commander fix\n    commander fix --test\n`,
  init: `  ${$.bold}commander init [flags]${$.reset}\n\n  Zero-config environment scan + fallback chain setup.\n  Scans API keys, tests connectivity to all providers, measures latency,\n  and saves the optimal fallback chain to .commander.json.\n\n  ${$.bold}Flags:${$.reset}\n    --skip-tests    Skip connectivity tests (scan keys only)\n    --timeout=<ms>  Per-provider test timeout (default: 5000)\n    --save          Save config only, skip getting-started guide\n\n  ${$.dim}Example:${$.reset}\n    commander init\n    commander init --timeout=3000\n`,
  status: `  ${$.bold}commander status${$.reset}\n\n  Show system status: provider, API keys, runtime, meta-learner stats.\n`,
  config: `  ${$.bold}commander config [subcommand]${$.reset}\n\n  ${$.bold}Subcommands:${$.reset}\n    show              Show current configuration\n    set <key> <val>   Set a config value\n    list-providers    List all available providers\n    list-models       List available models\n    test              Test API connection\n\n  ${$.dim}Example:${$.reset}\n    commander config set model gpt-4o\n    commander config test\n`,
  history: `  ${$.bold}commander history [subcommand]${$.reset}\n\n  ${$.bold}Subcommands:${$.reset}\n    (none)            List all sessions\n    view <runId>      View session details\n    delete <runId>    Delete a session\n    prune <keep>      Keep only the last N sessions\n`,
  doctor: `  ${$.bold}commander doctor [flags]${$.reset}\n\n  Run diagnostics: Node.js, API key, packages, git, workspace, connectivity.\n\n  ${$.bold}Flags:${$.reset}\n    --offline, --no-network   Skip provider connectivity; API key is optional\n`,
  gui: `  ${$.bold}commander gui${$.reset}\n\n  Start the Agent War Room web dashboard (API + Web UI).\n  One-click: starts API (port 4000) + Web (port 5173) and opens the browser.\n`,
  plugin: `  ${$.bold}commander plugin <subcommand>${$.reset}\n\n  Install, list, and uninstall Commander plugins.\n\n  ${$.bold}Subcommands:${$.reset}\n    install <source>   Install a plugin (npm package / github:user/repo / local path)\n    list (ls)          List installed plugins\n    uninstall <name>   Uninstall a plugin\n    info <name>        Show plugin details\n\n  ${$.dim}Examples:${$.reset}\n    commander plugin install @commander/web-scraper\n    commander plugin install ./my-plugin\n    commander plugin list\n`,
  up: `  ${$.bold}commander up [task] [flags]${$.reset}\n\n  Unified execution + Web TUI. Starts a local server (default port 4000) that\n  serves the web dashboard and optionally runs a task with live metrics.\n\n  ${$.bold}Flags:${$.reset}\n    --port=<n>      Server port (default: 4000)\n    --no-open       Do not auto-open the browser\n    --resume        Resume frozen runs from their checkpoints\n\n  ${$.dim}Examples:${$.reset}\n    commander up\n    commander up "audit this repo"\n    commander up --port=5000\n`,
  // ── Advanced execution (local·exp) ───────────────────────────────
  company: `  ${$.bold}commander company <task>${$.reset}\n\n  Execute with Company Engine (capability matching + quality gating + memory).\n\n  ${$.dim}Example:${$.reset}\n    commander company "Build a CLI tool"\n`,
  swarm: `  ${$.bold}commander swarm <task> [flags]${$.reset}\n\n  Recursive swarm: fission (decompose) + fusion (merge).\n\n  ${$.bold}Flags:${$.reset}\n    --max-depth=<n>                    Max tree depth (default: 3)\n    --max-workers=<n>                  Max parallel workers (default: 10)\n    --mode=<balanced|thorough|fast>    Execution mode\n\n  ${$.dim}Example:${$.reset}\n    commander swarm "Audit this codebase for security issues"\n`,
  drive: `  ${$.bold}commander drive <task> [flags]${$.reset}\n\n  Autonomous drive loop with step-by-step execution.\n\n  ${$.bold}Flags:${$.reset}\n    --mode=<auto|supervised>           Drive mode\n    --iterations=<n>                   Max iterations (default: 20)\n    --verbose                          Show detailed output\n\n  ${$.dim}Example:${$.reset}\n    commander drive "Set up CI/CD pipeline" --verbose\n`,
  mode: `  ${$.bold}commander mode [mode]${$.reset}\n\n  Show or set the approval mode.\n\n  ${$.bold}Modes:${$.reset}\n    plan         Analysis only, no modifications\n    read-only    No writes, no destructive ops\n    suggest      Prompts before risky operations\n    auto-edit    Allows most operations, flags sandbox escapes\n    full-auto    No approval gates\n\n  ${$.dim}Example:${$.reset}\n    commander mode auto-edit\n`,
  skill: `  ${$.bold}commander skill [subcommand]${$.reset}\n\n  ${$.bold}Subcommands:${$.reset}\n    list (ls)         List all skills\n    view <name>       View skill details\n    create <name>     Create a new skill\n    pin <name>        Pin a skill (protect from curator)\n    unpin <name>      Unpin a skill\n    delete (rm)       Delete a skill\n    curate            Run curator (archive + consolidate)\n`,
  saga: `  ${$.bold}commander saga <subcommand>${$.reset}\n\n  Manage saga runs (durable, compensating transactions).\n\n  ${$.bold}Subcommands:${$.reset}\n    run <name>            Run a built-in example saga\n    list                  List all runs (committed/aborted/in-progress)\n    status <runId>        Show a run's snapshot\n    resume <runId>        Inspect a resumable run\n    approve <runId> <nodeId>    Approve a pending approval\n    reject  <runId> <nodeId>    Reject a pending approval\n    examples              List built-in example sagas\n\n  ${$.bold}Run flags:${$.reset}\n    --input=<json>        Saga input (JSON)\n    --run-id=<id>         Custom run ID (default: <name>-<timestamp>)\n    --timeout=<ms>        Total timeout (default: 60000)\n    --in-memory           Use in-memory stores (no disk persistence)\n\n  ${$.dim}Examples:${$.reset}\n    commander saga examples\n    commander saga run order-fulfillment --input='{"orderId":"o_42","amount":100}'\n    commander saga list\n`,
  resume: `  ${$.bold}commander resume [runId]${$.reset}\n\n  Resume a crashed run from its last checkpoint.\n\n  ${$.bold}Usage:${$.reset}\n    commander resume              List all resumable runs\n    commander resume <runId>      Resume a specific run from checkpoint\n\n  ${$.dim}Examples:${$.reset}\n    commander resume\n    commander resume run_abc123\n`,
  compensation: `  ${$.bold}commander compensation [subcommand]${$.reset}\n\n  Manage durable compensation queue (crash-safe retry).\n\n  ${$.bold}Subcommands:${$.reset}\n    status               Show queue summary (pending/in-progress/escalated)\n    list                 List all queue items with details\n    retry <id>           Reset escalated item to pending for retry\n\n  ${$.bold}Flags (list):${$.reset}\n    --limit=<n>          Max items to show (default: 50)\n    --status=<s>         Filter by status (pending/in_progress/escalated)\n\n  ${$.dim}Examples:${$.reset}\n    commander compensation\n    commander compensation list --status=escalated\n    commander compensation retry <id>\n`,
  cost: `  ${$.bold}commander cost [flags]${$.reset}\n\n  View token usage and cost reports.\n\n  ${$.bold}Flags:${$.reset}\n    --format=<table|json|csv>   Output format (default: table)\n    --since=<date>              Filter by date (e.g., 2026-01-01)\n    --model=<name>              Filter by model\n    --provider=<name>           Filter by provider\n\n  ${$.dim}Example:${$.reset}\n    commander cost\n    commander cost --since=2026-06-01 --format=json\n`,
  completion: `  ${$.bold}commander completion [shell]${$.reset}\n\n  Generate shell autocompletion scripts.\n\n  ${$.bold}Shells:${$.reset}\n    bash      Generate bash completion\n    zsh       Generate zsh completion\n    fish      Generate fish completion\n    install   Auto-detect shell and install (default)\n\n  ${$.dim}Example:${$.reset}\n    commander completion install\n    source <(commander completion bash)\n`,
  intelligence: `  ${$.bold}commander intelligence [flags]${$.reset}\n\n  Show what Commander has learned from your usage.\n\n  ${$.bold}Flags:${$.reset}\n    (none)       Dashboard summary — key stats at a glance\n    --stats      MetaLearner: Thompson Sampling scores, regression alerts, suggestions\n    --skills     Extracted skills: auto-learned patterns from successful runs\n    --patterns   Failure patterns: repeated mistakes and warnings\n    --all        Show everything\n\n  ${$.dim}Examples:${$.reset}\n    commander intelligence\n    commander intelligence --stats\n    commander i --all\n`,
  feedback: `  ${$.bold}commander feedback [flags]${$.reset}\n\n  Submit feedback to help improve Commander.\n\n  ${$.bold}Flags:${$.reset}\n    --rating=<1-5>        Rate your experience\n    --message="<text>"    General feedback\n    --bug="<text>"        Report a bug\n    --feature="<text>"    Request a feature\n\n  ${$.bold}Subcommands:${$.reset}\n    stats                 View feedback summary\n\n  ${$.dim}Example:${$.reset}\n    commander feedback --rating=5 --message="Great tool!"\n    commander feedback --bug="crash on empty input"\n`,
  experience: `  ${$.bold}commander experience [subcommand] [flags]${$.reset}\n\n  Manage Commander's learned experience — skills, patterns, and MetaLearner.\n\n  ${$.bold}Subcommands:${$.reset}\n    status               Show what's currently learned (default)\n    reset                Reset learned experience\n\n  ${$.bold}Reset flags:${$.reset}\n    --skills             Reset extracted skills only\n    --patterns           Reset failure patterns only\n    --meta               Reset MetaLearner state only\n    --force              Skip confirmation prompt\n    (no flag)            Reset ALL experience\n\n  ${$.dim}Examples:${$.reset}\n    commander experience\n    commander experience reset --skills\n    commander experience reset --force\n`,
  debug: `  ${$.bold}commander debug intent [runId]${$.reset}\n\n  Show why the agent made a specific decision — the full decision chain.\n\n  ${$.bold}Usage:${$.reset}\n    commander debug intent              List all intent-captured runs\n    commander debug intent <runId>      Show decision chain tree\n\n  ${$.bold}Renders:${$.reset}\n    Goal → Model Selection → Thompson Sample → Strategy → Tool Choice → Verification Result\n\n  ${$.dim}Example:${$.reset}\n    commander debug intent\n    commander debug intent run_abc123\n`,
  goal: `  ${$.bold}commander goal <subcommand> [flags]${$.reset}\n\n  Multi-round goal-driven execution with independent judge verification.\n\n  ${$.bold}Subcommands:${$.reset}\n    judge <task>                   Judge a task against stop conditions\n    conditions [subcmd]            Manage global stop conditions\n\n  ${$.bold}Conditions subcommands:${$.reset}\n    list                           List all global stop conditions\n    set --add=<id> [...]           Add/update a stop condition\n    delete --delete=<id>           Remove a stop condition\n    clear                          Clear all stop conditions\n\n  ${$.bold}Condition flags (set):${$.reset}\n    --add=<id>                     Condition ID (e.g., "no-ts-errors")\n    --desc=<text>                  Human-readable description\n    --type=<type>                  MUST_HAVE | MUST_NOT_HAVE | MUST_MATCH | MUST_BE_ABOVE | CUSTOM\n    --pattern=<regex>              Pattern to match\n    --threshold=<N>                Numeric threshold (for MUST_BE_ABOVE)\n    --custom=<prompt>              Custom evaluation prompt (for CUSTOM)\n\n  ${$.dim}Examples:${$.reset}\n    commander goal conditions set --add=no-ts --desc="No TS errors" --type=MUST_NOT_HAVE --pattern="error TS"\n    commander goal conditions list\n    commander goal judge "Fix all TypeScript errors in src/"\n`,
  budget: `  ${$.bold}commander budget [runId]${$.reset}\n\n  View real-time token budget status across active runs.\n\n  ${$.bold}Usage:${$.reset}\n    commander budget                    List all active token budgets\n    commander budget <runId>            Detailed budget breakdown for a run\n\n  ${$.bold}Shows:${$.reset}\n    Per-run: phase (relaxed/moderate/tight/critical/exceeded), utilization bar chart\n    Per-sub-agent: allocated vs used tokens, over-budget warnings\n\n  ${$.dim}Example:${$.reset}\n    commander budget\n    commander budget ultimate_1718_42\n`,
  checkpoint: `  ${$.bold}commander checkpoint [runId] [flags]${$.reset}\n\n  View MiMo-style checkpoint documents. Written automatically at 20%, 45%, and 70%\n  token budget by an independent checkpoint-writer sub-agent (outside main agent attention).\n\n  ${$.bold}Usage:${$.reset}\n    commander checkpoint               List all checkpoint files\n    commander checkpoint <runId>       View specific checkpoint (progress + decisions)\n    commander checkpoint --prune N     Keep only the N newest checkpoints\n\n  ${$.bold}Shows:${$.reset}\n    Per-checkpoint: version, trigger%, progress (completed/pending/failed),\n    token budget bar, key decisions, errors, next action\n\n  ${$.dim}Examples:${$.reset}\n    commander checkpoint\n    commander checkpoint ultimate_1718_42\n    commander checkpoint --prune 20\n`,
  // ── Infrastructure ──────────────────────────────────────────────────────
  jobs: `  ${$.bold}commander jobs [jobId] [flags]${$.reset}\n\n  Manage background tasks (list, inspect, stop).\n\n  ${$.bold}Usage:${$.reset}\n    commander jobs                    List recent background jobs\n    commander jobs <jobId>            Show job details\n    commander jobs <jobId> --logs     Show last 50 log lines\n    commander jobs <jobId> --stop     Stop a running job\n`,
  notify: `  ${$.bold}commander notify <message> [flags]${$.reset}\n\n  Send a notification via configured channels.\n\n  ${$.bold}Flags:${$.reset}\n    --slack              Send via Slack\n    --discord            Send via Discord\n    --webhook            Send via custom webhook\n    --priority=<level>   low | normal | high | urgent\n`,
  schedule: `  ${$.bold}commander schedule <subcommand>${$.reset}\n\n  Manage the recurring task scheduler.\n\n  ${$.bold}Subcommands:${$.reset}\n    (none) | list        List scheduled tasks\n    add <name> <task>    Add a task (--cron="0 2 * * *" or --every="30m")\n    remove <id>          Remove a scheduled task\n    enable <id>          Enable a task\n    disable <id>         Disable a task\n`,
  webhook: `  ${$.bold}commander webhook <subcommand>${$.reset}\n\n  Manage webhook rules and start the webhook receiver.\n\n  ${$.bold}Subcommands:${$.reset}\n    (none) | list                          List webhook rules\n    add <source> --events <list> --task <t>  Add a rule (github/gitlab/bitbucket/custom)\n    remove <id>                            Remove a rule\n    start [--port=9876]                    Start the webhook server\n`,
  security: `  ${$.bold}commander security <subcommand> [args]${$.reset}\n\n  Run Commander's adversarial / red-team / compliance test batteries.\n\n  ${$.bold}Subcommands:${$.reset}\n    redteam              Red-team battery\n    compliance-audit     Compliance audit\n    adversarial-llm      Adversarial LLM test\n    hard-adversarial     Hard adversarial test\n    unknown-adversarial  Unknown-attack adversarial test\n\n  ${$.dim}Example:${$.reset}\n    commander security redteam --rounds 3\n`,
  workflow: `  ${$.bold}commander workflow <subcommand>${$.reset}\n\n  Manage workflows and the scheduler daemon.\n\n  ${$.bold}Subcommands:${$.reset}\n    ls                       List available and scheduled workflows\n    run <id>                Execute a workflow\n    create <name>           Scaffold a new workflow (--description= --cron=)\n    schedule <id>            Schedule a workflow (--cron="..." --interval="30m")\n    unschedule <id>          Remove a schedule\n    pause <id> | resume <id>  Pause / resume a schedule\n    history [wfId]          Show execution history\n    daemon                  Start the scheduler daemon\n    stop                     Stop the scheduler daemon\n`,
  diagnose: `  ${$.bold}commander diagnose [flags]${$.reset}\n\n  Run V2 distributed stack health diagnostics.\n\n  Checks four subsystems and prints a PASS/FAIL/WARN summary:\n    1. V2 kernel health    — DB connectivity, schema version, run/step counts\n    2. Worker plane health — env vars, V2 mode, worker registration & heartbeats\n    3. Storage backend     — backend type, production fail-closed posture\n    4. Security posture    — OutboundNetworkPolicy, ReversibilityGate, AnomalyDetector\n\n  ${$.bold}Flags:${$.reset}\n    --json     Machine-readable JSON output\n    --help     Show this help message\n\n  ${$.bold}Exit codes:${$.reset}\n    0  All critical checks passed\n    1  One or more critical checks failed\n\n  ${$.dim}Example:${$.reset}\n    commander diagnose\n    commander diagnose --json\n`,
};

function showCommandHelp(cmd: string): boolean {
  const help = COMMAND_HELP[cmd];
  if (!help) return false;
  const profile = profileOf(cmd);
  const profileLabel =
    profile === 'local·exp'
      ? `${$.yellow}local·exp${$.reset} (experimental)`
      : `${$.cyan}${profile}${$.reset}`;
  console.log(`${help}\n  ${$.bold}Profile:${$.reset} ${profileLabel}`);
  return true;
}

// ============================================================================
// Main entry
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === 'help') {
    cmdHelp(args.includes('--all'));
    process.exit(0);
  }

  // Cross-process rate limiting for costly CLI commands
  const { checkCliRateLimit } = await import('./cli/cliRateLimiter');
  if (!checkCliRateLimit(args[0])) {
    console.error(
      'Rate limit exceeded. Maximum 10 LLM-costly CLI invocations per minute. Please wait before retrying.',
    );
    process.exit(1);
  }

  if (args[0] === '--version' || args[0] === 'version') {
    try {
      // `../package.json` is packages/core/package.json from BOTH `src/` (dev,
      // tsx) and `dist/` (built) — they are sibling directories. The previous
      // `../../package.json` resolved to packages/package.json, which does not
      // exist, so `--version` always fell through to "unknown".
      const pkgPath = nodeRequire.resolve('../package.json');
      console.log(`${nodeRequire(pkgPath).version} (profile: ${resolveActiveProfile()})`);
    } catch (err) {
      reportSilentFailure(err, 'cli:120');
      console.log(`unknown (profile: ${resolveActiveProfile()})`);
    }
    process.exit(0);
  }

  const cmd = args[0];
  const rest = args.slice(1);

  // Per-command --help
  if (rest.includes('--help') || rest.includes('-h')) {
    if (showCommandHelp(cmd)) process.exit(0);
  }

  switch (cmd) {
    // ── Core execution ──
    case 'run': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0 || rest.includes('--help')) {
        showCommandHelp('run');
        process.exit(rest.includes('--help') ? 0 : 1);
      }
      await cmdRun(positional.join(' '), flags);
      break;
    }

    // ── Code review ──
    case 'review':
      await cmdReview(rest);
      break;

    // ── Auto-fix ──
    case 'fix':
      await cmdFix(parseFlags(rest).flags);
      break;

    // ── Setup ──
    case 'init':
      await cmdInit(parseFlags(rest).flags);
      break;
    case 'quickstart':
      if (rest.includes('--check')) {
        await cmdQuickstart(rest);
      } else {
        console.log(
          `\n  ${$.yellow}💡 Tip:${$.reset} 'quickstart' has been upgraded to ${$.cyan}commander init${$.reset}\n`,
        );
        await cmdInit(parseFlags(rest).flags);
      }
      break;

    // ── Management ──
    case 'status':
      await cmdStatus();
      break;
    case 'config':
      await cmdConfig(rest);
      break;
    case 'doctor':
      await cmdDoctor(rest);
      break;
    case 'gui':
      await cmdGui();
      break;
    case 'mode':
      await cmdMode(rest[0]);
      break;
    case 'history':
      await cmdHistory(rest);
      break;
    case 'skill':
      await cmdSkill(rest);
      break;
    case 'plugin':
      await cmdPlugin(rest);
      break;

    // ── Advanced execution ──
    case 'company':
      if (rest.length === 0 || rest[0] === '--help') {
        showCommandHelp('company');
        process.exit(rest.length === 0 ? 1 : 0);
      }
      await cmdCompany(rest.join(' '));
      break;
    case 'swarm': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0) {
        showCommandHelp('swarm');
        process.exit(1);
      }
      await cmdSwarm(positional.join(' '), flags);
      break;
    }
    case 'drive': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0) {
        showCommandHelp('drive');
        process.exit(1);
      }
      await cmdDrive(positional.join(' '), flags);
      break;
    }
    case 'up': {
      const { positional, flags } = parseFlags(rest);
      await cmdUp(positional, flags);
      break;
    }

    // ── Infrastructure ──
    case 'saga':
      await cmdSaga(rest);
      break;
    case 'jobs':
      await cmdJobs(rest);
      break;
    case 'notify': {
      const { positional, flags } = parseFlags(rest);
      if (positional.length === 0) {
        showCommandHelp('notify');
        process.exit(1);
      }
      await cmdNotify(positional.join(' '), flags);
      break;
    }
    case 'schedule':
      await cmdSchedule(rest);
      break;
    case 'webhook':
      await cmdWebhook(rest);
      break;
    case 'resume': {
      const { positional, flags } = parseFlags(rest);
      await cmdResume(positional, flags);
      break;
    }
    case 'compensation': {
      const { positional, flags } = parseFlags(rest);
      await cmdCompensation(positional, flags);
      break;
    }
    case 'cost': {
      const { flags } = parseFlags(rest);
      await cmdCost(flags);
      break;
    }

    // ── Misc ──
    case 'completion':
      await cmdCompletion(rest);
      break;
    // ── Intelligence ──
    case 'intelligence':
    case 'i': {
      const { flags } = parseFlags(rest);
      await cmdIntelligence(flags);
      break;
    }

    case 'feedback':
      await cmdFeedback(rest);
      break;

    // ── Experience ──
    case 'experience': {
      const { positional, flags } = parseFlags(rest);
      await cmdExperience(positional, flags);
      break;
    }

    // ── Debug ──
    case 'debug': {
      const { positional, flags } = parseFlags(rest);
      await cmdDebugIntent(positional, flags);
      break;
    }

    // ── Budget ──
    case 'budget': {
      const { positional, flags } = parseFlags(rest);
      await cmdBudget(positional, flags);
      break;
    }

    // ── Checkpoint ──
    case 'checkpoint':
    case 'cp':
      await cmdCheckpoint(rest);
      break;

    // ── Goal ──
    case 'goal': {
      const { positional, flags } = parseFlags(rest);
      await cmdGoalJudge(positional, flags);
      break;
    }

    // ── Sandbox ──
    case 'sandbox':
      await cmdSandbox(rest);
      break;

    // ── Security batteries ──
    case 'security':
      await cmdSecurity(rest);
      break;

    // ── Workflow scheduler ──
    case 'workflow':
    case 'wf':
      await cmdWorkflow(rest);
      break;

    // ── V2 distributed stack diagnostics ──
    case 'diagnose':
      await cmdDiagnose(rest);
      break;

    case 'action': {
      const { positional, flags } = parseFlags(rest);
      await cmdAction(positional, flags);
      break;
    }

    // ── Viz (execution topology visualizer) ──
    case 'viz': {
      // Security: Use spawn with explicit argv array instead of execSync with
      // template literal to prevent command injection via CLI arguments.
      // Per OWASP OS Command Injection Defense Cheat Sheet: avoid shell interpretation.
      const { spawn } = nodeRequire('child_process');
      const vizPath = nodeRequire('path').join(__dirname, '../../../viz/dist/index.js');
      try {
        spawn('node', [vizPath, ...rest], { stdio: 'inherit', shell: false });
      } catch (err) {
        reportSilentFailure(err, 'cli:299');
        console.error(
          `\n  ${$.yellow}⚠${$.reset} ${$.dim}Viz package not built. Run: cd packages/viz && pnpm build${$.reset}\n`,
        );
      }
      break;
    }

    default: {
      const validCmds = [
        'run',
        'review',
        'fix',
        'init',
        'status',
        'config',
        'doctor',
        'gui',
        'mode',
        'history',
        'skill',
        'plugin',
        'intelligence',
        'experience',
        'debug',
        'budget',
        'checkpoint',
        'cp',
        'goal',
        'company',
        'swarm',
        'drive',
        'up',
        'saga',
        'resume',
        'compensation',
        'cost',
        'completion',
        'feedback',
        'sandbox',
        'viz',
        'jobs',
        'notify',
        'schedule',
        'webhook',
        'security',
        'workflow',
        'diagnose',
        'action',
      ];
      const didYouMean = validCmds.filter((c) => c.startsWith(cmd.toLowerCase()));
      const hint =
        didYouMean.length > 0 ? ` Did you mean ${$.cyan}${didYouMean[0]}${$.reset}?` : '';
      console.error(
        `\n  ${$.red}${$.bold}Unknown command:${$.reset} ${cmd}${hint}\n\n  Run ${$.cyan}commander help${$.reset} to see available commands.\n`,
      );
      process.exit(1);
      break;
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} ${msg}`);
  if (err instanceof Error && err.stack) {
    // Show abbreviated stack in debug mode
    if (process.env.DEBUG || process.env.COMMANDER_DEBUG) {
      const stackLines = err.stack.split('\n').slice(1, 4);
      for (const line of stackLines) {
        console.error(`  ${$.dim}${line.trim()}${$.reset}`);
      }
    }
  }
  console.error(
    `  ${$.dim}Run ${$.cyan}commander doctor${$.reset}${$.dim} to diagnose issues.${$.reset}`,
  );
  console.error(
    `  ${$.dim}Run ${$.cyan}commander quickstart${$.reset}${$.dim} for setup guidance.${$.reset}\n`,
  );
  process.exit(1);
});
