import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, type ExecFileOptions } from 'node:child_process';
import {
  executeReview,
  formatReviewOutput,
  reviewReportToJson,
  loadReviewGuidelines,
} from '../../reviewAgent';
import { $, section, kv, bullet, startSpinner } from './_shared';
import { PROVIDER_ORDER, type ProviderType } from '../../config/commanderConfig';

export async function cmdGui() {
  section('GUI DASHBOARD');
  const apiDir = path.join(process.cwd(), 'apps', 'api');
  const webDir = path.join(process.cwd(), 'apps', 'web');

  if (!fs.existsSync(path.join(apiDir, 'src', 'index.ts'))) {
    console.log(`  ${$.red}API server not found at apps/api/${$.reset}`);
    return;
  }

  console.log(`  ${$.green}Starting API server...${$.reset}`);
  console.log(`  ${$.green}Starting Web dashboard...${$.reset}`);
  console.log(
    `  ${$.dim}API:${$.reset}  http://localhost:4000/v1 (enterprise entry — see /v1/openapi.json)`,
  );
  console.log(`  ${$.dim}Web:${$.reset}  http://localhost:5173\n`);

  const bin = path.join(process.cwd(), 'node_modules', '.bin');
  const api = execFile(
    path.join(bin, 'tsx'),
    ['src/index.ts'],
    {
      cwd: apiDir,
      stdio: 'inherit',
      env: { ...process.env, PORT: '4000' },
    } as ExecFileOptions,
    () => {},
  );

  const web = execFile(
    path.join(bin, 'vite'),
    ['--port', '5173'],
    {
      cwd: webDir,
      stdio: 'inherit',
    } as ExecFileOptions,
    () => {},
  );

  setTimeout(() => {
    const url = 'http://localhost:5173';
    const cmd =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(cmd, [url], { stdio: 'ignore' } as ExecFileOptions, () => {}).unref();
  }, 3000);

  const cleanup = () => {
    api.kill();
    web.kill();
    process.exit(0);
  };
  api.on('exit', cleanup);
  web.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await new Promise(() => {});
}

export async function cmdSkill(subargs: string[]) {
  const { getSkillSystem, SkillCurator } = await import('../../skills');
  const system = getSkillSystem();

  const sub = subargs[0] || 'help';

  if (sub === 'list' || sub === 'ls') {
    const catalog = await system.manager.list();
    if (catalog.length === 0) {
      console.log(`\n  ${$.dim}No skills found.${$.reset}\n`);
      return;
    }
    section(`SKILLS (${catalog.length})`);
    for (const entry of catalog) {
      const pin = entry.pinned ? '📌' : '  ';
      const qual = (entry.qualityScore * 100).toFixed(0);
      const used = entry.usageCount;
      console.log(
        `  ${pin} ${$.bold}${entry.name}${$.reset} ${$.dim}${entry.description.slice(0, 50)}${$.reset}`,
      );
      console.log(
        `      ${$.gray}quality: ${qual}% · uses: ${used} · ${entry.category} · [${entry.tags.join(', ')}]${$.reset}`,
      );
    }
    console.log();
    return;
  }

  if (sub === 'view') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander skill view <name>\n`);
      return;
    }
    const skill = await system.manager.get(name);
    if (!skill) {
      console.error(`  ${$.red}Skill "${name}" not found.${$.reset}\n`);
      return;
    }
    section(`SKILL: ${skill.name}`);
    kv('Description', skill.description);
    kv('Category', skill.metadata.category);
    kv('Tags', skill.metadata.tags.join(', '));
    kv('Quality', `${(skill.metadata.qualityScore * 100).toFixed(0)}%`);
    kv(
      'Usage',
      `${skill.metadata.usageCount} · success rate: ${(skill.metadata.avgSuccessRate * 100).toFixed(0)}%`,
    );
    kv('Pinned', skill.metadata.pinned ? 'Yes' : 'No', skill.metadata.pinned ? $.green : $.dim);
    kv('Source', skill.metadata.source);
    kv('Created', skill.metadata.createdAt.slice(0, 10));
    console.log(`\n  ${$.dim}${'-'.repeat(50)}${$.reset}`);
    console.log(`  ${skill.content.slice(0, 1000)}${skill.content.length > 1000 ? '\n  ...' : ''}`);
    console.log();
    return;
  }

  if (sub === 'create') {
    const name = subargs[1];
    const desc = subargs[2] || name;
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander skill create <name> [description]\n`);
      return;
    }
    const content = `# ${name}\n\n${desc}\n\n## Steps\n1. TBD`;
    const skill = await system.manager.create(name, content, {
      category: 'general',
      tags: [],
      source: 'user',
    });
    console.log(`  ${$.green}✓${$.reset} Created skill "${$.bold}${skill.name}${$.reset}"\n`);
    return;
  }

  if (sub === 'pin') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander skill pin <name>\n`);
      return;
    }
    await system.manager.setPinned(name, true);
    console.log(`  ${$.green}✓${$.reset} Pinned "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'unpin') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander skill unpin <name>\n`);
      return;
    }
    await system.manager.setPinned(name, false);
    console.log(`  ${$.green}✓${$.reset} Unpinned "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = subargs[1];
    if (!name) {
      console.error(`  ${$.red}Usage:${$.reset} commander skill delete <name>\n`);
      return;
    }
    await system.manager.delete(name);
    console.log(`  ${$.green}✓${$.reset} Deleted "${$.bold}${name}${$.reset}"\n`);
    return;
  }

  if (sub === 'curate') {
    section('CURATE');
    const done = startSpinner('Running curator...');
    const curator = new SkillCurator(system.manager);
    const report = await curator.curate();
    done();
    if (report.archived.length > 0) {
      console.log(`  ${$.yellow}Archived:${$.reset} ${report.archived.join(', ')}`);
    }
    if (report.consolidated.length > 0) {
      console.log(`  ${$.yellow}Consolidated:${$.reset} ${report.consolidated.join(', ')}`);
    }
    kv('Before', `${report.totalBefore}`, $.gray);
    kv('After', `${report.totalAfter}`, $.gray);
    kv('Archived', `${report.totalArchived}`, $.yellow);
    console.log();
    return;
  }

  console.log(`
  ${$.bold}SKILL COMMANDS${$.reset}
    ${$.cyan}commander skill list${$.reset}         List all skills
    ${$.cyan}commander skill view <name>${$.reset}  View skill details
    ${$.cyan}commander skill create <name>${$.reset} Create a new skill
    ${$.cyan}commander skill pin <name>${$.reset}    Pin a skill (protect from curator)
    ${$.cyan}commander skill unpin <name>${$.reset}  Unpin a skill
    ${$.cyan}commander skill delete <name>${$.reset} Delete a skill
    ${$.cyan}commander skill curate${$.reset}        Run curator (archive+consolidate)
  `);
}

export async function cmdReview(args: string[]) {
  const scope = args.includes('--commit')
    ? ('commit' as const)
    : args.includes('--branch')
      ? ('branch' as const)
      : ('uncommitted' as const);

  const baseIdx = args.indexOf('--base');
  const baseRef = baseIdx >= 0 && baseIdx + 1 < args.length ? args[baseIdx + 1] : undefined;

  const commitIdx = args.indexOf('--commit');
  const commitCandidate = commitIdx >= 0 ? args[commitIdx + 1] : undefined;
  const commitSha =
    commitCandidate && !commitCandidate.startsWith('--') ? commitCandidate : undefined;

  const useJson = args.includes('--json');
  const requireProvider = args.includes('--real');
  const providerEquals = args.find((arg) => arg.startsWith('--provider='));
  const providerIdx = args.indexOf('--provider');
  const providerRaw = providerEquals
    ? providerEquals.slice('--provider='.length)
    : providerIdx >= 0
      ? args[providerIdx + 1]
      : undefined;

  if (requireProvider && !providerRaw) {
    console.error(`\n  ${$.red}Review failed: --real requires --provider=<name>${$.reset}\n`);
    process.exit(1);
  }
  if (providerRaw && !PROVIDER_ORDER.includes(providerRaw as ProviderType)) {
    console.error(`\n  ${$.red}Review failed: unknown provider ${providerRaw}${$.reset}\n`);
    process.exit(1);
  }
  const provider = providerRaw as ProviderType | undefined;

  const loadedGuidelines = loadReviewGuidelines();

  const customGuidelineIdx = args.indexOf('--guidelines');
  const customGuidelines =
    customGuidelineIdx >= 0 && customGuidelineIdx + 1 < args.length
      ? args[customGuidelineIdx + 1].split('|')
      : [];

  section('CODE REVIEW');
  bullet(
    `Scope: ${scope}${baseRef ? ` (base: ${baseRef})` : ''}${commitSha ? ` (commit: ${commitSha})` : ''}`,
  );
  if (loadedGuidelines.guidelines.length > 0 || customGuidelines.length > 0) {
    bullet(`Guidelines: ${[...loadedGuidelines.guidelines, ...customGuidelines].length} rule(s)`);
  }
  if (requireProvider) {
    bullet(`Real provider: ${provider}`);
    bullet('Sends at most 15,000 diff characters; max 4,000 tokens; 8 MiB response cap');
    bullet('Caller-side timeout: 120 seconds; provider/model execution tools: none');
    bullet('The provider may retain the submitted diff under its own terms');
  }
  console.log();

  const done = startSpinner('Reviewing changes...');
  try {
    const report = await executeReview({
      scope,
      baseRef,
      commitSha,
      guidelines: [...loadedGuidelines.guidelines, ...customGuidelines],
      guidelineSources: [
        ...loadedGuidelines.sources,
        ...customGuidelines.map(() => '--guidelines'),
      ],
      outputFormat: useJson ? 'json' : 'text',
      requireProvider,
      provider,
    });
    done();

    if (useJson) {
      console.log(reviewReportToJson(report));
    } else {
      console.log(formatReviewOutput(report));
    }

    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    done();
    console.error(
      `\n  ${$.red}Review failed: ${err instanceof Error ? err.message : String(err)}${$.reset}\n`,
    );
    process.exit(1);
  }
}

export function cmdHelp(showAll = false) {
  console.log(`
  ${$.bold}${$.blue}╭──────────────────────────────────────────────────╮${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.bold}Praetor${$.reset} — multi-agent orchestration            ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}│${$.reset}  ${$.dim}one command · 5 topologies · 25 providers${$.reset}       ${$.bold}${$.blue}│${$.reset}
  ${$.bold}${$.blue}╰──────────────────────────────────────────────────╯${$.reset}

  ${$.bold}GETTING STARTED${$.reset}
    ${$.gray}$ praetor init${$.reset}                        ${$.dim}Zero-config setup + provider scan${$.reset}
    ${$.gray}$ praetor run "Hello, world!"${$.reset}         ${$.dim}Your first task${$.reset}
    ${$.gray}$ praetor run showcase${$.reset}                ${$.dim}3-agent code audit demo${$.reset}

  ${$.bold}CORE COMMANDS${$.reset}
    ${$.cyan}run <task> [flags]${$.reset}           Execute with full multi-agent pipeline
    ${$.cyan}review [--commit|--branch]${$.reset}   AI code review
    ${$.cyan}fix${$.reset}                           Auto-fix lint, formatting & type errors
    ${$.cyan}status${$.reset}                        System status & active provider
    ${$.cyan}config [sub]${$.reset}                  View/change settings
    ${$.cyan}history${$.reset}                       List past sessions

  ${$.bold}RUN FLAGS${$.reset}
    ${$.cyan}--dry-run${$.reset}              Show plan without executing
    ${$.cyan}--stream${$.reset}               Real-time SSE progress
    ${$.cyan}--tui${$.reset}                  Terminal dashboard with live topology
    ${$.cyan}--mode=<mode>${$.reset}          balanced (default), fast, thorough, goal
    ${$.cyan}--provider=<name>${$.reset}      Force provider (openai, anthropic, etc.)
    ${$.cyan}--budget=<tokens>${$.reset}      Token budget (default: 100000)

  ${$.bold}MANAGEMENT${$.reset}
    ${$.cyan}init${$.reset}                    Scan env, test providers, save fallback chain
    ${$.cyan}doctor${$.reset}                  Run diagnostics
    ${$.cyan}mode [mode]${$.reset}             Approval mode (plan|read-only|suggest|auto-edit|full-auto)
    ${$.cyan}skill [sub]${$.reset}             Manage learnable skills (list, view, create, curate)
    ${$.cyan}plugin [sub]${$.reset}            Install, list, uninstall plugins
    ${$.cyan}gui${$.reset}                     Start Agent War Room web dashboard${
      showAll
        ? `

  ${$.bold}ADVANCED EXECUTION${$.reset}
    ${$.cyan}company <task>${$.reset}          Local company-mode: quality gating + memory ${$.yellow}(exp)${$.reset}
    ${$.cyan}swarm <task> [flags]${$.reset}    Recursive decomposition + parallel ${$.yellow}(exp)${$.reset}
    ${$.cyan}drive <task> [flags]${$.reset}    Autonomous step-by-step loop ${$.yellow}(exp)${$.reset}
    ${$.cyan}up [task] [flags]${$.reset}       Unified execution + Web TUI

  ${$.bold}INFRASTRUCTURE${$.reset}
    ${$.cyan}saga [sub]${$.reset}              Durable compensating transactions
    ${$.cyan}resume [runId]${$.reset}          Resume a crashed run from checkpoint
    ${$.cyan}compensation [sub]${$.reset}      Durable retry queue
    ${$.cyan}cost [--since]${$.reset}          Token usage & cost reports
    ${$.cyan}diagnose [--json]${$.reset}       V2 distributed stack health diagnostics

  ${$.bold}MISC${$.reset}
    ${$.cyan}completion [shell]${$.reset}      Shell autocompletion (bash, zsh, fish)
    ${$.cyan}feedback [--rating|--bug]${$.reset} Submit feedback to improve Praetor`
        : ''
    }

  ${$.bold}PROFILES${$.reset}
    ${$.cyan}local${$.reset}        Local CLI SKU (default). Runs in-process; no gateway, no multi-tenancy.
    ${$.yellow}local·exp${$.reset}    Experimental one-run-model extension (still local).
    ${$.dim}Enterprise routing is via POST /v1/runs (Enterprise Gateway SKU, alpha), not a CLI command.${$.reset}

  ${$.bold}OPTIONS${$.reset}
    ${$.cyan}--version${$.reset}               Show version
    ${$.cyan}--help${$.reset}                  Show this help
    ${$.cyan}--help --all${$.reset}            Show all commands

  ${$.dim}Run ${$.cyan}praetor <command> --help${$.reset}${$.dim} for command-specific help.${$.reset}
  `);
}
