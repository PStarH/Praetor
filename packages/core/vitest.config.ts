import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      // `tests/ws9/_evidence.ts` binds evidence through the repo-root WS9
      // orchestrator, which lives outside this package. Vite refuses to resolve
      // a specifier that escapes the package root, so without this alias all six
      // registered `tests/ws9/*.test.ts` suites fail to load with
      // "Cannot find module '../../../scripts/ws9-livefire'" — a suite that is
      // registered but unloadable is a green-looking hole.
      {
        find: /^(?:\.\.\/){3}scripts\/ws9-livefire$/,
        replacement: fileURLToPath(new URL('../../scripts/ws9-livefire.ts', import.meta.url)),
      },
    ],
  },
  test: {
    // Serial execution. The suite has ~220 test files, many of which exercise
    // full AgentRuntime loops, share SQLite WAL paths, open HTTP servers, or
    // mutate singleton registries. Multi-threaded/fork runs caused SIGSEGV
    // (better-sqlite3), EMFILE, and EADDRNOTAVAIL races. fileParallelism:false
    // runs test files sequentially; sequential configs inside individual files
    // keep tests within a file from competing for the same resources.
    pool: 'threads',
    threads: false,
    fileParallelism: false,
    // Integration tests exercise full AgentRuntime execution loops (tool
    // calling, security correlators, tenant isolation). 180s testTimeout gives
    // realistic headroom for E2E flows; slow E2E tests further override with
    // explicit per-`it` timeouts so they don't fight the global ceiling.
    testTimeout: 180000,
    hookTimeout: 60000,
    // Prevent open handles from hanging CI after the suite finishes (seen on Ubuntu).
    forceExit: true,
    // NOT free: a global retry converts a nondeterministic failure into a pass,
    // so a test that is green here may be green *only* because it was retried.
    // Vitest reports retried tests but still exits 0, which means the suite's
    // verdict does not distinguish "passed" from "passed on the third attempt".
    // Kept at 2 because the serial-execution reasons above (EADDRNOTAVAIL /
    // EMFILE races) are infrastructure, not logic — but this is a deliberate,
    // audit-visible tradeoff, not a default worth copying. Removing it requires
    // a full-suite run to separate genuine flakes from genuine fixes.
    retry: 2,
    setupFiles: ['tests/setup.ts'],
    include: [
      'tests/cli/envLoader.test.ts',
      'tests/cli/action.test.ts',
      'tests/cli/firstUserReadiness.test.ts',
      'tests/cli/nodeSupport.test.ts',
      'tests/planner/workGraphPlanner.test.ts',
      // Tenant Bridge/Silo deployment scripts. Tracked and green, but absent
      // from this explicit list — so the `pnpm --filter @praetor/core test
      // tests/deployment/tenantDeployment.test.ts` command documented in
      // deploy/README.md failed with "No test files found".
      'tests/deployment/tenantDeployment.test.ts',
      // --- atr ---
      'tests/atr/recoveryBootstrapper.test.ts',
      'tests/atr/taskQueue.test.ts',
      'tests/atr/gitSnapshot.test.ts',
      'tests/atr/executionScheduler.test.ts',
      'tests/atr/durableInteractionStore.test.ts',
      'tests/atr/effectReconciliationWorker.test.ts',
      'src/atr/__tests__/schedulerTenantPriority.test.ts',
      // --- recovery ---
      'tests/recovery/kill9.test.ts',
      // --- runtime ---
      'tests/runtime/agentHandoff.test.ts',
      'tests/runtime/tenantManagerFailClosed.test.ts',
      'tests/runtime/tenantBucketFailClosed.test.ts',
      'tests/security/productionKeyGate.test.ts',
      'tests/security/pluginSandboxTraversal.test.ts',
      'tests/security/workspaceRootIsolation.test.ts',
      'tests/runtime/incrementalSCC.integration.test.ts',
      'tests/runtime/agentInbox.test.ts',
      'tests/runtime/agentRuntime.test.ts',
      'tests/runtime/runTelemetryRecorder.test.ts',
      'tests/runtime/runInitializer.test.ts',
      'tests/runtime/preLoopSetup.test.ts',
      'tests/runtime/agentLoopOrchestrator.test.ts',
      'tests/runtime/executionContextInjector.test.ts',
      'tests/runtime/executionRouter.test.ts',
      'tests/runtime/agentRuntime.integration.test.ts',
      'tests/runtime/agentRuntimeInterface.test.ts',
      'tests/runtime/runtimeFactory.test.ts',
      'tests/runtime/kernelStepExecutor.test.ts',
      'tests/runtime/mtlsRuntimeIpc.test.ts',
      // Cascade-fix regression — walks packages/core/src/**.ts and verifies
      // every `const XSingleton = createTenantAwareSingleton(...)` factory
      // call carries an `allowGlobalFallback` option within ±15 lines.
      'tests/runtime/createTenantAwareSingleton.cascade.test.ts',
      // --- im providers ---
      'tests/im/imProviderRegistry.test.ts',
      'tests/im/imContextStore.test.ts',
      'tests/im/imOutboundDispatcher.test.ts',
      'tests/im/providers/dingtalk.test.ts',
      'tests/im/providers/feishu.test.ts',
      'tests/im/providers/wecom.test.ts',
      'tests/im/providers/slack.test.ts',
      'tests/im/providers/teams.test.ts',
      'tests/im/providers/discord.test.ts',
      'tests/checkpointStore.test.ts',
      'tests/runtime/baseOpenAICompatibleRetry.test.ts',
      'tests/runtime/bm25ToolDiscovery.test.ts',
      'tests/runtime/circuitBreaker.test.ts',
      'tests/runtime/concurrencyController.test.ts',
      'tests/runtime/concurrentToolExecution.test.ts',
      'tests/runtime/stateIsolation.test.ts',
      'tests/runtime/executionContext.test.ts',
      'tests/runtime/concurrentExecute.test.ts',
      'tests/runtime/deployRollbackIntegration.test.ts',
      'tests/runtime/compensation-integration.test.ts',
      'tests/runtime/compensationRegistry.test.ts',
      'tests/runtime/costBenchmark.test.ts',
      'tests/runtime/costEstimator.test.ts',
      'tests/runtime/credentialManager.test.ts',
      'tests/runtime/criticalPath.test.ts',
      'tests/runtime/cycleDetector.test.ts',
      'tests/runtime/dagConverter.test.ts',
      'tests/runtime/deadLetterQueue.test.ts',
      'tests/runtime/determinismCapture.test.ts',
      'tests/runtime/dlqRetryWorker.test.ts',
      'tests/runtime/healthCheck.test.ts',
      'tests/runtime/e2e.test.ts',
      'tests/runtime/entropyGater.test.ts',
      'tests/runtime/evolutionaryWorkflowEngine.test.ts',
      'tests/runtime/execPolicy.edge.test.ts',
      'tests/runtime/apiStability.test.ts',
      'tests/runtime/execPolicy.catastrophic.test.ts',
      'tests/runtime/geminiCacheManager.test.ts',
      'tests/runtime/htmlReport.test.ts',
      'tests/runtime/llmRetry.test.ts',
      'tests/runtime/oidcAuthPlugin.test.ts',
      'tests/runtime/samlAuthPlugin.test.ts',
      'tests/runtime/owaspAsiHttpRoute.test.ts',
      'tests/runtime/httpTenantGate.test.ts',
      'tests/runtime/walSegmented.test.ts',
      'tests/runtime/stateCheckpointBackend.test.ts',
      'tests/runtime/runtimeAdmission.test.ts',
      'tests/runtime/httpRbacGate.test.ts',
      'tests/runtime/builtinSecurityPluginRegistration.test.ts',
      'tests/runtime/siemForwarder.test.ts',
      'tests/runtime/localEmbedding.test.ts',
      'tests/runtime/messageBus.test.ts',
      'tests/runtime/metaLearner.test.ts',
      'tests/runtime/metaTool.test.ts',
      'tests/selfEvolution/strategySelector.test.ts',
      'tests/selfEvolution/strategyPerformanceTracker.test.ts',
      'tests/runtime/metricsCollector.test.ts',
      'tests/runtime/modelPerformanceStore.test.ts',
      'tests/runtime/modelRouter.test.ts',
      'tests/runtime/smartModelRouter.test.ts',
      'tests/runtime/contextCompactor.test.ts',
      'tests/selfEvolution/trajectoryAnalyzer.test.ts',
      'tests/runtime/openTelemetryExporter.test.ts',
      'tests/runtime/promptCacheSavings.test.ts',
      'tests/runtime/llmCaller.test.ts',
      'tests/runtime/providerFallbackChain.test.ts',
      'tests/runtime/reflexionInjector.test.ts',
      'tests/runtime/runRecovery.test.ts',
      'tests/runtime/runtimeAdversarial.test.ts',
      'tests/runtime/securityOrchestrator.test.ts',
      'tests/runtime/securityOrchestrator.integration.test.ts',
      'tests/runtime/securityOrchestratorHelper.test.ts',
      'tests/runtime/supervisionTree.integration.test.ts',
      'tests/runtime/samplesStore.test.ts',
      'tests/runtime/semanticCache.test.ts',
      'tests/runtime/cacheManager.test.ts',
      'tests/runtime/speculativeExecutor.test.ts',
      'tests/runtime/stepErrorBoundary.test.ts',
      'tests/runtime/stepTimeoutManager.test.ts',
      'tests/runtime/capacity-baseline.test.ts',
      'tests/runtime/tenant-runtime-isolation.test.ts',
      'tests/runtime/tenantAwareSingleton.test.ts',
      'tests/runtime/tokenBenchmark.test.ts',
      'tests/runtime/tokenMeasurement.test.ts',
      'tests/runtime/toolApproval.test.ts',
      'tests/runtime/toolCalling.test.ts',
      'tests/runtime/toolOrchestrator.test.ts',
      'tests/runtime/toolPlanner.test.ts',
      'tests/runtime/toolResultCache.test.ts',
      'tests/runtime/toolGateHelper.test.ts',
      // RUN-02: denial provenance + cause bound to call identity (A denied /
      // B retried must not cross-contaminate; hook/policy never relabelled
      // GUARDIAN_BLOCKED). Zero tool execution in every case.
      'tests/runtime/toolDenialProvenance.test.ts',
      'tests/runtime/resilience-integration.test.ts',
      'tests/runtime/toolRetriever.test.ts',
      'tests/runtime/vcrProvider.test.ts',
      'tests/runtime/batchProvider.test.ts',
      'tests/runtime/webhookDispatcher.test.ts',
      'tests/runtime/runtimeGuardianBridge.test.ts',
      'tests/runtime/workflowPopulation.test.ts',
      'tests/runtime/sopDashboard.test.ts',
      'tests/runtime/observationPurifier.test.ts',
      'tests/runtime/parameterController.test.ts',
      'tests/runtime/tokenGovernor.test.ts',
      // V2 SideEffectGate PEP — fail-closed invariants for every external effect
      'tests/runtime/sideEffectGate.test.ts',
      // LM-03: composed gate → ToolExecutionService boundary. Uses the REAL
      // gate (0 tool-body calls on denial, exactly 1 on an explicit grant) so a
      // regression in the production admission path cannot hide behind the
      // always-admit unit fixture.
      'tests/runtime/productionBoundaryComposition.test.ts',
      // V2 InMemoryCompensationQueue — test-friendly compensation queue core
      'src/atr/__tests__/inMemoryCompensationQueue.test.ts',
      // AR-03 parity: ONE shared scenario table drives BOTH compensation queue
      // implementations (better-sqlite3 CompensationQueue + the native-module-free
      // double) and asserts identical observable outcomes — measured, not claimed.
      'src/atr/__tests__/compensationQueueParity.test.ts',
      // async-I/O migration regression suite — guards the no-event-loop-blocking,
      // no-TOCTOU-probes, no-missed-visibility contract of the 5 hotspot files
      // (healthCheck/checkpoint, compensationService/mkdir, freezeDry/round-trip,
      // traceStore.flushAsync, checkpointWriter.persist).
      'tests/runtime/async-migration.test.ts',
      // --- telos ---
      'tests/telos/providerPool.test.ts',
      'tests/telos/telosOrchestrator.test.ts',
      'tests/telos/tokenSentinel.test.ts',
      'tests/telos/modelCascadeController.test.ts',
      // --- intelligence ---
      'tests/intelligence/costAggregator.test.ts',
      'tests/intelligence/costPredictor.test.ts',
      // --- sandbox ---
      'tests/sandbox/lane.test.ts',
      'src/sandbox/__tests__/laneFairness.test.ts',
      'tests/sandbox/appContainer.test.ts',
      'tests/sandbox/teeEnclave.test.ts',
      'tests/sandbox/sshBackendExecPolicy.test.ts',
      'tests/sandbox/localBackendExecPolicy.test.ts',
      'tests/sandbox/localBackendTimeout.test.ts',
      // --- tools ---
      // async-I/O regression tests added alongside the safePath/pathExists
      // async refactor; they guard the "no event-loop blocking, no TOCTOU
      // probes, no missed warn-on-real-error" contract.
      'tests/tools/_utils/pathExists.test.ts',
      'tests/tools/fileSystemTool.asyncHelpers.test.ts',
      'tests/tools/persistenceTool.test.ts',
      'tests/tools/verificationTool.asyncHelpers.test.ts',
      // --- observability ---
      'tests/observability/autoScorer.test.ts',
      'tests/observability/datasetStore.test.ts',
      'tests/observability/evalHttpEndpoints.test.ts',
      'tests/observability/evalScorer.test.ts',
      'tests/observability/experimentRunner.test.ts',
      'tests/observability/normalizeExpected.test.ts',
      'tests/observability/otelExporter.test.ts',
      'tests/observability/retryRuleOnRealTraces.test.ts',
      'tests/observability/samplingPolicy.test.ts',
      'tests/observability/traceContext.test.ts',
      'tests/observability/traceContextBridge.test.ts',
      'tests/observability/sloOperations.test.ts',
      // --- plugins/observability (plugin SDK regression — separate from
      // core observability, exercises the same surface from the
      // plugin-loader perspective) ---
      'tests/plugins/observability/autoScorer.test.ts',
      'tests/plugins/observability/datasetStore.test.ts',
      'tests/plugins/observability/evalHttpEndpoints.test.ts',
      'tests/plugins/observability/evalScorer.test.ts',
      'tests/plugins/observability/experimentRunner.test.ts',
      'tests/plugins/observability/normalizeExpected.test.ts',
      // Not run: tests/plugins/observability/{otelExporter,retryRuleOnRealTraces}.test.ts
      // depend on the plugin otelExporter module, which has not been extracted
      // from core yet. Declared in scripts/test-manifest.mjs DECLARED_NOT_RUN.
      'tests/plugins/observability/samplingPolicy.test.ts',
      'tests/plugins/observability/sloOperations.test.ts',
      'tests/plugins/observability/traceContext.test.ts',
      'tests/plugins/observability/traceContextBridge.test.ts',
      // --- plugins/gap (gap registry / SLA / auto-create / audit) ---
      'tests/plugins/gap/issueAutoCreate.test.ts',
      'tests/plugins/gap/metrics.test.ts',
      'tests/plugins/gap/quarterlyAudit.test.ts',
      'tests/plugins/gap/registry.test.ts',
      'tests/plugins/gap/slaEnforcer.test.ts',
      'tests/plugins/gap/storage.test.ts',
      'tests/plugins/gap/types.test.ts',
      'tests/plugins/builtin/registerBuiltinPlugins.test.ts',
      'tests/plugins/builtin/consensus/adaptiveStopping.test.ts',
      'tests/plugins/builtin/consensus/sacProtocol.test.ts',
      // --- security (3-layer defense regression — reversible gate, anomaly
      // detector, universal sanitizer, tenancy boundary, plugin supply) ---
      'tests/security/adversarial.test.ts',
      // 'tests/security/agentdojoDefense.test.ts', // FIXED: createCommanderDefender now implemented in securityBenchmarkRunner.ts
      'tests/security/agentdojoDefense.test.ts',
      'tests/security/outboundNetworkPolicy.test.ts',
      'tests/security/pluginSupply.test.ts',
      'tests/security/pluginImportPermission.test.ts',
      'tests/security/raspExtensionsPlugin.test.ts',
      'tests/security/securityResponseEngine.integration.test.ts',
      'tests/security/securityInvariantVerifier.test.ts',
      'tests/security/reversibilityGate.test.ts',
      'tests/security/securityAnomalyDetector.test.ts',
      'tests/security/securityPrimitives.test.ts',
      'src/security/fetchGovernor.test.ts',
      'tests/security/tenancy.test.ts',
      // --- request data scrubbing ---
      'tests/shadow/scrubber.test.ts',
      'tests/architecture/shadow-replay-removal.test.ts',
      // --- storage (cached driver regression) ---
      'tests/storage/cachedDriver.test.ts',
      // --- runtime (LLM caller refactor regression) ---
      // Not run: tests/runtime/llmCaller.test.ts — FallbackChainExhaustedError
      // does not record a fallback_exhausted sample (real defect in the
      // LLMCaller phase-1 helper). Declared in scripts/test-manifest.mjs.
      // --- chaos (types only — chaos suites themselves are opt-in
      // because they require orchestrated fault injection) ---
      'tests/chaos/types.test.ts',
      // --- ultimate (checkpoint + resume + taskPool regression) ---
      // Not run: tests/ultimate/checkpoint.roundTrip.test.ts — orchestrator
      // checkpoint emission for Goal+Swarm is not wired into ReliabilityEngine
      // persistence. Declared in scripts/test-manifest.mjs DECLARED_NOT_RUN.
      'tests/ultimate/checkpointAdapters.test.ts',
      'tests/ultimate/artifactSystem.test.ts',
      'tests/ultimate/subAgentNarrowContext.test.ts',
      'tests/ultimate/taskPool.test.ts',
      // --- memory (cross-tenant leak fix) ---
      'tests/memoryCurator.test.ts',
      'tests/memoryBenchmark.test.ts',
      'tests/memory/thompsonMemoryScorer.test.ts',
      'src/memory/__tests__/tenantIsolation.test.ts',
      'src/runtime/__tests__/tenantFairnessMonitor.test.ts',
      // --- P1 memory management agent prototype ---
      'tests/memory/temporalGraph.test.ts',
      'tests/memory/memoryManagerAgent.test.ts',
      'tests/memory/threeLayerMemoryManagerIntegration.test.ts',
      'tests/memory/memoryBootstrap.integration.test.ts',
      'tests/memory/memoryService.contract.test.ts',
      'tests/memory/inMemoryMemoryService.test.ts',
      'tests/memory/postgresMemoryService.test.ts',
      'tests/memory/postgresMemoryService.integration.test.ts',
      'tests/memory/memoryStoreFacade.test.ts',
      'tests/memory/memoryMigration.test.ts',
      'tests/memory/utils.test.ts',
      'tests/memory/l3-10a-productWrite.test.ts',
      // --- memory persistence (bare-require regression: save()/load() wrote nothing) ---
      'tests/memory/threeLayerMemoryPersistence.test.ts',
      // --- cross-tenant isolation on the write paths (ET-05) ---
      'tests/memory/threeLayerMemoryTenantIsolation.test.ts',

      // --- GDPR compliance + AdaptiveHITL weight learning ---
      'tests/architecture/gdprCompliance.test.ts',
      // --- governance risk level is measured, not asserted (ET-02) ---
      'tests/architecture/governanceRiskLevel.test.ts',
      // --- 4 architecture gap fixes (HNSW, TEE workers, Distributed bus, Petri scheduler) ---
      'tests/architecture/gapFixes.test.ts',
      // --- V2 architecture integrity tests ---
      'tests/architecture/v2-event-sourcing-integrity.test.ts',
      // L3-07 step-scoped ControlPlane workload identity
      'tests/controlPlane/workloadIdentity.test.ts',

      // --- memory (audit MED item 1 — Phase A route-out) ---
      'tests/threeLayerRouting.test.ts',

      // --- hub event glue (Phase 2) ---
      'tests/hub/toolBlockedHandler.test.ts',
      'tests/hub/retryHookCorrelator.test.ts',
      'tests/hub/semanticCircuitCorrelator.test.ts',

      // --- storage ---
      'tests/storage/dataRetention.test.ts',
      'tests/storage/inMemoryDriver.test.ts',
      'tests/storage/jsonDriver.test.ts',
      'tests/storage/postgresDriver.test.ts',
      'tests/storage/sqliteDriver.test.ts',
      'tests/storage/persistentStore.test.ts',

      // --- security ---
      // EnterpriseSecurityGateway + BillExplosionGuard + DLP integration.
      // HallucinationDetector signal coverage (overconfidence, entailment,
      // self-contradiction, hedging-aware, temporal, edge cases).
      'tests/enterprise-security.test.ts',
      'tests/hallucinationDetector.test.ts',
      'tests/security/guardianAgent.test.ts',
      'tests/security/securityGuardianFacade.test.ts',
      'tests/security/guardianDangerousToolCall.test.ts',
      'tests/security/capabilityToken.test.ts',
      'tests/security/biscuitCapabilityAdapter.test.ts',
      'tests/security/keyProvider.test.ts',
      'tests/security/auditChainLedger.test.ts',
      // WS9 §6 KC-5 closure — chain manifest, asymmetric signer, fail-closed persistor
      'tests/security/auditChainIntegrity.test.ts',
      'tests/security/agentLineage.test.ts',
      'tests/security/federatedIdentity.test.ts',
      'tests/security/outputSanitizer.test.ts',
      // NOTE: tests/security/costGuard.test.ts was removed from this list — the
      // file does not exist on disk. Do not re-add it to satisfy a stale entry.
      // UnifiedCostAuthority (UCA) — single source of truth for cost control.
      // Replaces the legacy BillExplosionGuard + CostGuard + TokenSentinel overlap.
      'tests/security/unifiedCostAuthority.test.ts',
      'tests/security/agentSoc.test.ts',
      'tests/security/euAiActCompliance.test.ts',
      'tests/security/agentStandbyManager.test.ts',
      'tests/security/redTeamBaseline.test.ts',
      // Fail-closed contract for the red team battery gate, plus the stdout
      // layout that .github/workflows/red-team.yml parses.
      'tests/security/redTeamGate.test.ts',
      'tests/security/edgeSecurityProfile.test.ts',
      'tests/security/complianceAuditReport.test.ts',
      'tests/security/d25-api-key-grep.test.ts',
      'tests/security/d26-rotation-signoff-gate.test.ts',
      'tests/security/hardeningSprint.d1.test.ts',
      'tests/security/threatIntelligenceFeed.test.ts',
      'tests/security/crossAgentCorrelator.test.ts',
      'tests/security/mlInjectionDetector.test.ts',
      'tests/security/fuzzTestFramework.test.ts',
      'tests/security/crossTenantFuzz.test.ts',
      'tests/security/dataLeakageVerifier.test.ts',
      'tests/security/postQuantumCrypto.test.ts',
      'tests/security/multimodalContentScanner.test.ts',
      'tests/security/voiceContentScanner.test.ts',
      'tests/security/mitreAtlasMapper.test.ts',
      'tests/security/adaptiveHitl.test.ts',
      'tests/security/securityBenchmarkRunner.test.ts',
      'tests/security/injecAgentLoader.test.ts',
      'tests/security/cyberSecEvalLoader.test.ts',
      'tests/security/harmBenchLoader.test.ts',
      'tests/security/supplyChainAttestor.test.ts',
      'tests/security/differentialPrivacyLayer.test.ts',
      'tests/security/property/invariantPropertyTests.ts',
      'tests/security/a2aMtls.test.ts',
      'tests/security/a2aAuth.test.ts',
      'tests/security/memoryIsolation.test.ts',
      'tests/security/memoryToolTenantIsolation.test.ts',
      'tests/security/postgresRLS.test.ts',
      // WS9 live-fire cross-tenant isolation tests
      // (DATA/EXEC/NET/RATE/AUDIT/TAMPER/KEY per spec/ws9-tenant-livefire-compliance.md)
      // describe.skip when infrastructure (PG/Vault/gVisor/API) is unavailable;
      // unconditional tests exercise production-wired PEPs directly.
      'tests/ws9/data-isolation.test.ts',
      'tests/ws9/exec-isolation.test.ts',
      'tests/ws9/net-isolation.test.ts',
      'tests/ws9/rate-isolation.test.ts',
      'tests/ws9/audit-isolation.test.ts',
      'tests/ws9/key-injection.test.ts',
      'tests/security/taintTrackingPlugin.test.ts',
      'tests/security/dynamicCostGuardian.test.ts',
      'tests/security/m4-security-closure.test.ts',
      'tests/security/policyBundleRollback.test.ts',
      'tests/observability/m5-slo-persistence.test.ts',
      // --- harness ---
      'tests/harness/tier1AgentLoop.test.ts',
      'tests/harness/tier1Harness.test.ts',
      // H-03 fail-closed regression: unsafe final content (any length) is not success.
      'tests/harness/contentScanFailClosed.test.ts',
      // commander-rotate integration tests exercise the real CLI subprocess,
      // argv parser, persisted audit chain, and receipt contract.
      'tests/security/commander-rotate.test.ts',
      'tests/security/d25-precommit-hook.test.ts',
      'tests/security/supplyChainScanner.sourceMode.test.ts',
      // --- http ---
      // --- ultimate ---
      // Not run: tests/ultimate/{coordinationPolicy,coordinationPolicyLearned,
      // learnedWeights,learnedWeightsTenant}.test.ts use legacy topology alias
      // names incompatible with the D3.2 canonical types. Declared in
      // scripts/test-manifest.mjs DECLARED_NOT_RUN.
      'tests/ultimate/epsilonExploration.test.ts',
      'tests/ultimate/epsilonStore.test.ts',
      'tests/ultimate/explorationEventLog.test.ts',
      'tests/ultimate/orchestrationLabels.test.ts',
      'tests/ultimate/routingDashboard.test.ts',
      'tests/ultimate/subAgentGuard.test.ts',
      'tests/ultimate/tenantWorkCoordinatorRegistry.test.ts',
      'tests/ultimate/topologyRouter.test.ts',
      'tests/ultimate/taskTreeDag.test.ts',
      'tests/ultimate/topologyOptimizer.test.ts',
      'tests/ultimate/atomizer.test.ts',
      'tests/ultimate/subAgentExecutor.test.ts',
      'tests/ultimate/deliberation.test.ts',
      'tests/ultimate/orchestrator.test.ts',
      'tests/ultimate/workCoordinator.test.ts',
      'tests/ultimate/workQueueStore.test.ts',
      'tests/ultimate/exeStep.classify.test.ts',
      'tests/ultimate/tokenBudget.test.ts',
      'tests/ultimate/qualityGates.test.ts',
      'tests/ultimate/checkpointManager.test.ts',
      'tests/ultimate/evolutionRunner.test.ts',
      'tests/ultimate/topologyExecutionRunner.test.ts',
      'tests/ultimate/metricsHelper.test.ts',
      'tests/ultimate/agentFileCollector.test.ts',
      'tests/ultimate/qualityGateFixer.test.ts',
      // --- e2e ---
      'tests/e2e/orchestration.test.ts',
      'tests/e2e/sloMeasurement.test.ts',
      'tests/e2e/load.test.ts',
      'tests/e2e/chaos.test.ts',
      'tests/e2e/mock-api.test.ts',
      // --- benchmark ---
      // Not run: benchmark suites that assert wall-clock latency budgets, need
      // the external StepFun API, or intermittently time out in CI. Declared in
      // scripts/test-manifest.mjs DECLARED_NOT_RUN.
      'tests/benchmark/costBenchmark.test.ts',
      'tests/benchmark/reliabilityBenchmark.test.ts',
      'tests/benchmark/webarena-agentbench.test.ts',
      // --- algorithmic effectiveness benchmarks ---
      'tests/benchmarks/algorithmicEffectiveness/types.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/scriptedLLM.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/liveLLM.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/evaluator.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/reporter.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/runner.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/registry.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/anomalyDetector.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/thompsonMemory.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/sacProtocol.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/semanticFirewall.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/samplingPolicy.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/qualityGates.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/outputSanitizer.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/backpressureController.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/capabilityMatcher.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/contextCompactor.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/cacheManager.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/predictionLoop.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/trajectoryAnalyzer.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/adaptiveStopping.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/swarmOrchestrator.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/dynamicCostGuardian.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/tokenSentinel.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/providerFallbackChain.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/speculativeExecutor.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/parameterController.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/strategySelector.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/strategyPerformanceTracker.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/metaLearner.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/topologyRouter.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/modelRouter.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/modelCascadeController.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/smartModelRouter.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/effortScaler.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/deliberation.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/tokenGovernor.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/fusionEngine.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/executionRouter.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/subAgentExecutor.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/llmRetry.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/bm25ToolDiscovery.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/circuitBreaker.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/costPredictor.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/securityPrimitives.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/reversibilityGate.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/modules/outboundNetworkPolicy.test.ts',
      'tests/benchmarks/algorithmicEffectiveness/index.test.ts',
      'tests/benchmarks/baselineSchema.test.ts',
      'tests/scripts/check-readiness.test.ts',
      'tests/scripts/bench-v2-live.test.ts',
      'tests/scripts/bench-failover-rto-live.test.ts',
      // --- low-coverage module target tests ---
      'tests/observability/anomalyDetector.test.ts',
      'tests/runtime/backpressureController.test.ts',
      'tests/runtime/capabilityMatcher.test.ts',
      'tests/security/semanticFirewall.test.ts',
      'tests/selfEvolution/metaLearner.test.ts',
      // --- orchestration patterns (Concurrent/Graph/MoA/Router/CrossPollination/AutoLoop/DynamicReplanner) ---
      'tests/orchestration/orchestrationPatterns.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
