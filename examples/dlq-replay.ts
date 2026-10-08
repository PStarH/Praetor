#!/usr/bin/env npx tsx
/**
 * DLQ Replay End-to-End Example — 死信队列重放端到端示例
 *
 * 场景描述:
 *   演示 Commander 的死信队列（DeadLetterQueue）流程。执行一个会失败的任务
 *   (调用不存在的工具)，失败条目被记录到 DLQ；随后查看未恢复条目并调用
 *   replay() 重放，展示恢复流程。
 *
 * 关键 API: DeadLetterQueue, enqueue, listUnrecoveredEntries, replay, getStats
 * 运行方式: npx tsx examples/dlq-replay.ts
 */
import { DeadLetterQueue } from '@praetor/core/runtime';
import * as os from 'node:os';
import * as path from 'node:path';

async function main() {
  console.log('=== DLQ 重放端到端示例 ===\n');

  // 使用临时目录存放 DLQ，避免污染工作区
  const dlqDir = path.join(os.tmpdir(), `commander-dlq-${Date.now()}`);
  const dlq = new DeadLetterQueue(dlqDir);

  // 1) 模拟任务执行失败 —— 调用不存在的工具 / 触发错误
  console.log('--- 阶段 1: 任务执行失败，写入 DLQ ---');
  dlq.enqueue({
    category: 'tool',
    runId: 'run-001',
    agentId: 'commander',
    operationName: 'nonexistent_tool',
    errorMessage: 'Tool "nonexistent_tool" not found in registry',
    errorClass: 'permanent',
    retryable: true,
    attemptNumber: 3,
    tags: ['mode:execution'],
    payload: { toolName: 'nonexistent_tool', args: { query: 'test' } },
  });
  console.log('已入队: nonexistent_tool 调用失败 (retryable=true)');

  dlq.enqueue({
    category: 'execution',
    runId: 'run-002',
    agentId: 'commander',
    operationName: 'generate_report',
    errorMessage: 'Execution timed out after 30000ms',
    errorClass: 'transient',
    retryable: true,
    attemptNumber: 1,
    tags: ['mode:timeout'],
  });
  console.log('已入队: generate_report 执行超时 (retryable=true)\n');

  // 2) 查看 DLQ 中的未恢复条目
  console.log('--- 阶段 2: 查看未恢复条目 ---');
  const unrecovered = dlq.listUnrecoveredEntries();
  console.log(`未恢复条目数: ${unrecovered.length}`);
  for (const { category, entry } of unrecovered) {
    console.log(`  [${category}] ${entry.operationName}: ${entry.errorMessage}`);
    console.log(`    id=${entry.id}  retryable=${entry.retryable}  recovered=${entry.recovered}`);
  }

  // 3) 查看各分类统计
  console.log('\n--- 阶段 3: DLQ 分类统计 ---');
  for (const stat of dlq.getStats()) {
    console.log(`  ${stat.category}: ${stat.count} 条`);
  }

  // 4) 重放失败的条目
  console.log('\n--- 阶段 4: 重放 (replay) 失败条目 ---');
  for (const { entry } of unrecovered) {
    const replayed = dlq.replay(entry.id);
    if (replayed) {
      console.log(`  重放 ${entry.operationName}: recovered=${replayed.entry.recovered}`);
      console.log(`    新标签: ${replayed.entry.tags.join(', ')}`);
    }
  }

  // 5) 确认恢复后的状态
  console.log('\n--- 阶段 5: 确认恢复状态 ---');
  const remaining = dlq.listUnrecoveredEntries();
  console.log(`重放后未恢复条目数: ${remaining.length}`);
  console.log(remaining.length === 0 ? '所有失败条目已恢复' : '仍有条目未恢复');
}

main().catch(console.error);
