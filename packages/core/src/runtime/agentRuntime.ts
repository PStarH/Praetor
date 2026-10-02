/**
 * Agent Runtime — Core execution engine for the Commander agent loop.
 *
 * `execute()` is a thin facade: RunInitializer → PreLoopSetup →
 * AgentLoopOrchestrator → FinallyCleanupHandler. Per-run mutable state lives in
 * `ExecutionContext` (M2); construction-time services are initialized via
 * `serviceInitializer`.
 *
 * The central orchestrator that drives the LLM → Tools → Verification → Retry
 * cycle. Each call to execute() runs one full agent turn:
 *   1. Model routing (eco → standard → power)
 *   2. Tool selection & availability filtering
 *   3. LLM provider call with timeout & retry
 *   4. Tool execution with dependency-aware planning
 *   5. Verification via UnifiedVerificationPipeline
 *   6. State checkpointing (crash-safe atomic writes)
 *   7. Metrics collection & trace recording
 *
 * Integrates CircuitBreaker, TokenGovernor, ContextCompactor, CompensationRegistry,
 * DeadLetterQueue, CycleDetector, and all tool subsystems.
 */
import { reportSilentFailure } from '../silentFailureReporter';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  AgentExecutionContext,
  AgentExecutionResult,
  AgentRuntimeConfig,
  Tool,
  ToolCall,
  ToolResult,
  ToolDefinition,
} from './types';

import type { AgentRuntimeInterface } from './agentRuntimeInterface';
import { ModelRouter, getModelRouter } from './modelRouter';
import { SmartModelRouter, type ModelRouterUserConfig } from './smartModelRouter';
import { getTraceRecorder } from './executionTrace';
import { PersistentTraceStore } from './traceStore';
import { ContextCompactor } from './contextCompactor';
import { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import { CircuitBreaker } from './circuitBreaker';
import { UnifiedVerificationPipeline } from './unifiedVerification';
import { TokenGovernor } from './tokenGovernor';
import { SamplesStore } from './samplesStore';
import { StateCheckpointer } from './stateCheckpointer';
import type { RunRecoveryResult } from './runRecovery';
import { getGlobalDeterminismCapture } from './determinismCapture';
import { StepTimeoutManager } from './stepTimeoutManager';
import { ProviderFallbackChain } from './providerFallbackChain';
import { ReflexionInjector } from '../memory/reflexionInjector';
import { DeadLetterQueue } from './deadLetterQueue';
import { getMetricsCollector } from './metricsCollector';
import { CompensationRegistry } from './compensationRegistry';
import { ReliabilityEngine } from './reliabilityEngine';
import { AgentInbox } from './agentInbox';
import { ExecutionContextInjector } from './executionContextInjector';
import { ExecutionRouter } from './executionRouter';
import { TeamRegistry } from './teamRegistry';
import { AgentHandoff } from './agentHandoff';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { MemoryManagerAgent } from '../memory/memoryManagerAgent';
import { runWithTenant } from './tenantContext';
import { getHookManager } from '../pluginManager';
import { ToolOutputManager } from './toolOutputManager';
import { ToolOrchestrator } from './toolOrchestrator';
import { ToolPlanner } from './toolPlanner';
import { CycleDetector } from './cycleDetector';
import { getExecutionScheduler, type RunHandle } from '../atr/scheduler';
import { LeaseManager } from '../atr/leaseManager';
import { createContentScanner, type ContentScanner } from '../contentScanner';
import { getEnterpriseSecurityGateway } from '../security/enterpriseSecurityGateway';
import { getCapabilityTokenIssuer } from '../security/capabilityToken';
import { isAgentSuspended, isAgentQuarantined } from '../security/securityResponseEngine';
import { assertInvariants } from '../security/securityInvariantVerifier';
import type { TenantProvider, TenantConfig } from './tenantProvider';
import type { PlannedToolCall } from '../compensation/rollbackPlanner';
import { getGlobalTenantProvider } from './tenantProvider';
import { getLaneManager } from '../sandbox/lane';
import type { MemoryStore } from '../episodicMemory';
import { getConversationStore } from '../memory/conversationStore';
import { CacheManager } from './cacheManager';
import { ConcurrencyController } from './concurrencyController';
import { RunLifecycleManager } from './runLifecycleManager';
import { getFreezeDryManager } from './freezeDry';
import { TenantManager } from './tenantManager';
import { CompensationService } from './compensationService';
import type { CompensationPlan } from '../compensation/types';
import type { SingleFlightStats } from './singleFlightRequestCache';
import type { GeminiCacheStats } from './geminiCacheManager';
import { ToolExecutionService } from './toolExecutionService';
import { initializeServices } from './serviceInitializer';
import { CheckpointingPhase } from './phases/checkpointing';
import { RunTelemetryRecorder } from './runTelemetryRecorder';
import { OpenTelemetryExporter } from './openTelemetryExporter';
import { FinallyCleanupHandler, type TenantOverrides } from './finallyCleanupHandler';
import { LLMRequestBuilder } from './llmRequestBuilder';
import { GoalCompletionVerifier } from './goalCompletionVerifier';
import { ToolExecutionHandler } from './toolExecutionHandler';
import { RunInitializer, type InitResult } from './runInitializer';
import { PreLoopSetup } from './preLoopSetup';
import { AgentLoopOrchestrator } from './agentLoopOrchestrator';
import { LlmCaller } from './llm/llmCaller';
import { normalizeToolCall } from './tool/toolCallNormalizer';
import { ToolCallRetryLoopDetector } from './tool/toolCallRetryLoopDetector';
import { ToolCallSecurityGate } from './tool/toolCallSecurityGate';
import { TenantContextResolver } from './tenant/tenantContextResolver';
import { ReflexionGenerator } from './reflexionGenerator';
import { compileSchema } from './toolCallValidator';
import { getGlobalLogger } from '../logging';
import { getDataRetentionJanitor } from '../storage/dataRetention';
import { getCostEstimator } from './costEstimator';
import { ExecutionContext, taskTypeToCategory } from './executionContext';
import { detectTaskType } from './taskAnalyzer';

// TokenSentinel and CostGuard imports removed — both superseded by
// UnifiedCostAuthority (UCA). The legacy classes remain as @deprecated
// thin shells for backward compatibility but are no longer invoked
// from the agent runtime hot path.
import { getModelPerformanceStore } from './modelPerformanceStore';
import { getSecurityMonitor } from '../security/securityMonitor';
import { initializeRuntimeGuardian } from './runtimeGuardianBridge';
import { SecurityOrchestrator } from './securityOrchestrator';
import { DEFAULT_CONFIG, generateId } from './runtimeHelpers';

export class AgentRuntime implements AgentRuntimeInterface {
  private config: AgentRuntimeConfig;
  private providers: Map<string, LLMProvider> = new Map();
  private tools: Map<string, Tool> = new Map();
  private router: ModelRouter;
  private smartRouter: SmartModelRouter | null = null;
  /** When false, the smart router is bypassed and the legacy routeWithCascade path runs even if a smartRouter instance exists. Default ON. */
  private smartRouterActive: boolean = true;
  private compactor: ContextCompactor;
  private slidingWindow: SlidingWindowOrchestrator;
  private reliabilityEngine!: ReliabilityEngine;
  private circuitBreaker: CircuitBreaker;
  private verificationPipeline: UnifiedVerificationPipeline;
  private reflexionInjector: ReflexionInjector;
  private governor: TokenGovernor;
  /** Per-run mutable scratch state — isolates concurrent execute() calls. */
  private runContext = new ExecutionContext();
  private samplesStore: SamplesStore;
  private memory: import('../threeLayerMemory').ThreeLayerMemory | null = null;
  private traceStore: PersistentTraceStore;
  private checkpointer: StateCheckpointer;
  /** Startup zombie-run recovery scan; awaited before any run is admitted. */
  private recoverySettled: Promise<import('./serviceInitializer').RecoverySettlement>;
  private dlq: DeadLetterQueue;
  private leaseManager: LeaseManager;
  private reflexionGenerator: ReflexionGenerator = new ReflexionGenerator();
  private stepTimeout: StepTimeoutManager;
  private fallbackChain: ProviderFallbackChain<import('./types').LLMResponse>;
  private lastPrefixCacheKey?: string;
  private agentInbox: AgentInbox;
  private contextInjector: ExecutionContextInjector;
  private executionRouter: ExecutionRouter;
  private teamRegistry: TeamRegistry;
  private agentHandoff: AgentHandoff;
  private outputManager: ToolOutputManager;
  private breakerRegistry: import('./circuitBreakerRegistry').CircuitBreakerRegistry;
  private memoryStore: MemoryStore | null = null;
  private otelExporter: OpenTelemetryExporter | null = null;
  private orchestrator: ToolOrchestrator;
  private planner: ToolPlanner;
  private cycleDetector: CycleDetector;
  /** Tools promoted to Tier 1 (full schema) in the current turn — for hallucination rejection gate */
  private promotedTools: Set<string> = new Set();
  // Phase 3 — ExecutionScheduler handle for the currently executing run
  private runHandle: RunHandle | null = null;
  /** Tracks successful mutation tool calls per retry attempt for rollback planning */
  private executedMutations: PlannedToolCall[] = [];
  /** RunLedger transaction context (runId, leaseToken, fencingEpoch) */
  private ledgerCtx: {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  } | null = null;
  private contentScanner: ContentScanner;
  // SecurityOrchestrator: unified runtime defense facade
  private securityOrch: SecurityOrchestrator;
  // Conversation store (FTS5-powered session persistence)
  private conversationStore: import('../memory/conversationStore').ConversationStore | null = null;

  // Extracted services (shrink the god object)
  private cacheManager: CacheManager;
  private concurrencyController: ConcurrencyController;
  private runLifecycle: RunLifecycleManager;
  private tenantManager: TenantManager;
  private compensationService: CompensationService;
  private toolExecutionService: ToolExecutionService;
  private checkpointingPhase: CheckpointingPhase;
  // Records success/failure run telemetry (hooks, metrics, bus, circuit
  // breaker, memory, intelligence, meta-learner) - extracted from execute().
  private runTelemetryRecorder: RunTelemetryRecorder;
  // Finally-block cleanup — extracted from execute() for testability/clarity
  private finallyCleanupHandler: FinallyCleanupHandler;
  // Extracted from execute() step 2 — builds the cache-optimized LLM request.
  private llmRequestBuilder: LLMRequestBuilder;
  // Extracted from execute()'s retry loop — verifies goal completion via the
  // configured verification tool before accepting a stop signal.
  private goalCompletionVerifier: GoalCompletionVerifier;
  // Extracted from execute()'s retry loop — owns the per-response tool-execution
  // phase (onStepStart → tool dispatch → result redaction → onStepComplete).
  private toolExecutionHandler: ToolExecutionHandler;

  // Extracted from execute() step 1 — acquires concurrency/lane, seeds FreezeDry,
  // starts the tracer, writes the intent log, and registers with the scheduler.
  private runInitializer: RunInitializer;

  // Extracted from execute() step 3 — per-run setup inside runWithTenant before
  // the retry loop: budget check, routing, LLM request build, context injection,
  // event emission, and circuit-breaker check.
  private preLoopSetup: PreLoopSetup;

  // Extracted from execute() step 4 — the retry loop: LLM call, tool execution,
  // verification, early exit, checkpointing, and result construction.
  private agentLoopOrchestrator: AgentLoopOrchestrator;

  // Extracted from AgentRuntime private methods — shrink the god object.
  private llmCaller: LlmCaller;
  private toolCallRetryLoopDetector: ToolCallRetryLoopDetector;
  private toolCallSecurityGate: ToolCallSecurityGate;
  private tenantContextResolver: TenantContextResolver;

  // Tenant config provider (kept for direct lookups in execute())
  private tenantProvider: TenantProvider;

  // Last error from a provider call, preserved so the retry loop can
  // classify it properly instead of seeing "Unknown error".
  private lastProviderError: Error | null = null;
  // Last hallucination detection result, fed into AdaptiveHITL signals.
  private lastHallucinationDetected = false;

  constructor(
    config?: Partial<AgentRuntimeConfig>,
    router?: ModelRouter,
    tenantProvider?: TenantProvider,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Wire providerRetry config into maxRetries and retryDelayMs so callers
    // can control provider-level retry behavior without setting individual fields.
    if (config?.providerRetry) {
      if (config.providerRetry.attempts !== undefined) {
        this.config.maxRetries = config.providerRetry.attempts;
      }
      if (config.providerRetry.initialDelayMs !== undefined) {
        this.config.retryDelayMs = config.providerRetry.initialDelayMs;
      }
    }

    this.router = router ?? getModelRouter();
    if (this.config.smartModelRouter?.enabled) {
      this.smartRouter =
        SmartModelRouter.fromEnv() ??
        new SmartModelRouter(this.config.smartModelRouter as Partial<ModelRouterUserConfig>);
    }
    this.tenantProvider = tenantProvider ?? getGlobalTenantProvider();

    // Delegate subsystem construction to ServiceInitializer so this file stays
    // an orchestrator rather than a 500-line constructor.
    const services = initializeServices(
      {
        config: this.config,
        getRunHandle: () => this.runContext.runHandle,
        getLedgerCtx: () => this.runContext.ledgerCtx,
        getActiveRuns: () => new Set(this.runLifecycle?.getActiveRuns() ?? []),
        isRunPaused: (runId) => this.checkpointingPhase?.isPaused(runId) ?? false,
        getPromotedTools: () => this.runContext.promotedTools as Set<string>,
        generateActionId: () => this.generateActionId(),
      },
      this.tools,
    );

    // Promote all initialized services to instance fields (preserves the
    // existing AgentRuntimeInterface surface while shrinking the god object).
    this.recoverySettled = services.recoverySettled;
    this.compactor = services.compactor;
    this.slidingWindow = services.slidingWindow;
    this.reliabilityEngine = services.reliabilityEngine;
    this.circuitBreaker = services.circuitBreaker;
    this.dlq = services.dlq;
    this.checkpointer = services.checkpointer;
    this.governor = services.governor;
    this.verificationPipeline = services.verificationPipeline;
    this.verificationPipeline.setRuntime(this);
    this.reflexionInjector = services.reflexionInjector;
    this.reflexionGenerator = services.reflexionGenerator;
    this.samplesStore = services.samplesStore;
    this.traceStore = services.traceStore;
    this.leaseManager = services.leaseManager;
    this.stepTimeout = services.stepTimeout;
    this.fallbackChain = services.fallbackChain;
    this.compensationService = services.compensationService;
    this.agentInbox = services.agentInbox;
    this.teamRegistry = services.teamRegistry;
    this.agentHandoff = services.agentHandoff;
    this.cacheManager = services.cacheManager;
    this.concurrencyController = services.concurrencyController;
    this.runLifecycle = services.runLifecycle;
    this.tenantManager = services.tenantManager;
    this.toolExecutionService = services.toolExecutionService;
    this.outputManager = services.outputManager;
    this.breakerRegistry = services.breakerRegistry;
    this.orchestrator = services.orchestrator;
    this.planner = services.planner;
    this.cycleDetector = services.cycleDetector;
    this.contentScanner = services.contentScanner;
    this.securityOrch = services.securityOrch;
    this.contextInjector = services.contextInjector;
    this.memory = services.memory;
    this.memoryStore = services.memoryStore;
    this.conversationStore = services.conversationStore;
    this.otelExporter = services.otelExporter;

    // Auto-wire an active memory manager agent when the runtime owns a memory
    // instance and no manager is present. This turns passive memory.add() into
    // autonomous store/retrieve/update/summarize/discard decisions.
    if (this.memory && !this.memory.hasMemoryManagerAgent()) {
      this.memory.setMemoryManagerAgent(new MemoryManagerAgent());
    }

    this.executionRouter = new ExecutionRouter({
      getSmartRouter: () => this.smartRouter,
      isSmartRouterActive: () => this.smartRouterActive,
      getRouter: () => this.router,
      getGovernor: () => this.runContext.governor,
      getProviders: () => this.providers,
    });

    this.checkpointingPhase = new CheckpointingPhase({
      checkpointer: this.checkpointer,
      runLifecycle: this.runLifecycle,
      leaseManager: this.leaseManager,
      getRunHandle: () => this.runContext.runHandle,
    });

    // RunTelemetryRecorder owns the success/failure telemetry tails that were
    // previously inlined in execute()'s retry loop. Getters are used so the
    // recorder always reads the runtime's current state (e.g. runHandle is
    // assigned mid-run, router/memory are stable after init).
    this.runTelemetryRecorder = new RunTelemetryRecorder({
      getMemory: () => this.memory,
      getRouter: () => this.router,
      getCircuitBreaker: () => this.circuitBreaker,
      getRunHandle: () => this.runContext.runHandle,
      getCheckpointingPhase: () => this.checkpointingPhase,
      getMaxRetries: () => this.config.maxRetries,
    });

    // Wire the finally-block cleanup handler with getter callbacks so it always
    // observes the runtime's current (possibly tenant-overridden) instance
    // fields rather than values captured at construction time.
    this.finallyCleanupHandler = new FinallyCleanupHandler({
      getCircuitBreaker: () => this.circuitBreaker,
      getRunLifecycle: () => this.runLifecycle,
      getTenantManager: () => this.tenantManager,
      getConcurrencyController: () => this.concurrencyController,
      getTracer: () => getTraceRecorder(),
      getConfig: () => this.config,
      getOtelExporter: () => this.otelExporter,
      getSamplesStore: () => this.samplesStore,
      getTraceStore: () => this.traceStore,
      getConversationStore: () => this.conversationStore,
      restoreTenantOverrides: (overrides, tenantId) =>
        this.tenantContextResolver.restoreTenantOverrides(overrides, tenantId),
    });

    // LLMRequestBuilder — dependency-injected via getter/setter callbacks so it
    // always observes the runtime's current (per-run) instance fields rather
    // than values captured at construction time.
    this.llmRequestBuilder = new LLMRequestBuilder({
      getConfig: () => this.config,
      getGovernor: () => this.runContext.governor,
      getRouter: () => this.router,
      getSmartRouter: () => this.smartRouter,
      getTools: () => this.tools,
      setPromotedTools: (tools: Set<string>) => {
        this.runContext.setPromotedTools(tools);
      },
      setTool: (name: string, tool: Tool) => {
        this.tools.set(name, tool);
      },
      getLastPrefixCacheKey: () => this.runContext.lastPrefixCacheKey,
      setLastPrefixCacheKey: (key: string) => {
        this.runContext.setLastPrefixCacheKey(key);
      },
    });

    // GoalCompletionVerifier — owns the goal-completion verification gate that
    // previously lived inline in execute()'s retry loop. Getter callbacks keep
    // it decoupled from the runtime's concrete (possibly per-tenant) state.
    this.goalCompletionVerifier = new GoalCompletionVerifier({
      getExecuteTool: () => this.executeTool.bind(this),
      getMaxRetries: () => this.config.maxRetries,
    });

    // ToolExecutionHandler — owns the tool-execution phase that previously lived
    // inline in execute()'s retry loop (onStepStart hook → tool-call parsing →
    // batch-safe/sequential dispatch → result redaction → onStepComplete →
    // follow-up LLM call). Getter callbacks keep it decoupled from the runtime's
    // concrete (possibly per-tenant) instance fields; the runtime-method
    // callbacks are bound so `this` resolves correctly inside the handler.
    this.toolExecutionHandler = new ToolExecutionHandler({
      getConfig: () => this.config,
      getTools: () => this.tools,
      getGovernor: () => this.runContext.governor,
      getCacheManager: () => this.cacheManager,
      getPlanner: () => this.planner,
      getOrchestrator: () => this.orchestrator,
      getOutputManager: () => this.outputManager,
      getCycleDetector: () => this.cycleDetector,
      getSecurityOrch: () => this.securityOrch,
      getSlidingWindow: () => this.runContext.slidingWindow,
      getMemory: () => this.memory,
      getCompactor: () => this.compactor,
      isRunPaused: (runId) => this.checkpointingPhase?.isPaused(runId) ?? false,
      normalizeToolCall: (tc) => normalizeToolCall(tc),
      applyPreToolCallGates: (
        tc,
        agentId,
        runId,
        tenantId,
        recentToolPatterns,
        toolLoopCount,
        siblingAbortSignal,
      ) =>
        this.toolCallSecurityGate.applyPreToolCallGates(
          tc,
          agentId,
          runId,
          tenantId,
          recentToolPatterns,
          toolLoopCount,
          siblingAbortSignal,
        ),
      applyBeforeToolCallSecurity: (tc, agentId, runId) =>
        this.toolCallSecurityGate.applyBeforeToolCallSecurity(tc, agentId, runId),
      executeTool: (runId, toolCall, agentId, tenantId, allowedTools, agentCtx) =>
        this.executeTool(runId, toolCall, agentId, tenantId, allowedTools, agentCtx),
      invalidateMutationCache: (toolName) => this.invalidateMutationCache(toolName),
      callWithTimeout: (request, routing, attemptNumber, taskId) =>
        this.llmCaller.callWithTimeout(request, routing, attemptNumber, taskId),
      setExecutedMutations: (mutations) => {
        this.runContext.replaceExecutedMutations(mutations);
      },
      setLastHallucinationDetected: (value) => {
        this.lastHallucinationDetected = value;
      },
    });

    // RunInitializer — extracted from the top of execute(). Acquires the
    // concurrency/lane slots, seeds FreezeDry, starts the tracer, writes the
    // intent log, sets the active-runs gauge, and registers with the scheduler.
    this.runInitializer = new RunInitializer({
      getConfig: () => this.config,
      getConcurrencyController: () => this.concurrencyController,
      getTenantProvider: () => this.tenantProvider,
      getTenantManager: () => this.tenantManager,
      getLaneManager: () => getLaneManager(),
      getRunLifecycle: () => this.runLifecycle,
      getFreezeDryManager: () => getFreezeDryManager(),
      getTracer: () => getTraceRecorder(),
      getExecutionScheduler: () => getExecutionScheduler(),
    });

    // PreLoopSetup — extracted from the pre-loop body inside runWithTenant.
    // Owns context-data lift, budget check, routing, LLM request construction,
    // tool provisioning, checkpoint start, context injection, started event,
    // onAgentStart hooks, sliding-window creation, and circuit-breaker check.
    this.preLoopSetup = new PreLoopSetup({
      getConfig: () => this.config,
      getRouter: () => this.router,
      getExecutionRouter: () => this.executionRouter,
      getLLMRequestBuilder: () => this.llmRequestBuilder,
      getContextInjector: () => this.contextInjector,
      getCheckpointingPhase: () => this.checkpointingPhase,
      getSamplesStore: () => this.samplesStore,
      getGovernor: () => this.runContext.governor,
      getCircuitBreaker: () => this.circuitBreaker,
      getProviders: () => this.providers,
      getTools: () => this.tools,
      getCacheManager: () => this.cacheManager,
      getSmartRouterActive: () => this.smartRouterActive,
      setSmartRouterActive: (enabled) => {
        this.smartRouterActive = enabled;
      },
      setGovernor: (governor) => {
        this.runContext.setGovernor(governor);
      },
      setSlidingWindow: (sw) => {
        this.runContext.setSlidingWindow(sw);
      },
      setVerificationPipelineEvaluator: (provider) => {
        this.verificationPipeline.setEvaluatorProvider(provider);
      },
    });

    // LlmCaller — owns the LLM provider invocation chain previously implemented
    // by the private methods callWithTimeout / callProviderOrThrow / callProvider.
    this.llmCaller = new LlmCaller({
      getProviders: () => this.providers,
      getLastProviderError: () => this.lastProviderError,
      setLastProviderError: (err) => {
        this.lastProviderError = err;
      },
      samplesStore: this.samplesStore,
      cacheManager: this.cacheManager,
      stepTimeout: this.stepTimeout,
      fallbackChain: this.fallbackChain,
      llmTimeoutMs: this.config.llmTimeoutMs,
    });

    // AgentLoopOrchestrator — extracted from execute()'s retry loop. Owns the
    // LLM call, tool execution, verification, early exit, checkpointing, and
    // result construction. Getter callbacks keep it decoupled from per-run state.
    this.agentLoopOrchestrator = new AgentLoopOrchestrator({
      getConfig: () => this.config,
      getProviders: () => this.providers,
      getRouter: () => this.router,
      getSmartRouter: () => this.smartRouter,
      getGovernor: () => this.runContext.governor,
      getCircuitBreaker: () => this.circuitBreaker,
      getToolExecutionHandler: () => this.toolExecutionHandler,
      getToolExecutionService: () => this.toolExecutionService,
      getGoalCompletionVerifier: () => this.goalCompletionVerifier,
      getVerificationPipeline: () => this.verificationPipeline,
      getContentScanner: () => this.contentScanner,
      getMemory: () => this.memory,
      getCheckpointingPhase: () => this.checkpointingPhase,
      getSamplesStore: () => this.samplesStore,
      getCompactor: () => this.compactor,
      getCycleDetector: () => this.cycleDetector,
      getReflexionInjector: () => this.reflexionInjector,
      getReflexionGenerator: () => this.reflexionGenerator,
      getSecurityOrch: () => this.securityOrch,
      getRunTelemetryRecorder: () => this.runTelemetryRecorder,
      getMetricsCollector: () => getMetricsCollector(),
      getCostEstimator: () => getCostEstimator(),
      getHookManager: () => getHookManager(),
      getLastProviderError: () => this.lastProviderError,
      setLastProviderError: (err) => {
        this.lastProviderError = err;
      },
      setLastHallucinationDetected: (value) => {
        this.lastHallucinationDetected = value;
      },
      onCircuitReleased: () => {
        // Circuit-released flag is tracked by mutating init.circuitReleased
        // inside the orchestrator so the finally cleanup handler reads the
        // correct per-run value.
      },
      executeTool: this.executeTool.bind(this),
      callWithTimeout: this.llmCaller.callWithTimeout.bind(this.llmCaller),
    });

    // ToolCallRetryLoopDetector — pure helper, no runtime dependencies.
    this.toolCallRetryLoopDetector = new ToolCallRetryLoopDetector();

    // ToolCallSecurityGate — centralizes SecurityOrchestrator pre-tool-call
    // checks and the four pre-tool-call safety gates.
    this.toolCallSecurityGate = new ToolCallSecurityGate({
      getSecurityOrch: () => this.securityOrch,
      getCycleDetector: () => this.cycleDetector,
      getTool: (name) => this.getTool(name),
      getLastHallucinationDetected: () => this.lastHallucinationDetected,
      retryLoopDetector: this.toolCallRetryLoopDetector,
    });

    // TenantContextResolver — multi-tenant store swapping and restore.
    this.tenantContextResolver = new TenantContextResolver({
      getTenantManager: () => this.tenantManager,
      getTenantStores: () => ({
        origSamplesStore: this.samplesStore,
        origTraceStore: this.traceStore,
        origCheckpointer: this.checkpointer,
        origMemory: this.memory,
        origGovernor: this.runContext.isActive ? this.runContext.governor : this.governor,
      }),
      setTenantStores: (stores) => {
        this.samplesStore = stores.origSamplesStore;
        this.traceStore = stores.origTraceStore;
        this.checkpointer = stores.origCheckpointer;
        this.memory = stores.origMemory;
        this.governor = stores.origGovernor;
        if (this.runContext.isActive) {
          this.runContext.setGovernor(stores.origGovernor);
        }
      },
    });

    // Benchmarks may intentionally generate high tool-call volumes; let callers
    // disable GuardianAgent monitoring through the runtime config.
    if (this.config.securityMonitor?.enabled === false) {
      this.securityOrch.updateConfig({ enableGuardianAgent: false });
    }

    // SOC 2 C1.2 / GDPR Art 17 disposal — schedule the retention janitor from
    // the runtime constructor so CLI-only paths still get the housekeeping tick.
    try {
      const janitor = getDataRetentionJanitor();
      const claimed = janitor.schedule(60 * 60 * 1000, false);
      getGlobalLogger().info(
        'AgentRuntime',
        claimed
          ? `DataRetentionJanitor scheduled (1h interval) [rootDir=${janitor.rootDir}, claimed]`
          : `DataRetentionJanitor dedup-catch -- tick already owned (rootDir=${janitor.rootDir})`,
      );
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to schedule retention janitor', {
        error: (e as Error)?.message,
      });
    }

    // Start security monitoring (best-effort, can be disabled for benchmarks)
    if (this.config.securityMonitor?.enabled !== false) {
      try {
        getSecurityMonitor().start();
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:712');
        /* best-effort */
      }
    }

    // Initialize the runtime guardian bridge with this runtime's provider access.
    // Only initialize when explicitly enabled in config — avoids side effects
    // in tests that don't expect extra LLM calls from the guardian.
    if (this.config.runtimeGuardian?.enabled) {
      try {
        const runtimeRef = this;
        initializeRuntimeGuardian((name: string) => {
          const provider = runtimeRef.getProvider(name);
          if (!provider) return null;
          return {
            call: (input: {
              model: string;
              messages: { role: string; content: string }[];
              maxTokens: number;
            }) =>
              provider.call({
                ...input,
                messages: input.messages as LLMMessage[],
              }),
          };
        }, this.config.runtimeGuardian);
      } catch (err) {
        reportSilentFailure(err, 'agentRuntime:runtime-guardian-init');
        /* best-effort — GuardianAgent rules still provide baseline protection */
      }
    }
  }

  /**
   * Handle a mutation tool failure by generating a rollback plan and triggering compensation.
   * Publishes a 'tool.compensation_planned' bus event with plan metadata.
   * For safe plans, auto-executes compensation via SagaCoordinator.
   */
  async handleMutationToolFailure(
    toolName: string,
    args: Record<string, unknown>,
    error: string,
  ): Promise<void> {
    return this.compensationService.handleMutationToolFailure(
      toolName,
      args,
      error,
      this.runContext.mutableExecutedMutations,
    );
  }

  /**
   * Execute a compensation plan by iterating through steps and calling
   * compensationRegistry.compensate() for each recorded action.
   */
  async compensateViaSaga(plan: CompensationPlan): Promise<void> {
    return this.compensationService.compensateViaSaga(plan);
  }

  /** Invalidate read caches after mutation tools succeed */
  private invalidateMutationCache(toolName: string): void {
    const toolCache = this.cacheManager.getToolCache();
    if (toolName.startsWith('file_')) {
      toolCache.invalidatePattern('file_read');
    } else if (toolName.startsWith('memory_')) {
      toolCache.invalidatePattern('memory_recall');
      toolCache.invalidatePattern('memory_list');
    } else if (toolName === 'git_push' || toolName === 'git_commit') {
      toolCache.invalidateTool('git');
    } else if (toolName === 'shell_execute' || toolName === 'python_execute') {
      // Shell commands may mutate filesystem; invalidate file_read broadly
      toolCache.invalidatePattern('file_read');
    }
  }

  registerProvider(name: string, provider: LLMProvider): void {
    this.providers.set(name, provider);
  }

  registerTool(name: string, tool: Tool): void {
    // Normalize OpenAI-style `parameters` to ToolDefinition's `inputSchema` so
    // runtime validation and prompt rendering work for all registered tools.
    type LegacyToolDefinition = ToolDefinition & { parameters?: Record<string, unknown> };
    const def = tool.definition as LegacyToolDefinition;
    if (def.parameters && (!def.inputSchema || Object.keys(def.inputSchema).length === 0)) {
      def.inputSchema = def.parameters;
    }
    if (!tool.compiledSchema && def.inputSchema) {
      try {
        tool.compiledSchema = compileSchema(def.inputSchema);
      } catch (err) {
        getGlobalLogger().warn('AgentRuntime', 'Failed to compile tool input schema', {
          toolName: name,
          error: (err as Error)?.message,
        });
      }
    }
    this.tools.set(name, tool);
  }

  getProvider(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  getFirstAvailableProvider(preferredName?: string): LLMProvider | undefined {
    if (preferredName) {
      const p = this.providers.get(preferredName);
      if (p) return p;
    }
    return this.providers.values().next().value;
  }

  getSmartRouter(): SmartModelRouter | null {
    return this.smartRouter;
  }

  /**
   * Live toggle for SmartModelRouter participation. When false, the runtime
   * falls back to the legacy `routeWithCascade` path even if a smart router
   * instance exists. Default ON at construction. Idempotent.
   */
  setSmartModelRouterEnabled(enabled: boolean): void {
    this.smartRouterActive = enabled;
  }

  /** Current state of the SmartModelRouter toggle (for diagnostics). */
  isSmartModelRouterEnabled(): boolean {
    return this.smartRouterActive;
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Return the names of all registered tools. */
  listToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getConfig(): AgentRuntimeConfig {
    return { ...this.config };
  }

  /** Access the persistent MemoryService facade or null if not initialized. */
  getMemoryStore(): MemoryStore | null {
    return this.memoryStore;
  }

  /** Number of pending run acquisitions waiting on the concurrency semaphore. */
  getQueueDepth(): number {
    return this.concurrencyController.getQueueDepth();
  }

  /** Active ExecutionScheduler handle for the in-flight run (ToolExecutionRuntime). */
  getRunHandle(): RunHandle | null {
    return this.runContext.runHandle;
  }

  /** Promoted tools for the active run's hallucination rejection gate. */
  getPromotedTools(): Set<string> {
    return this.runContext.promotedTools as Set<string>;
  }

  /** Access the state checkpointer for crash recovery and run inspection. */
  getCheckpointer(): StateCheckpointer {
    return this.checkpointer;
  }

  getInbox(): AgentInbox {
    return this.agentInbox;
  }
  getTeamRegistry(): TeamRegistry {
    return this.teamRegistry;
  }
  getHandoff(): AgentHandoff {
    return this.agentHandoff;
  }

  /** Expose the tool orchestrator's circuit breaker registry for runtime observation. */
  getBreakerRegistry(): import('./circuitBreakerRegistry').CircuitBreakerRegistry {
    return this.breakerRegistry;
  }

  /** Flush any buffered dead-letter-queue entries to disk for observation. */
  async flushDeadLetterQueue(): Promise<void> {
    try {
      await this.dlq.flush();
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:1071');
      /* best-effort */
    }
  }

  getExecutionScheduler() {
    return getExecutionScheduler();
  }
  getCompensationRegistry(): CompensationRegistry {
    return this.compensationService.getRegistry();
  }
  getReliabilityEngine(): ReliabilityEngine {
    return this.reliabilityEngine;
  }

  /** Cancel all in-flight steps managed by the StepTimeoutManager.
   *  Used during graceful shutdown to abort hung tool executions. */
  cancelAllSteps(): number {
    return this.stepTimeout.cancelAll();
  }

  /** Access the step timeout manager for shutdown coordination. */
  getStepTimeoutManager(): StepTimeoutManager {
    return this.stepTimeout;
  }

  /**
   * Execute an agent task end-to-end.
   * Wraps entire body in try/finally to guarantee cleanup (GAP-02, GAP-05).
   * Enforces maxConcurrency via semaphore (GAP-07).
   */
  async execute(ctx: AgentExecutionContext): Promise<AgentExecutionResult> {
    // Fail closed: do not admit work until the startup recovery scan has
    // settled. Admitting a run while leftover EXECUTING runs are still being
    // fenced/compensated would let a reclaimed run race the scan.
    await this.assertRecoverySettled();
    let tenantId = getGlobalTenantProvider().getCurrentTenantId() ?? ctx.tenantId ?? undefined;
    let tenantCfg = tenantId ? this.tenantProvider.getTenantConfig(tenantId) : undefined;

    const tenantResolution = this.tenantContextResolver.resolveTenantContext(
      tenantId,
      tenantCfg,
      generateId(),
      ctx.agentId,
      ctx.missionId,
    );
    if (!tenantResolution.allowed) {
      return {
        runId: generateId(),
        agentId: ctx.agentId,
        missionId: ctx.missionId,
        status: 'failed',
        summary: tenantResolution.error!,
        steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0,
        error: tenantResolution.error!,
      };
    }
    const tenantOverrides = tenantResolution.overrides;

    // Issue a capability token authorizing the agent's available tools unless
    // the caller already supplied one. The token is scoped to this run and
    // forwarded to the tool execution service for authorization checks.
    // Fail-closed: if tools are listed but we cannot mint a token, abort the
    // run rather than executing tools unconstrained (CAP-01).
    if (!ctx.capabilityToken && ctx.availableTools.length > 0) {
      try {
        const issuer = getCapabilityTokenIssuer();
        // Prefer a concrete tenant audience. Global '*' tokens are rejected
        // when a tenant-scoped verify runs (CAP-02), so only use '*' when no
        // tenant context exists (single-tenant / local).
        // availableTools is typed as string[], but some tests pass Tool objects;
        // canonicalize to names so issue() can encode the claim set.
        const toolNames = ctx.availableTools
          .map((t) => {
            if (typeof t === 'string') return t;
            if (typeof t !== 'object' || !t) return '';
            const direct = (t as { name?: unknown }).name;
            if (typeof direct === 'string' && direct.length > 0) return direct;
            const nested = (t as { definition?: { name?: unknown } }).definition?.name;
            return typeof nested === 'string' ? nested : '';
          })
          .filter((n) => n.length > 0);
        ctx.capabilityToken = issuer.issue({
          sub: ctx.agentId,
          aud: tenantId && tenantId.length > 0 ? tenantId : '*',
          tools: toolNames,
          ttlSeconds: 300,
        });
      } catch (capErr) {
        reportSilentFailure(capErr, 'agentRuntime:issueCapabilityToken');
        throw new Error(
          `CAPABILITY_TOKEN_REQUIRED: failed to issue capability token for tools [${ctx.availableTools.join(', ')}]: ${capErr instanceof Error ? capErr.message : String(capErr)}`,
        );
      }
    }

    let init: InitResult;
    try {
      this.runContext.enter(
        ctx.tokenBudget || this.config.budgetHardCapTokens || 200_000,
        taskTypeToCategory(detectTaskType(ctx.goal)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        runId: generateId(),
        agentId: ctx.agentId,
        missionId: ctx.missionId,
        status: 'failed',
        summary: message,
        steps: [],
        totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        totalDurationMs: 0,
        error: message,
      };
    }

    try {
      init = await runWithTenant(tenantId, () => this.runInitializer.initialize(ctx));
      tenantId = init.tenantId;
      tenantCfg = init.tenantCfg;
      this.runContext.setRunHandle(init.runHandle);

      let execResult: AgentExecutionResult | undefined;
      try {
        execResult = await runWithTenant(tenantId, async () => {
          const setup = await this.preLoopSetup.prepare(ctx, init);
          if ('status' in setup) {
            return setup;
          }
          return await this.agentLoopOrchestrator.run(ctx, init, setup);
        });

        // GAP-08: Call scheduler abortRun for failed runs — triggers compensation
        // for any recorded compensable actions and releases the scheduler-level lease.
        // On success, commitRun is called inside the runWithTenant callback.
        const runHandle = this.runContext.runHandle;
        if (execResult && execResult.status === 'failed' && runHandle) {
          const handle = runHandle as RunHandle;
          try {
            await getExecutionScheduler().abortRun({
              runId: init.runId,
              leaseToken: handle.leaseToken,
              fencingEpoch: handle.fencingEpoch,
              tenantId,
              reason: execResult.error ?? 'execution failed',
            });
          } catch (e) {
            getGlobalLogger().debug('AgentRuntime', 'Scheduler abortRun failed', {
              runId: init.runId,
              error: (e as Error).message,
            });
          }
        }

        return execResult;
      } finally {
        // DeterminismCapture: clear in-memory captures for this run to prevent
        // memory leak. WAL data persists for crash recovery via restoreFromWAL().
        try {
          getGlobalDeterminismCapture().clearRun(init.runId);
        } catch (capErr) {
          reportSilentFailure(capErr, 'agentRuntime:clearDeterminismCapture');
        }
        // Cleanup is delegated to FinallyCleanupHandler (circuit breaker release,
        // run lifecycle, tenant/lane/concurrency slot release, tracer completion,
        // SLO check, OTel export, SOP auto-export, store flush, tenant restore).
        await runWithTenant(tenantId, () =>
          this.finallyCleanupHandler.cleanup({
            runId: init.runId,
            ctx,
            circuitReleased: init.circuitReleased,
            tenantCfg,
            tenantId,
            currentLane: init.currentLane,
            startTime: init.startTime,
            execResult,
            tenantOverrides,
          }),
        );
      }
    } finally {
      this.runContext.exit();
    }
  }

  /** Tier 4.4 helper: estimate cost of a failed step and attribute it to a failure mode. */
  private recordCostByFailureMode(mode: string, response?: LLMResponse | null): void {
    if (!response) return;
    try {
      const costUsd = getCostEstimator().estimateCostFromUsage(
        response.model,
        response.usage.promptTokens,
        response.usage.completionTokens,
      );
      getMetricsCollector().recordCostByFailureMode(
        mode,
        costUsd,
        getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
      );
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:4575');
      /* best-effort */
    }
  }

  /**
   * Execute a tool call and return STRUCTURED error context to the model.
   * Instead of silently logging errors, the model receives enough context
   * to reason about the failure and decide next steps.
   *
   * 主路径委托 TES：TIMEOUT/ABORTED advice 禁止 transient retry（对齐 Orchestrator.formatError）。
   * TEH 侧只 planExecution，不经 Orchestrator.execute。
   */
  private async executeTool(
    runId: string,
    toolCall: ToolCall,
    agentId: string,
    tenantId?: string,
    allowedTools?: string[],
    agentCtx?: AgentExecutionContext,
  ): Promise<ToolResult> {
    // Security (RASP): Check if agent is suspended or quarantined before executing any tool.
    // This closes the detection→response loop — alerts from security detectors
    // suspend agents, and this check prevents further tool execution.
    if (isAgentQuarantined(agentId)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error:
          'BLOCKED: Agent is quarantined due to critical security event. Manual review required.',
        durationMs: 0,
      };
    }
    if (isAgentSuspended(agentId)) {
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: 'BLOCKED: Agent is temporarily suspended due to a security alert. Retry later.',
        durationMs: 0,
      };
    }

    // Security (G9): Verify security invariants before tool execution.
    // Checks all registered invariants (AUTH, AUTHZ, SANDBOX, FLOW, AUDIT, etc.)
    // and blocks execution if any invariant is violated.
    const requireCapabilityToken =
      (agentCtx?.availableTools?.length ?? allowedTools?.length ?? 0) > 0;
    try {
      const invariantResult = assertInvariants(
        {
          agentId,
          runId,
          toolName: toolCall.name,
          toolArgs: toolCall.arguments,
          capabilityTokenPresent: !!agentCtx?.capabilityToken,
          requireCapabilityToken,
          agentSuspended: isAgentSuspended(agentId),
          agentQuarantined: isAgentQuarantined(agentId),
        },
        'executeTool',
      );
      if (!invariantResult.passed) {
        const violated = invariantResult.violations.map((v) => v.invariant.id).join(', ');
        return {
          toolCallId: toolCall.id,
          name: toolCall.name,
          output: '',
          error: `BLOCKED: Security invariant violated (${violated}). Tool execution denied.`,
          durationMs: 0,
        };
      }
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:assertInvariants');
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: '',
        error: 'BLOCKED: Security invariant verifier failed. Tool execution denied.',
        durationMs: 0,
      };
    }

    const gateway = getEnterpriseSecurityGateway();
    // 查找工具的 costTier（从 this.tools Map 中获取 ToolDefinition）
    const toolDef = this.tools.get(toolCall.name);
    const costTier = toolDef?.definition.costTier;
    const preCheck = gateway.preToolCheck({
      tenantId,
      sessionId: runId,
      runId,
      toolName: toolCall.name,
      source: agentId,
      input: JSON.stringify(toolCall.arguments).slice(0, 10000),
      costTier,
    });
    if (!preCheck.allowed) {
      const errorMsg = `SECURITY_GATEWAY_BLOCKED: ${preCheck.reason ?? 'tool policy'}`;
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: errorMsg,
        error: errorMsg,
        durationMs: 0,
      };
    }

    if (allowedTools && !allowedTools.includes(toolCall.name)) {
      const errorMsg = `TOOL_NOT_ALLOWED: "${toolCall.name}" is not in the allowed tools list for this agent. Allowed: ${allowedTools.join(', ')}`;
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: errorMsg,
        error: errorMsg,
        durationMs: 0,
      };
    }

    const result = await this.toolExecutionService.execute(
      runId,
      toolCall,
      agentId,
      tenantId,
      allowedTools,
      agentCtx,
      this.runContext.mutableExecutedMutations,
      agentCtx?.capabilityToken,
    );

    // DeterminismCapture: record tool response for event replay recovery (Path A).
    // Fire-and-forget — capture failures never block the critical path.
    try {
      const captureStep = getGlobalDeterminismCapture().nextStep(runId);
      getGlobalDeterminismCapture().captureToolResponse(runId, captureStep, result);
    } catch (capErr) {
      reportSilentFailure(capErr, 'agentRuntime:captureToolResponse');
    }

    // EnterpriseSecurityGateway: post-tool DLP scan on tool output + UCA 成本记录.
    const postCheck = gateway.postToolCheck({
      tenantId,
      sessionId: runId,
      runId,
      toolName: toolCall.name,
      output: result.output,
      agentId,
      costTier,
    });
    if (!postCheck.allowed) {
      const errorMsg = `SECURITY_GATEWAY_BLOCKED_OUTPUT: ${postCheck.reason ?? 'DLP policy'}`;
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: errorMsg,
        error: errorMsg,
        durationMs: result.durationMs,
      };
    }
    if (postCheck.sanitizedOutput && postCheck.sanitizedOutput !== result.output) {
      result.output = postCheck.sanitizedOutput;
    }

    return result;
  }
  private generateActionId(): string {
    return `act_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  // ---------------------------------------------------------------------------
  // Auto-resume (GAP-03)
  // ---------------------------------------------------------------------------

  /**
   * List runs that crashed (have checkpoints but no terminal state).
   * Callers can use this to present a resume UI or auto-resume.
   */
  listUnfinishedRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointingPhase.listUnfinishedRuns();
  }

  /** Tier 1.2: Resume a crashed run using the full RunRecovery pipeline.
   *  Validates the lease, reconstructs completedToolCallIds from checkpoint
   *  messages, and returns a result suitable for continuing from the last step.
   *  Returns null if the checkpoint is not found or the lease was lost.
   */
  async resume(runId: string, tenantId?: string): Promise<RunRecoveryResult | null> {
    // Same fail-closed gate as execute(): resuming is exactly the operation that
    // must not race the startup zombie scan.
    await this.assertRecoverySettled();
    const result = await this.checkpointingPhase.resume(runId, tenantId);
    if (result && result.status === 'recovered') {
      getGlobalLogger().info('AgentRuntime', 'Run recovered', {
        runId,
        resumeFromStep: result.resumeFromStep,
        completedToolCalls: result.completedToolCallIds.size,
      });
    }
    return result;
  }

  /**
   * Await the startup recovery scan and fail closed if it did not succeed.
   * A failed scan means leftover runs from a previous process are in an unknown
   * state; admitting or resuming runs then risks double execution.
   */
  private async assertRecoverySettled(): Promise<void> {
    const settlement = await this.recoverySettled;
    if (!settlement.ok) {
      throw new Error(
        `Startup recovery scan failed; refusing to admit runs: ${settlement.error.message}`,
      );
    }
  }

  /** List all runs that have recoverable checkpoints (non-terminal phases). */
  listResumableRuns(): Array<{ runId: string; phase: string; timestamp: string }> {
    return this.checkpointingPhase.listResumableRuns();
  }

  /**
   * Signal a running execution to pause at the next checkpoint boundary.
   * Returns true if the run was active and pause was signaled, false otherwise.
   */
  pauseRun(runId: string): boolean {
    return this.checkpointingPhase.pauseRun(runId);
  }

  /**
   * Clear the pause flag for a run (e.g., after resume).
   */
  unpauseRun(runId: string): void {
    this.checkpointingPhase.unpauseRun(runId);
  }

  isPaused(runId: string): boolean {
    return this.checkpointingPhase.isPaused(runId);
  }

  /**
   * List all active runs with their pause state.
   * Returns an array of { runId, paused, checkpointPhase }.
   */
  getActiveRuns(): Array<{ runId: string; paused: boolean; checkpointPhase?: string }> {
    return this.checkpointingPhase.getActiveRuns();
  }

  getActiveRunCount(): number {
    return this.checkpointingPhase.getActiveRunCount();
  }

  isRunActive(runId: string): boolean {
    return this.checkpointingPhase.isRunActive(runId);
  }

  getSemanticCacheStats() {
    return this.cacheManager.getSemanticCacheStats();
  }

  getSingleFlightStats(): SingleFlightStats {
    return this.cacheManager.getSingleFlightStats();
  }

  getGeminiCacheStats(): GeminiCacheStats {
    return this.cacheManager.getGeminiCacheStats();
  }

  getCostEstimatorHistory() {
    return getCostEstimator().exportHistory();
  }

  /** Tier 4.3: Return a per-provider health snapshot for the dashboard. */
  getProviderHealth(): Array<{
    provider: string;
    state: string;
    errorRate: number;
    requestCount: number;
    lastFailureAt: number;
  }> {
    const breakerStats = this.circuitBreaker.getStats();
    const health: Array<{
      provider: string;
      state: string;
      errorRate: number;
      requestCount: number;
      lastFailureAt: number;
    }> = [];
    for (const [name] of this.providers) {
      const success = getMetricsCollector().getCounter('llm_success_total', [
        { name: 'provider', value: name },
      ]);
      const errors = getMetricsCollector().getCounter('llm_errors_total', [
        { name: 'provider', value: name },
      ]);
      const total = success + errors;
      health.push({
        provider: name,
        state: breakerStats.state,
        errorRate: total > 0 ? errors / total : 0,
        requestCount: total,
        lastFailureAt: breakerStats.lastFailureTime,
      });
    }
    return health;
  }

  /** Dispose sub-resources (timers, file handles) when this runtime is discarded */
  dispose(): void {
    this.compensationService.dispose();
    this.cacheManager.dispose();
    this.reliabilityEngine.shutdown();
    try {
      getModelPerformanceStore().dispose();
    } catch (err) {
      reportSilentFailure(err, 'agentRuntime:4779');
      /* best-effort */
    }
    this.agentInbox.dispose();
    // Shutdown trace store to flush pending buffers
    if (typeof this.traceStore.shutdown === 'function') this.traceStore.shutdown();
    // Stop OpenTelemetry exporter if running
    if (this.otelExporter) {
      this.otelExporter.stop().catch((err) => {
        getGlobalLogger().debug('AgentRuntime', 'OTel exporter stop failed (non-critical)', {
          error: (err as Error)?.message,
        });
      });
    }
    // Dispose tenant-scoped stores
    this.tenantManager.flushAll();
  }
}
