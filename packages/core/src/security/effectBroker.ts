/**
 * EffectBroker — Architecture V2 mandatory registry for external side effects.
 *
 * Any WorkGraph or tool path that triggers an external side effect must be
 * admitted through a registered EffectBroker. Fail-closed: the former
 * env-gated compat shim is removed (WS2 §4 / §9) — no production-source
 * escape hatch remains.
 *
 * Note: this module is the process-local registry (get/set). The full
 * admit/execute monopoly lives in @praetor/effect-broker (worker-plane).
 * Wiring setEffectBroker() here does NOT claim LLM outlet monopoly.
 */

export interface EffectBroker {
  readonly kind: 'effect_broker';
  admit(req: unknown): unknown;
}

let globalEffectBroker: EffectBroker | null = null;

export function setEffectBroker(broker: EffectBroker | null): void {
  globalEffectBroker = broker;
}

export function getEffectBroker(): EffectBroker | null {
  return globalEffectBroker;
}

/**
 * Compat shim removed (WS2 §4). Always false — no env escape hatch in
 * production source (static gate forbids the former bypass env literal).
 */
export function isEffectBrokerCompatEnabled(): boolean {
  return false;
}

/**
 * Retained for call-site compatibility; no-op now that compat cannot be enabled.
 */
export function requireEffectBrokerCompatAudit(): void {
  // intentionally empty — compat mode removed
}
