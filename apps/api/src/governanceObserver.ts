// Governance Observer v2 - 治理观察者
// 统计高风险任务、审批率、风险 Agent 分布
// v2: 增加磁盘持久化，治理证据不再仅存内存

import { reportSilentFailure } from '@praetor/core';
import * as fs from 'fs';
import * as path from 'path';

const PERSISTENCE_DIR = '.commander_governance';
const SNAPSHOT_FILE = 'governance-snapshots.ndjson';

/**
 * Append a governance snapshot to disk (NDJSON format).
 * Non-blocking — failures are silently caught so governance never breaks execution.
 */
export function persistGovernanceSnapshot(stats: GovernanceStats, alerts: GovernanceAlert[]): void {
  try {
    const dir = path.resolve(process.cwd(), PERSISTENCE_DIR);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const record = {
      timestamp: new Date().toISOString(),
      stats,
      alerts,
    };
    const filePath = path.join(dir, SNAPSHOT_FILE);
    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    reportSilentFailure(err, 'governanceObserver:29');
    /* best-effort persistence — never break governance flow */
  }
}

/**
 * Load persisted governance snapshots from disk.
 * Returns newest-first, limited to `limit` entries.
 */
export function loadGovernanceSnapshots(
  limit = 100,
): Array<{ timestamp: string; stats: GovernanceStats; alerts: GovernanceAlert[] }> {
  try {
    const filePath = path.resolve(process.cwd(), PERSISTENCE_DIR, SNAPSHOT_FILE);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const records = lines.map((line) => JSON.parse(line));
    return records.slice(-limit).reverse();
  } catch (err) {
    reportSilentFailure(err, 'governanceObserver:48');
    return [];
  }
}

export interface GovernanceStats {
  highRiskTasks: {
    total: number;
    completed: number;
    pending: number;
  };
  manualApprovalRate: number;
  agentRiskDistribution: Record<string, number>; // agentId -> high risk task count
  lastUpdated: string;
}

export interface GovernanceAlert {
  type: 'LESSON' | 'ISSUE' | 'WARNING';
  message: string;
  agentId?: string;
  timestamp: string;
}

// 计算治理统计
export function calculateGovernanceStats(
  missions: Record<string, unknown>[],
  agents: Record<string, unknown>[],
): GovernanceStats {
  // Mission rows come from a loose snapshot schema, so probe each field via
  // a typed accessor; keeps the calculation logic intact without scattering `any`.
  const riskLevel = (m: Record<string, unknown>): string | undefined =>
    m.riskLevel as string | undefined;
  const status = (m: Record<string, unknown>): string | undefined => m.status as string | undefined;
  const governanceMode = (m: Record<string, unknown>): string | undefined =>
    m.governanceMode as string | undefined;
  const approvalStatus = (m: Record<string, unknown>): string | undefined =>
    m.approvalStatus as string | undefined;
  const assignedAgentId = (m: Record<string, unknown>): string | undefined =>
    m.assignedAgentId as string | undefined;

  const highRiskMissions = missions.filter(
    (m) => riskLevel(m) === 'HIGH' || riskLevel(m) === 'CRITICAL',
  );

  const completed = highRiskMissions.filter((m) => status(m) === 'DONE').length;
  const pending = highRiskMissions.filter((m) => status(m) !== 'DONE').length;

  // 计算手动审批率
  const manualMissions = missions.filter((m) => governanceMode(m) === 'MANUAL');
  const approvedManual = manualMissions.filter((m) => approvalStatus(m) === 'APPROVED').length;
  const manualApprovalRate = manualMissions.length > 0 ? approvedManual / manualMissions.length : 0;

  // Agent 风险分布
  const agentRiskDistribution: Record<string, number> = {};
  highRiskMissions.forEach((m) => {
    const agentId = assignedAgentId(m);
    if (agentId) {
      agentRiskDistribution[agentId] = (agentRiskDistribution[agentId] || 0) + 1;
    }
  });

  return {
    highRiskTasks: {
      total: highRiskMissions.length,
      completed,
      pending,
    },
    manualApprovalRate,
    agentRiskDistribution,
    lastUpdated: new Date().toISOString(),
  };
}

// 生成治理警报
export function generateGovernanceAlerts(stats: GovernanceStats): GovernanceAlert[] {
  const alerts: GovernanceAlert[] = [];

  // 高风险任务积压警告
  if (stats.highRiskTasks.pending > 5) {
    alerts.push({
      type: 'WARNING',
      message: `高风险任务积压: ${stats.highRiskTasks.pending} 个待处理`,
      timestamp: new Date().toISOString(),
    });
  }

  // 审批率过低警告
  if (stats.manualApprovalRate < 0.5 && stats.highRiskTasks.total > 0) {
    alerts.push({
      type: 'ISSUE',
      message: `手动审批率过低: ${(stats.manualApprovalRate * 100).toFixed(1)}%`,
      timestamp: new Date().toISOString(),
    });
  }

  // 高风险 Agent 识别
  for (const [agentId, count] of Object.entries(stats.agentRiskDistribution)) {
    if (count >= 3) {
      alerts.push({
        type: 'LESSON',
        message: `Agent ${agentId} 频繁执行高风险任务 (${count} 次)，需要关注`,
        agentId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return alerts;
}

// 生成周报格式的 ProjectMemory
export function generateWeeklyGovernanceReport(
  stats: GovernanceStats,
  alerts: GovernanceAlert[],
): string {
  const lines = [
    `# 治理周报 - ${new Date().toISOString().split('T')[0]}`,
    '',
    '## 高风险任务统计',
    `- 总数: ${stats.highRiskTasks.total}`,
    `- 已完成: ${stats.highRiskTasks.completed}`,
    `- 待处理: ${stats.highRiskTasks.pending}`,
    '',
    '## 审批统计',
    `- 手动审批率: ${(stats.manualApprovalRate * 100).toFixed(1)}%`,
    '',
    '## Agent 风险分布',
  ];

  for (const [agentId, count] of Object.entries(stats.agentRiskDistribution)) {
    lines.push(`- ${agentId}: ${count} 个高风险任务`);
  }

  if (alerts.length > 0) {
    lines.push('', '## 警报');
    alerts.forEach((a) => {
      lines.push(`- [${a.type}] ${a.message}`);
    });
  }

  return lines.join('\n');
}
