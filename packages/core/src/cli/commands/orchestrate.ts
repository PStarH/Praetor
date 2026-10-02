import { detectProvider, type ProviderType } from '../../config/commanderConfig';
import type { LLMProvider } from '../../runtime/types';
import type { GoalConfig } from '../../goal/types';
import { GoalOrchestrator } from '../../goal/goalOrchestrator';
import { SwarmOrchestrator } from '../../swarm/swarmOrchestrator';
import type { SwarmConfig } from '../../swarm/types';
import { DriveOrchestrator } from '../../drive/driveOrchestrator';
import type { DriveConfig } from '../../drive/types';
import { createRuntime, $, section, cmdHeader, startSpinner, fatalError } from './_shared';

export async function cmdGoal(task: string, flags: Record<string, string>) {
  const forcedProvider = flags.provider?.toLowerCase() as ProviderType | undefined;
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
  // Note: parseFlags strips the leading --, so flags.provider not flags['--provider']
  let llmProvider: LLMProvider | undefined;

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

  const config: Partial<GoalConfig> = {};
  if (flags.model) config.model = flags.model;
  else if (provider.defaultModel) config.model = provider.defaultModel;
  if (flags.mode) config.mode = flags.mode as GoalConfig['mode'];
  if (flags.budget) config.budgetTokens = parseInt(flags.budget, 10);
  if (flags['max-rounds']) config.maxRounds = parseInt(flags['max-rounds'], 10);

  const orch = new GoalOrchestrator(llmProvider, config);

  console.log(
    `  ${$.dim}Provider:${$.reset} ${$.cyan}${forcedProvider ?? 'auto'}${$.reset}  ${$.dim}Mode:${$.reset} ${$.cyan}${config.mode ?? 'balanced'}${$.reset}  ${$.dim}Budget:${$.reset} ${$.cyan}${(config.budgetTokens ?? 100000).toLocaleString()} tok${$.reset}  ${$.dim}Max rounds:${$.reset} ${$.cyan}${config.maxRounds ?? 10}${$.reset}\n`,
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

  if (result.ledger.length > 1) {
    console.log();
    section('ROUND HISTORY');
    for (const r of result.ledger) {
      const icon = r.decision === 'continue' ? '↻' : r.decision.startsWith('stop_') ? '■' : '?';
      const color = r.decision === 'continue' ? $.cyan : $.yellow;
      console.log(
        `  ${color}${icon}${$.reset} Round ${r.round}: ${r.findingsTotal} findings · ${(r.improvementRate * 100).toFixed(0)}% improvement · ${r.decision}`,
      );
    }
  }

  console.log();
}

export async function cmdSwarm(task: string, flags: Record<string, string>) {
  const forcedProvider = flags.provider?.toLowerCase() as ProviderType | undefined;
  const provider = detectProvider(forcedProvider);
  const runtime = createRuntime(forcedProvider);
  if (!runtime || !provider) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
  }

  cmdHeader(task);

  let llmProvider: LLMProvider | undefined;

  if (forcedProvider) {
    llmProvider = runtime.getProvider(forcedProvider);
    if (!llmProvider) {
      console.error(
        `\n  ${$.red}${$.bold}ERROR${$.reset} Provider "${forcedProvider}" not available.\n`,
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

  const swarmConfig: Partial<SwarmConfig> = {};
  if (flags.model) swarmConfig.model = flags.model;
  else if (provider.defaultModel) swarmConfig.model = provider.defaultModel;
  if (flags.mode)
    swarmConfig.goalConfig = { ...swarmConfig.goalConfig, mode: flags.mode as GoalConfig['mode'] };
  if (swarmConfig.model)
    swarmConfig.goalConfig = { ...swarmConfig.goalConfig, model: swarmConfig.model };
  if (flags.budget)
    swarmConfig.goalConfig = {
      ...swarmConfig.goalConfig,
      budgetTokens: parseInt(flags.budget, 10),
    };
  if (flags['max-rounds'])
    swarmConfig.goalConfig = {
      ...swarmConfig.goalConfig,
      maxRounds: parseInt(flags['max-rounds'], 10),
    };
  if (flags['max-depth']) swarmConfig.maxDepth = parseInt(flags['max-depth'], 10);
  if (flags['max-workers']) swarmConfig.maxWorkers = parseInt(flags['max-workers'], 10);

  const orch = new SwarmOrchestrator(llmProvider, swarmConfig);

  const modeLabel = flags['mode'] ?? 'balanced';
  const depthLabel = flags['max-depth'] ?? '3';
  console.log(
    `  ${$.dim}Mode:${$.reset} ${$.cyan}${modeLabel}${$.reset}  ${$.dim}Max depth:${$.reset} ${$.cyan}${depthLabel}${$.reset}  ${$.dim}Max workers:${$.reset} ${$.cyan}${flags['max-workers'] ?? 10}${$.reset}\n`,
  );

  const done = startSpinner('Swarm loop running...');
  const startTime = Date.now();
  const result = await orch.execute(task);
  done();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('SWARM RESULT');
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
  console.log(`  ${$.bold}Tree depth:${$.reset} ${result.topology.depth}`);
  console.log(`  ${$.bold}Managers:${$.reset} ${result.topology.managerCount}`);
  console.log(`  ${$.bold}Total nodes:${$.reset} ${result.topology.totalNodes}`);
  const fusionReports = result.fusionReports ?? [];
  console.log(
    `  ${$.bold}Fusion conflicts:${$.reset} ${fusionReports.reduce((s, r) => s + (r.conflicts?.length ?? 0), 0)}`,
  );
  console.log();

  if (fusionReports.some((r) => (r.conflicts?.length ?? 0) > 0)) {
    section('FUSION CONFLICTS');
    for (const report of fusionReports) {
      for (const conflict of report.conflicts ?? []) {
        const severityColor =
          conflict.severity === 'critical'
            ? $.red
            : conflict.severity === 'high'
              ? $.yellow
              : $.dim;
        console.log(`  ${severityColor}⚠ ${conflict.type}${$.reset} ${conflict.description}`);
        if (conflict.suggestedResolution) {
          console.log(`    ${$.dim}→ ${conflict.suggestedResolution}${$.reset}`);
        }
      }
    }
    console.log();
  }

  section('TOPOLOGY');
  console.log(
    `  ${$.bold}Levels:${$.reset} ${result.topology.levelBreaths.map((b, i) => `level ${i}: ${b} nodes`).join(' · ')}`,
  );
  console.log();
}

export async function cmdDrive(task: string, flags: Record<string, string>) {
  const forcedProvider = (flags.provider || flags['--provider'])?.toLowerCase() as ProviderType | undefined;
  const provider = detectProvider(forcedProvider);
  const runtime = createRuntime(forcedProvider);
  if (!runtime || !provider) {
    fatalError(
      'No API key found.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or another provider env var. Run: commander quickstart',
    );
  }

  cmdHeader(task);

  const llmProvider =
    (forcedProvider ? runtime.getProvider(forcedProvider) : undefined) ??
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

  if (!llmProvider) {
    console.error(`\n  ${$.red}${$.bold}ERROR${$.reset} No LLM provider available.\n`);
    process.exit(1);
  }

  const driveConfig: Partial<DriveConfig> = {};
  if (flags.model || flags['--model']) driveConfig.model = flags.model || flags['--model'];
  else if (provider.defaultModel) driveConfig.model = provider.defaultModel;
  const modeVal = flags.mode || flags['--mode'];
  if (modeVal) driveConfig.mode = modeVal as DriveConfig['mode'];
  const iterVal = flags.iterations || flags['--iterations'];
  if (iterVal) driveConfig.maxIterations = parseInt(iterVal, 10);
  if (flags.verbose || flags['--verbose']) driveConfig.verbose = true;

  const orch = new DriveOrchestrator(llmProvider, runtime, driveConfig);

  const modeLabel = modeVal ?? 'auto';
  console.log(
    `  ${$.dim}Mode:${$.reset} ${$.cyan}${modeLabel}${$.reset}  ${$.dim}Max iterations:${$.reset} ${$.cyan}${driveConfig.maxIterations ?? 20}${$.reset}\n`,
  );

  const done = startSpinner('Drive loop running...');
  const startTime = Date.now();
  const result = await orch.execute(task);
  done();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  section('DRIVE RESULT');
  const statusIcon =
    result.status === 'completed' ? '✅' : result.status === 'partial' ? '⚠️' : '❌';
  const statusColor =
    result.status === 'completed' ? $.green : result.status === 'partial' ? $.yellow : $.red;
  console.log(
    `  ${statusIcon} ${statusColor}${$.bold}${result.status.toUpperCase()}${$.reset}  ${$.dim}${elapsed}s · ${result.totalIterations} iterations · ${result.totalTokensUsed.toLocaleString()} tok${$.reset}\n`,
  );

  console.log(`  ${$.bold}Iterations:${$.reset} ${result.totalIterations}`);
  console.log(
    `  ${$.bold}Steps:${$.reset} ${result.steps.filter((s) => s.status === 'completed').length}/${result.steps.length}`,
  );
  console.log(`  ${$.bold}Tokens:${$.reset} ${result.totalTokensUsed.toLocaleString()}`);
  console.log(`  ${$.bold}Duration:${$.reset} ${elapsed}s`);
  console.log();

  const failed = result.steps.filter((s) => s.status === 'failed' || s.status === 'blocked');
  if (failed.length > 0) {
    section('BLOCKED STEPS');
    for (const s of failed) {
      console.log(`  ${$.red}⚠${$.reset} ${s.description}`);
      if (s.error) console.log(`    ${$.dim}${s.error.slice(0, 200)}${$.reset}`);
    }
    console.log();
  }

  section('STEP BREAKDOWN');
  for (const s of result.steps) {
    const icon =
      s.status === 'completed'
        ? '✅'
        : s.status === 'running'
          ? '↻'
          : s.status === 'blocked'
            ? '🚫'
            : s.status === 'failed'
              ? '❌'
              : '○';
    const color = s.status === 'completed' ? $.green : s.status === 'blocked' ? $.red : $.yellow;
    const retries = s.retryCount > 0 ? ` ${$.dim}(retries: ${s.retryCount})${$.reset}` : '';
    console.log(`  ${color}${icon}${$.reset} ${s.description}${retries}`);
  }
  console.log();
}
