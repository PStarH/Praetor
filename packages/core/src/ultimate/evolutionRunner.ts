/**
 * Extracted from UltimateOrchestrator to shrink the god object.
 *
 * Responsible for the self-optimization feedback loop:
 *  - applyOptimizationSuggestions: reads MetaLearner suggestions and mutates
 *    the live orchestrator config (model tier mapping, quality gate thresholds).
 *  - analyzeAndEvolve: runs a unified trajectory analysis + evolution cycle,
 *    publishing insights and feeding them to the evolver agent.
 */
import type { UltimateOrchestratorConfig, EffortLevel } from './types';
import type { AgentRuntimeInterface } from '../runtime';
import type { ExecutionExperience, AnalysisMode, LLMProvider, ModelTier } from '../runtime/types';
import { getMetaLearner, DEFAULT_META_LEARNER_CONFIG } from '../selfEvolution/metaLearner';
import { TrajectoryAnalyzer } from '../selfEvolution/trajectoryAnalyzer';
import { getEvolverAgent } from '../selfEvolution/evolverAgent';
import { getMessageBus } from '../runtime/messageBus';
import { getGlobalLogger } from '../logging';

export interface EvolutionRunnerDeps {
  config: UltimateOrchestratorConfig;
  runtime: AgentRuntimeInterface;
}

export class EvolutionRunner {
  constructor(private readonly deps: EvolutionRunnerDeps) {}

  /**
   * Close the meta-learning feedback loop.
   * Reads optimization suggestions from the MetaLearner and applies them
   * to the orchestrator's live config — making the system self-optimizing.
   * When an experience is provided, creates a falsifiable prediction for each strategy change.
   */
  applyOptimizationSuggestions(exp?: ExecutionExperience): void {
    const suggestions = getMetaLearner().getSuggestions();
    for (const suggestion of suggestions) {
      if (suggestion.confidence < 0.3) continue;

      switch (suggestion.type) {
        case 'model_tier_change': {
          // Adjust model tier mapping: find the effort level using the 'from' model
          for (const [effortLevel, currentModel] of Object.entries(
            this.deps.config.modelTierMapping,
          )) {
            if (currentModel === suggestion.from) {
              this.deps.config.modelTierMapping[effortLevel as EffortLevel] =
                suggestion.to as ModelTier;
              getMessageBus().publish('system.alert', 'ultimate-orchestrator', {
                type: 'self_optimization',
                change: `model_tier: ${effortLevel} switched from ${suggestion.from} → ${suggestion.to}`,
                confidence: suggestion.confidence,
                evidence: suggestion.evidence,
              });
            }
          }
          break;
        }
        case 'strategy_change': {
          // Adjust topology routing: prefer the suggested topology for compatible effort levels
          const topologyMap: Record<string, string> = {
            SEQUENTIAL: 'CHAIN',
            PARALLEL: 'DISPATCH',
            HIERARCHICAL: 'ORCHESTRATOR',
            HYBRID: 'ORCHESTRATOR',
          };
          const preferredTopology = topologyMap[suggestion.to];
          if (preferredTopology) {
            this.deps.config.defaultSynthesisConfig.qualityGates.forEach((g) => {
              if (g.name === 'consistency') {
                const thresholdAdjustment = suggestion.confidence * 0.1;
                g.threshold = Math.max(
                  0.1,
                  Math.min(
                    1.0,
                    g.threshold +
                      (suggestion.to === 'HYBRID' || suggestion.to === 'PARALLEL'
                        ? -thresholdAdjustment
                        : thresholdAdjustment),
                  ),
                );
              }
            });
            getMessageBus().publish('system.alert', 'ultimate-orchestrator', {
              type: 'self_optimization',
              change: `strategy: prefer ${suggestion.to} over ${suggestion.from}`,
              confidence: suggestion.confidence,
              evidence: suggestion.evidence,
            });

            // Create a falsifiable prediction for the strategy change
            if (exp) {
              getMetaLearner().createPrediction(
                `opt-${Date.now()}`,
                `strategy change: ${suggestion.from} → ${suggestion.to}`,
                suggestion.to,
                suggestion.from,
                exp.modelUsed,
                [exp.taskType],
                [], // predicted fixes (filled from trajectory analysis)
                ['unclassified'], // predicted regressions to watch
              );
            }
          }
          break;
        }
        case 'prompt_template_change': {
          // Adjust quality gate thresholds based on prompt template suggestions
          const gateConfig = this.deps.config.qualityGates.find(
            (g) => g.name === suggestion.target,
          );
          if (gateConfig) {
            const thresholdAdjustment = suggestion.confidence * 0.1;
            if (suggestion.to === 'strict') {
              gateConfig.threshold = Math.min(1.0, gateConfig.threshold + thresholdAdjustment);
            } else if (suggestion.to === 'relaxed') {
              gateConfig.threshold = Math.max(0.1, gateConfig.threshold - thresholdAdjustment);
            }
          }
          break;
        }
        case 'tool_change': {
          // Could adjust available tools or tool configurations
          getMessageBus().publish('system.alert', 'ultimate-orchestrator', {
            type: 'self_optimization',
            change: `tool_change: ${suggestion.from} → ${suggestion.to} (confidence: ${suggestion.confidence})`,
            confidence: suggestion.confidence,
            evidence: suggestion.evidence,
          });
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Unified trajectory analysis + evolution cycle.
   * Single TrajectoryAnalyzer call feeds both failure classification and evolver mutations,
   * eliminating the duplicate LLM call that previously existed in analyzeExecution + runEvolutionCycle.
   */
  async analyzeAndEvolve(
    exp: ExecutionExperience,
    effortLevel?: string,
    taskType?: string,
  ): Promise<void> {
    const config = getMetaLearner()['config'] ?? DEFAULT_META_LEARNER_CONFIG;
    const mode: AnalysisMode = config.analysisMode ?? 'light';

    let provider: LLMProvider | undefined = undefined;
    let model: string | undefined = undefined;
    if (mode !== 'light' && this.deps.runtime) {
      provider =
        this.deps.runtime.getFirstAvailableProvider?.() ??
        this.deps.runtime.getProvider('openai') ??
        this.deps.runtime.getProvider('anthropic') ??
        this.deps.runtime.getProvider('openrouter') ??
        this.deps.runtime.getProvider('mimo') ??
        this.deps.runtime.getProvider('deepseek') ??
        this.deps.runtime.getProvider('glm') ??
        this.deps.runtime.getProvider('xiaomi') ??
        this.deps.runtime.getProvider('google');
      if (provider && effortLevel) {
        model = this.deps.config.modelTierMapping[effortLevel as EffortLevel] ?? 'gpt-4o-mini';
      }
    }

    // Single analyzer call — results feed both trajectory insights and evolution
    const analyzer = new TrajectoryAnalyzer(mode, provider, model);
    const insights = await analyzer.analyze([exp]);

    // Publish trajectory insights
    const bus = getMessageBus();
    for (const insight of insights) {
      if (!insight.success) {
        bus.publish('memory.written', 'ultimate-orch', {
          type: 'trajectory_insight',
          runId: insight.runId,
          category: insight.failureCategory,
          confidence: insight.confidence,
          evidence: insight.evidence,
          analysisTokens: insight.analysisTokens,
        });
      }
    }

    // Feed insights to evolver (previously a second TrajectoryAnalyzer call)
    if (insights.length > 0) {
      try {
        const evolver = getEvolverAgent();
        const cycle = evolver.runCycle(insights, this.deps.config, exp, [taskType ?? 'general']);
        if (cycle.applied > 0) {
          bus.publish('system.alert', 'ultimate-orch', {
            type: 'evolution_applied',
            applied: cycle.applied,
            details: cycle.mutations.map((m) => `${m.domain}: ${m.description}`),
          });
        }
      } catch (e) {
        getGlobalLogger().warn('UltimateOrchestrator', 'Evolution cycle failed', {
          error: (e as Error)?.message,
        });
      }
    }
  }
}
