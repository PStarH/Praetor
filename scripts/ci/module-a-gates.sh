#!/usr/bin/env bash

set -uo pipefail

evidence_dir="${COMMANDER_CI_EVIDENCE_DIR:-.internal/evidence/ci/module-a}"
mkdir -p "$evidence_dir" || exit 1

summary_file="$evidence_dir/summary.txt"
: > "$summary_file"
overall_status=0

run_gate() {
  local name="$1"
  shift
  local log_file="$evidence_dir/${name}.log"

  printf '\n[%s] %s\n' "$name" "$*"
  set +e
  "$@" >"$log_file" 2>&1
  local exit_code=$?
  set -e

  printf '%s exit=%s log=%s\n' "$name" "$exit_code" "$log_file" | tee -a "$summary_file"
  if [ "$exit_code" -ne 0 ]; then
    overall_status=1
  fi
}

run_gate module-a-ci-config \
  pnpm --workspace-root exec node --import tsx --test scripts/module-a-ci.test.ts
run_gate build-prerequisites bash -c '
  pnpm --filter @praetor/contracts build &&
  pnpm --filter @praetor/plugin-sdk build &&
  pnpm --filter @praetor/effect-broker build &&
  pnpm --filter @praetor/kernel build &&
  pnpm --filter @praetor/action-adapters build &&
  pnpm --filter @praetor/core build &&
  pnpm --filter @praetor/worker-plane build &&
  pnpm --filter @praetor/api build
'
run_gate focused \
  pnpm --workspace-root exec node --import tsx --test \
  packages/worker-plane/src/effectGate.test.ts \
  packages/worker-plane/src/toolStepExecutor.broker.test.ts
run_gate worker-full \
  pnpm --workspace-root exec node --import tsx --test \
  packages/worker-plane/src/workerService.test.ts \
  packages/worker-plane/src/registry.rls.test.ts \
  packages/worker-plane/src/stepWorkloadIdentity.test.ts \
  packages/worker-plane/src/llmBrokerBridge.test.ts \
  packages/worker-plane/src/m3-worker-plane.test.ts \
  packages/worker-plane/src/l3-03b-gateway-localonly.test.ts \
  packages/worker-plane/src/l3-03a-effect-tool-monopoly.test.ts \
  packages/worker-plane/src/ticketAdapter.test.ts \
  packages/worker-plane/src/actionGatewayPolicy.test.ts \
  packages/worker-plane/src/bootstrap.policy.test.ts \
  packages/worker-plane/src/bootstrap.authority.test.ts \
  packages/worker-plane/src/healthServer.test.ts \
  packages/worker-plane/src/main.health.test.ts
run_gate effect-broker-full \
  pnpm --workspace-root exec node --import tsx --test \
  packages/effect-broker/src/broker.test.ts \
  packages/effect-broker/src/ws2-acceptance.test.ts \
  packages/effect-broker/src/l3-07-acceptance.test.ts \
  packages/effect-broker/src/l3-08a-unknown-reconcile.test.ts \
  packages/effect-broker/src/evidenceBundle.test.ts \
  packages/effect-broker/src/adapterErrors.test.ts \
  packages/effect-broker/src/l4-02-adapter-classification.test.ts
run_gate evidence-signer-persistence \
  pnpm --workspace-root exec node --import tsx --test \
  packages/effect-broker/src/evidenceSigner.test.ts \
  packages/effect-broker/src/evidenceSink.test.ts
run_gate worker-typecheck pnpm --filter @praetor/worker-plane typecheck
run_gate effect-broker-typecheck pnpm --filter @praetor/effect-broker typecheck
run_gate api-typecheck pnpm --filter @praetor/api typecheck
run_gate arch-guard pnpm arch:guard
run_gate arch-gate pnpm --workspace-root exec node --import tsx scripts/architecture-gate.ts
run_gate deploy-portability pnpm test:deploy-portability
run_gate ci-yaml-format pnpm exec prettier --check .github/workflows/ci.yml
run_gate diff-check git diff --check

printf 'overall exit=%s\n' "$overall_status" | tee -a "$summary_file"
exit "$overall_status"
