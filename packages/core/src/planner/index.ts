/**
 * @praetor/core planner — WorkGraph (Architecture V2).
 */
export {
  planWorkGraph,
  executeWorkGraph,
  profileFromCliVerb,
  OrchestrationPlanner,
  getOrchestrationPlanner,
} from './workGraphPlanner';
export type {
  PlannerProfile,
  WorkNodeKind,
  WorkNode,
  WorkGraph,
  PlanInput,
  WorkGraphExecutor,
} from './workGraphPlanner';
