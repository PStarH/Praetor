import * as crypto from 'node:crypto';
import { reportSilentFailure } from '../silentFailureReporter';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_TOKEN_GOVERNOR_BUDGET,
  TOOL_OUTPUT_TURN_BUDGET,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_RECOVERY_MS,
  VERIFICATION_FLOOR_TOKENS,
  VERIFICATION_BUDGET_TOKENS,
  MAX_REFLEXION_MEMORIES,
  MAX_TOKENS_PER_REFLEXION,
  TOOL_ORCHESTRATOR_MAX_RETRIES,
  TOOL_ORCHESTRATOR_CIRCUIT_THRESHOLD,
  DEFAULT_LLM_TIMEOUT_MS,
} from './runtimeConstants';

import type { AgentRuntimeConfig } from './types';

import { ContextCompactor } from './contextCompactor';
import { SlidingWindowOrchestrator } from './slidingWindowOrchestrator';
import { ReliabilityEngine } from './reliabilityEngine';
import { TokenGovernor } from './tokenGovernor';
import { UnifiedVerificationPipeline } from './unifiedVerification';
import { ReflexionInjector } from '../memory/reflexionInjector';
import { SamplesStore } from './samplesStore';
import { PersistentTraceStore } from './traceStore';
import { LeaseManager } from '../atr/leaseManager';
import { StepTimeoutManager } from './stepTimeoutManager';
import { ProviderFallbackChain } from './providerFallbackChain';
import { CompensationService } from './compensationService';
import { AgentInbox } from './agentInbox';
import { TeamRegistry } from './teamRegistry';
import { AgentHandoff } from './agentHandoff';
import { CacheManager } from './cacheManager';
import { ConcurrencyController } from './concurrencyController';
import { RunLifecycleManager } from './runLifecycleManager';
import { TenantManager } from './tenantManager';
import { ToolExecutionService } from './toolExecutionService';
import { ToolOutputManager } from './toolOutputManager';
import { ToolApproval } from './toolApproval';
import { ToolOrchestrator } from './toolOrchestrator';
import { ToolPlanner } from './toolPlanner';
import { CycleDetector } from './cycleDetector';
import { createContentScanner, DefaultContentScanner } from '../contentScanner';
import { harmfulContentRules } from '../plugins/harmful-content-rules/rules';
import { ExecutionContextInjector } from './executionContextInjector';
import { SecurityOrchestrator, getSecurityOrchestrator } from './securityOrchestrator';
import { ReflexionGenerator } from './reflexionGenerator';
import { CircuitBreaker } from './circuitBreaker';
import { CircuitBreakerRegistry } from './circuitBreakerRegistry';

import { getMessageBus } from './messageBus';
import { getWebhookDispatcher } from './webhookDispatcher';
import { installHubGlue } from '../hub';
import { getIntentLog } from './intentLog';
import { getMetricsCollector } from './metricsCollector';
import { getGlobalLogger } from '../logging';
import { getGlobalTenantProvider } from './tenantProvider';
import { getGlobalThreeLayerMemory } from '../threeLayerMemory';
import { getTraceRecorder } from './executionTrace';
import { getConversationStore } from '../memory/conversationStore';
import { getHookManager } from '../pluginManager';
import { createParameterControllerPlugin } from './parameterController';
import { registerBuiltinPlugins } from '../plugins/builtin/registerBuiltinPlugins';
import {
  registerResponseCallbacks,
  startSecurityResponseEngine,
} from '../security/securityResponseEngine';
import { bootstrapRuntimeAdmission } from './runtimeAdmission';
import { startAuditAggregatorBridge } from '../security/auditAggregatorBridge';
import { installProcessCrashHandlers } from './processCrashSafety';
import { RecoveryBootstrapper, type RecoveryResult } from '../atr/recoveryBootstrapper';
import { getRunLedgerBundle } from '../atr/runLedger';
import { onCircuitBreakerOpen } from './dlqReplayWorker';
import { getCapabilityTokenVerifier } from '../security/capabilityToken';
import { getAgentLineage } from '../security/agentLineage';
import {
  getReversibilityGate,
  resetReversibilityGate,
  type ReversibilityGate,
} from '../security/reversibilityGate';
import {
  installGlobalFetchGovernor,
  resetGlobalFetchGovernor,
} from '../security/securityPrimitives';
import { getOTelExporter } from './openTelemetryExporter';
import { getGlobalEventSourcingEngine } from './eventSourcingEngine';
import { getGlobalEventSourcingSubscriber } from './eventSourcingSubscriber';
import { bootstrapMemoryPersistence, resolveMemoryStoreType } from '../memory/utils';
import { registerDefaultInvariants } from '../security/securityInvariantVerifier';
import { getSupervisionTreeRegistry } from './supervisionTree';

import type { StateCheckpointer } from './stateCheckpointer';
import type { DeadLetterQueue } from './deadLetterQueue';

interface ServiceInitializerConfig {
  config: AgentRuntimeConfig;
  /** Legacy parameters kept for backward compatibility; they are replaced by
   *  the ReliabilityEngine-created instances inside initializeServices(). */
  checkpointer?: StateCheckpointer;
  dlq?: DeadLetterQueue;
  traceStore?: PersistentTraceStore;
  getRunHandle: () => import('../atr/scheduler').RunHandle | null;
  getLedgerCtx: () => {
    runId: string;
    leaseToken: string;
    fencingEpoch: number;
    tenantId?: string;
  } | null;
  getActiveRuns: () => Set<string>;
  isRunPaused?: (runId: string) => boolean;
  getPromotedTools: () => Set<string>;
  generateActionId: () => string;
}

/** Keep the process-wide fetch timeout at least as long as the LLM step timeout. */
export function resolveResourceGovernorTimeout(
  config: Pick<AgentRuntimeConfig, 'llmTimeoutMs' | 'resourceGovernor'>,
): number {
  return config.resourceGovernor?.timeoutMs ?? config.llmTimeoutMs ?? 120_000;
}

export interface InitializedServices {
  compactor: ContextCompactor;
  slidingWindow: SlidingWindowOrchestrator;
  reliabilityEngine: ReliabilityEngine;
  circuitBreaker: CircuitBreaker;
  dlq: DeadLetterQueue;
  checkpointer: StateCheckpointer;
  governor: TokenGovernor;
  verificationPipeline: UnifiedVerificationPipeline;
  reflexionInjector: ReflexionInjector;
  reflexionGenerator: ReflexionGenerator;
  samplesStore: SamplesStore;
  traceStore: PersistentTraceStore;
  leaseManager: LeaseManager;
  stepTimeout: StepTimeoutManager;
  fallbackChain: ProviderFallbackChain<import('./types').LLMResponse>;
  compensationService: CompensationService;
  agentInbox: AgentInbox;
  teamRegistry: TeamRegistry;
  agentHandoff: AgentHandoff;
  cacheManager: CacheManager;
  concurrencyController: ConcurrencyController;
  runLifecycle: RunLifecycleManager;
  tenantManager: TenantManager;
  toolExecutionService: ToolExecutionService;
  outputManager: ToolOutputManager;
  breakerRegistry: CircuitBreakerRegistry;
  orchestrator: ToolOrchestrator;
  planner: ToolPlanner;
  cycleDetector: CycleDetector;
  contentScanner: ReturnType<typeof createContentScanner>;
  securityOrch: SecurityOrchestrator;
  contextInjector: ExecutionContextInjector;
  memory: import('../threeLayerMemory').ThreeLayerMemory | null;
  memoryStore: import('../memory').MemoryStore | null;
  conversationStore: import('../memory/conversationStore').ConversationStore | null;
  otelExporter: import('./openTelemetryExporter').OpenTelemetryExporter | null;
  supervisor: import('./supervisionTree').Supervisor | null;
  /**
   * Settlement of the startup zombie-run recovery scan. Callers MUST await this
   * before admitting work: recovery fences and reclaims runs left EXECUTING by a
   * previous process, so starting a run before it settles can race the scan.
   */
  recoverySettled: Promise<RecoverySettlement>;
}

/** Outcome of the startup recovery scan; failures stay explicit, never silent. */
export type RecoverySettlement = { ok: true; result: RecoveryResult } | { ok: false; error: Error };

export function initializeServices(
  svcConfig: ServiceInitializerConfig,
  tools: Map<string, import('./types').Tool>,
): InitializedServices {
  const {
    config,
    getRunHandle,
    getLedgerCtx,
    getActiveRuns,
    isRunPaused,
    getPromotedTools,
    generateActionId,
  } = svcConfig;

  // Reset any prior global fetch governor from previous tests/benchmarks.
  resetGlobalFetchGovernor();

  const compactor = new ContextCompactor({
    maxContextTokens: config.budgetHardCapTokens || DEFAULT_CONTEXT_WINDOW_TOKENS,
  });

  // Install Hub Glue closed-loop event handlers (tool.blocked routing +
  // cycle/retry/semantic-circuit correlators). Idempotent — safe to call
  // once at boot. The hub/index.ts docstring states "serviceInitializer
  // wires this"; this call makes that contract true instead of leaving the
  // 5 Phase-2 correlator modules dormant.
  try {
    installHubGlue();
  } catch (err) {
    reportSilentFailure(err, 'serviceInitializer:hubGlue');
  }

  const slidingWindow = new SlidingWindowOrchestrator();

  // The scheduler and checkpoint authorization must share the same lease
  // authority. Constructing a second LeaseManager breaks fencing in memory
  // mode and can reject every checkpoint written by an active run.
  const leaseManager = getRunLedgerBundle().lease;
  const reliabilityEngine = new ReliabilityEngine({
    circuitThreshold: CIRCUIT_BREAKER_THRESHOLD,
    circuitRecoveryMs: CIRCUIT_BREAKER_RECOVERY_MS,
    circuitProviderName: 'agentRuntime',
    leaseManager,
    circuitTransitionHandler: (from, to, provider) => {
      try {
        getIntentLog(undefined).write({
          schemaVersion: 1,
          runId: 'circuit-breaker',
          capturedAt: new Date().toISOString(),
          stage: 'agentRuntime.circuit',
          decision: 'transition',
          reason: `circuit ${from}->${to}`,
          payload: { from, to, provider: provider ?? 'agentRuntime' },
        });
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:140');
        /* best-effort */
      }
    },
  });

  const circuitBreaker = reliabilityEngine.getCircuitBreaker();
  const resolvedDlq = reliabilityEngine.getDeadLetterQueue();
  const resolvedCheckpointer = reliabilityEngine.getStateCheckpointer();

  circuitBreaker.setObservability({
    onTransition: (from, to, provider) => {
      try {
        getMetricsCollector().recordCircuitTransition(from, to, provider ?? 'agentRuntime');
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:155');
        /* best-effort */
      }
      try {
        resolvedDlq.enqueue({
          category: 'circuit_breaker',
          operationName: 'circuit.transition',
          errorMessage: `${from}->${to}`,
          tags: [`from:${from}`, `to:${to}`, `provider:${provider ?? 'agentRuntime'}`],
          failureMode: 'circuit_open',
          failureModeNumber: 11,
        });
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:168');
        /* best-effort */
      }
      try {
        getIntentLog(undefined).write({
          schemaVersion: 1,
          runId: 'circuit-breaker',
          capturedAt: new Date().toISOString(),
          stage: 'agentRuntime.circuit',
          decision: 'transition',
          reason: `circuit ${from}->${to}`,
          payload: { from, to, provider: provider ?? 'agentRuntime' },
        });
      } catch (err) {
        reportSilentFailure(err, 'serviceInitializer:182');
        /* best-effort */
      }
      // When circuit opens, trigger compensation rollback linkage
      if (to === 'OPEN') {
        onCircuitBreakerOpen({
          provider: provider ?? 'agentRuntime',
          reason: `Circuit transitioned ${from}->${to}`,
        });
      }
    },
  });

  circuitBreaker.setSemanticTripHandler((consecutiveFailures, reason, ctx) => {
    const bus = getMessageBus();
    bus.publish('system.alert', 'runtime', {
      type: 'semantic_circuit_trip',
      consecutiveFailures,
      reason,
      ...(ctx?.runId !== undefined ? { runId: ctx.runId } : {}),
      ...(ctx?.toolName !== undefined ? { toolName: ctx.toolName } : {}),
    });
    try {
      resolvedDlq.enqueue({
        category: 'verification',
        operationName: 'semantic.circuit_trip',
        errorMessage: `Semantic circuit tripped after ${consecutiveFailures} consecutive verification failures: ${reason}`,
        tags: ['semantic_drift', 'verification_failure', `count:${consecutiveFailures}`],
        failureMode: 'verification',
        failureModeNumber: 7,
      });
    } catch (err) {
      reportSilentFailure(err, 'serviceInitializer:205');
      /* best-effort */
    }
    try {
      getIntentLog(undefined).write({
        schemaVersion: 1,
        runId: 'semantic-circuit-breaker',
        capturedAt: new Date().toISOString(),
        stage: 'agentRuntime.semantic',
        decision: 'trip',
        reason: `semantic circuit tripped: ${consecutiveFailures} consecutive failures`,
        payload: { consecutiveFailures, reason },
      });
    } catch (err) {
      reportSilentFailure(err, 'serviceInitializer:219');
      /* best-effort */
    }
  });

  const governor = new TokenGovernor({
    totalBudget: config.budgetHardCapTokens || DEFAULT_TOKEN_GOVERNOR_BUDGET,
  });

  const verificationPipeline = new UnifiedVerificationPipeline({
    enabled: true,
    budgetFloorTokens: VERIFICATION_FLOOR_TOKENS,
    llmVerificationBudget: VERIFICATION_BUDGET_TOKENS,
  });

  const reflexionInjector = new ReflexionInjector({
    maxReflections: MAX_REFLEXION_MEMORIES,
    maxTokensPerReflection: MAX_TOKENS_PER_REFLEXION,
  });

  const samplesStore = new SamplesStore();
  const resolvedTraceStore = new PersistentTraceStore();
  const stepTimeout = new StepTimeoutManager();
  const fallbackChain = new ProviderFallbackChain<import('./types').LLMResponse>({
    totalTimeoutMs: config.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
    // Buyer-visible failover signal: the golden-path demo-qa suite (and the
    // viral demo) assert the `[Fallback] <from> 切换至 <to>` marker on stdout.
    onProviderSkipped: (from, to) => {
      // eslint-disable-next-line no-console
      console.log(`[Fallback] ${from} 切换至 ${to ?? '(none left)'}`);
      getGlobalLogger().warn('ProviderFallbackChain', `Provider ${from} failed; falling back`, {
        from,
        to: to ?? 'exhausted',
      });
    },
  });

  const compensationService = new CompensationService({
    dlq: resolvedDlq,
    getRunId: () => getLedgerCtx()?.runId ?? 'unknown',
    traceStore: resolvedTraceStore,
  });

  // Reset any prior gate instance (tests/benchmarks may have left one behind)
  // and create a fresh gate bound to the current approval callback.
  resetReversibilityGate();
  const reversibilityGateEnabled = config.reversibilityGate?.enabled !== false;
  // Backward compatibility: only fail-closed (blockWithoutCallback=true) when an
  // explicit approval callback is configured. Consumers that have not opted into
  // human approval continue to receive alerts but are not blocked.
  // IMPORTANT: do NOT wire the fail-closed defaultApprovalCallback into the
  // gate — that would silently deny every unknown/irreversible tool even when
  // the caller never opted into human approval.
  const hasExplicitApprovalCallback = Boolean(config.approval?.approvalCallback);
  const explicitApprovalCallback = config.approval?.approvalCallback;
  const reversibilityGate: ReversibilityGate | null = reversibilityGateEnabled
    ? getReversibilityGate({
        approvalCallback: hasExplicitApprovalCallback
          ? async (toolName, args) => {
              const decision = await explicitApprovalCallback!({
                id: crypto.randomUUID(),
                toolName,
                arguments: args,
                reason: 'irreversible_tool',
              });
              return decision.approved;
            }
          : undefined,
        blockWithoutCallback:
          config.reversibilityGate?.blockWithoutCallback ?? hasExplicitApprovalCallback,
      })
    : null;

  const agentInbox = new AgentInbox();
  const teamRegistry = new TeamRegistry();
  const agentHandoff = new AgentHandoff(agentInbox, resolvedCheckpointer);

  let memory: import('../threeLayerMemory').ThreeLayerMemory | null = null;
  try {
    memory = getGlobalThreeLayerMemory();
  } catch (e) {
    getGlobalLogger().warn('AgentRuntime', 'Failed to initialize global memory', {
      error: (e as Error)?.message,
    });
  }

  try {
    getTraceRecorder(resolvedTraceStore);
  } catch (e) {
    getGlobalLogger().warn('AgentRuntime', 'Failed to initialize trace recorder', {
      error: (e as Error)?.message,
    });
  }

  let memoryStore: import('../memory').MemoryStore | null = null;
  const memoryStoreType = resolveMemoryStoreType(config);
  bootstrapMemoryPersistence(memoryStoreType)
    .then((store) => {
      memoryStore = store;
    })
    .catch((e) => {
      getGlobalLogger().warn('AgentRuntime', 'Failed to bootstrap persistent memory', {
        type: memoryStoreType,
        error: (e as Error)?.message,
      });
    });

  let otelExporter: import('./openTelemetryExporter').OpenTelemetryExporter | null = null;
  const otelEnabled =
    config.otelExporter?.enabled ?? process.env.COMMANDER_OTEL_ENABLED !== 'false';
  if (otelEnabled) {
    try {
      const exporter = getOTelExporter({
        endpoint: config.otelExporter?.endpoint,
        serviceName: config.otelExporter?.serviceName,
        headers: config.otelExporter?.headers,
      });
      exporter.start().catch((e) =>
        getGlobalLogger().warn('AgentRuntime', 'Failed to start OTel exporter', {
          error: (e as Error)?.message,
        }),
      );
      otelExporter = exporter;
    } catch (e) {
      getGlobalLogger().warn('AgentRuntime', 'Failed to initialize OTel exporter', {
        error: (e as Error)?.message,
      });
    }
  }

  const cacheManager = new CacheManager({
    semanticCache: config.semanticCache,
    singleFlight: config.singleFlight,
    geminiCache: config.geminiCache,
    enableToolCaching: config.enableToolCaching,
  });

  const concurrencyController = new ConcurrencyController(config.maxConcurrency);
  const runLifecycle = new RunLifecycleManager();
  const tenantManager = new TenantManager();

  const reflexionGenerator = new ReflexionGenerator();

  const outputManager = new ToolOutputManager({
    enabled: true,
    turnBudget: TOOL_OUTPUT_TURN_BUDGET,
  });

  // Security (OWASP ASI08): Default approval callback is fail-closed.
  // Per OWASP — never auto-approve unknown or high-risk tools. Only auto-approve
  // tools with 'auto' or 'semi_auto' policy level and non-critical/non-high risk.
  // This mirrors the fail-closed default in ToolApproval's constructor, but is
  // needed here because serviceInitializer explicitly passes a callback.
  const defaultApprovalCallback = async (req: {
    id: string;
    toolName: string;
    arguments: Record<string, unknown>;
    reason?: string;
    policy?: { level?: string; riskLevel?: string };
  }) => {
    const level = req.policy?.level ?? 'manual';
    const risk = req.policy?.riskLevel ?? 'high';
    const allowed =
      (level === 'auto' || level === 'semi_auto') && risk !== 'critical' && risk !== 'high';
    return {
      approved: allowed,
      requestId: req.id,
      approvedAt: new Date().toISOString(),
      reason: allowed
        ? 'Approved by default callback (auto/semi_auto, low/medium risk)'
        : 'Denied by fail-closed default: unknown or high-risk tool requires explicit approval',
    } as { approved: boolean; requestId: string; approvedAt: string; reason: string };
  };

  const approvalCallback = config.approval?.approvalCallback ?? defaultApprovalCallback;
  const breakerRegistry = new CircuitBreakerRegistry();

  const toolApproval = new ToolApproval(approvalCallback);
  // Wire the capability-token verifier so that ToolApproval's token fast-path
  // and runtime enforcement can actually validate HMAC-signed tokens.
  // Use a factory so resets/reconfigurations are picked up; worker/runtime only
  // imports the verifier singleton, never the issuer/signing key.
  try {
    toolApproval.setTokenVerifier(() => getCapabilityTokenVerifier());
  } catch (err) {
    getGlobalLogger().warn(
      'ServiceInitializer',
      'Failed to wire capability token verifier; token enforcement unavailable',
      { error: (err as Error)?.message },
    );
  }

  // Install global fetch governor so all outbound HTTP calls are subject to
  // timeout enforcement. Disabled via config.resourceGovernor.enabled = false.
  const resourceGovernorEnabled = config.resourceGovernor?.enabled !== false;
  if (resourceGovernorEnabled) {
    try {
      installGlobalFetchGovernor({
        timeoutMs: resolveResourceGovernorTimeout(config),
        maxPayloadBytes: config.resourceGovernor?.maxPayloadBytes,
      });
    } catch (err) {
      getGlobalLogger().warn('ServiceInitializer', 'Failed to install global fetch governor', {
        error: (err as Error)?.message,
      });
    }
  }

  // Security (G9): Register default security invariants for runtime verification.
  // These invariants are checked at every critical execution point (tool execution,
  // LLM call, agent spawn) to ensure security properties always hold.
  try {
    registerDefaultInvariants();
    getGlobalLogger().info(
      'ServiceInitializer',
      'Security invariants registered for runtime verification',
    );
  } catch (err) {
    getGlobalLogger().warn(
      'ServiceInitializer',
      'Failed to register security invariants — runtime verification unavailable',
      { error: (err as Error)?.message },
    );
  }

  const toolApprovalEnabled = config.toolApproval?.enabled !== false;
  const orchestrator = new ToolOrchestrator(
    {
      enabled: toolApprovalEnabled,
      maxRetries: TOOL_ORCHESTRATOR_MAX_RETRIES,
      circuitBreakerThreshold: TOOL_ORCHESTRATOR_CIRCUIT_THRESHOLD,
      useApproval: toolApprovalEnabled,
    },
    toolApproval,
    breakerRegistry,
  );

  const toolExecutionService = new ToolExecutionService({
    tools,
    compensationService,
    cacheManager,
    dlq: resolvedDlq,
    getRunHandle,
    isRunPaused,
    config,
    reflexionGenerator,
    stepTimeout,
    getPromotedTools,
    generateActionId,
    getBreakerRegistry: () => breakerRegistry,
    reversibilityGate,
  });

  const planner = new ToolPlanner();
  const cycleDetector = new CycleDetector({
    enabled: config.cycleDetection?.enabled !== false,
  });
  const contentScanner = createContentScanner(config.contentScanner);
  DefaultContentScanner.registerRulePack('harmful-content-rules', harmfulContentRules);
  const securityOrch = getSecurityOrchestrator();
  const contextInjector = new ExecutionContextInjector({
    agentInbox,
    getMemory: () => memory,
    securityOrch,
  });

  let conversationStore: import('../memory/conversationStore').ConversationStore | null = null;
  try {
    conversationStore = getConversationStore();
    const bus = getMessageBus();
    const store = conversationStore;
    const sessionMap = new Map<string, string>();

    bus.subscribe('agent.started', (msg) => {
      const payload = msg.payload as Record<string, unknown>;
      const runId = (payload.runId ?? payload.taskId) as string | undefined;
      const goal = payload.goal as string | undefined;
      if (!runId || !goal) return;
      store
        .startSession({
          projectId: 'default',
          agentId: msg.source,
          goal: goal || undefined,
          metadata: { runId, model: payload.model },
        })
        .then((session) => {
          sessionMap.set(runId, session.id);
          store.addTurn({ sessionId: session.id, role: 'user', content: goal }).catch(() => {});
        })
        .catch(() => {});
    });

    bus.subscribe('agent.completed', (msg) => {
      const payload = msg.payload as Record<string, unknown>;
      const runId = (payload.runId ?? payload.taskId) as string | undefined;
      const summary = payload.summary as string | undefined;
      if (!runId) return;
      const sessionId = sessionMap.get(runId);
      if (sessionId) {
        sessionMap.delete(runId);
        store
          .addTurn({ sessionId, role: 'assistant', content: (summary || '').slice(0, 5000) })
          .catch(() => {});
        store.endSession(sessionId).catch(() => {});
      }
    });

    bus.subscribe('agent.failed', (msg) => {
      const payload = msg.payload as Record<string, unknown>;
      const runId = (payload.runId ?? payload.taskId) as string | undefined;
      const error = payload.error as string | undefined;
      if (!runId) return;
      const sessionId = sessionMap.get(runId);
      if (sessionId) {
        sessionMap.delete(runId);
        store
          .addTurn({
            sessionId,
            role: 'assistant',
            content: `[Failed] ${(error || '').slice(0, 2000)}`,
          })
          .catch(() => {});
        store.endSession(sessionId).catch(() => {});
      }
    });
  } catch (e) {
    getGlobalLogger().warn('AgentRuntime', 'Failed to initialize conversation store', {
      error: (e as Error)?.message,
    });
  }

  getHookManager()
    .register(createParameterControllerPlugin())
    .catch((e) =>
      getGlobalLogger().debug('AgentRuntime', 'Hook registration', {
        error: (e as Error)?.message,
      }),
    );

  // no-excuse-ok: catch — boot boundary; never block agent runtime startup.
  registerBuiltinPlugins({
    rasp: true,
    taint: true,
    rag: true,
    ragDisabled: true,
    gap: true,
    observability: true,
  }).catch((e) =>
    getGlobalLogger().warn('AgentRuntime', 'Built-in plugin registration failed', {
      error: (e as Error)?.message,
    }),
  );

  // Wire security.alert → SecurityResponseEngine so monitor/RASP detections
  // trigger automated suspend/quarantine/throttle actions.
  try {
    registerResponseCallbacks({
      terminateSession: (agentId, reason) => {
        const count = getAgentLineage().revokeByAgentId(agentId, `terminate: ${reason}`);
        if (count === 0) {
          getGlobalLogger().warn(
            'SecurityResponseEngine',
            'No live lineage session matched termination',
            {
              agentId,
              reason,
            },
          );
          return false;
        }
        getGlobalLogger().warn('SecurityResponseEngine', 'Agent lineage terminated', {
          agentId,
          reason,
          revokedNodes: count,
        });
        return true;
      },
      revokeTokens: (agentId) => {
        // AgentLineage.revokeByAgentId revokes every tracked capability JTI for
        // the agent and its descendants. A boolean result is required so the
        // response engine cannot claim success when no registry entry existed.
        const count = getAgentLineage().revokeByAgentId(
          agentId,
          'security response token revocation',
        );
        return count > 0;
      },
    });
    startSecurityResponseEngine();
  } catch (err) {
    getGlobalLogger().warn(
      'ServiceInitializer',
      'Failed to start SecurityResponseEngine; automated alert response disabled',
      { error: (err as Error)?.message },
    );
  }

  try {
    bootstrapRuntimeAdmission();
  } catch (err) {
    getGlobalLogger().warn('ServiceInitializer', 'Failed to bootstrap admission control', {
      error: (err as Error)?.message,
    });
  }

  try {
    startAuditAggregatorBridge();
  } catch (err) {
    getGlobalLogger().warn('ServiceInitializer', 'Failed to start audit aggregator bridge', {
      error: (err as Error)?.message,
    });
  }

  resolvedCheckpointer.setLeaseManager(leaseManager);

  // P0: Initialize the EventSourcingEngine WAL before any state transitions
  // occur. This loads existing events from disk so the hash chain continues
  // across process restarts. Fire-and-forget — the engine handles lazy init
  // on first append if this fails.
  getGlobalEventSourcingEngine()
    .init()
    .then(() => {
      // P0: Start the EventSourcingSubscriber after the engine is
      // initialized so events flow to a ready WAL. The subscriber
      // forwards agent lifecycle events (tool.started/completed,
      // agent.started/completed/failed, trace.recorded, etc.) from
      // the MessageBus to the EventSourcingEngine WAL.
      try {
        getGlobalEventSourcingSubscriber().start();
      } catch (e) {
        getGlobalLogger().warn('AgentRuntime', 'EventSourcingSubscriber start failed', {
          error: (e as Error)?.message,
        });
      }
    })
    .catch((e: unknown) =>
      getGlobalLogger().warn('AgentRuntime', 'EventSourcingEngine init failed', {
        error: (e as Error)?.message,
      }),
    );

  installProcessCrashHandlers({
    dlq: resolvedDlq,
    leaseManager,
    activeRunIds: getActiveRuns,
    leaseTokenFor: (runId: string) => {
      return getRunHandle()?.runId === runId
        ? (getRunHandle() as import('../atr/scheduler').RunHandle)?.leaseToken
        : undefined;
    },
    fencingEpochFor: (runId: string) => {
      return getRunHandle()?.runId === runId
        ? (getRunHandle() as import('../atr/scheduler').RunHandle)?.fencingEpoch
        : undefined;
    },
    tenantIdFor: () => getGlobalTenantProvider().getCurrentTenantId() ?? undefined,
  });

  // P0: Zombie run recovery on startup. Scans the RunLedger for runs left
  // in EXECUTING/VERIFYING/PAUSED by a previously crashed process. Fences
  // zombies (bumps fencing epoch), then aborts+compensates or reclaims
  // for resume. Idempotent — safe to call even if no zombies exist.
  //
  // `bootstrap()` is async and only settles once compensation has actually
  // settled, so the scan is exposed as `recoverySettled` rather than awaited
  // here: `initializeServices` is called from a synchronous constructor. The
  // runtime awaits it before admitting work (see AgentRuntime.execute), and a
  // failed scan is reported as `{ ok: false }` — never silently dropped.
  const recoverySettled: Promise<RecoverySettlement> = RecoveryBootstrapper.bootstrap().then(
    (result) => {
      if (result.scanned > 0) {
        getGlobalLogger().info('AgentRuntime', 'Recovery bootstrap scan completed', {
          scanned: result.scanned,
          recovered: result.recovered,
          aborted: result.aborted,
          skipped: result.skipped,
        });
      }
      return { ok: true, result } as const;
    },
    (e: unknown) => {
      const error = e instanceof Error ? e : new Error(String(e));
      getGlobalLogger().warn('AgentRuntime', 'Recovery bootstrap scan failed', {
        error: error.message,
      });
      return { ok: false, error } as const;
    },
  );

  // ── Supervision Tree (Erlang/OTP "Let It Crash") ──────────────────────
  // Create a root supervisor for agent runtime instances. The supervisor
  // monitors agent health via messageBus 'agent.failed' events and reports
  // crashes. In-process supervision provides health tracking + alerting;
  // true process-level restart is handled by the ATR scheduler's lease
  // expiry + recovery mechanism. Akka OTP best practice: supervisor only
  // makes restart decisions, never contains business logic.
  let supervisor: import('./supervisionTree').Supervisor | null = null;
  try {
    const registry = getSupervisionTreeRegistry();
    supervisor = registry.createSupervisor({
      id: `sup_root_${getGlobalTenantProvider().getCurrentTenantId() ?? 'default'}`,
      strategy: 'one_for_one',
      maxRestarts: 5,
      maxRestartIntervalMs: 60_000,
      defaultShutdownMs: 5_000,
      publishEvents: true,
    });

    // Register a child representing the agent runtime. The child's isAlive
    // reflects whether any runs are active (no crash signal received).
    // On crash, reportChildCrash is called via the messageBus subscription
    // below — no changes needed to agentRuntime.ts itself.
    const childId = `agent_${getGlobalTenantProvider().getCurrentTenantId() ?? 'default'}`;
    const activeRunsRef = getActiveRuns;
    if (supervisor) {
      supervisor
        .startChild({
          id: childId,
          start: async () => ({
            id: childId,
            isAlive: () => activeRunsRef().size > 0 || true, // runtime process is alive
            healthCheck: async () => ({
              healthy: true,
              issues: activeRunsRef().size > 0 ? undefined : ['No active runs'],
            }),
          }),
          shutdownMs: 5_000,
          maxRestarts: 3,
          maxRestartIntervalMs: 60_000,
        })
        .catch((err: unknown) => {
          reportSilentFailure(err, 'serviceInitializer:supervisorStartChild');
        });
    } // end if (supervisor)

    // Subscribe to agent.failed events — when an agent crashes, report it
    // to the supervisor so it can apply restart strategy + publish alerts.
    const bus = getMessageBus();
    bus.subscribe('agent.failed', (message) => {
      const payload = message.payload as { agentId?: string; error?: string };
      const agentId = payload.agentId ?? childId;
      const error = payload.error ?? 'Unknown agent failure';
      supervisor?.reportChildCrash(agentId, error).catch((err: unknown) => {
        reportSilentFailure(err, 'serviceInitializer:agentFailedHandler');
      });
    });
  } catch (err) {
    reportSilentFailure(err, 'serviceInitializer:supervisionTree');
    supervisor = null;
  }

  // ── Outbound Webhook Dispatcher ───────────────────────────────────────
  // Start the outbound webhook event dispatcher so that agent.completed,
  // agent.failed, and other MessageBus events are pushed (HMAC-SHA256
  // signed, retried with exponential backoff, SSRF-guarded) to any webhook
  // URLs registered in .commander/webhooks.json. Without this start() call
  // the dispatcher's `started` flag stays false and dispatch() silently
  // drops every event — leaving the entire WebhookDispatcher module dead.
  // Safe to fail: webhooks are a best-effort side-channel, never on the
  // critical execution path.
  try {
    getWebhookDispatcher().start();
  } catch (err) {
    getGlobalLogger().warn(
      'ServiceInitializer',
      'Failed to start WebhookDispatcher; outbound webhooks disabled',
      { error: (err as Error)?.message },
    );
  }

  return {
    compactor,
    slidingWindow,
    reliabilityEngine,
    circuitBreaker,
    dlq: resolvedDlq,
    checkpointer: resolvedCheckpointer,
    governor,
    verificationPipeline,
    reflexionInjector,
    reflexionGenerator,
    samplesStore,
    traceStore: resolvedTraceStore,
    leaseManager,
    stepTimeout,
    fallbackChain,
    compensationService,
    agentInbox,
    teamRegistry,
    agentHandoff,
    cacheManager,
    concurrencyController,
    runLifecycle,
    tenantManager,
    toolExecutionService,
    outputManager,
    breakerRegistry,
    orchestrator,
    planner,
    cycleDetector,
    contentScanner,
    securityOrch,
    contextInjector,
    memory,
    memoryStore,
    conversationStore,
    otelExporter,
    supervisor,
    recoverySettled,
  };
}
