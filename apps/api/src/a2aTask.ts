/**
 * A2A Task Lifecycle Implementation
 * Based on Google's A2A Protocol Specification
 *
 * Tasks have a defined lifecycle and produce Artifacts
 */

import { v4 as uuidv4 } from 'uuid';
import { getCurrentTenantId, TenantIsolationError } from '@praetor/core/runtime/tenantContext';

export const DEFAULT_A2A_TENANT_ID = '__default__';

export type TaskStatus =
  | 'pending' // Task created, waiting to start
  | 'running' // Task is being processed
  | 'paused' // Task paused, can be resumed
  | 'completed' // Task completed successfully
  | 'failed' // Task failed
  | 'cancelled'; // Task cancelled by user

export type TaskPriority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  /** Tenant that owns the task */
  tenantId?: string;
  /** Client that submitted the task */
  clientId: string;
  /** Remote agent processing the task */
  agentId?: string;
  /** Task description */
  description: string;
  /** Task priority */
  priority: TaskPriority;
  /** Current status */
  status: TaskStatus;
  /** Input data */
  input: Record<string, unknown>;
  /** Output artifact (when completed) */
  artifact?: Artifact;
  /** Progress percentage (0-100) */
  progress: number;
  /** Error message (if failed) */
  error?: string;
  /** Messages exchanged during task */
  messages: TaskMessage[];
  /** Timestamps */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface TaskMessage {
  id: string;
  timestamp: string;
  sender: 'client' | 'agent';
  type: 'context' | 'reply' | 'artifact' | 'instruction' | 'status-update';
  content: string;
  /** Additional data */
  metadata?: Record<string, unknown>;
}

export interface Artifact {
  id: string;
  taskId: string;
  /** Tenant that owns the artifact */
  tenantId?: string;
  /** MIME type */
  contentType: string;
  /** Content (text or base64 for binary) */
  content: string;
  /** URL if content is external */
  url?: string;
  /** Metadata */
  metadata: ArtifactMetadata;
}

export interface ArtifactMetadata {
  size?: number;
  encoding?: 'utf-8' | 'base64';
  filename?: string;
  createdAt: string;
}

function resolveCurrentTenantId(): string {
  return getCurrentTenantId() ?? DEFAULT_A2A_TENANT_ID;
}

function assertTenantMatch(resourceTenantId: string | undefined): void {
  const current = resolveCurrentTenantId();
  const owner = resourceTenantId ?? DEFAULT_A2A_TENANT_ID;
  if (owner !== current) {
    throw new TenantIsolationError(
      `Cross-tenant access blocked: resource tenant=${owner}, current=${current}`,
    );
  }
}

/**
 * Task State Machine
 */
export class TaskStateMachine {
  private transitions: Map<TaskStatus, TaskStatus[]> = new Map([
    ['pending', ['running', 'cancelled']],
    ['running', ['paused', 'completed', 'failed', 'cancelled']],
    ['paused', ['running', 'cancelled']],
    ['completed', []], // Terminal state
    ['failed', []], // Terminal state
    ['cancelled', []], // Terminal state
  ]);

  /**
   * Check if transition is valid
   */
  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    const allowed = this.transitions.get(from) || [];
    return allowed.includes(to);
  }

  /**
   * Transition task to new status
   */
  transition(task: Task, newStatus: TaskStatus): Task {
    if (!this.canTransition(task.status, newStatus)) {
      throw new Error(`Invalid transition: ${task.status} → ${newStatus}`);
    }

    task.status = newStatus;
    task.updatedAt = new Date().toISOString();

    // Set timestamps
    if (newStatus === 'running' && !task.startedAt) {
      task.startedAt = task.updatedAt;
    }
    if (['completed', 'failed', 'cancelled'].includes(newStatus)) {
      task.completedAt = task.updatedAt;
    }

    return task;
  }

  /**
   * Check if task is in terminal state
   */
  isTerminal(task: Task): boolean {
    return ['completed', 'failed', 'cancelled'].includes(task.status);
  }
}

/**
 * Task Manager
 */
export class TaskManager {
  private tasks: Map<string, Task> = new Map();
  private stateMachine = new TaskStateMachine();

  /**
   * Create a new task
   */
  create(
    clientId: string,
    description: string,
    input: Record<string, unknown>,
    priority: TaskPriority = 'medium',
  ): Task {
    const task: Task = {
      id: uuidv4(),
      tenantId: resolveCurrentTenantId(),
      clientId,
      description,
      priority,
      status: 'pending',
      input,
      progress: 0,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.tasks.set(task.id, task);
    return task;
  }

  /**
   * Get task by ID
   */
  get(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    assertTenantMatch(task.tenantId);
    return task;
  }

  private getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    assertTenantMatch(task.tenantId);
    return task;
  }

  private tasksForCurrentTenant(): Task[] {
    const current = resolveCurrentTenantId();
    return Array.from(this.tasks.values()).filter(
      (t) => (t.tenantId ?? DEFAULT_A2A_TENANT_ID) === current,
    );
  }

  /**
   * Start a task
   */
  start(taskId: string, agentId: string): Task {
    const task = this.getTask(taskId);

    task.agentId = agentId;
    return this.stateMachine.transition(task, 'running');
  }

  /**
   * Pause a task
   */
  pause(taskId: string): Task {
    const task = this.getTask(taskId);

    return this.stateMachine.transition(task, 'paused');
  }

  /**
   * Resume a paused task
   */
  resume(taskId: string): Task {
    const task = this.getTask(taskId);

    return this.stateMachine.transition(task, 'running');
  }

  /**
   * Complete a task
   */
  complete(taskId: string, artifact: Artifact): Task {
    const task = this.getTask(taskId);

    task.artifact = artifact;
    task.progress = 100;
    return this.stateMachine.transition(task, 'completed');
  }

  /**
   * Fail a task
   */
  fail(taskId: string, error: string): Task {
    const task = this.getTask(taskId);

    task.error = error;
    return this.stateMachine.transition(task, 'failed');
  }

  /**
   * Cancel a task
   */
  cancel(taskId: string): Task {
    const task = this.getTask(taskId);

    return this.stateMachine.transition(task, 'cancelled');
  }

  /**
   * Update task progress
   */
  updateProgress(taskId: string, progress: number): Task {
    const task = this.getTask(taskId);

    task.progress = Math.max(0, Math.min(100, progress));
    task.updatedAt = new Date().toISOString();

    return task;
  }

  /**
   * Add message to task
   */
  addMessage(
    taskId: string,
    sender: 'client' | 'agent',
    type: TaskMessage['type'],
    content: string,
    metadata?: Record<string, unknown>,
  ): TaskMessage {
    const task = this.getTask(taskId);

    const message: TaskMessage = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      sender,
      type,
      content,
      metadata,
    };

    task.messages.push(message);
    task.updatedAt = new Date().toISOString();

    return message;
  }

  /**
   * List tasks by status
   */
  listByStatus(status: TaskStatus): Task[] {
    return this.tasksForCurrentTenant().filter((t) => t.status === status);
  }

  /**
   * List tasks by client
   */
  listByClient(clientId: string): Task[] {
    return this.tasksForCurrentTenant().filter((t) => t.clientId === clientId);
  }

  /**
   * List tasks by agent
   */
  listByAgent(agentId: string): Task[] {
    return this.tasksForCurrentTenant().filter((t) => t.agentId === agentId);
  }

  /**
   * List all tasks
   */
  listAll(): Task[] {
    return this.tasksForCurrentTenant();
  }
}

/**
 * Artifact Manager
 */
export class ArtifactManager {
  private artifacts: Map<string, Artifact> = new Map();

  /**
   * Create an artifact
   */
  create(
    taskId: string,
    contentType: string,
    content: string,
    metadata?: Partial<ArtifactMetadata>,
  ): Artifact {
    const artifact: Artifact = {
      id: uuidv4(),
      taskId,
      tenantId: resolveCurrentTenantId(),
      contentType,
      content,
      metadata: {
        createdAt: new Date().toISOString(),
        ...metadata,
      },
    };

    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  /**
   * Get artifact by ID
   */
  get(artifactId: string): Artifact | undefined {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return undefined;

    assertTenantMatch(artifact.tenantId);
    return artifact;
  }

  /**
   * Get artifacts by task
   */
  getByTask(taskId: string): Artifact[] {
    const current = resolveCurrentTenantId();
    return Array.from(this.artifacts.values()).filter(
      (a) => a.taskId === taskId && (a.tenantId ?? DEFAULT_A2A_TENANT_ID) === current,
    );
  }
}
