/**
 * Governance Checkpoint System
 * Based on LangGraph's checkpoint mechanism
 *
 * Implements mandatory and conditional checkpoints based on governance mode
 */

import { MissionGovernanceMode, MissionRiskLevel } from '@praetor/core';

/**
 * Checkpoint types
 */
export type CheckpointType =
  | 'mandatory' // MANUAL mode - requires explicit approval
  | 'conditional' // GUARDED mode - requires approval based on risk score
  | 'automatic'; // SINGLE mode - auto-approved

/**
 * Checkpoint status
 */
export type CheckpointStatus =
  | 'pending' // Waiting for approval
  | 'approved' // Approved, can proceed
  | 'rejected' // Rejected, task aborted
  | 'expired'; // Approval timeout

/**
 * Approval decision
 */
export interface ApprovalDecision {
  approved: boolean;
  reviewerId: string;
  reviewedAt: string;
  reason?: string;
  conditions?: string[]; // Conditions attached to approval
}

/**
 * Governance Checkpoint
 */
export interface GovernanceCheckpoint {
  id: string;
  missionId: string;
  taskId: string;
  type: CheckpointType;
  status: CheckpointStatus;
  tenantId?: string;

  /** Risk assessment */
  riskScore: number; // 0-100
  riskLevel: MissionRiskLevel;

  /** Approval requirements */
  requiredApprovals: string[]; // User IDs who can approve
  currentApprovals: ApprovalDecision[];

  /** Timing */
  createdAt: string;
  expiresAt?: string; // Optional timeout
  approvedAt?: string;

  /** Fallback action if rejected/expired */
  fallbackAction: 'abort' | 'proceed' | 'escalate';

  /** Context for reviewers */
  context: CheckpointContext;
}

/**
 * Context information for checkpoint review
 */
export interface CheckpointContext {
  /** What triggered this checkpoint */
  trigger: string;

  /** Agent requesting approval */
  agentId: string;
  agentRole: string;

  /** Task description */
  taskDescription: string;

  /** Risk factors identified */
  riskFactors: RiskFactor[];

  /** Supporting evidence (logs, outputs) */
  evidence: CheckpointEvidence[];
}

/**
 * Risk factor
 */
export interface RiskFactor {
  category: 'data' | 'security' | 'compliance' | 'operational' | 'financial';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  mitigation?: string;
}

/**
 * Evidence for checkpoint review
 */
export interface CheckpointEvidence {
  type: 'log' | 'output' | 'metric' | 'external';
  timestamp: string;
  content: string;
  source: string;
}

/**
 * Checkpoint configuration for different governance modes
 */
export interface CheckpointConfig {
  mode: MissionGovernanceMode;

  /** Risk threshold for conditional checkpoint (GUARDED mode) */
  riskThreshold?: number; // 0-100

  /** Users authorized to approve checkpoints */
  approvers: string[];

  /** Timeout for approval (milliseconds) */
  timeout?: number;

  /** Fallback action if timeout expires */
  fallbackOnTimeout: 'abort' | 'proceed' | 'escalate';
}

/**
 * Default checkpoint configurations by governance mode
 */
export const DEFAULT_CHECKPOINT_CONFIGS: Record<MissionGovernanceMode, CheckpointConfig> = {
  AUTO: {
    mode: 'AUTO',
    approvers: [],
    fallbackOnTimeout: 'proceed',
  },
  GUARDED: {
    mode: 'GUARDED',
    riskThreshold: 50,
    approvers: [],
    timeout: 300000, // 5 minutes
    fallbackOnTimeout: 'escalate',
  },
  MANUAL: {
    mode: 'MANUAL',
    approvers: [],
    timeout: 3600000, // 1 hour
    fallbackOnTimeout: 'abort',
  },
};

/**
 * Checkpoint Manager
 */
export class CheckpointManager {
  private checkpoints: Map<string, GovernanceCheckpoint> = new Map();
  private configs: Map<string, CheckpointConfig> = new Map();

  /**
   * Set checkpoint configuration for a mission
   */
  setConfig(missionId: string, config: CheckpointConfig): void {
    this.configs.set(missionId, config);
  }

  /**
   * Determine checkpoint type based on governance mode and risk
   */
  determineCheckpointType(
    mode: MissionGovernanceMode,
    riskScore: number,
    riskThreshold?: number,
  ): CheckpointType {
    switch (mode) {
      case 'MANUAL':
        return 'mandatory';

      case 'GUARDED':
        const threshold = riskThreshold ?? DEFAULT_CHECKPOINT_CONFIGS.GUARDED.riskThreshold ?? 50;
        return riskScore >= threshold ? 'conditional' : 'automatic';

      case 'AUTO':
      default:
        return 'automatic';
    }
  }

  /**
   * Create a checkpoint
   */
  create(
    missionId: string,
    taskId: string,
    agentId: string,
    agentRole: string,
    taskDescription: string,
    governanceMode: MissionGovernanceMode,
    riskScore: number,
    riskLevel: MissionRiskLevel,
    riskFactors: RiskFactor[],
    approvers: string[],
    timeout?: number,
    tenantId?: string,
  ): GovernanceCheckpoint {
    const config = this.configs.get(missionId) ?? DEFAULT_CHECKPOINT_CONFIGS[governanceMode];
    const type = this.determineCheckpointType(governanceMode, riskScore, config.riskThreshold);

    const checkpointId = `ckpt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const checkpoint: GovernanceCheckpoint = {
      id: checkpointId,
      missionId,
      taskId,
      type,
      status: type === 'automatic' ? 'approved' : 'pending',
      tenantId,
      riskScore,
      riskLevel,
      requiredApprovals: type === 'automatic' ? [] : approvers,
      currentApprovals: [],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (timeout ?? config.timeout ?? 3600000)).toISOString(),
      fallbackAction: config.fallbackOnTimeout,
      context: {
        trigger: `Task execution: ${taskDescription}`,
        agentId,
        agentRole,
        taskDescription,
        riskFactors,
        evidence: [],
      },
    };

    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  /**
   * Get checkpoint by ID
   */
  get(checkpointId: string): GovernanceCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /**
   * Get pending checkpoints for a mission
   */
  getPendingByMission(missionId: string): GovernanceCheckpoint[] {
    return Array.from(this.checkpoints.values()).filter(
      (c) => c.missionId === missionId && c.status === 'pending',
    );
  }

  /**
   * Get pending checkpoints for an approver
   */
  getPendingForApprover(approverId: string, tenantId?: string): GovernanceCheckpoint[] {
    return Array.from(this.checkpoints.values()).filter(
      (c) =>
        c.status === 'pending' &&
        (!tenantId || c.tenantId === tenantId) &&
        c.requiredApprovals.includes(approverId) &&
        !c.currentApprovals.some((a) => a.reviewerId === approverId),
    );
  }

  /**
   * Get all checkpoints (for admin endpoints)
   */
  getAll(): GovernanceCheckpoint[] {
    return Array.from(this.checkpoints.values());
  }

  /**
   * Approve a checkpoint
   */
  approve(
    checkpointId: string,
    reviewerId: string,
    reason?: string,
    conditions?: string[],
  ): GovernanceCheckpoint {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    if (checkpoint.status !== 'pending') {
      throw new Error(`Checkpoint is not pending: ${checkpoint.status}`);
    }

    if (!checkpoint.requiredApprovals.includes(reviewerId)) {
      throw new Error(`User ${reviewerId} is not authorized to approve this checkpoint`);
    }

    // Check if already approved by this user
    if (checkpoint.currentApprovals.some((a) => a.reviewerId === reviewerId)) {
      throw new Error(`Already approved by ${reviewerId}`);
    }

    const approval: ApprovalDecision = {
      approved: true,
      reviewerId,
      reviewedAt: new Date().toISOString(),
      reason,
      conditions,
    };

    checkpoint.currentApprovals.push(approval);

    // Check if all required approvals received
    if (checkpoint.currentApprovals.length >= checkpoint.requiredApprovals.length) {
      checkpoint.status = 'approved';
      checkpoint.approvedAt = new Date().toISOString();
    }

    checkpoint.context.evidence.push({
      type: 'log',
      timestamp: new Date().toISOString(),
      content: `Approved by ${reviewerId}${reason ? `: ${reason}` : ''}`,
      source: 'governance-checkpoint',
    });

    return checkpoint;
  }

  /**
   * Reject a checkpoint
   */
  reject(checkpointId: string, reviewerId: string, reason: string): GovernanceCheckpoint {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    if (checkpoint.status !== 'pending') {
      throw new Error(`Checkpoint is not pending: ${checkpoint.status}`);
    }

    if (!checkpoint.requiredApprovals.includes(reviewerId)) {
      throw new Error(`User ${reviewerId} is not authorized to reject this checkpoint`);
    }

    const rejection: ApprovalDecision = {
      approved: false,
      reviewerId,
      reviewedAt: new Date().toISOString(),
      reason,
    };

    checkpoint.currentApprovals.push(rejection);
    checkpoint.status = 'rejected';

    checkpoint.context.evidence.push({
      type: 'log',
      timestamp: new Date().toISOString(),
      content: `Rejected by ${reviewerId}: ${reason}`,
      source: 'governance-checkpoint',
    });

    return checkpoint;
  }

  /**
   * Check for expired checkpoints and apply fallback
   */
  checkExpirations(tenantId?: string): GovernanceCheckpoint[] {
    const now = new Date();
    const expired: GovernanceCheckpoint[] = [];

    for (const checkpoint of this.checkpoints.values()) {
      if (
        (!tenantId || checkpoint.tenantId === tenantId) &&
        checkpoint.status === 'pending' &&
        checkpoint.expiresAt &&
        new Date(checkpoint.expiresAt) < now
      ) {
        checkpoint.status = 'expired';

        // Apply fallback action
        if (checkpoint.fallbackAction === 'proceed') {
          checkpoint.status = 'approved';
          checkpoint.approvedAt = new Date().toISOString();
        }

        checkpoint.context.evidence.push({
          type: 'log',
          timestamp: new Date().toISOString(),
          content: `Checkpoint expired, fallback action: ${checkpoint.fallbackAction}`,
          source: 'governance-checkpoint',
        });

        expired.push(checkpoint);
      }
    }

    return expired;
  }

  /**
   * Add evidence to a checkpoint
   */
  addEvidence(checkpointId: string, evidence: CheckpointEvidence): GovernanceCheckpoint {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    checkpoint.context.evidence.push(evidence);
    return checkpoint;
  }

  /**
   * Get checkpoint statistics
   */
  getStats(missionId?: string, tenantId?: string): CheckpointStats {
    const checkpoints = Array.from(this.checkpoints.values()).filter(
      (checkpoint) =>
        (!missionId || checkpoint.missionId === missionId) &&
        (!tenantId || checkpoint.tenantId === tenantId),
    );

    return {
      total: checkpoints.length,
      pending: checkpoints.filter((c) => c.status === 'pending').length,
      approved: checkpoints.filter((c) => c.status === 'approved').length,
      rejected: checkpoints.filter((c) => c.status === 'rejected').length,
      expired: checkpoints.filter((c) => c.status === 'expired').length,
      mandatoryCount: checkpoints.filter((c) => c.type === 'mandatory').length,
      conditionalCount: checkpoints.filter((c) => c.type === 'conditional').length,
      automaticCount: checkpoints.filter((c) => c.type === 'automatic').length,
      averageApprovalTime: this.calculateAverageApprovalTime(checkpoints),
    };
  }

  private calculateAverageApprovalTime(checkpoints: GovernanceCheckpoint[]): number | null {
    const approved = checkpoints.filter((c) => c.status === 'approved' && c.approvedAt);
    if (approved.length === 0) return null;

    const times = approved.map(
      (c) => new Date(c.approvedAt!).getTime() - new Date(c.createdAt).getTime(),
    );

    return times.reduce((a, b) => a + b, 0) / times.length;
  }
}

/**
 * Checkpoint statistics
 */
export interface CheckpointStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
  mandatoryCount: number;
  conditionalCount: number;
  automaticCount: number;
  averageApprovalTime: number | null; // milliseconds
}

/**
 * Risk score calculator
 */
export class RiskScoreCalculator {
  /**
   * Calculate risk score from mission and task factors
   */
  static calculate(
    governanceMode: MissionGovernanceMode,
    riskLevel: MissionRiskLevel,
    operations: string[],
    dataSensitivity: 'public' | 'internal' | 'confidential' | 'restricted',
  ): number {
    let score = 0;

    // Base score from risk level
    const riskScores: Record<MissionRiskLevel, number> = {
      LOW: 20,
      MEDIUM: 40,
      HIGH: 70,
      CRITICAL: 90,
    };
    score += riskScores[riskLevel];

    // Governance mode adjustment
    if (governanceMode === 'MANUAL') {
      score += 10; // MANUAL mode indicates higher risk awareness
    } else if (governanceMode === 'GUARDED') {
      score += 5;
    }

    // Operation risk factors
    const highRiskOps = ['delete', 'deploy', 'production', 'financial', 'security'];
    const hasHighRiskOp = operations.some((op) =>
      highRiskOps.some((risk) => op.toLowerCase().includes(risk)),
    );
    if (hasHighRiskOp) {
      score += 15;
    }

    // Data sensitivity adjustment
    const sensitivityScores: Record<string, number> = {
      public: 0,
      internal: 5,
      confidential: 15,
      restricted: 25,
    };
    score += sensitivityScores[dataSensitivity];

    // Cap at 100
    return Math.min(100, score);
  }

  /**
   * Determine risk level from score
   */
  static scoreToLevel(score: number): MissionRiskLevel {
    if (score >= 80) return 'CRITICAL';
    if (score >= 60) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }
}
