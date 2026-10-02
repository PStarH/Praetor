/**
 * commander security <subcommand> [args] — Adversarial / compliance test batteries.
 *
 * Wires the standalone security CLI scripts (which live under `src/security/`
 * and are designed to be run with the installed `tsx` binary) into the top-level
 * `commander` CLI as `commander security <sub>` subcommands.
 *
 * Each underlying script is self-executing (it calls `main()` at module
 * top-level and parses `process.argv` itself), so this dispatcher runs each
 * one in a child process rather than importing it. That:
 *   - preserves each script's own argv parsing unchanged,
 *   - avoids triggering their top-level `main()` on import, and
 *   - keeps the heavy test harnesses out of the main CLI process.
 *
 * Subcommand → script mapping:
 *   redteam             → security/runRedTeamBattery.ts
 *   compliance-audit    → security/runComplianceAudit.ts
 *   adversarial-llm     → security/runAdversarialLLMTest.ts
 *   hard-adversarial    → security/hardAdversarialTest.ts
 *   unknown-adversarial → security/unknownAdversarialTest.ts
 *
 * Runner resolution:
 *   - If a compiled `.js` exists next to the source, run it with `node`
 *     (production install, no `tsx` required).
 *   - Otherwise fall back to the installed `tsx` binary (dev checkout).
 *
 * The scripts can still be run standalone, e.g.:
 *   node_modules/.bin/tsx packages/core/src/security/runComplianceAudit.ts
 *   node_modules/.bin/tsx packages/core/src/security/runRedTeamBattery.ts --rounds 3
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'fs';
import path from 'path';
import { $, section, bullet } from '../util';
import { getDirname } from '../../esmCompat';
const __dirname = getDirname(import.meta.url);

/** Maps a `commander security <sub>` subcommand to its standalone script. */
const SECURITY_SCRIPTS: Record<string, string> = {
  redteam: 'runRedTeamBattery.ts',
  'compliance-audit': 'runComplianceAudit.ts',
  'adversarial-llm': 'runAdversarialLLMTest.ts',
  'hard-adversarial': 'hardAdversarialTest.ts',
  'unknown-adversarial': 'unknownAdversarialTest.ts',
};

/**
 * Resolve the absolute path of a security script, preferring the compiled
 * `.js` (when running from `dist/`) and falling back to the `.ts` source.
 * Returns `{ path, useTsx }`.
 */
function resolveScript(scriptName: string): { path: string; useTsx: boolean } | null {
  // `cli/commands/security.{ts,js}` → `../../security/<script>`
  const securityDir = path.resolve(__dirname, '..', '..', 'security');
  const jsPath = path.join(securityDir, scriptName.replace(/\.ts$/, '.js'));
  const tsPath = path.join(securityDir, scriptName);

  if (existsSync(jsPath)) return { path: jsPath, useTsx: false };
  if (existsSync(tsPath)) return { path: tsPath, useTsx: true };
  return null;
}

/** Print usage / available subcommands. */
function printSecurityHelp(): void {
  section('commander security <subcommand> [args]');
  console.log(`  Run Commander's adversarial / red-team / compliance test batteries.\n`);
  console.log(`  ${$.bold}Subcommands:${$.reset}`);
  bullet(`${$.cyan}redteam${$.reset}             Red-team battery (runRedTeamBattery)`);
  bullet(`${$.cyan}compliance-audit${$.reset}    Compliance audit (runComplianceAudit)`);
  bullet(`${$.cyan}adversarial-llm${$.reset}     Adversarial LLM test (runAdversarialLLMTest)`);
  bullet(`${$.cyan}hard-adversarial${$.reset}    Hard adversarial test (hardAdversarialTest)`);
  bullet(
    `${$.cyan}unknown-adversarial${$.reset} Unknown-attack adversarial test (unknownAdversarialTest)`,
  );
  console.log(`\n  ${$.bold}Standalone usage (equivalent):${$.reset}`);
  bullet(
    `${$.dim}node_modules/.bin/tsx packages/core/src/security/runRedTeamBattery.ts [args]${$.reset}`,
  );
  bullet(
    `${$.dim}node_modules/.bin/tsx packages/core/src/security/runComplianceAudit.ts [args]${$.reset}`,
  );
  console.log(
    `\n  ${$.dim}Pass --help to a subcommand to see its own flags, e.g. ` +
      `commander security redteam --help${$.reset}\n`,
  );
}

/**
 * CLI entry point: `commander security <sub> [args...]`.
 * Spawns the matching standalone script with the remaining args, inheriting
 * stdio so each script's own CLI/help/progress output flows through.
 */
export async function cmdSecurity(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    printSecurityHelp();
    return;
  }

  const scriptName = SECURITY_SCRIPTS[subcommand];
  if (!scriptName) {
    console.log(
      `\n  ${$.red}✗${$.reset} Unknown security subcommand: ${$.bold}${subcommand}${$.reset}\n`,
    );
    printSecurityHelp();
    process.exitCode = 1;
    return;
  }

  const resolved = resolveScript(scriptName);
  if (!resolved) {
    console.log(
      `\n  ${$.red}✗${$.reset} Could not locate security script: ${$.bold}${scriptName}${$.reset}\n` +
        `  Looked under: ${path.resolve(__dirname, '..', '..', 'security')}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const passThroughArgs = args.slice(1);

  // Build the child argv. For `.js` we use the running node directly; for
  // `.ts` we use the installed tsx binary so the TypeScript source executes.
  const childCmd = resolved.useTsx
    ? path.join(process.cwd(), 'node_modules', '.bin', 'tsx')
    : process.execPath;
  const childArgs = [resolved.path, ...passThroughArgs];

  try {
    execFileSync(childCmd, childArgs, {
      stdio: 'inherit',
      env: { ...process.env },
    });
  } catch (err: unknown) {
    const errorWithStatus = err as { status?: number; code?: number };
    const exitCode = typeof errorWithStatus.status === 'number' ? errorWithStatus.status : (errorWithStatus.code ?? 1);
    process.exitCode = exitCode;
    if (typeof exitCode !== 'number' || exitCode === 0) {
      // Child printed output
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `\n  ${$.red}✗${$.reset} Subcommand ${$.bold}${subcommand}${$.reset} failed: ${msg}\n` +
          `  Tip: run standalone with ${$.dim}node_modules/.bin/tsx packages/core/src/security/${scriptName}${$.reset}\n`,
      );
    }
  }
}
