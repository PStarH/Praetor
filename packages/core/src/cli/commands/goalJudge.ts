/**
 * CLI: commander goal judge — Independent goal verification
 *      commander goal conditions — Stop condition management
 */
import { getGoalJudge, type StopCondition } from '../../runtime/goalJudge';

interface FlagMap {
  set?: string;
  list?: boolean;
  delete?: string;
  clear?: boolean;
  global?: boolean;
  add?: string;
  type?: string;
  pattern?: string;
  threshold?: string;
  custom?: string;
  model?: string;
  budget?: string;
}

import { $ } from '../util';

// Color helpers (consistent with the rest of the CLI)
const res = $.reset;
const bold = (s: string) => `${$.bold}${s}${$.reset}`;
const dim = (s: string) => `${$.dim}${s}${$.reset}`;
const green = (s: string) => `${$.green}${s}${$.reset}`;
const red = (s: string) => `${$.red}${s}${$.reset}`;
const yellow = (s: string) => `${$.yellow}${s}${$.reset}`;
const cyan = (s: string) => `${$.cyan}${s}${$.reset}`;

const TYPE_LABELS: Record<string, string> = {
  MUST_HAVE: 'MUST_HAVE',
  MUST_NOT_HAVE: 'MUST_NOT_HAVE',
  MUST_MATCH: 'MUST_MATCH',
  MUST_BE_ABOVE: 'MUST_BE_ABOVE',
  CUSTOM: 'CUSTOM',
};

export function formatJudgeVerdict(verdict: {
  passed: boolean;
  confidence: number;
  reasoning: string;
  evidence: string[];
  conditionsChecked: Array<{
    conditionId: string;
    description: string;
    passed: boolean;
    evidence: string;
  }>;
  modelUsed: string;
  tokensUsed: number;
  timestamp: number;
}): string {
  const lines: string[] = [];
  const statusColor = verdict.passed ? green : red;
  const statusIcon = verdict.passed ? '✅ PASS' : '❌ FAIL';

  lines.push('');
  lines.push(statusColor(`${statusIcon}  ${bold('Goal Judge Verdict')}`));
  lines.push('');
  const confColor = verdict.confidence >= 0.8 ? $.green : $.yellow;
  lines.push(
    `${bold('Confidence:')} ${confColor}${(verdict.confidence * 100).toFixed(0)}%${$.reset}`,
  );
  lines.push(
    `${bold('Model:')}      ${cyan(verdict.modelUsed)}  ${dim(`(${verdict.tokensUsed} tokens)`)}`,
  );
  lines.push(`${bold('Reasoning:')}  ${verdict.reasoning}`);
  lines.push('');

  if (verdict.conditionsChecked.length > 0) {
    lines.push(bold('Stop Conditions:'));
    for (const c of verdict.conditionsChecked) {
      const icon = c.passed ? '✅' : '❌';
      const color = c.passed ? green : red;
      lines.push(`  ${icon} ${color(`[${c.conditionId}]`)} ${c.description}`);
      lines.push(`     ${dim(c.evidence)}`);
    }
    lines.push('');
  }

  if (verdict.evidence.length > 0) {
    lines.push(bold('Evidence:'));
    for (const e of verdict.evidence) {
      const icon = e.startsWith('PASSED')
        ? '✅'
        : e.startsWith('FAILED') ||
            e.startsWith('WARNING') ||
            e.startsWith('SUSPICIOUS') ||
            e.startsWith('INSUFFICIENT') ||
            e.startsWith('RELEVANCE')
          ? '❌'
          : '📋';
      lines.push(`  ${icon} ${e}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function cmdGoalJudge(
  args: string[],
  flags: FlagMap,
  _provider?: unknown,
): Promise<void> {
  const goalJudge = getGoalJudge();

  // commander goal conditions
  if (args[0] === 'conditions') {
    const subCmd = args[1];

    if (subCmd === 'list' || flags.list) {
      const globalConditions = goalJudge.getGlobalStopConditions();
      if (globalConditions.length === 0) {
        console.log(`\n${dim('  No global stop conditions set.')}${res}`);
        console.log(
          `${dim('  Use \'commander goal conditions set --id=<id> --desc="..." --type=MUST_HAVE\' to add one.')}${res}\n`,
        );
      } else {
        console.log(
          `\n${bold('Global Stop Conditions')} ${dim(`(${globalConditions.length})`)}${res}\n`,
        );
        for (const c of globalConditions) {
          const typeLabel = TYPE_LABELS[c.type] ?? c.type;
          console.log(`  ${cyan(c.id)}${res}  ${dim(`[${typeLabel}]`)}${res}`);
          console.log(`  ${c.description}`);
          if (c.pattern) console.log(`  ${dim('Pattern:')} ${c.pattern}`);
          if (c.threshold !== undefined) console.log(`  ${dim('Threshold:')} ${c.threshold}`);
          if (c.customPrompt) console.log(`  ${dim('Custom:')} ${c.customPrompt.slice(0, 80)}...`);
          console.log('');
        }
      }
      return;
    }

    if (subCmd === 'set' && flags.add) {
      const desc = (flags as Record<string, string | undefined>).desc ?? flags.add;
      const condition: StopCondition = {
        id: flags.add,
        description: desc,
        type: (flags.type as StopCondition['type']) ?? 'MUST_HAVE',
        pattern: flags.pattern,
        threshold: flags.threshold ? parseInt(flags.threshold, 10) : undefined,
        customPrompt: flags.custom,
      };

      const existing = goalJudge.getGlobalStopConditions();
      const updated = existing.filter((c) => c.id !== condition.id);
      updated.push(condition);
      goalJudge.setGlobalStopConditions(updated);

      console.log(`\n${green('✅')} Stop condition ${cyan(condition.id)}${res} added.`);
      console.log(`   ${bold('Type:')} ${TYPE_LABELS[condition.type]}`);
      console.log(`   ${condition.description}\n`);
      return;
    }

    if (subCmd === 'delete' && flags.delete) {
      const existing = goalJudge.getGlobalStopConditions();
      const updated = existing.filter((c) => c.id !== flags.delete);
      if (updated.length === existing.length) {
        console.log(`\n${red('❌')} Condition ${cyan(flags.delete)}${res} not found.\n`);
      } else {
        goalJudge.setGlobalStopConditions(updated);
        console.log(`\n${green('✅')} Condition ${cyan(flags.delete)}${res} deleted.\n`);
      }
      return;
    }

    if (subCmd === 'clear' || flags.clear) {
      goalJudge.setGlobalStopConditions([]);
      console.log(`\n${green('✅')} All stop conditions cleared.\n`);
      return;
    }

    // Default: show conditions subcommand help
    console.log(`\n${bold('commander goal conditions')}${res}\n`);
    console.log(`  ${bold('Subcommands:')}`);
    console.log(`    list                    List global stop conditions`);
    console.log(`    set --add=<id> [...]    Add/update a stop condition`);
    console.log(`    delete --delete=<id>     Remove a stop condition`);
    console.log(`    clear                   Clear all stop conditions\n`);
    console.log(`  ${bold('Set flags:')}`);
    console.log(`    --add=<id>              Condition ID (e.g., "no-ts-errors")`);
    console.log(`    --desc=<text>           Human-readable description`);
    console.log(
      `    --type=<type>           MUST_HAVE | MUST_NOT_HAVE | MUST_MATCH | MUST_BE_ABOVE | CUSTOM`,
    );
    console.log(
      `    --pattern=<regex>       Pattern to match (for MUST_MATCH/MUST_HAVE/MUST_NOT_HAVE)`,
    );
    console.log(`    --threshold=<N>         Numeric threshold (for MUST_BE_ABOVE)`);
    console.log(`    --custom=<prompt>       Custom evaluation prompt (for CUSTOM)\n`);
    console.log(`  ${dim('Examples:')}`);
    console.log(
      `    ${dim('commander goal conditions set --add=no-ts-errors --desc="No TypeScript errors" --type=MUST_NOT_HAVE --pattern="error TS"')}`,
    );
    console.log(
      `    ${dim('commander goal conditions set --add=all-tests-pass --desc="All tests passing" --type=MUST_HAVE --pattern="Tests:.*0 failed"')}`,
    );
    console.log(`    ${dim('commander goal conditions list')}\n`);
    return;
  }

  // commander goal judge <runId>
  if (args[0] === 'judge') {
    const task = args.slice(1).join(' ');

    if (!task) {
      console.log(`\n${red('❌')} Usage: commander goal judge <task description>\n`);
      console.log(
        `${dim('  Example: commander goal judge "Fix all TypeScript errors in src/"')}\n`,
      );
      return;
    }

    console.log(`\n${bold('Judging:')} ${cyan(task)}${res}`);
    console.log(`${dim('Running independent goal judge...')}${res}`);

    // For CLI, use a rule-based verdict (no LLM provider in CLI context)
    const goalJudge = getGoalJudge();

    const verdict = await goalJudge.judge({
      runId: `cli-${Date.now()}`,
      goal: task,
      output: task, // In CLI mode, we judge the task itself against conditions
      evidenceCount: 0,
    });

    console.log(formatJudgeVerdict(verdict));
    return;
  }

  // Default: show help
  console.log(`\n${bold('commander goal judge')}${res}\n`);
  console.log(`  Run an independent goal verification against defined stop conditions.\n`);
  console.log(`  ${bold('Usage:')}`);
  console.log(`    commander goal judge <task>        Judge a task against stop conditions`);
  console.log(`    commander goal conditions [cmd]    Manage global stop conditions\n`);
  console.log(`  ${dim('Examples:')}`);
  console.log(
    `    ${dim('commander goal conditions set --add=no-err --desc="No errors" --type=MUST_NOT_HAVE')}`,
  );
  console.log(`    ${dim('commander goal judge "Fix all TypeScript errors"')}`);
  console.log(`    ${dim('commander goal conditions list')}\n`);
}

/**
 * Format judge verdict for display in the TUI/dashboard.
 */
export function formatJudgeVerdictCompact(verdict: {
  passed: boolean;
  confidence: number;
  reasoning: string;
  modelUsed: string;
  tokensUsed: number;
}): string {
  const icon = verdict.passed ? '✅' : '❌';
  const pct = `${(verdict.confidence * 100).toFixed(0)}%`;
  return `${icon} Judge: ${verdict.passed ? 'PASS' : 'FAIL'} (${pct}) via ${verdict.modelUsed} (${verdict.tokensUsed}t)`;
}
