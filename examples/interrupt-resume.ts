#!/usr/bin/env npx tsx
/**
 * Interrupt & Resume End-to-End Example — 中断恢复端到端示例
 *
 * 场景描述:
 *   演示任务执行中的中断与恢复。任务执行到中途时写入 checkpoint 并暂停
 *   (phase=interrupted)，随后通过 resume() 加载 checkpoint 并注入新的
 *   userInstructions 恢复执行，展示中断前后的状态对比。
 *
 * 关键 API: StateCheckpointer, checkpoint, resume, loadCheckpoint, CheckpointState
 * 运行方式: npx tsx examples/interrupt-resume.ts
 */
import { StateCheckpointer } from '@praetor/core/runtime';
import type { CheckpointState } from '@praetor/core/runtime';
import * as os from 'node:os';
import * as path from 'node:path';

async function main() {
  console.log('=== 中断恢复端到端示例 ===\n');

  // 使用临时目录存放 checkpoint，避免污染工作区
  const stateDir = path.join(os.tmpdir(), `commander-interrupt-${Date.now()}`);
  const checkpointer = new StateCheckpointer(stateDir);
  const runId = `run-${Date.now()}`;

  // 1) 模拟任务执行：第 1 步完成，写入 checkpoint
  console.log('--- 阶段 1: 任务开始执行 ---');
  const baseState: CheckpointState = {
    runId,
    agentId: 'commander',
    timestamp: new Date().toISOString(),
    phase: 'tool_execution',
    stepNumber: 1,
    attemptNumber: 1,
    messages: [{ role: 'user', content: '分析项目结构并生成报告' }],
    tokenUsage: { promptTokens: 120, completionTokens: 80, totalTokens: 200 },
    stepDurations: [340],
    context: {
      agentId: 'commander', projectId: 'demo', goal: '分析项目结构并生成报告',
      availableTools: ['file_read', 'file_search'], maxSteps: 10, tokenBudget: 64000,
    },
    totalDurationMs: 340,
  };
  checkpointer.checkpoint(baseState);
  console.log(`已写入 checkpoint: phase=${baseState.phase}, step=${baseState.stepNumber}, tokens=${baseState.tokenUsage.totalTokens}`);

  // 2) 中断任务（pause）：写入 interrupted 检查点
  console.log('\n--- 阶段 2: 任务被中断（pause）---');
  const pausedState: CheckpointState = {
    ...baseState,
    stepNumber: 2,
    phase: 'interrupted',
    timestamp: new Date().toISOString(),
    messages: [...baseState.messages, { role: 'assistant', content: '需要用户确认报告输出格式' }],
    tokenUsage: { promptTokens: 200, completionTokens: 150, totalTokens: 350 },
    stepDurations: [340, 510],
    totalDurationMs: 850,
    lastError: '等待用户输入报告格式',
  };
  checkpointer.checkpoint(pausedState);
  console.log(`任务已暂停: phase=${pausedState.phase}, 原因: ${pausedState.lastError}`);

  // 3) 查看中断时的 checkpoint 状态
  console.log('\n--- 阶段 3: 查看中断检查点 ---');
  const snapshot = checkpointer.loadCheckpoint(runId);
  if (snapshot) {
    console.log(`检查点: step=${snapshot.stepNumber}, phase=${snapshot.phase}, tokens=${snapshot.tokenUsage.totalTokens}, messages=${snapshot.messages.length}`);
  }

  // 4) 恢复执行（resume）：加载 checkpoint 并注入新的 userInstructions
  console.log('\n--- 阶段 4: 注入新指令并恢复执行（resume）---');
  const recovered = checkpointer.resume(runId);
  if (!recovered) {
    console.log('未找到 checkpoint，无法恢复');
    return;
  }
  const newInstructions = '请使用 Markdown 格式输出报告，包含目录树';
  const resumedState: CheckpointState = {
    ...recovered,
    stepNumber: recovered.stepNumber + 1,
    phase: 'tool_execution',
    timestamp: new Date().toISOString(),
    messages: [...recovered.messages, { role: 'user', content: newInstructions }],
    lastError: undefined,
  };
  checkpointer.checkpoint(resumedState);
  console.log(`已注入指令: "${newInstructions}"`);
  console.log(`恢复后: phase=${resumedState.phase}, step=${resumedState.stepNumber}`);

  // 5) 中断前后状态对比
  console.log('\n=== 中断前后状态对比 ===');
  console.log('中断前: phase=interrupted, step=2, messages=2, tokens=350');
  console.log(`恢复后: phase=${resumedState.phase}, step=${resumedState.stepNumber}, messages=${resumedState.messages.length}, tokens=${resumedState.tokenUsage.totalTokens}`);

  checkpointer.deleteCheckpoint(runId);
}

main().catch(console.error);
