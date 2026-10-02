import { reportSilentFailure } from './silentFailureReporter';
import { AgentRuntime, getMessageBus, getGlobalTenantProvider } from './runtime';
import { createAllTools, wireResourceToolDependencies } from './tools';
import { AgentTool } from './tools/agentTool';
import { UltimateOrchestrator } from './ultimate/orchestrator';
import { TELOSOrchestrator } from './telos/telosOrchestrator';
import { deliberate } from './ultimate/deliberation';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { MCPIntegrationManager, readMCPConfig } from './tools/mcpToolAdapter';
import { A2AServer, createA2AServer } from './mcp/a2aServer';
import { A2ADiscoveryManager } from './mcp/a2aClient';
import { A2ADelegateTool } from './tools/a2aDelegateTool';
import type { A2AAgentCard } from './mcp/a2aCompliance';
import { getGlobalLogger } from './logging';
import { assessGovernanceRiskLevel } from './ultimate/riskAssessor';

export interface AgentLoopConfig {
  projectRoot: string;
  maxConcurrentTasks: number;
  sessionTimeoutMs: number;
  stateFile: string;
  tools: string[];
}

const DEFAULT_CONFIG: AgentLoopConfig = {
  projectRoot: process.cwd(),
  maxConcurrentTasks: 5,
  sessionTimeoutMs: 3600000,
  stateFile: '.commander_state.json',
  tools: ['web', 'file', 'exec', 'git'],
};

export class CommanderAgentLoop {
  private runtime: AgentRuntime;
  private telos: TELOSOrchestrator;
  private orchestrator: UltimateOrchestrator;
  private config: AgentLoopConfig;
  private taskQueue: Array<{
    id: string;
    goal: string;
    priority: number;
    status: string;
    createdAt: string;
    tenantId?: string;
  }> = [];
  private activeSessions: Map<string, { startTime: number; goal: string; tenantId?: string }> =
    new Map();
  private isRunning = false;
  private mcpManager: MCPIntegrationManager | null = null;
  private a2aServer: A2AServer | null = null;
  private a2aDiscoveryManager: A2ADiscoveryManager | null = null;
  private logger = getGlobalLogger();

  constructor(config?: Partial<AgentLoopConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runtime = new AgentRuntime();

    // Register all tools (synchronous, no dynamic imports needed)
    const allTools = createAllTools();
    for (const [name, tool] of allTools) {
      this.runtime.registerTool(name, tool);
    }
    wireResourceToolDependencies(allTools, {
      handoff: { handoff: this.runtime.getHandoff(), agentId: 'commander' },
      toolResolver: (name) => this.runtime.getTool(name)?.definition,
      registryTools: [],
    });

    // Register AgentTool (sub-agent spawning) with the runtime
    const agentTool = new AgentTool(this.runtime);
    agentTool.registerAgent({
      name: 'general',
      description: 'General-purpose sub-agent',
      prompt: 'You are a capable sub-agent. Complete the assigned task thoroughly.',
      tools: ['browser_search', 'web_fetch', 'python_execute', 'file_read', 'code'],
    });
    agentTool.registerAgent({
      name: 'researcher',
      description: 'Web research specialist',
      prompt: 'You are a research specialist. Find and synthesize information from the web.',
      tools: ['browser_search', 'web_fetch', 'file_read'],
    });
    this.runtime.registerTool('agent', agentTool);

    this.telos = new TELOSOrchestrator(this.runtime);
    this.orchestrator = new UltimateOrchestrator(this.telos, this.runtime);
    this.loadState();
  }

  /**
   * Register LLM providers from environment variables.
   * Uses dynamic imports to avoid loading all 21 provider modules at compile time.
   * Called from start() before the main loop begins.
   */
  async registerProviders(): Promise<void> {
    const registrations: Array<() => Promise<void>> = [];

    if (process.env.OPENAI_API_KEY) {
      const apiKey = process.env.OPENAI_API_KEY;
      const baseUrl = process.env.OPENAI_BASE_URL;
      const defaultModel = process.env.OPENAI_MODEL || 'gpt-4o';
      registrations.push(async () => {
        const { OpenAIProvider } = await import('./runtime/providers/openaiProvider');
        this.runtime.registerProvider(
          'openai',
          new OpenAIProvider({ apiKey, baseUrl, defaultModel }),
        );
      });
    }
    if (process.env.AZURE_OPENAI_API_KEY) {
      const apiKey = process.env.AZURE_OPENAI_API_KEY;
      const baseUrl = process.env.AZURE_OPENAI_BASE_URL;
      const defaultModel = process.env.AZURE_OPENAI_MODEL || 'gpt-4o';
      const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
      registrations.push(async () => {
        const { AzureOpenAIProvider } = await import('./runtime/providers/azureOpenAIProvider');
        this.runtime.registerProvider(
          'azure',
          new AzureOpenAIProvider({ apiKey, baseUrl, defaultModel, apiVersion }),
        );
      });
    }
    if (process.env.ANTHROPIC_API_KEY) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      registrations.push(async () => {
        const { AnthropicProvider } = await import('./runtime/providers/anthropicProvider');
        this.runtime.registerProvider('anthropic', new AnthropicProvider({ apiKey }));
      });
    }
    if (process.env.GOOGLE_API_KEY) {
      const apiKey = process.env.GOOGLE_API_KEY;
      registrations.push(async () => {
        const { GoogleProvider } = await import('./runtime/providers/googleProvider');
        this.runtime.registerProvider('google', new GoogleProvider({ apiKey }));
      });
    }
    if (process.env.OPENROUTER_API_KEY) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      registrations.push(async () => {
        const { OpenRouterProvider } = await import('./runtime/providers/openRouterProvider');
        this.runtime.registerProvider('openrouter', new OpenRouterProvider({ apiKey }));
      });
    }
    if (process.env.DEEPSEEK_API_KEY) {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      registrations.push(async () => {
        const { DeepSeekProvider } = await import('./runtime/providers/deepseekProvider');
        this.runtime.registerProvider('deepseek', new DeepSeekProvider({ apiKey }));
      });
    }
    if (process.env.ZHIPU_API_KEY) {
      const apiKey = process.env.ZHIPU_API_KEY;
      registrations.push(async () => {
        const { GLMProvider } = await import('./runtime/providers/glmProvider');
        this.runtime.registerProvider('glm', new GLMProvider({ apiKey }));
      });
    }
    if (process.env.MIMO_API_KEY) {
      const apiKey = process.env.MIMO_API_KEY;
      registrations.push(async () => {
        const { MiMoProvider } = await import('./runtime/providers/mimoProvider');
        this.runtime.registerProvider('mimo', new MiMoProvider({ apiKey }));
      });
    }
    if (process.env.XIAOMI_API_KEY) {
      const apiKey = process.env.XIAOMI_API_KEY;
      registrations.push(async () => {
        const { XiaomiProvider } = await import('./runtime/providers/xiaomiProvider');
        this.runtime.registerProvider('xiaomi', new XiaomiProvider({ apiKey }));
      });
    }
    if (process.env.MINIMAX_API_KEY) {
      const apiKey = process.env.MINIMAX_API_KEY;
      registrations.push(async () => {
        const { MiniMaxProvider } = await import('./runtime/providers/minimaxProvider');
        this.runtime.registerProvider('minimax', new MiniMaxProvider({ apiKey }));
      });
    }
    if (process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_MODEL) {
      const baseUrl = process.env.OLLAMA_HOST || process.env.OLLAMA_BASE_URL || undefined;
      const defaultModel = process.env.OLLAMA_MODEL || undefined;
      registrations.push(async () => {
        const { OllamaProvider } = await import('./runtime/providers/ollamaProvider');
        this.runtime.registerProvider('ollama', new OllamaProvider({ baseUrl, defaultModel }));
      });
    }
    if (process.env.VLLM_BASE_URL || process.env.VLLM_MODEL) {
      const baseUrl = process.env.VLLM_BASE_URL || undefined;
      const defaultModel = process.env.VLLM_MODEL || undefined;
      registrations.push(async () => {
        const { VLLMProvider } = await import('./runtime/providers/vllmProvider');
        this.runtime.registerProvider('vllm', new VLLMProvider({ baseUrl, defaultModel }));
      });
    }
    if (process.env.CO_API_KEY || process.env.COHERE_API_KEY) {
      const apiKey = process.env.CO_API_KEY || process.env.COHERE_API_KEY || '';
      registrations.push(async () => {
        const { CohereProvider } = await import('./runtime/providers/cohereProvider');
        this.runtime.registerProvider('cohere', new CohereProvider({ apiKey }));
      });
    }
    if (process.env.MISTRAL_API_KEY) {
      const apiKey = process.env.MISTRAL_API_KEY;
      registrations.push(async () => {
        const { MistralProvider } = await import('./runtime/providers/mistralProvider');
        this.runtime.registerProvider('mistral', new MistralProvider({ apiKey }));
      });
    }
    if (process.env.GROQ_API_KEY) {
      const apiKey = process.env.GROQ_API_KEY;
      registrations.push(async () => {
        const { GroqProvider } = await import('./runtime/providers/groqProvider');
        this.runtime.registerProvider('groq', new GroqProvider({ apiKey }));
      });
    }
    if (process.env.TOGETHER_API_KEY) {
      const apiKey = process.env.TOGETHER_API_KEY;
      registrations.push(async () => {
        const { TogetherProvider } = await import('./runtime/providers/togetherProvider');
        this.runtime.registerProvider('together', new TogetherProvider({ apiKey }));
      });
    }
    if (process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY) {
      const apiKey = process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY || '';
      registrations.push(async () => {
        const { PerplexityProvider } = await import('./runtime/providers/perplexityProvider');
        this.runtime.registerProvider('perplexity', new PerplexityProvider({ apiKey }));
      });
    }
    if (process.env.FIREWORKS_API_KEY) {
      const apiKey = process.env.FIREWORKS_API_KEY;
      registrations.push(async () => {
        const { FireworksProvider } = await import('./runtime/providers/fireworksProvider');
        this.runtime.registerProvider('fireworks', new FireworksProvider({ apiKey }));
      });
    }
    if (process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY) {
      const apiKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY || '';
      registrations.push(async () => {
        const { ReplicateProvider } = await import('./runtime/providers/replicateProvider');
        this.runtime.registerProvider('replicate', new ReplicateProvider({ apiKey }));
      });
    }
    if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
      registrations.push(async () => {
        const { BedrockProvider } = await import('./runtime/providers/bedrockProvider');
        this.runtime.registerProvider('bedrock', new BedrockProvider({}));
      });
    }
    if (process.env.XAI_API_KEY) {
      const apiKey = process.env.XAI_API_KEY;
      const baseUrl = process.env.XAI_BASE_URL;
      const defaultModel = process.env.XAI_MODEL || 'grok-2-latest';
      registrations.push(async () => {
        const { XAIProvider } = await import('./runtime/providers/xaiProvider');
        this.runtime.registerProvider('xai', new XAIProvider({ apiKey, baseUrl, defaultModel }));
      });
    }
    if (process.env.ANYSCALE_API_KEY) {
      const apiKey = process.env.ANYSCALE_API_KEY;
      const baseUrl = process.env.ANYSCALE_BASE_URL;
      const defaultModel = process.env.ANYSCALE_MODEL || 'meta-llama/Llama-3.3-70B-Instruct';
      registrations.push(async () => {
        const { AnyscaleProvider } = await import('./runtime/providers/anyscaleProvider');
        this.runtime.registerProvider(
          'anyscale',
          new AnyscaleProvider({ apiKey, baseUrl, defaultModel }),
        );
      });
    }
    if (process.env.DEEPINFRA_API_KEY) {
      const apiKey = process.env.DEEPINFRA_API_KEY;
      const baseUrl = process.env.DEEPINFRA_BASE_URL;
      const defaultModel = process.env.DEEPINFRA_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
      registrations.push(async () => {
        const { DeepInfraProvider } = await import('./runtime/providers/deepinfraProvider');
        this.runtime.registerProvider(
          'deepinfra',
          new DeepInfraProvider({ apiKey, baseUrl, defaultModel }),
        );
      });
    }
    if (process.env.AGNES_API_KEY) {
      const apiKey = process.env.AGNES_API_KEY;
      const baseUrl = process.env.AGNES_BASE_URL;
      const defaultModel = process.env.AGNES_MODEL || 'agnes-2.5-flash';
      registrations.push(async () => {
        const { AgnesProvider } = await import('./runtime/providers/agnesProvider');
        this.runtime.registerProvider(
          'agnes',
          new AgnesProvider({ apiKey, baseUrl, defaultModel }),
        );
      });
    }
    if (process.env.STEPFUN_API_KEY) {
      const apiKey = process.env.STEPFUN_API_KEY;
      const baseUrl = process.env.STEPFUN_BASE_URL;
      const defaultModel = process.env.STEPFUN_MODEL || 'step-2-16k';
      registrations.push(async () => {
        const { StepFunProvider } = await import('./runtime/providers/stepfunProvider');
        this.runtime.registerProvider(
          'stepfun',
          new StepFunProvider({ apiKey, baseUrl, defaultModel }),
        );
      });
    }
    await Promise.all(registrations.map((fn) => fn()));
    this.logger.info(
      'AgentLoop',
      `Registered ${registrations.length} provider(s) from environment`,
    );
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.config.stateFile)) {
        const data = fs.readFileSync(this.config.stateFile, 'utf-8');
        const parsed = JSON.parse(data);
        this.taskQueue = parsed.taskQueue || [];
        this.logger.info('AgentLoop', `Loaded state: ${this.taskQueue.length} pending tasks`);
      }
    } catch (e) {
      this.logger.warn('AgentLoop', 'Failed to load state', { error: (e as Error)?.message });
      this.taskQueue = [];
    }
  }

  private saveState(): void {
    // Synchronous write — the state file is small (<1KB) and must be consistent
    // for crash recovery. Async writes create races on process exit and test assertions.
    const data = JSON.stringify(
      {
        taskQueue: this.taskQueue,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    try {
      fs.writeFileSync(this.config.stateFile, data, 'utf-8');
    } catch (e) {
      this.logger.debug('AgentLoop', 'saveState error', { error: (e as Error)?.message });
    }
  }

  private static readonly MAX_QUEUE_SIZE = 1000;

  addTask(goal: string, priority = 0, tenantId?: string): string {
    const id = `task_${Date.now()}_${this.taskQueue.length}`;
    const newTask = {
      id,
      goal,
      priority,
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
      tenantId,
    };
    // Insertion sort: find correct position and insert (O(N) instead of O(N log N) full sort)
    let insertIdx = this.taskQueue.length;
    for (let i = 0; i < this.taskQueue.length; i++) {
      if (priority > this.taskQueue[i].priority) {
        insertIdx = i;
        break;
      }
    }
    this.taskQueue.splice(insertIdx, 0, newTask);
    // Cap queue size to prevent unbounded growth in long sessions
    if (this.taskQueue.length > CommanderAgentLoop.MAX_QUEUE_SIZE) {
      this.taskQueue.length = CommanderAgentLoop.MAX_QUEUE_SIZE;
    }
    this.saveState();
    this.logger.info('AgentLoop', `Task added: ${goal.slice(0, 60)}... (${id})`);
    return id;
  }

  getQueueLength(): number {
    return this.taskQueue.length;
  }
  getActiveCount(): number {
    return this.activeSessions.size;
  }

  /**
   * Initialize MCP/A2A external integrations.
   * Called once at the start of start() since connections are async.
   */
  private async initializeExternalIntegrations(): Promise<void> {
    // Config reading (async to avoid blocking event loop)
    const configPath = path.join(this.config.projectRoot, '.commander.json');
    let commanderConfig: Record<string, unknown> | undefined;
    try {
      if (fs.existsSync(configPath)) {
        const data = await fs.promises.readFile(configPath, 'utf-8');
        commanderConfig = JSON.parse(data) as Record<string, unknown>;
      }
    } catch (err) {
      reportSilentFailure(err, 'agentLoop:354');
      this.logger.warn('AgentLoop', 'Failed to read .commander.json config');
    }

    // MCP integration
    try {
      const mcpServers = readMCPConfig(commanderConfig as Parameters<typeof readMCPConfig>[0]);
      if (mcpServers.length > 0) {
        this.mcpManager = new MCPIntegrationManager();
        await this.mcpManager.connect(mcpServers);
        if (this.mcpManager.isConnected()) {
          this.mcpManager.registerIntoRuntime(this.runtime);
          this.logger.info(
            'AgentLoop',
            `Registered ${this.mcpManager.getToolCount()} MCP tools from ${this.mcpManager.getServerCount()} servers`,
          );
        }
      }
    } catch (err) {
      this.logger.warn('AgentLoop', 'Failed to initialize MCP integration', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // A2A server
    const a2aConfig = commanderConfig?.a2a as Record<string, unknown> | undefined;
    try {
      if (a2aConfig?.server) {
        const serverCfg = a2aConfig.server as Record<string, unknown>;
        if (serverCfg.enabled !== false) {
          const agentCard: A2AAgentCard = {
            name: 'Commander',
            description:
              'Multi-agent orchestration system. Supports deliberation, multi-agent topologies, MCP tools, and distributed execution.',
            version: '1.0.0',
            supportedInterfaces: [
              {
                url: `http://${serverCfg.host ?? '127.0.0.1'}:${serverCfg.port ?? 3002}`,
                protocolBinding: 'JSONRPC',
                protocolVersion: '1.0',
              },
            ],
            capabilities: {
              streaming: false,
              pushNotifications: false,
              stateTransitionHistory: true,
            },
            defaultInputModes: ['text'],
            defaultOutputModes: ['text'],
            skills: [
              {
                id: 'deliberation',
                name: 'Task Deliberation',
                description: 'Analyze task complexity and select optimal execution topology',
                tags: ['planning', 'analysis'],
              },
              {
                id: 'orchestration',
                name: 'Multi-Agent Orchestration',
                description:
                  'Execute tasks using 5 canonical topologies (SINGLE, CHAIN, DISPATCH, ORCHESTRATOR, REVIEW) with 9 legacy alias names',
                tags: ['execution', 'multi-agent'],
              },
              {
                id: 'tool-execution',
                name: 'Tool Execution',
                description: 'Execute the 18 built-in tools and any MCP-compatible external tools',
                tags: ['tools', 'mcp'],
              },
            ],
          };

          this.a2aServer = createA2AServer(
            {
              port: (serverCfg.port as number) ?? 3002,
              host: (serverCfg.host as string) ?? '127.0.0.1',
              agentCard,
              authToken:
                (serverCfg.authToken as string) ??
                process.env.A2A_AUTH_TOKEN ??
                crypto.randomUUID() + crypto.randomUUID(),
            },
            this.runtime,
          );
          await this.a2aServer.start();
          this.logger.info(
            'AgentLoop',
            `A2A server started on ${serverCfg.host ?? '127.0.0.1'}:${serverCfg.port ?? 3002}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn('AgentLoop', 'Failed to start A2A server', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // A2A discovery from config
    try {
      if (a2aConfig?.remoteAgents && Array.isArray(a2aConfig.remoteAgents)) {
        this.a2aDiscoveryManager = new A2ADiscoveryManager();
        const remoteConfigs = a2aConfig.remoteAgents as Array<{
          label: string;
          url: string;
          authToken?: string;
        }>;
        const validConfigs = remoteConfigs.filter((cfg) => {
          if (!cfg.authToken || cfg.authToken.length < 16) {
            this.logger.warn(
              'AgentLoop',
              `Skipping A2A remote agent "${cfg.label}" — authToken is required (>=16 chars).`,
            );
            return false;
          }
          return true;
        });
        if (validConfigs.length > 0) {
          await this.a2aDiscoveryManager.discoverFromConfig(
            validConfigs as Array<{ label: string; url: string; authToken: string }>,
          );
          this.logger.info(
            'AgentLoop',
            `Connected to ${this.a2aDiscoveryManager.getAgentCount()} remote A2A agents`,
          );
        }
      }
    } catch (err) {
      this.logger.warn('AgentLoop', 'Failed to discover A2A agents from config', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.a2aDiscoveryManager = null;
    }

    // Register a2a_delegate tool
    {
      const dm = this.a2aDiscoveryManager ?? new A2ADiscoveryManager();
      this.runtime.registerTool('a2a_delegate', new A2ADelegateTool(dm));
    }

    // A2A discovery from env var
    const envJson = process.env.COMMANDER_A2A_AGENTS;
    const envAuthToken = process.env.COMMANDER_A2A_AUTH_TOKEN;
    if (envJson && !this.a2aDiscoveryManager) {
      try {
        const urls = JSON.parse(envJson) as string[];
        if (Array.isArray(urls) && urls.length > 0) {
          if (!envAuthToken || envAuthToken.length < 16) {
            this.logger.warn(
              'AgentLoop',
              'COMMANDER_A2A_AGENTS is set but COMMANDER_A2A_AUTH_TOKEN is missing or too short; skipping env-based A2A discovery.',
            );
          } else {
            this.a2aDiscoveryManager = new A2ADiscoveryManager();
            await this.a2aDiscoveryManager.discoverFromConfig(
              urls.map((url, i) => ({ label: `a2a-env-${i}`, url, authToken: envAuthToken })),
            );
            this.logger.info(
              'AgentLoop',
              `Connected to ${this.a2aDiscoveryManager.getAgentCount()} env-configured A2A agents`,
            );
          }
        }
      } catch (err) {
        reportSilentFailure(err, 'agentLoop:493');
        this.logger.warn('AgentLoop', 'Failed to parse COMMANDER_A2A_AGENTS env var');
      }
    }
  }

  async start() {
    if (this.isRunning) return;

    await this.initializeExternalIntegrations();

    this.isRunning = true;
    this.logger.info('AgentLoop', `Agent loop started. Tools: ${this.config.tools.join(', ')}`);
    this.logger.info('AgentLoop', `Pending tasks: ${this.taskQueue.length}`);

    while (this.isRunning && this.taskQueue.length > 0) {
      if (this.activeSessions.size >= this.config.maxConcurrentTasks) {
        await this.sleep(1000);
        continue;
      }

      const task = this.taskQueue.shift();
      if (!task) continue;

      this.executeTask(task).catch((err) => {
        this.logger.error(
          'AgentLoop',
          `Task ${task.id} failed`,
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }

    // Wait for active sessions to complete before exiting
    while (this.activeSessions.size > 0) {
      await this.sleep(1000);
    }

    this.logger.info('AgentLoop', 'Queue empty. All sessions complete.');
  }

  private async executeTask(task: { id: string; goal: string; tenantId?: string }) {
    const bus = getMessageBus();
    const tenantId = task.tenantId ?? getGlobalTenantProvider().getCurrentTenantId() ?? undefined;
    this.activeSessions.set(task.id, { startTime: Date.now(), goal: task.goal, tenantId });
    // Persist queue state now that the task is confirmed running.
    // Must happen before any async yield point so that crash between
    // shift() and execution start does not lose the task.
    this.saveState();

    this.logger.info('AgentLoop', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    this.logger.info('AgentLoop', `Executing: ${task.goal.slice(0, 80)}`);
    this.logger.info('AgentLoop', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    bus.publish('agent.started', 'commander-loop', { taskId: task.id, goal: task.goal });

    try {
      // Phase 1: Deliberation
      const plan = deliberate(task.goal);
      this.logger.info(
        'AgentLoop',
        `Type: ${plan.taskType} | Agents: ${plan.estimatedAgentCount} | Topology: ${plan.recommendedTopology} | Nature: ${plan.taskNature} | Spec: ${plan.suitableForSpeculation} | Time/agent: ${(plan.timeBudgetPerAgentMs / 1000).toFixed(1)}s`,
      );

      // Phase 2: Execute via orchestrator
      const result = await this.orchestrator.execute({
        projectId: 'commander',
        agentId: 'commander-lead',
        tenantId,
        goal: task.goal,
        contextData: {
          availableTools: this.config.tools,
          // Risk is measured from the goal, never asserted. This used to be a
          // hardcoded `'LOW'`, which made telosOrchestrator compute
          // `requiresApproval: false` for every goal — see assessGovernanceRiskLevel.
          governanceProfile: { riskLevel: assessGovernanceRiskLevel(task.goal, this.config.tools) },
        },
      });

      this.logger.info('AgentLoop', `Status: ${result.status}`);
      this.logger.info('AgentLoop', `Synthesis: ${result.synthesis.slice(0, 200)}...`);

      bus.publish('agent.completed', 'commander-loop', {
        taskId: task.id,
        status: result.status,
        metrics: result.metrics,
      });

      return result;
    } catch (err) {
      this.logger.error(
        'AgentLoop',
        'Task error',
        err instanceof Error ? err : new Error(String(err)),
      );
      bus.publish('agent.failed', 'commander-loop', { taskId: task.id, error: String(err) });
    } finally {
      this.activeSessions.delete(task.id);
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;

    if (this.a2aServer) {
      try {
        await this.a2aServer.stop();
        this.logger.info('AgentLoop', 'A2A server stopped');
      } catch (err) {
        this.logger.error(
          'AgentLoop',
          'Failed to stop A2A server',
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    if (this.mcpManager) {
      try {
        await this.mcpManager.disconnect();
        this.logger.info('AgentLoop', 'MCP servers disconnected');
      } catch (err) {
        this.logger.error(
          'AgentLoop',
          'Failed to disconnect MCP',
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }

    this.logger.info('AgentLoop', `Loop stopped. ${this.activeSessions.size} sessions remaining.`);
  }

  getStatus(): object {
    return {
      running: this.isRunning,
      queueLength: this.taskQueue.length,
      activeSessions: this.activeSessions.size,
      sessions: Array.from(this.activeSessions.entries()).map(([id, s]) => ({
        id,
        goal: s.goal.slice(0, 60),
        runningFor: Date.now() - s.startTime,
      })),
      tools: this.config.tools,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(r, ms);
      t.unref();
    });
  }
}
