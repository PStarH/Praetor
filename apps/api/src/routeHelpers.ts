import type {
  MissionStatus,
  MissionPriority,
  MissionRiskLevel,
  MissionGovernanceMode,
  ProjectMemoryKind,
  LogLevel,
} from '@praetor/core';

export function isMissionStatus(value: string): value is MissionStatus {
  return ['PLANNED', 'RUNNING', 'BLOCKED', 'DONE'].includes(value);
}

export function isMissionPriority(value: string): value is MissionPriority {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value);
}

export function isMissionRiskLevel(value: string): value is MissionRiskLevel {
  return ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value);
}

export function isMissionGovernanceMode(value: string): value is MissionGovernanceMode {
  return ['AUTO', 'GUARDED', 'MANUAL'].includes(value);
}

export function isProjectMemoryKind(value: string): value is ProjectMemoryKind {
  return ['DECISION', 'ISSUE', 'LESSON', 'SUMMARY'].includes(value);
}

export function isLogLevel(value: string): value is LogLevel {
  return ['INFO', 'SUCCESS', 'WARN', 'ERROR'].includes(value);
}

export function mapErrorToStatusCode(error: unknown) {
  const message = toErrorMessage(error);
  if (
    message === 'Project not found' ||
    message === 'Mission not found' ||
    message === 'Agent not found'
  ) {
    return 404;
  }
  if (message === 'MISSION_REQUIRES_APPROVAL') {
    return 409;
  }
  return 400;
}

export function toErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Unknown error';
  }
  switch (error.message) {
    case 'PROJECT_NOT_FOUND':
      return 'Project not found';
    case 'MISSION_NOT_FOUND':
      return 'Mission not found';
    case 'AGENT_NOT_FOUND':
      return 'Agent not found';
    case 'MISSION_REQUIRES_APPROVAL':
      return 'Mission requires approval before completion';
    default:
      // Security: Per Express security best practice — do not leak internal
      // error messages to clients. Return a generic message for unrecognized
      // errors; the global error handler logs the full detail server-side.
      return 'An internal error occurred';
  }
}
