#!/usr/bin/env npx tsx
/**
 * Saga Compensation End-to-End Example — Saga 补偿事务端到端示例
 *
 * 场景描述:
 *   演示 Commander 的 Saga 补偿事务。构建一个包含 3 个步骤的 Saga
 *   (step1 扣款成功、step2 预留库存成功、step3 发货失败)，当 step3 失败时
 *   前两步的补偿事务被自动触发（LIFO 顺序），Saga 最终状态为 aborted
 *   (已补偿)，系统回滚到一致状态。
 *
 * 关键 API: createSaga/SagaBuilder, step, compensate, runSaga, CheckpointManager, ApprovalManager
 * 运行方式: npx tsx examples/saga-compensation.ts
 */
import {
  createSaga,
  runSaga,
  CheckpointManager,
  InMemorySagaStore,
  ApprovalManager,
  InMemoryApprovalStore,
} from '@praetor/core';
import type { SagaContext, SagaResult } from '@praetor/core';

async function main() {
  console.log('=== Saga 补偿事务端到端示例 ===\n');

  // 1) 构建基础设施：检查点存储 + 审批管理
  const checkpoint = new CheckpointManager(new InMemorySagaStore());
  const approval = new ApprovalManager({ store: new InMemoryApprovalStore() });

  // 2) 使用 SagaBuilder 构建事务图：3 个步骤，前两步带补偿函数
  const graph = createSaga('order-fulfillment')
    .describe('下单履约：扣款 -> 预留库存 -> 发货')
    .step('charge-card', async () => {
      console.log('  [step1] 扣款成功: chargeId=ch_001, amount=100');
      return { chargeId: 'ch_001', amount: 100 };
    })
    .compensate(async (result) => {
      const r = result as { chargeId: string };
      console.log(`  [补偿 step1] 自动退款: ${r.chargeId}`);
    })
    .step('reserve-inventory', async () => {
      console.log('  [step2] 库存预留成功: reservationId=rsv_001');
      return { reservationId: 'rsv_001' };
    })
    .compensate(async (result) => {
      const r = result as { reservationId: string };
      console.log(`  [补偿 step2] 自动释放库存: ${r.reservationId}`);
    })
    .step('ship-order', async () => {
      console.log('  [step3] 发货失败: 物流系统不可用');
      throw new Error('物流系统不可用，发货失败');
    })
    .build();

  // 3) 构造 Saga 执行上下文
  const context: SagaContext = {
    runId: `saga-${Date.now()}`,
    input: { orderId: 'ORD-001', amount: 100 },
    results: new Map(),
    attempts: new Map(),
    metadata: {},
    signal: new AbortController().signal,
  };

  // 4) 执行 Saga —— step3 失败后自动触发补偿
  console.log('--- 开始执行 Saga ---');
  const result: SagaResult = await runSaga(graph, context, checkpoint, approval);

  // 5) 展示结果
  console.log('\n--- Saga 执行结果 ---');
  console.log(`Saga 状态: ${result.status}`); // 'aborted' 表示已中止并补偿
  console.log(`摘要: ${result.summary}`);
  console.log(`错误: ${result.error ?? '无'}`);
  console.log(`已执行步骤结果: ${Object.keys(result.results).join(', ') || '无'}`);
  console.log(`耗时: ${result.durationMs}ms`);

  console.log('\n=== 结论 ===');
  console.log('step3 发货失败后，step2 与 step1 的补偿事务被自动触发（LIFO 顺序）');
  console.log('Saga 最终状态: aborted (已补偿)，系统回滚到一致状态');
}

main().catch(console.error);
