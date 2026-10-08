/**
 * A2A HTTP Endpoints
 * REST API for Agent-to-Agent communication
 * Based on Google's A2A Protocol Specification
 */

import express, { Request, Response, Router } from 'express';
import { TenantIsolationError } from '@praetor/core/runtime/tenantContext';
import { AgentCardGenerator, AgentCardRegistry } from './agentCard';
import { TaskManager, ArtifactManager, Task, TaskStatus } from './a2aTask';
import { requireA2ABearerAuth } from './a2aAuth';

export interface A2AServerConfig {
  port: number;
  baseUrl: string;
}

function handleTaskError(res: Response, error: unknown): void {
  if (error instanceof TenantIsolationError || (error as Error).name === 'TenantIsolationError') {
    res.status(403).json({ error: 'Forbidden', message: (error as Error).message });
    return;
  }
  res.status(400).json({ error: (error as Error).message });
}

export function createA2ARouter(
  taskManager: TaskManager,
  artifactManager: ArtifactManager,
  cardRegistry: AgentCardRegistry,
  options?: { authToken?: string | null },
): Router {
  const router = express.Router();
  // Security: express.json() with limit is applied globally in index.ts.
  // Omit `token` unless explicitly overridden so env COMMANDER_A2A_AUTH_TOKEN is used.
  const requireAuth = requireA2ABearerAuth({
    mode: 'rest',
    ...(options && 'authToken' in options ? { token: options.authToken } : {}),
  });

  /**
   * GET /.well-known/agent-card
   * Return the Agent Card for this agent (public discovery).
   */
  router.get('/.well-known/agent-card', (req: Request, res: Response) => {
    const baseUrl = req.protocol + '://' + req.get('host');
    const card = AgentCardGenerator.generateCommanderCard(baseUrl);
    res.json(card);
  });

  // All non-discovery routes require bearer auth (fail-closed if token unset).
  router.use(requireAuth);

  /**
   * GET /agent-cards
   * List all registered agents
   */
  router.get('/agent-cards', (req: Request, res: Response) => {
    const { tag, capability } = req.query;

    let cards;
    if (tag) {
      cards = cardRegistry.findByTags([tag as string]);
    } else if (capability) {
      cards = cardRegistry.findByCapability(capability as string);
    } else {
      cards = cardRegistry.listAll();
    }

    res.json({ cards, count: cards.length });
  });

  /**
   * GET /agent-cards/:id
   * Get a specific agent card
   */
  router.get('/agent-cards/:id', (req: Request, res: Response) => {
    try {
      const card = cardRegistry.get(String(req.params.id));
      if (!card) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.json(card);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks
   * Create a new task
   */
  router.post('/tasks', (req: Request, res: Response) => {
    const { clientId, description, input, priority } = req.body;

    if (!clientId || !description) {
      return res.status(400).json({
        error: 'Missing required fields: clientId, description',
      });
    }

    const task = taskManager.create(clientId, description, input || {}, priority || 'medium');

    res.status(201).json(task);
  });

  /**
   * GET /tasks/:id
   * Get task status
   */
  router.get('/tasks/:id', (req: Request, res: Response) => {
    try {
      const task = taskManager.get(String(req.params.id));
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks/:id/start
   * Start a task
   */
  router.post('/tasks/:id/start', (req: Request, res: Response) => {
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'Missing agentId' });
    }

    try {
      const task = taskManager.start(String(req.params.id), agentId);
      res.json(task);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks/:id/pause
   * Pause a running task
   */
  router.post('/tasks/:id/pause', (req: Request, res: Response) => {
    try {
      const task = taskManager.pause(String(req.params.id));
      res.json(task);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks/:id/resume
   * Resume a paused task
   */
  router.post('/tasks/:id/resume', (req: Request, res: Response) => {
    try {
      const task = taskManager.resume(String(req.params.id));
      res.json(task);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks/:id/cancel
   * Cancel a task
   */
  router.post('/tasks/:id/cancel', (req: Request, res: Response) => {
    try {
      const task = taskManager.cancel(String(req.params.id));
      res.json(task);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks/:id/complete
   * Complete a task with an artifact
   */
  router.post('/tasks/:id/complete', (req: Request, res: Response) => {
    const { contentType, content, metadata } = req.body;

    if (!contentType || content === undefined) {
      return res.status(400).json({
        error: 'Missing required fields: contentType, content',
      });
    }

    try {
      const artifact = artifactManager.create(
        String(req.params.id),
        contentType,
        content,
        metadata,
      );

      const task = taskManager.complete(String(req.params.id), artifact);
      res.json(task);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks/:id/fail
   * Mark a task as failed
   */
  router.post('/tasks/:id/fail', (req: Request, res: Response) => {
    const { error } = req.body;

    if (!error) {
      return res.status(400).json({ error: 'Missing error message' });
    }

    try {
      const task = taskManager.fail(String(req.params.id), error);
      res.json(task);
    } catch (err) {
      handleTaskError(res, err);
    }
  });

  /**
   * POST /tasks/:id/progress
   * Update task progress
   */
  router.post('/tasks/:id/progress', (req: Request, res: Response) => {
    const { progress } = req.body;

    if (typeof progress !== 'number') {
      return res.status(400).json({ error: 'Progress must be a number' });
    }

    try {
      const task = taskManager.updateProgress(String(req.params.id), progress);
      res.json(task);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * POST /tasks/:id/messages
   * Send a message to a task
   */
  router.post('/tasks/:id/messages', (req: Request, res: Response) => {
    const { sender, type, content, metadata } = req.body;

    if (!sender || !type || !content) {
      return res.status(400).json({
        error: 'Missing required fields: sender, type, content',
      });
    }

    try {
      const message = taskManager.addMessage(
        String(req.params.id),
        sender,
        type,
        content,
        metadata,
      );
      res.status(201).json(message);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * GET /tasks
   * List tasks with filters
   */
  router.get('/tasks', (req: Request, res: Response) => {
    const { status, clientId, agentId } = req.query;

    let tasks: Task[];

    if (status) {
      tasks = taskManager.listByStatus(status as TaskStatus);
    } else if (clientId) {
      tasks = taskManager.listByClient(clientId as string);
    } else if (agentId) {
      tasks = taskManager.listByAgent(agentId as string);
    } else {
      tasks = Array.from(taskManager.listAll());
    }

    res.json({ tasks, count: tasks.length });
  });

  /**
   * GET /artifacts/:id
   * Get an artifact by ID
   */
  router.get('/artifacts/:id', (req: Request, res: Response) => {
    try {
      const artifact = artifactManager.get(String(req.params.id));

      if (!artifact) {
        return res.status(404).json({ error: 'Artifact not found' });
      }

      res.json(artifact);
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  /**
   * GET /artifacts/task/:taskId
   * Get artifacts for a task
   */
  router.get('/artifacts/task/:taskId', (req: Request, res: Response) => {
    try {
      const artifacts = artifactManager.getByTask(String(req.params.taskId));
      res.json({ artifacts, count: artifacts.length });
    } catch (error) {
      handleTaskError(res, error);
    }
  });

  return router;
}

/**
 * Start A2A Server
 */
export function startA2AServer(config: A2AServerConfig) {
  const app = express();

  const taskManager = new TaskManager();
  const artifactManager = new ArtifactManager();
  const cardRegistry = new AgentCardRegistry();

  // Register self
  const selfCard = AgentCardGenerator.generateCommanderCard(`http://localhost:${config.port}`);
  cardRegistry.register(selfCard);

  // Mount A2A routes
  app.use('/a2a', createA2ARouter(taskManager, artifactManager, cardRegistry));

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: '2.0.0' });
  });

  return new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      process.stdout.write(`A2A Server running on http://localhost:${config.port}\n`);
      process.stdout.write(
        `Agent Card: http://localhost:${config.port}/a2a/.well-known/agent-card\n`,
      );
      resolve();
    });
  });
}
