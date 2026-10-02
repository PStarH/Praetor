import { deliberate, deliberateWithLLM } from '../../ultimate/deliberation';
import { classifyEffortLevel } from '../../ultimate/effortScaler';
import { AgentRuntime } from '../../runtime/agentRuntime';
import { OpenAIProvider } from '../../runtime/providers/openaiProvider';
import { AnthropicProvider } from '../../runtime/providers/anthropicProvider';
import { GoogleProvider } from '../../runtime/providers/googleProvider';
import { OpenRouterProvider } from '../../runtime/providers/openRouterProvider';
import { DeepSeekProvider } from '../../runtime/providers/deepseekProvider';
import { GLMProvider } from '../../runtime/providers/glmProvider';
import { MiMoProvider } from '../../runtime/providers/mimoProvider';
import { XiaomiProvider } from '../../runtime/providers/xiaomiProvider';
import { OllamaProvider } from '../../runtime/providers/ollamaProvider';
import { VLLMProvider } from '../../runtime/providers/vllmProvider';
import { CohereProvider } from '../../runtime/providers/cohereProvider';
import { MistralProvider } from '../../runtime/providers/mistralProvider';
import { GroqProvider } from '../../runtime/providers/groqProvider';
import { TogetherProvider } from '../../runtime/providers/togetherProvider';
import { PerplexityProvider } from '../../runtime/providers/perplexityProvider';
import { FireworksProvider } from '../../runtime/providers/fireworksProvider';
import { ReplicateProvider } from '../../runtime/providers/replicateProvider';
import { BedrockProvider } from '../../runtime/providers/bedrockProvider';
import { XAIProvider } from '../../runtime/providers/xaiProvider';
import { AnyscaleProvider } from '../../runtime/providers/anyscaleProvider';
import { DeepInfraProvider } from '../../runtime/providers/deepinfraProvider';
import { AgnesProvider } from '../../runtime/providers/agnesProvider';
import { StepFunProvider } from '../../runtime/providers/stepfunProvider';
import { MiniMaxProvider } from '../../runtime/providers/minimaxProvider';
import { getModelRouter } from '../../runtime/modelRouter';
import { createAllTools, wireResourceToolDependencies } from '../../tools/index';
import {
  executeReview,
  formatReviewOutput,
  reviewReportToJson,
  loadReviewGuidelines,
} from '../../reviewAgent';
import type { LLMProvider } from '../../runtime/types';
import type { EffortLevel, OrchestrationTopology } from '../../ultimate/types';
import { UltimateOrchestrator } from '../../ultimate/orchestrator';
import { TELOSOrchestrator } from '../../telos/telosOrchestrator';
import { CompanyEngine } from '../../ultimate/companyEngine';
import { SSEStream } from '../../runtime/sseStream';
import { getMetaLearner } from '../../selfEvolution/metaLearner';
import { detectProvider, getEffectiveModel, type ProviderType } from '../../config/commanderConfig';
import { getApprovalSystem } from '../../sandbox';
import { getGlobalLogger } from '../../logging';
import { StateCheckpointer } from '../../runtime/stateCheckpointer';
import { spawn } from 'node:child_process';
import { TaskPool } from '../../ultimate/taskPool';
import { GoalOrchestrator } from '../../goal/goalOrchestrator';
import type { GoalConfig } from '../../goal/types';
import { SwarmOrchestrator } from '../../swarm/swarmOrchestrator';
import type { SwarmConfig } from '../../swarm/types';
import { DriveOrchestrator } from '../../drive/driveOrchestrator';
import type { DriveConfig } from '../../drive/types';
import { Scheduler, WorkflowRegistry } from '../../scheduler';
import type { ScheduleEntry, WorkflowTrigger } from '../../scheduler';
import {
  section,
  kv,
  bullet,
  cmdHeader,
  startSpinner,
  startSpinnerWithFailure,
  progressBar,
  StepProgress,
  onboardingMessage,
  $,
  parseFlags,
  fatalError,
  warn,
  setTheme,
  getThemeName,
  listThemes,
} from '../util';

const DEFAULT_TOOLS = 'web,file,exec,git';

export function loadTools(): string[] {
  return (process.env.COMMANDER_TOOLS || DEFAULT_TOOLS).split(',').map((s) => s.trim());
}

export function createRuntime(
  preferredProvider?: ProviderType,
  preferredModel?: string,
): AgentRuntime | null {
  const provider = detectProvider(preferredProvider);
  if (!provider) return null;

  const modelId = getEffectiveModel(preferredModel, preferredProvider);
  const runtime = new AgentRuntime({
    budgetHardCapTokens: 200000,
    smartModelRouter: { enabled: true },
  });
  const allTools = createAllTools();
  for (const [name, tool] of allTools) {
    runtime.registerTool(name, tool);
  }
  wireResourceToolDependencies(allTools, {
    handoff: { handoff: runtime.getHandoff(), agentId: 'commander' },
    toolResolver: (name) => runtime.getTool(name)?.definition,
    registryTools: [],
  });

  type ProviderConstructor = new (config: {
    apiKey: string;
    baseUrl?: string;
    defaultModel?: string;
    name?: string;
  }) => LLMProvider;

  const ProviderMap: Record<string, ProviderConstructor> = {
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
    google: GoogleProvider,
    openrouter: OpenRouterProvider,
    deepseek: DeepSeekProvider,
    glm: GLMProvider,
    mimo: MiMoProvider,
    xiaomi: XiaomiProvider,
    ollama: OllamaProvider,
    vllm: VLLMProvider,
    cohere: CohereProvider,
    mistral: MistralProvider,
    groq: GroqProvider,
    together: TogetherProvider,
    perplexity: PerplexityProvider,
    fireworks: FireworksProvider,
    replicate: ReplicateProvider,
    bedrock: BedrockProvider,
    xai: XAIProvider,
    anyscale: AnyscaleProvider,
    deepinfra: DeepInfraProvider,
    agnes: AgnesProvider,
    stepfun: StepFunProvider,
    minimax: MiniMaxProvider,
  };
  const ProviderClass = ProviderMap[provider.type] ?? OpenAIProvider;

  runtime.registerProvider(
    provider.type,
    new ProviderClass({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      defaultModel: modelId,
    }),
  );

  const router = getModelRouter();
  for (const tier of ['eco', 'standard', 'power', 'consensus'] as const) {
    router.registerModel({
      id: `${modelId}@${tier}`,
      provider: provider.type,
      tier,
      costPer1MInput: 0.8,
      costPer1MOutput: 4,
      capabilities: ['code', 'reasoning', 'analysis', 'creative', 'math'],
      contextWindow: 128000,
      priority: -1,
    });
  }

  return runtime;
}

export type { EffortLevel, OrchestrationTopology };
export {
  deliberate,
  deliberateWithLLM,
  classifyEffortLevel,
  detectProvider,
  getEffectiveModel,
  onboardingMessage,
  $,
  section,
  kv,
  bullet,
  cmdHeader,
  startSpinner,
  startSpinnerWithFailure,
  progressBar,
  StepProgress,
  parseFlags,
  fatalError,
  warn,
  setTheme,
  getThemeName,
  listThemes,
  getGlobalLogger,
  getMetaLearner,
  getApprovalSystem,
  StateCheckpointer,
  spawn,
  TaskPool,
  GoalOrchestrator,
  GoalConfig,
  SwarmOrchestrator,
  SwarmConfig,
  DriveOrchestrator,
  DriveConfig,
  CompanyEngine,
  SSEStream,
  TELOSOrchestrator,
  UltimateOrchestrator,
  executeReview,
  formatReviewOutput,
  reviewReportToJson,
  loadReviewGuidelines,
  Scheduler,
  WorkflowRegistry,
  ScheduleEntry,
  WorkflowTrigger,
  AgentRuntime,
};
