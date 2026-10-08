import express, { Router } from 'express';
import {
  canTransition,
  AGENT_CARD_WELL_KNOWN_PATH,
  A2A_VERSION_HEADER,
  A2A_PROTOCOL_VERSION,
  A2A_ERROR,
  A2A_METHODS,
} from '@praetor/core';
import { getCurrentTenantId, TenantIsolationError } from '@praetor/core/runtime/tenantContext';
import type {
  A2AAgentCard,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2ATask,
  A2ATaskState,
} from '@praetor/core';
import { requireA2ABearerAuth } from './a2aAuth';

const DEFAULT_A2A_V2_TENANT_ID = '__default__';

function resolveCurrentTenantId(): string {
  return getCurrentTenantId() ?? DEFAULT_A2A_V2_TENANT_ID;
}

function v1AgentCard(): A2AAgentCard {
  return {
    name: 'Commander TELOS',
    description: 'Token-Efficient Low-waste Orchestration System',
    version: '2.0.0',
    supportedInterfaces: [
      { url: '/a2a', protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION },
    ],
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [
      {
        id: 'orchestrate',
        name: 'Orchestrate',
        description: 'Plan and execute multi-agent missions',
        tags: ['plan', 'execute'],
      },
      {
        id: 'research',
        name: 'Research',
        description: 'Deep research with subagents',
        tags: ['research', 'subagent'],
      },
    ],
    provider: { organization: 'TELOS', url: 'https://github.com/PStarH/Commander' },
  };
}

type TenantA2ATask = A2ATask & { tenantId?: string };

const tasks = new Map<string, TenantA2ATask>();
const completionTimers = new Map<string, ReturnType<typeof setTimeout>>();
let taskIdCounter = 0;

function clearCompletionTimer(taskId: string): void {
  const timer = completionTimers.get(taskId);
  if (timer === undefined) return;
  clearTimeout(timer);
  completionTimers.delete(taskId);
}

/**
 * CAA-05: the scheduled terminal transition must pass the same `canTransition`
 * authority as every other transition. Without it, a CANCELED task (cancel lands
 * inside the delay window) is overwritten to COMPLETED by the timer.
 */
function completeTask(task: TenantA2ATask): void {
  clearCompletionTimer(task.id);
  if (!canTransition(task.status.state, 'COMPLETED')) return;
  task.status = { state: 'COMPLETED', timestamp: new Date().toISOString() };
}

export function createA2AV2Router(options?: { authToken?: string | null }): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.
  // Omit `token` unless explicitly overridden so env COMMANDER_A2A_AUTH_TOKEN is used.
  const requireAuth = requireA2ABearerAuth({
    mode: 'jsonrpc',
    ...(options && 'authToken' in options ? { token: options.authToken } : {}),
  });

  // Well-known Agent Card (v1.0) — public discovery; mutations require bearer auth.
  router.get(AGENT_CARD_WELL_KNOWN_PATH, (_req, res) => {
    res.json(v1AgentCard());
  });

  // JSON-RPC 2.0 single endpoint for all A2A methods
  router.post('/', requireAuth, async (req, res) => {
    const rpcReq = req.body as A2AJsonRpcRequest;
    if (!rpcReq || rpcReq.jsonrpc !== '2.0') {
      return res.status(400).json(errorResponse(rpcReq?.id ?? null, -32600, 'Invalid Request'));
    }

    try {
      const response = await handleMethod(rpcReq);
      res.json(response);
    } catch (err) {
      const code =
        err instanceof TenantIsolationError || (err as Error).name === 'TenantIsolationError'
          ? -32603
          : -32603;
      res.json(
        errorResponse(rpcReq.id, code, err instanceof Error ? err.message : 'Internal error'),
      );
    }
  });

  // SSE streaming endpoint
  router.post('/stream', requireAuth, async (req, res) => {
    const rpcReq = req.body as A2AJsonRpcRequest;
    if (rpcReq.method !== A2A_METHODS.SEND_MESSAGE_STREAM) {
      return res
        .status(400)
        .json(errorResponse(rpcReq?.id ?? null, -32600, 'Only message/stream supported'));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'A2A-Version': A2A_PROTOCOL_VERSION,
    });

    const task = createTask('WORKING');
    res.write(`data: ${JSON.stringify(ssr('task', task))}\n\n`);

    setTimeout(() => {
      completeTask(task);
      task.artifacts = [
        { artifactId: 'art-1', parts: [{ type: 'text', text: 'Task completed.' }] },
      ];
      res.write(`data: ${JSON.stringify(ssr('task', task))}\n\n`);
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcReq.id, result: { task } })}\n\n`);
      res.end();
    }, 100);
  });

  return router;
}

async function handleMethod(req: A2AJsonRpcRequest): Promise<A2AJsonRpcResponse> {
  switch (req.method) {
    case A2A_METHODS.SEND_MESSAGE: {
      const task = createTask('WORKING');
      tasks.set(task.id, task);
      completionTimers.set(
        task.id,
        setTimeout(() => completeTask(task), 50),
      );
      return { jsonrpc: '2.0', id: req.id, result: { task } };
    }

    case A2A_METHODS.GET_TASK: {
      const params = req.params as { id: string };
      const task = tasks.get(params.id);
      if (!task) return errorResponse(req.id, A2A_ERROR.TASK_NOT_FOUND, 'Task not found');
      assertTaskTenant(task);
      return { jsonrpc: '2.0', id: req.id, result: { task } };
    }

    case A2A_METHODS.LIST_TASKS: {
      const current = resolveCurrentTenantId();
      const tenantTasks = Array.from(tasks.values()).filter(
        (t) => (t.tenantId ?? DEFAULT_A2A_V2_TENANT_ID) === current,
      );
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: { tasks: tenantTasks, pageSize: 50, totalSize: tenantTasks.length },
      };
    }

    case A2A_METHODS.CANCEL_TASK: {
      const params = req.params as { id: string };
      const task = tasks.get(params.id);
      if (!task) return errorResponse(req.id, A2A_ERROR.TASK_NOT_FOUND, 'Task not found');
      assertTaskTenant(task);
      if (!canTransition(task.status.state, 'CANCELED')) {
        return errorResponse(req.id, A2A_ERROR.TASK_NOT_CANCELABLE, 'Task cannot be canceled');
      }
      task.status = { state: 'CANCELED', timestamp: new Date().toISOString() };
      clearCompletionTimer(task.id);
      return { jsonrpc: '2.0', id: req.id, result: { task } };
    }

    case A2A_METHODS.GET_AGENT_CARD:
      return { jsonrpc: '2.0', id: req.id, result: v1AgentCard() };

    default:
      return errorResponse(req.id, -32601, `Method not found: ${req.method}`);
  }
}

function createTask(initialState: A2ATaskState): TenantA2ATask {
  const id = `task-${++taskIdCounter}-${Date.now()}`;
  return {
    id,
    contextId: 'default',
    tenantId: resolveCurrentTenantId(),
    status: { state: initialState, timestamp: new Date().toISOString() },
  };
}

function assertTaskTenant(task: TenantA2ATask): void {
  const current = resolveCurrentTenantId();
  const owner = task.tenantId ?? DEFAULT_A2A_V2_TENANT_ID;
  if (owner !== current) {
    throw new TenantIsolationError(
      `Cross-tenant access blocked: task tenant=${owner}, current=${current}`,
    );
  }
}

function ssr(
  type: string,
  data: unknown,
): { jsonrpc: string; id: string | number | null; result: Record<string, unknown> } {
  return { jsonrpc: '2.0', id: null, result: { [type]: data } };
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): A2AJsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
