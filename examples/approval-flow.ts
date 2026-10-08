#!/usr/bin/env npx tsx
/**
 * Approval Flow End-to-End Example — 审批流端到端示例
 *
 * 场景描述:
 *   演示 Commander 的工具审批拦截流程。当 Agent 尝试调用高风险工具
 *   (如 shell_execute) 时，ToolApproval 策略会拦截并触发人工审批回调，
 *   审批通过后工具调用才继续执行；危险命令则被拒绝。生产环境中
 *   Commander 的 AgentRuntime 会在每次工具调用前自动调用 requestApproval。
 *
 * 关键 API:
 *   - ToolApproval               审批引擎（构造时传入自定义 approval callback）
 *   - ApprovalPolicy             审批策略（pattern / level / riskLevel）
 *   - requestApproval()          工具执行前的审批请求入口
 *   - DEFAULT_APPROVAL_POLICIES  内置默认策略集
 *
 * 运行方式:
 *   npx tsx examples/approval-flow.ts
 */
import { ToolApproval, DEFAULT_APPROVAL_POLICIES } from '@praetor/core';
import type { ApprovalRequest, ApprovalResult } from '@praetor/core';

async function main() {
  console.log('=== 审批流端到端示例 ===\n');

  // 1) 自定义审批回调 —— 模拟人工审批界面
  //    Commander 运行时在拦截到 manual / semi_auto 工具调用时调用此回调。
  const approvalCallback = async (req: ApprovalRequest): Promise<ApprovalResult> => {
    console.log(`  [审批拦截] 工具=${req.toolName}  级别=${req.policy.level}  风险=${req.policy.riskLevel}`);
    console.log(`  参数: ${JSON.stringify(req.arguments)}`);
    const cmd = String(req.arguments.command ?? '');
    const approved = !cmd.includes('rm -rf /');
    console.log(`  人工审批结果: ${approved ? '通过' : '拒绝'}\n`);
    return {
      approved,
      requestId: req.id,
      approvedAt: new Date().toISOString(),
      reason: approved ? '人工审批通过' : '危险命令，拒绝执行',
    };
  };

  // 2) 创建 ToolApproval 实例（构造时自动加载 DEFAULT_APPROVAL_POLICIES）
  const approval = new ToolApproval(approvalCallback);
  console.log(`已加载 ${DEFAULT_APPROVAL_POLICIES.length} 条默认审批策略`);
  console.log('其中 shell_execute -> manual(高风险), file_read -> auto(低风险)\n');

  // 3) 场景 A: 低风险工具 file_read —— 自动审批，不触发回调
  console.log('--- 场景 A: 低风险工具自动审批 ---');
  const readResult = await approval.requestApproval('file_read', { path: '/tmp/data.txt' });
  console.log(`file_read => ${readResult.approved ? '自动通过' : '拒绝'} (${readResult.reason})\n`);

  // 4) 场景 B: 高风险工具 shell_execute(安全命令) —— 触发人工审批并通过
  console.log('--- 场景 B: 高风险工具触发人工审批（通过）---');
  const safeResult = await approval.requestApproval('shell_execute', { command: 'ls -la /tmp' });
  console.log(`shell_execute (安全命令) => ${safeResult.approved ? '继续执行' : '已阻止'}\n`);

  // 5) 场景 C: 高风险工具 shell_execute(危险命令) —— 审批拒绝
  console.log('--- 场景 C: 危险命令被审批拒绝 ---');
  const dangerResult = await approval.requestApproval('shell_execute', { command: 'rm -rf /' });
  console.log(`shell_execute (危险命令) => ${dangerResult.approved ? '继续执行' : '已阻止'}`);
  console.log(`拒绝原因: ${dangerResult.reason}\n`);

  // 6) 查看审批统计
  const stats = approval.getStats();
  console.log('=== 审批统计 ===');
  console.log(`总审批次数: ${stats.total}  通过: ${stats.approved}  拒绝: ${stats.rejected}`);
  console.log(`审批通过率: ${(stats.approvalRate * 100).toFixed(0)}%`);
}

main().catch(console.error);
