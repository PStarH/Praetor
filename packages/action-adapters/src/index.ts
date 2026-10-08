export {
  AdapterExecutionError,
  type AdapterCommitState,
  type AdapterRetryMode,
} from '@praetor/effect-broker';

export { ActionAdapterRegistry } from './registry.js';
export { createGitHubPullRequestCreateAdapter } from './github/pullRequestCreate.js';
export { createServiceNowIncidentCreateAdapter } from './servicenow/incidentCreate.js';
export {
  createKubernetesDeploymentRollbackAdapter,
  KUBERNETES_DEPLOYMENT_ROLLBACK_DESCRIPTOR,
} from './kubernetes/deploymentRollback.js';
export type {
  KubernetesDeploymentRollbackAdapterOptions,
  KubernetesObservedOutcome,
} from './kubernetes/deploymentRollback.js';
export {
  EnvAdapterCredentialProvider,
  parseGitHubDestination,
  parseKubernetesDeploymentDestination,
  parseServiceNowDestination,
  toEvidenceSummary,
} from './types.js';
export type {
  ActionAdapter,
  AdapterCompensateInput,
  AdapterCredentialProvider,
  AdapterEvidenceSummary,
  AdapterExecuteInput,
  AdapterQueryInput,
  EnvAdapterCredentialProviderOptions,
  KubernetesClusterCredentialConfig,
  KubernetesCredentialProvider,
} from './types.js';
export { registerConformanceSuite } from './conformance/suite.js';
export type {
  ConformanceAdapterContext,
  ConformanceAdapterFactory,
  ConformanceRemoteCounters,
} from './conformance/suite.js';
